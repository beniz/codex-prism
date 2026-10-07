use std::path::{Path, PathBuf};
use tauri::{Emitter, WebviewWindow};
use tokio::io::{AsyncBufReadExt, BufReader};

/// Windows CREATE_NO_WINDOW flag to prevent console windows from flashing
/// when spawning child processes (e.g. uv, powershell, python).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ─── Binary Discovery ───

/// Discover the uv binary on the system.
/// Checks: which → cargo bin → standard paths → bare fallback.
fn find_uv_binary() -> Result<String, String> {
    // 1. Try to find uv on PATH
    if let Ok(path) = which::which("uv") {
        return Ok(path.to_string_lossy().to_string());
    }

    // 2. Check user-specific paths
    if let Some(home) = dirs::home_dir() {
        #[cfg(not(target_os = "windows"))]
        let user_paths = vec![
            home.join(".cargo").join("bin").join("uv"),
            home.join(".local").join("bin").join("uv"),
        ];
        #[cfg(target_os = "windows")]
        let user_paths = vec![
            // uv's default install location (same as Codex)
            home.join(".local").join("bin").join("uv.exe"),
            home.join(".cargo").join("bin").join("uv.exe"),
            // %LOCALAPPDATA%\uv\bin\uv.exe
            PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
                home.join("AppData")
                    .join("Local")
                    .to_string_lossy()
                    .to_string()
            }))
            .join("uv")
            .join("bin")
            .join("uv.exe"),
        ];

        for path in &user_paths {
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    // 3. Check standard paths (Unix only)
    #[cfg(not(target_os = "windows"))]
    {
        let standard_paths = ["/usr/local/bin/uv", "/opt/homebrew/bin/uv", "/usr/bin/uv"];
        for path in &standard_paths {
            if PathBuf::from(path).exists() {
                return Ok(path.to_string());
            }
        }
    }

    // 4. Bare fallback — hope it's in PATH
    Ok("uv".to_string())
}

// ─── Status Types ───

#[derive(serde::Serialize)]
pub struct UvStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
}

#[derive(serde::Serialize)]
pub struct VenvInfo {
    pub venv_path: String,
    pub python_path: String,
    pub created: bool,
}

// ─── Helper: build PATH with venv bin prepended ───

fn venv_bin_dir(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(not(target_os = "windows"))]
    {
        venv_dir.join("bin")
    }
    #[cfg(target_os = "windows")]
    {
        venv_dir.join("Scripts")
    }
}

fn venv_python(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(not(target_os = "windows"))]
    {
        venv_bin_dir(venv_dir).join("python")
    }
    #[cfg(target_os = "windows")]
    {
        venv_bin_dir(venv_dir).join("python.exe")
    }
}

fn venv_pip(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(not(target_os = "windows"))]
    {
        venv_bin_dir(venv_dir).join("pip")
    }
    #[cfg(target_os = "windows")]
    {
        venv_bin_dir(venv_dir).join("pip.exe")
    }
}

fn venv_pip_shim(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(not(target_os = "windows"))]
    {
        venv_bin_dir(venv_dir).join("pip")
    }
    #[cfg(target_os = "windows")]
    {
        venv_bin_dir(venv_dir).join("pip.cmd")
    }
}

fn path_with_venv(venv_dir: &std::path::Path) -> String {
    let bin = venv_bin_dir(venv_dir);
    let current = std::env::var("PATH").unwrap_or_default();
    #[cfg(target_os = "windows")]
    let sep = ";";
    #[cfg(not(target_os = "windows"))]
    let sep = ":";
    format!("{}{}{}", bin.to_string_lossy(), sep, current)
}

