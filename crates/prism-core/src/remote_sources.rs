//! Attach-only SSH transport. The SSH child is ours; the remote server never is.
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::VecDeque, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite},
    process::{Child, Command},
};
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    WebSocketStream,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub executable: String,
    #[serde(default)]
    pub socket: String,
    /// None attaches to the existing control socket; Some uses SSH direct-tcpip.
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub token_file: String,
}
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
pub(crate) fn unix_path(s: &str) -> bool {
    s.starts_with('/')
        && !s.contains(['\0', '\n', '\r'])
        && !s.split('/').any(|p| p == "." || p == "..")
}
impl SshConnection {
    pub(crate) fn validate(&self) -> Result<(), String> {
        uuid::Uuid::parse_str(&self.id).map_err(|_| "Invalid SSH connection ID")?;
        if self.name.trim().is_empty()
            || self.host.is_empty()
            || self.host.starts_with('-')
            || !self
                .host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-@:".contains(c))
        {
            return Err(
                "Enter a connection name and an SSH host alias or user@host (without options)"
                    .into(),
            );
        }
        for path in [&self.socket, &self.token_file] {
            if !path.is_empty() && !unix_path(path) {
                return Err("Remote paths must be absolute Unix paths".into());
            }
        }
        if !self.executable.is_empty() && self.executable != "codex" && !unix_path(&self.executable)
        {
            return Err("Codex executable must be an absolute remote path, or codex".into());
        }
        if self.port == Some(0) || (self.port.is_none() && !self.token_file.is_empty()) {
            return Err("A token file requires an existing WebSocket listener port".into());
        }
        Ok(())
    }
    fn ssh(&self) -> Command {
        let mut cmd = Command::new("ssh");
        cmd.args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
        ]);
        cmd.kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        cmd
    }
    fn proxy_command(&self) -> String {
        let executable = if self.executable.is_empty() {
            "codex"
        } else {
            &self.executable
        };
        let mut command = format!("exec {} app-server proxy", quote(executable));
        if !self.socket.is_empty() {
            command.push_str(&format!(" --sock {}", quote(&self.socket)));
        }
        command
    }
}
trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub(crate) struct Remote {
    ws: WebSocketStream<Box<dyn Io>>,
    _child: Option<Child>,
    next: u64,
    queued: VecDeque<Value>,
}
const ATTACH_HELP: &str = "Check SSH access and the remote Codex executable/socket. If no server is running, connect this host in ChatGPT Settings → Connections first, then retry. Prism only attaches to existing servers.";
impl Remote {
    #[cfg(test)]
    pub(crate) async fn fixture() -> (Self, WebSocketStream<tokio::io::DuplexStream>) {
        use tokio_tungstenite::tungstenite::protocol::Role;
        let (client, server) = tokio::io::duplex(65536);
        let io: Box<dyn Io> = Box::new(client);
        let client = WebSocketStream::from_raw_socket(io, Role::Client, None).await;
        let server = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        (
            Self {
                ws: client,
                _child: None,
                next: 1,
                queued: VecDeque::new(),
            },
            server,
        )
    }
    pub(crate) async fn connect(profile: &SshConnection) -> Result<Self, String> {
        profile.validate()?;
        tokio::time::timeout(Duration::from_secs(25), Self::attach(profile))
            .await
            .map_err(|_| format!("Remote connection timed out. {ATTACH_HELP}"))?
            .map_err(|e| format!("{e}. {ATTACH_HELP}"))
    }
    async fn attach(profile: &SshConnection) -> Result<Self, String> {
        let mut request = "ws://localhost/"
            .into_client_request()
            .map_err(|e| e.to_string())?;
        if !profile.token_file.is_empty() {
            let mut cmd = profile.ssh();
            let mut child = cmd
                .arg(&profile.host)
                .arg(format!("head -c 4097 -- {}", quote(&profile.token_file)))
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            let mut token = Vec::new();
            child
                .stdout
                .take()
                .ok_or("Missing SSH stdout")?
                .take(4098)
                .read_to_end(&mut token)
                .await
                .map_err(|e| e.to_string())?;
            if !child.wait().await.map_err(|e| e.to_string())?.success() || token.len() > 4096 {
                return Err("Cannot read remote token file".into());
            }
            let token = std::str::from_utf8(&token)
                .map_err(|_| "Invalid remote token")?
                .trim();
            if token.is_empty() {
                return Err("Remote token file is empty".into());
            }
            request.headers_mut().insert(
                "Authorization",
                format!("Bearer {token}")
                    .parse()
                    .map_err(|_| "Invalid remote token")?,
            );
        }
        let mut cmd = profile.ssh();
        if let Some(port) = profile.port {
            cmd.args(["-W", &format!("127.0.0.1:{port}")])
                .arg(&profile.host);
        } else {
            cmd.arg(&profile.host).arg(profile.proxy_command());
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot run SSH: {e}"))?;
        let io: Box<dyn Io> = Box::new(tokio::io::join(
            child.stdout.take().ok_or("Missing SSH stdout")?,
            child.stdin.take().ok_or("Missing SSH stdin")?,
        ));
        let config = WebSocketConfig::default()
            .max_message_size(Some(24 * 1024 * 1024))
            .max_frame_size(Some(24 * 1024 * 1024));
        let (ws, _) = tokio_tungstenite::client_async_with_config(request, io, Some(config))
            .await
            .map_err(|e| format!("Cannot attach to Codex: {e}"))?;
        let mut remote = Self {
            ws,
            _child: Some(child),
            next: 1,
            queued: VecDeque::new(),
        };
        let init = remote.call("initialize", json!({"clientInfo":{"name":"codex_prism","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        if init["platformFamily"] != "unix" {
            return Err("Remote data sources currently require Linux or macOS".into());
        }
        remote
            .send(json!({"method":"initialized","params":{}}))
            .await?;
        Ok(remote)
    }
    pub(crate) async fn send(&mut self, value: Value) -> Result<(), String> {
        self.ws
            .send(Message::Text(value.to_string().into()))
            .await
            .map_err(|e| e.to_string())
    }
    async fn receive(&mut self) -> Result<Value, String> {
        loop {
            match self
                .ws
                .next()
                .await
                .ok_or("Remote Codex disconnected")?
                .map_err(|e| e.to_string())?
            {
                Message::Text(text) => {
                    return serde_json::from_str(&text).map_err(|e| e.to_string())
                }
                Message::Close(_) => return Err("Remote Codex disconnected".into()),
                Message::Ping(_) => {
                    self.ws.flush().await.map_err(|e| e.to_string())?;
                }
                _ => {}
            }
        }
    }
    pub(crate) async fn event(&mut self) -> Result<Value, String> {
        if let Some(v) = self.queued.pop_front() {
            return Ok(v);
        }
        self.receive().await
    }
    pub(crate) async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let v = self.receive().await?;
                if v["id"] == id && v.get("method").is_none() {
                    return if let Some(e) = v.get("error") {
                        Err(e.to_string())
                    } else {
                        Ok(v["result"].clone())
                    };
                }
                if self.queued.len() == 256 {
                    return Err("Too many remote events before response".into());
                }
                self.queued.push_back(v);
            }
        })
        .await
        .map_err(|_| "Remote request timed out".to_owned())?
    }
}
pub(crate) async fn check(profile: &SshConnection, path: &str) -> Result<(), String> {
    let mut remote = Remote::connect(profile).await?;
    let metadata = remote.call("fs/getMetadata", json!({"path":path})).await?;
    if metadata["isDirectory"] != true {
        return Err("Remote source is not a directory".into());
    }
    remote
        .call("fs/readDirectory", json!({"path":path}))
        .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> SshConnection {
        SshConnection {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Research".into(),
            host: "research-host".into(),
            executable: String::new(),
            socket: String::new(),
            port: None,
            token_file: String::new(),
        }
    }
    #[test]
    fn validates_ssh_arguments_and_quotes_paths() {
        let mut p = profile();
        assert!(p.validate().is_ok());
        for host in [
            "-oProxyCommand=bad",
            "host;bad",
            "host\ncommand",
            "host with space",
        ] {
            p.host = host.into();
            assert!(p.validate().is_err());
        }
        p.host = "user@host".into();
        p.executable = "/a folder/codex'cli".into();
        p.socket = "/a folder/control.sock".into();
        assert!(p.validate().is_ok());
        assert_eq!(
            p.proxy_command(),
            "exec '/a folder/codex'\\''cli' app-server proxy --sock '/a folder/control.sock'"
        );
        for path in ["relative", "/data/../secret", "/data/./x", "/bad\0path"] {
            assert!(!unix_path(path));
        }
    }

    #[tokio::test]
    async fn rpc_keeps_notifications_and_reports_remote_errors() {
        let (mut remote, mut server) = Remote::fixture().await;
        let peer = tokio::spawn(async move {
            let request: Value =
                serde_json::from_str(server.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            server
                .send(Message::Text(
                    json!({"method":"turn/completed","params":{"threadId":"owned"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            server
                .send(Message::Text(
                    json!({"id":request["id"],"result":{"ok":true}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let request: Value =
                serde_json::from_str(server.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            server
                .send(Message::Text(
                    json!({"id":request["id"],"error":{"code":-1,"message":"unavailable"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        });
        assert_eq!(remote.call("test", json!({})).await.unwrap()["ok"], true);
        assert_eq!(remote.event().await.unwrap()["params"]["threadId"], "owned");
        assert!(remote
            .call("test", json!({}))
            .await
            .unwrap_err()
            .contains("unavailable"));
        peer.await.unwrap();
        assert!(remote.event().await.is_err());
    }
    /// Explicit opt-in only: host and executable are supplied outside the repository.
    #[tokio::test]
    #[ignore = "requires an existing remote Codex server and SSH credentials"]
    async fn live_existing_server() {
        let profile: SshConnection =
            serde_json::from_str(&std::env::var("PRISM_TEST_SSH_PROFILE").unwrap()).unwrap();
        let path = std::env::var("PRISM_TEST_SOURCE_PATH").unwrap();
        check(&profile, &path).await.unwrap();
        let mut remote = Remote::connect(&profile).await.unwrap();
        let result = remote.call("command/exec", json!({"command":["printf","prism-read-only-probe"],"sandboxPolicy":{"type":"readOnly"},"timeoutMs":5000})).await.unwrap();
        assert_eq!(result["exitCode"], 0);
        assert_eq!(result["stdout"], "prism-read-only-probe");
    }
}
