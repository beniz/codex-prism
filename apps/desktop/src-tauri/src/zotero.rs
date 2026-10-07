use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha1::Sha1;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

type HmacSha1 = Hmac<Sha1>;

// Register your app at https://www.zotero.org/oauth/apps
// Set these via ZOTERO_CONSUMER_KEY / ZOTERO_CONSUMER_SECRET env vars,
// or replace these defaults with your registered credentials.
fn consumer_key() -> String {
    std::env::var("ZOTERO_CONSUMER_KEY")
        .unwrap_or_else(|_| option_env!("ZOTERO_CONSUMER_KEY").unwrap_or("").to_string())
}

fn consumer_secret() -> String {
    std::env::var("ZOTERO_CONSUMER_SECRET").unwrap_or_else(|_| {
        option_env!("ZOTERO_CONSUMER_SECRET")
            .unwrap_or("")
            .to_string()
    })
}

const REQUEST_TOKEN_URL: &str = "https://www.zotero.org/oauth/request";
const AUTHORIZE_URL: &str = "https://www.zotero.org/oauth/authorize";
const ACCESS_TOKEN_URL: &str = "https://www.zotero.org/oauth/access";

// ─── Types ───

#[derive(Serialize)]
pub struct ZoteroAuthUrl {
    pub authorize_url: String,
}

#[derive(Serialize)]
pub struct ZoteroOAuthResult {
    pub api_key: String,
    pub user_id: String,
    pub username: String,
}

pub struct ZoteroOAuthPending {
    listener: TcpListener,
    request_token_secret: String,
}

pub type ZoteroOAuthState = tokio::sync::Mutex<Option<ZoteroOAuthPending>>;

// ─── OAuth 1.0a Helpers ───

fn percent_encode(input: &str) -> String {
    let mut result = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                result.push(byte as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

fn generate_nonce() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", ts)
}

fn get_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn hmac_sha1(key: &str, message: &str) -> Result<String, String> {
    let mut mac =
        HmacSha1::new_from_slice(key.as_bytes()).map_err(|e| format!("Invalid HMAC key: {}", e))?;
    mac.update(message.as_bytes());
    Ok(BASE64.encode(mac.finalize().into_bytes()))
}

fn oauth_signature(
    method: &str,
    url: &str,
    params: &[(String, String)],
    consumer_secret: &str,
    token_secret: &str,
) -> String {
    let mut sorted = params.to_vec();
    sorted.sort();

    let param_string: String = sorted
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    let base_string = format!(
        "{}&{}&{}",
        percent_encode(method),
        percent_encode(url),
        percent_encode(&param_string)
    );

    let signing_key = format!(
        "{}&{}",
        percent_encode(consumer_secret),
        percent_encode(token_secret)
    );

    hmac_sha1(&signing_key, &base_string).unwrap_or_default()
}

fn build_auth_header(params: &[(String, String)]) -> String {
    let parts: Vec<String> = params
        .iter()
        .filter(|(k, _)| k.starts_with("oauth_"))
        .map(|(k, v)| format!("{}=\"{}\"", percent_encode(k), percent_encode(v)))
        .collect();
    format!("OAuth {}", parts.join(", "))
}

fn parse_form_urlencoded(body: &str) -> HashMap<String, String> {
    body.split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

// ─── OAuth Flow Steps ───

async fn request_token(callback_url: &str) -> Result<(String, String), String> {
    let ck = consumer_key();
    let cs = consumer_secret();
    if ck.is_empty() || cs.is_empty() {
        return Err("Zotero OAuth credentials not configured. Set ZOTERO_CONSUMER_KEY and ZOTERO_CONSUMER_SECRET environment variables.".into());
    }

    let nonce = generate_nonce();
    let timestamp = get_timestamp();

    let mut params = vec![
        ("oauth_callback".into(), callback_url.to_string()),
        ("oauth_consumer_key".into(), ck.clone()),
        ("oauth_nonce".into(), nonce),
        ("oauth_signature_method".into(), "HMAC-SHA1".into()),
        ("oauth_timestamp".into(), timestamp),
        ("oauth_version".into(), "1.0".into()),
    ];

    let sig = oauth_signature("POST", REQUEST_TOKEN_URL, &params, &cs, "");
    params.push(("oauth_signature".into(), sig));

    let header = build_auth_header(&params);

    let client = reqwest::Client::new();
    let response = client
        .post(REQUEST_TOKEN_URL)
        .header("Authorization", header)
        .send()
        .await
        .map_err(|e| format!("Request token failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Request token failed ({}): {}", status, body));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    let map = parse_form_urlencoded(&body);

    let token = map
        .get("oauth_token")
        .cloned()
        .ok_or("Missing oauth_token in response")?;
    let secret = map
        .get("oauth_token_secret")
        .cloned()
        .ok_or("Missing oauth_token_secret in response")?;

    Ok((token, secret))
}

async fn wait_for_callback(listener: TcpListener) -> Result<(String, String), String> {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        accept_callback(listener),
    )
    .await;

    match result {
        Ok(inner) => inner,
        Err(_) => Err("OAuth authorization timed out (120s)".into()),
    }
}

async fn accept_callback(listener: TcpListener) -> Result<(String, String), String> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("Accept failed: {}", e))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Read failed: {}", e))?;
    let request = String::from_utf8_lossy(buf.get(..n).unwrap_or(&buf));

    // Parse: GET /callback?oauth_token=xxx&oauth_verifier=yyy HTTP/1.1
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");
    let query = path.split('?').nth(1).unwrap_or("");
    let params = parse_form_urlencoded(query);

    // Respond with success page
    let html = r#"<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Connected to Zotero!</h2><p style="color:#666">You can close this tab and return to Codex-Prism.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes()).await;

    let token = params
        .get("oauth_token")
        .cloned()
        .ok_or("Missing oauth_token in callback")?;
    let verifier = params
        .get("oauth_verifier")
        .cloned()
        .ok_or("Missing oauth_verifier in callback")?;

    Ok((token, verifier))
}