fn write_pip_shim(venv_dir: &Path) -> Result<(), String> {
    let uv_bin = find_uv_binary().unwrap_or_else(|_| "uv".to_string());
    let shim_path = venv_pip_shim(venv_dir);

    #[cfg(target_os = "windows")]
    {
        let content = format!(
            "@echo off\r\nset \"VIRTUAL_ENV={}\"\r\n\"{}\" pip %*\r\n",
            venv_dir.to_string_lossy(),
            uv_bin
        );
        std::fs::write(&shim_path, &content)
            .map_err(|e| format!("Failed to create pip shim: {}", e))?;
        let pip3_path = venv_bin_dir(venv_dir).join("pip3.cmd");
        let _ = std::fs::write(pip3_path, content);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let content = format!(
            "#!/bin/sh\nVIRTUAL_ENV=\"{}\" exec \"{}\" pip \"$@\"\n",
            venv_dir.to_string_lossy(),
            uv_bin
        );
        std::fs::write(&shim_path, content)
            .map_err(|e| format!("Failed to create pip shim: {}", e))?;
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&shim_path)
            .map_err(|e| format!("Failed to stat pip shim: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&shim_path, perms)
            .map_err(|e| format!("Failed to mark pip shim executable: {}", e))?;
    }

    Ok(())
}

async fn ensure_venv_pip(venv_dir: &Path) -> Result<(), String> {
    if venv_pip(venv_dir).exists() || venv_pip_shim(venv_dir).exists() {
        return Ok(());
    }

    let python = venv_python(venv_dir);
    if !python.exists() {
        return Err(format!(
            "Project .venv is missing Python at {}",
            python.display()
        ));
    }

    let mut ensure_cmd = tokio::process::Command::new(&python);
    ensure_cmd.args(["-m", "ensurepip", "--upgrade"]);
    ensure_cmd.env("VIRTUAL_ENV", venv_dir);
    ensure_cmd.env("PATH", path_with_venv(venv_dir));
    ensure_cmd.env("PYTHONNOUSERSITE", "1");
    #[cfg(target_os = "windows")]
    {
        ensure_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match ensure_cmd.output().await {
        Ok(output) if output.status.success() && venv_pip(venv_dir).exists() => Ok(()),
        _ => write_pip_shim(venv_dir),
    }
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn check_uv_status() -> Result<UvStatus, String> {
    let binary_path = match find_uv_binary() {
        Ok(path) => path,
        Err(_) => {
            return Ok(UvStatus {
                installed: false,
                binary_path: None,
                version: None,
            });
        }
    };

    // Verify binary actually works by running --version
    let mut version_cmd = std::process::Command::new(&binary_path);
    version_cmd.arg("--version");
    #[cfg(target_os = "windows")]
    {
        version_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let version_output = version_cmd.output();

    let version = match version_output {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        _ => {
            return Ok(UvStatus {
                installed: false,
                binary_path: None,
                version: None,
            });
        }
    };

    Ok(UvStatus {
        installed: true,
        binary_path: Some(binary_path),
        version,
    })
}

#[tauri::command]
pub async fn install_uv(window: WebviewWindow) -> Result<(), String> {
    // Ensure ~/.local/bin exists — uv installs its binary there.
    // If ~/.local is owned by root (e.g. created by pip), prompt for admin password.
    #[cfg(not(target_os = "windows"))]
    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local").join("bin");
        if std::fs::create_dir_all(&local_bin).is_err() {
            let user = std::env::var("USER").unwrap_or_default();
            let local_dir = home.join(".local");
            let script = format!(
                "mkdir -p '{}' && chown -R {} '{}'",
                local_bin.display(),
                user,
                local_dir.display()
            );
            let output = std::process::Command::new("osascript")
                .args([
                    "-e",
                    &format!(
                        "do shell script \"{}\" with administrator privileges",
                        script
                    ),
                ])
                .output()
                .map_err(|e| format!("Failed to fix permissions for ~/.local: {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "Failed to create ~/.local/bin: {}. \
                     Please run: sudo chown -R $(whoami) ~/.local",
                    stderr.trim()
                ));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell");
        c.creation_flags(CREATE_NO_WINDOW);
        c.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://astral.sh/uv/install.ps1 | iex",
        ]);
        c
    };

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run uv installer: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    // Stream stdout
    let win_stdout = window.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stdout.emit("uv-install-output", &line);
        }
    });

    // Stream stderr
    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stderr.emit("uv-install-output", &line);
        }
    });

    // Wait for completion
    let win_complete = window;
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let success = match child.wait().await {
            Ok(status) => status.success(),
            Err(_) => false,
        };

        let _ = win_complete.emit("uv-install-complete", success);
    });

    Ok(())
}

#[tauri::command]
pub async fn setup_project_venv(project_path: String) -> Result<VenvInfo, String> {
    let project = std::path::Path::new(&project_path);
    let venv_dir = project.join(".venv");

    // If venv already exists, just return info
    if venv_dir.exists() {
        ensure_venv_pip(&venv_dir).await?;
        let python = venv_python(&venv_dir);
        return Ok(VenvInfo {
            venv_path: venv_dir.to_string_lossy().to_string(),
            python_path: python.to_string_lossy().to_string(),
            created: false,
        });
    }

    let uv_bin = find_uv_binary().map_err(|e| format!("uv not found: {}", e))?;

    // Create venv: uv venv <project_path>/.venv
    let mut venv_cmd = tokio::process::Command::new(&uv_bin);
    let venv_arg = venv_dir.to_string_lossy().to_string();
    venv_cmd.args(["venv", "--seed", venv_arg.as_str()]);
    venv_cmd.current_dir(project);
    #[cfg(target_os = "windows")]
    {
        venv_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = venv_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to create venv: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("uv venv failed: {}", stderr));
    }

    let python = venv_python(&venv_dir);
    ensure_venv_pip(&venv_dir).await?;

    Ok(VenvInfo {
        venv_path: venv_dir.to_string_lossy().to_string(),
        python_path: python.to_string_lossy().to_string(),
        created: true,
    })
}

pub fn project_venv_status(project_path: String) -> Option<VenvInfo> {
    let venv_dir = std::path::Path::new(&project_path).join(".venv");
    let python = venv_python(&venv_dir);
    python.is_file().then(|| VenvInfo {
        venv_path: venv_dir.to_string_lossy().to_string(),
        python_path: python.to_string_lossy().to_string(),
        created: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inspecting_environment_never_creates_or_repairs_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        assert!(project_venv_status(root.clone()).is_none());
        assert!(!dir.path().join(".venv").exists());
        let python = venv_python(&dir.path().join(".venv"));
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "existing interpreter").unwrap();
        assert!(project_venv_status(root).is_some());
        assert_eq!(
            std::fs::read_to_string(python).unwrap(),
            "existing interpreter"
        );
    }
}
