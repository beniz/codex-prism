//! Native-only update policy. The webview never chooses an endpoint, key or installer arguments.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

const FEED: &str = "https://github.com/beniz/codex-prism/releases/latest/download/latest.json";
const RELEASES: &str = "https://github.com/beniz/codex-prism/releases";

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running_version: String,
    pub installation: String,
    pub available_version: Option<String>,
    pub installed_version: Option<String>,
    pub notes: Option<String>,
    pub release_url: String,
    pub can_install: bool,
    pub ready: bool,
}
#[derive(Deserialize)]
struct Manifest {
    version: String,
    notes: Option<String>,
    #[serde(default)]
    platforms: HashMap<String, serde_json::Value>,
}
#[derive(Default)]
pub struct Updates {
    pending: Mutex<Pending>,
}
#[derive(Default)]
struct Pending {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    checked_at: Option<std::time::Instant>,
    cached_result: Option<Result<Status, String>>,
}
fn newer(candidate: &str, running: &str) -> bool {
    match (
        semver::Version::parse(candidate),
        semver::Version::parse(running),
    ) {
        (Ok(a), Ok(b)) => a.pre.is_empty() && a > b,
        _ => false,
    }
}
fn installation() -> &'static str {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    if matches!(bundle_type(), Some(BundleType::Deb)) {
        return "deb";
    }
    if env!("PRISM_OFFICIAL_BUILD") != "1" && !cfg!(feature = "updater-test") {
        return "source";
    }
    match bundle_type() {
        Some(BundleType::AppImage) if std::env::var_os("APPIMAGE").is_some() => "appimage",
        Some(BundleType::Deb) => "deb",
        Some(BundleType::Nsis)
            if std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|parent| parent.join("uninstall.exe")))
                .is_some_and(|p| p.is_file()) =>
        {
            "windows"
        }
        Some(BundleType::App)
            if std::env::current_exe()
                .ok()
                .is_some_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/")) =>
        {
            "macos"
        }
        _ => "unknown",
    }
}
fn feed() -> String {
    #[cfg(feature = "updater-test")]
    if let Ok(value) = std::env::var("PRISM_TEST_UPDATE_FEED") {
        return value;
    }
    FEED.into()
}
fn target() -> String {
    format!(
        "{}-{}",
        if cfg!(target_os = "macos") {
            "darwin"
        } else {
            std::env::consts::OS
        },
        std::env::consts::ARCH
    )
}
fn base_status(app: &tauri::AppHandle) -> Status {
    Status {
        running_version: app.package_info().version.to_string(),
        installation: installation().into(),
        available_version: None,
        installed_version: None,
        notes: None,
        release_url: RELEASES.into(),
        can_install: false,
        ready: false,
    }
}

