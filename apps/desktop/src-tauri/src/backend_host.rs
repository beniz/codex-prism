//! Native integration supplied to the transport-independent core.
use prism_core::{BackendEvent, DirectoryPreparer, EventSink};
use std::path::Path;
use tauri::{Emitter, Manager};

pub struct DesktopEvents {
    app: tauri::AppHandle,
    window: Option<tauri::WebviewWindow>,
}
impl DesktopEvents {
    pub fn for_app(app: tauri::AppHandle) -> Self {
        Self { app, window: None }
    }
    pub fn for_window(window: tauri::WebviewWindow) -> Self {
        Self {
            app: window.app_handle().clone(),
            window: Some(window),
        }
    }
}
fn window_scoped(event: &BackendEvent) -> bool {
    matches!(
        event,
        BackendEvent::UvInstallOutput(_) | BackendEvent::UvInstallComplete(_)
    )
}
impl EventSink for DesktopEvents {
    fn emit(&self, event: BackendEvent) {
        if window_scoped(&event) {
            if let Some(window) = &self.window {
                let _ = window.emit(event.name(), event.payload());
            }
        } else {
            let _ = self.app.emit(event.name(), event.payload());
        }
    }
}

pub struct DesktopDirectoryPreparer;
impl DirectoryPreparer for DesktopDirectoryPreparer {
    fn prepare(&self, target: &Path, ownership_root: &Path) -> Result<(), String> {
        #[cfg(not(target_os = "windows"))]
        {
            // Preserve the existing native permission-repair flow outside the core.
            fn shell_quote(value: &str) -> String {
                format!("'{}'", value.replace('\'', "'\\''"))
            }
            let user = std::env::var("USER").unwrap_or_default();
            let script = format!(
                "mkdir -p {} && chown -R {} {}",
                shell_quote(&target.to_string_lossy()),
                shell_quote(&user),
                shell_quote(&ownership_root.to_string_lossy())
            );
            let applescript = format!(
                "do shell script \"{}\" with administrator privileges",
                script.replace('\\', "\\\\").replace('"', "\\\"")
            );
            let output = std::process::Command::new("osascript")
                .args(["-e", &applescript])
                .output()
                .map_err(|e| format!("Failed to repair directory permissions: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "Failed to create {}: {}",
                    target.display(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
            let test = target.join(format!(".prism-write-test-{}", std::process::id()));
            std::fs::write(&test, b"test").map_err(|e| e.to_string())?;
            std::fs::remove_file(test).map_err(|e| e.to_string())
        }
        #[cfg(target_os = "windows")]
        {
            let _ = ownership_root;
            Err(format!(
                "Cannot create {}. Check its permissions.",
                target.display()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installer_routing_preserves_window_and_app_audiences() {
        assert!(window_scoped(&BackendEvent::UvInstallOutput("line".into())));
        assert!(window_scoped(&BackendEvent::UvInstallComplete(true)));
        assert!(!window_scoped(&BackendEvent::SkillsInstallLog(
            "line".into()
        )));
        assert!(!window_scoped(&BackendEvent::Agent(serde_json::json!({}))));
        assert!(!window_scoped(&BackendEvent::ProjectReview {
            project_id: "id".into()
        }));
    }
}