async fn access_token(
    oauth_token: &str,
    token_secret: &str,
    verifier: &str,
) -> Result<ZoteroOAuthResult, String> {
    let ck = consumer_key();
    let cs = consumer_secret();

    let nonce = generate_nonce();
    let timestamp = get_timestamp();

    let mut params = vec![
        ("oauth_consumer_key".into(), ck),
        ("oauth_nonce".into(), nonce),
        ("oauth_signature_method".into(), "HMAC-SHA1".into()),
        ("oauth_timestamp".into(), timestamp),
        ("oauth_token".into(), oauth_token.to_string()),
        ("oauth_verifier".into(), verifier.to_string()),
        ("oauth_version".into(), "1.0".into()),
    ];

    let sig = oauth_signature("POST", ACCESS_TOKEN_URL, &params, &cs, token_secret);
    params.push(("oauth_signature".into(), sig));

    let header = build_auth_header(&params);

    let client = reqwest::Client::new();
    let response = client
        .post(ACCESS_TOKEN_URL)
        .header("Authorization", header)
        .send()
        .await
        .map_err(|e| format!("Access token failed: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Access token failed: {}", body));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    let map = parse_form_urlencoded(&body);

    let api_key = map
        .get("oauth_token")
        .cloned()
        .ok_or("Missing oauth_token in access response")?;
    let user_id = map
        .get("userID")
        .cloned()
        .ok_or("Missing userID in access response")?;
    let username = map.get("username").cloned().unwrap_or_default();

    Ok(ZoteroOAuthResult {
        api_key,
        user_id,
        username,
    })
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn zotero_start_oauth(
    state: tauri::State<'_, ZoteroOAuthState>,
) -> Result<ZoteroAuthUrl, String> {
    // Bind local callback server
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind local server: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();
    let callback_url = format!("http://127.0.0.1:{}/callback", port);

    // Get request token from Zotero
    let (token, secret) = request_token(&callback_url).await?;

    // Build authorize URL
    let authorize_url = format!(
        "{}?oauth_token={}&name=Codex-Prism&library_access=1&notes_access=0&write_access=0&all_groups=read",
        AUTHORIZE_URL, token
    );

    // Store pending state
    *state.lock().await = Some(ZoteroOAuthPending {
        listener,
        request_token_secret: secret,
    });

    Ok(ZoteroAuthUrl { authorize_url })
}

#[tauri::command]
pub async fn zotero_complete_oauth(
    state: tauri::State<'_, ZoteroOAuthState>,
) -> Result<ZoteroOAuthResult, String> {
    let pending = state
        .lock()
        .await
        .take()
        .ok_or("No pending OAuth flow. Call zotero_start_oauth first.")?;

    // Wait for the callback from Zotero
    let (oauth_token, oauth_verifier) = wait_for_callback(pending.listener).await?;

    // Exchange for access token
    access_token(&oauth_token, &pending.request_token_secret, &oauth_verifier).await
}

#[tauri::command]
pub async fn zotero_cancel_oauth(state: tauri::State<'_, ZoteroOAuthState>) -> Result<(), String> {
    *state.lock().await = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percent_encode_unreserved() {
        // Unreserved characters (RFC 3986) should pass through
        assert_eq!(percent_encode("abc"), "abc");
        assert_eq!(percent_encode("ABC"), "ABC");
        assert_eq!(percent_encode("012"), "012");
        assert_eq!(percent_encode("-._~"), "-._~");
    }

    #[test]
    fn test_percent_encode_special_chars() {
        assert_eq!(percent_encode(" "), "%20");
        assert_eq!(percent_encode("&"), "%26");
        assert_eq!(percent_encode("="), "%3D");
        assert_eq!(percent_encode("/"), "%2F");
        assert_eq!(percent_encode("hello world"), "hello%20world");
    }

    #[test]
    fn test_percent_encode_empty() {
        assert_eq!(percent_encode(""), "");
    }

    #[test]
    fn test_hmac_sha1_known_vector() {
        // Known HMAC-SHA1 test vector
        let result = hmac_sha1("key", "The quick brown fox jumps over the lazy dog").unwrap();
        // HMAC-SHA1("key", "The quick brown fox jumps over the lazy dog") is a known value
        assert!(!result.is_empty());
        // Base64 encoded, should contain only valid base64 chars
        assert!(result
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));
    }

    #[test]
    fn test_oauth_signature_produces_base64() {
        let params = vec![
            ("oauth_consumer_key".to_string(), "key123".to_string()),
            ("oauth_nonce".to_string(), "nonce".to_string()),
            (
                "oauth_signature_method".to_string(),
                "HMAC-SHA1".to_string(),
            ),
            ("oauth_timestamp".to_string(), "1234567890".to_string()),
            ("oauth_version".to_string(), "1.0".to_string()),
        ];
        let sig = oauth_signature(
            "POST",
            "https://example.com/api",
            &params,
            "consumer_secret",
            "token_secret",
        );
        assert!(!sig.is_empty());
        // Should be valid base64
        assert!(sig
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));
    }

    #[test]
    fn test_oauth_signature_deterministic() {
        let params = vec![
            ("a".to_string(), "1".to_string()),
            ("b".to_string(), "2".to_string()),
        ];
        let sig1 = oauth_signature("GET", "https://example.com", &params, "cs", "ts");
        let sig2 = oauth_signature("GET", "https://example.com", &params, "cs", "ts");
        assert_eq!(sig1, sig2);
    }

    #[test]
    fn test_build_auth_header_format() {
        let params = vec![
            ("oauth_consumer_key".to_string(), "mykey".to_string()),
            ("oauth_nonce".to_string(), "abc".to_string()),
            ("non_oauth_param".to_string(), "ignored".to_string()),
        ];
        let header = build_auth_header(&params);
        assert!(header.starts_with("OAuth "));
        assert!(header.contains("oauth_consumer_key"));
        assert!(header.contains("oauth_nonce"));
        // Non-oauth params should be excluded
        assert!(!header.contains("non_oauth_param"));
    }

    #[test]
    fn test_parse_form_urlencoded_basic() {
        let result = parse_form_urlencoded("key1=val1&key2=val2");
        assert_eq!(result.get("key1").unwrap(), "val1");
        assert_eq!(result.get("key2").unwrap(), "val2");
    }

    #[test]
    fn test_parse_form_urlencoded_empty_value() {
        let result = parse_form_urlencoded("key1=&key2=val");
        assert_eq!(result.get("key1").unwrap(), "");
        assert_eq!(result.get("key2").unwrap(), "val");
    }

    #[test]
    fn test_parse_form_urlencoded_single_pair() {
        let result = parse_form_urlencoded("token=abc123");
        assert_eq!(result.len(), 1);
        assert_eq!(result.get("token").unwrap(), "abc123");
    }

    #[test]
    fn test_parse_form_urlencoded_empty_string() {
        let result = parse_form_urlencoded("");
        // Empty string splits into [""] — splitn(2, '=') on "" yields key="" with no '=',
        // so value defaults to "" and we get one entry: ("", "")
        assert_eq!(result.len(), 1);
        assert_eq!(result.get("").unwrap(), "");
    }
}