// Query only package metadata, never execute a replacement executable to discover its version.
async fn installed_deb_version() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let exe = std::env::current_exe().ok()?;
        let path = exe
            .to_string_lossy()
            .trim_end_matches(" (deleted)")
            .to_owned();
        let owner = command_output("dpkg-query", &["-S", &path]).await?;
        let package = owner.lines().next()?.rsplit_once(": ")?.0;
        let metadata =
            command_output("dpkg-query", &["-W", "-f=${Status}\n${Version}", package]).await?;
        parse_deb_version(&metadata)
    }
    #[cfg(not(target_os = "linux"))]
    None
}
#[cfg(target_os = "linux")]
async fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(program)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    result
        .status
        .success()
        .then(|| String::from_utf8_lossy(&result.stdout).trim().to_owned())
}
#[cfg(any(target_os = "linux", test))]
fn parse_deb_version(metadata: &str) -> Option<String> {
    let (status, version) = metadata.trim().split_once('\n')?;
    (status == "install ok installed" && semver::Version::parse(version).is_ok())
        .then(|| version.into())
}
#[tauri::command]
pub async fn update_local_status(app: tauri::AppHandle) -> Result<Status, String> {
    let mut status = base_status(&app);
    if status.installation == "deb"
        && (!env!("PRISM_UPDATE_PUBLIC_KEY").is_empty() || cfg!(feature = "updater-test"))
    {
        status.installed_version = installed_deb_version()
            .await
            .filter(|v| newer(v, &status.running_version));
    }
    Ok(status)
}
#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
    manual: Option<bool>,
) -> Result<Status, String> {
    let mut pending = state
        .pending
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    if !manual.unwrap_or(false)
        && pending
            .checked_at
            .is_some_and(|t| t.elapsed() < Duration::from_secs(12 * 3600))
    {
        if let Some(result) = &pending.cached_result {
            let mut result = result.clone();
            if let Ok(status) = &mut result {
                status.installed_version =
                    update_local_status(app.clone()).await?.installed_version;
                status.ready = pending.bytes.is_some();
            }
            return result;
        }
    }
    let result = check_inner(&app, &mut pending).await;
    pending.checked_at = Some(std::time::Instant::now());
    pending.cached_result = Some(result.clone());
    result
}
async fn check_inner(app: &tauri::AppHandle, pending: &mut Pending) -> Result<Status, String> {
    let mut status = update_local_status(app.clone()).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(feed())
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    // Bound manifest size, including servers which omit Content-Length.
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err("Update manifest is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if !newer(&manifest.version, &status.running_version) {
        *pending = Pending::default();
        return Ok(status);
    }
    status.release_url = format!("{RELEASES}/tag/v{}", manifest.version);
    status.available_version = Some(manifest.version.clone());
    status.notes = manifest.notes;
    status.can_install = matches!(
        status.installation.as_str(),
        "appimage" | "macos" | "windows"
    ) && !env!("PRISM_UPDATE_PUBLIC_KEY").is_empty()
        && manifest.platforms.contains_key(&target());
    if status.can_install {
        // Refresh only when the selected version changes, preserving a verified pending download.
        if pending
            .update
            .as_ref()
            .is_none_or(|u| u.version != manifest.version)
        {
            let backend = app.state::<prism_core::Backend>().inner().clone();
            let update = app
                .updater_builder()
                .pubkey(env!("PRISM_UPDATE_PUBLIC_KEY"))
                .endpoints(vec![
                    reqwest::Url::parse(&feed()).map_err(|e| e.to_string())?
                ])
                .map_err(|e| e.to_string())?
                .timeout(Duration::from_secs(60))
                .installer_arg("/PRISMUPDATE")
                .on_before_exit(move || {
                    tauri::async_runtime::block_on(backend.cleanup_for_update());
                })
                .build()
                .map_err(|e| e.to_string())?
                .check()
                .await
                .map_err(|e| e.to_string())?;
            let mut update = update.ok_or("Release changed during update check; retry")?;
            update.timeout = Some(Duration::from_secs(600));
            if update.version != manifest.version {
                return Err("Release changed during update check; retry".into());
            }
            validate_url(update.download_url.as_str())?;
            #[cfg(not(feature = "updater-test"))]
            if !update.download_url.path().starts_with(&format!(
                "/beniz/codex-prism/releases/download/v{}/codex-prism-{}-",
                update.version, update.version
            )) {
                return Err("Update artifact does not match the announced release".into());
            }
            *pending = Pending {
                update: Some(update),
                bytes: None,
                ..Default::default()
            };
        }
        status.ready = pending.bytes.is_some();
    } else {
        *pending = Pending::default();
    }
    Ok(status)
}
fn validate_url(url: &str) -> Result<(), String> {
    #[cfg(feature = "updater-test")]
    if url.starts_with("http://127.0.0.1:") {
        return Ok(());
    }
    if url.starts_with("https://github.com/beniz/codex-prism/releases/download/") {
        Ok(())
    } else {
        Err("Update artifact is not hosted in the codex-prism release repository".into())
    }
}
#[tauri::command]
pub async fn update_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
    version: String,
) -> Result<(), String> {
    let mut pending = state
        .pending
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    let update = pending.update.as_ref().ok_or("Check for updates first")?;
    if pending.update.as_ref().is_none_or(|u| u.version != version) {
        return Err("The selected update changed; check for updates again".into());
    }
    let mut received = 0_u64;
    let mut last_progress = std::time::Instant::now();
    let bytes = update
        .download(
            |length, total| {
                received += length as u64;
                if last_progress.elapsed() >= Duration::from_millis(100) {
                    last_progress = std::time::Instant::now();
                    let _ = app.emit(
                        "update-progress",
                        serde_json::json!({"received": received, "total": total}),
                    );
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "update-progress",
        serde_json::json!({"received": bytes.len(), "total": bytes.len()}),
    );
    pending.bytes = Some(bytes);
    Ok(())
}
fn require_single_window(app: &tauri::AppHandle) -> Result<(), String> {
    if app.webview_windows().len() > 1 {
        return Err("Save and close other application windows before restarting".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
    version: String,
) -> Result<(), String> {
    require_single_window(&app)?;
    let mut pending = state
        .pending
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    if pending.update.as_ref().is_none_or(|u| u.version != version) {
        return Err("The selected update changed; check for updates again".into());
    }
    let bytes = pending.bytes.take().ok_or("Download the update first")?;
    let update = pending.update.take().ok_or("Check for updates first")?;
    let backend = app.state::<prism_core::Backend>().inner().clone();
    let pause = match backend.pause_for_update() {
        Ok(pause) => pause,
        Err(e) => {
            pending.update = Some(update);
            pending.bytes = Some(bytes);
            return Err(e);
        }
    };
    // Installation can do blocking filesystem/installer work. Never block the UI thread.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let result = update.install(&bytes).map_err(|e| e.to_string());
        (result, update, bytes)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(error) = outcome.0 {
        pending.update = Some(outcome.1);
        pending.bytes = Some(outcome.2);
        drop(pause);
        return Err(error);
    }
    backend.shutdown().await;
    app.restart();
}
#[tauri::command]
pub async fn update_restart_local(app: tauri::AppHandle) -> Result<(), String> {
    require_single_window(&app)?;
    let status = update_local_status(app.clone()).await?;
    if status.installed_version.is_none() {
        return Err("No newer fully installed package was found".into());
    }
    let backend = app.state::<prism_core::Backend>().inner().clone();
    let _pause = backend.pause_for_update()?;
    // current_exe may refer to an unlinked inode after dpkg replaced it.
    let path: PathBuf = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .trim_end_matches(" (deleted)")
        .into();
    if !path.is_file() {
        return Err("Installed application executable is missing".into());
    }
    backend.cleanup_for_update().await;
    std::process::Command::new(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_build_plugin_config_initializes_without_a_signing_key() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
        assert!(updater.pubkey.is_empty());
        assert!(!updater.dangerous_insecure_transport_protocol);
    }
    #[test]
    fn stable_upgrades_only() {
        assert!(newer("1.10.0", "1.9.0"));
        for v in ["1.9.0", "1.8.0", "2.0.0-beta.1", "garbage"] {
            assert!(!newer(v, "1.9.0"));
        }
    }
    #[test]
    fn deb_must_be_fully_installed() {
        assert_eq!(
            parse_deb_version("install ok installed\n1.8.0"),
            Some("1.8.0".into())
        );
        assert!(parse_deb_version("install ok unpacked\n1.8.0").is_none());
        assert!(parse_deb_version("deinstall ok config-files\n1.8.0").is_none());
    }
    #[test]
    fn reject_foreign_artifacts() {
        assert!(
            validate_url("https://github.com/beniz/codex-prism/releases/download/v1.8.0/app")
                .is_ok()
        );
        assert!(validate_url("https://github.com/other/project/releases/download/x").is_err());
        assert!(validate_url("file:///tmp/app").is_err());
    }
}

/// Compiled only into disposable CI fixtures, never official release binaries.
#[cfg(feature = "updater-test")]
pub fn start_test(app: &tauri::AppHandle) -> bool {
    let Ok(root) = std::env::var("PRISM_TEST_ROOT") else {
        return false;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let root = PathBuf::from(root);
        let result = async {
            let version = app.package_info().version.to_string();
            std::fs::write(root.join("started.json"), serde_json::to_vec(&serde_json::json!({"version": version, "executable": std::env::current_exe().ok()})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if version == std::env::var("PRISM_TEST_TARGET").unwrap_or_default() { return Ok::<_, String>(()); }
            let mode = std::env::var("PRISM_TEST_MODE").unwrap_or_default();
            if mode == "local" {
                // Keep A alive while the runner installs B through dpkg.
                for _ in 0..120 {
                    if root.join("installed").exists() { break; }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                let status = update_local_status(app.clone()).await?;
                std::fs::write(root.join("local.json"), serde_json::to_vec(&status).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                update_restart_local(app.clone()).await?;
            } else {
                let state = app.state::<Updates>();
                let status = update_check(app.clone(), state.clone(), Some(true)).await?;
                if !status.can_install { return Err(format!("Fixture cannot update: {status:?}")); }
                let downloaded = update_download(app.clone(), state.clone(), status.available_version.clone().ok_or("Missing update version")?).await;
                if mode == "tamper" {
                    if downloaded.is_ok() { return Err("Tampered package was accepted".into()); }
                    std::fs::write(root.join("rejected"), downloaded.err().unwrap_or_default()).map_err(|e| e.to_string())?;
                    return Ok(());
                }
                downloaded?;
                std::fs::write(root.join("installing"), &version).map_err(|e| e.to_string())?;
                update_install(app.clone(), state, status.available_version.ok_or("Missing update version")?).await?;
            }
            Ok(())
        }.await;
        if let Err(error) = result {
            let _ = std::fs::write(root.join("error"), error);
        }
        app.exit(0);
    });
    true
}
