use std::path::Path;
#[derive(serde::Serialize)]
pub struct ProjectCandidate {
    pub path: String,
    pub name: String,
    pub last_modified: u64,
    pub has_main_tex: bool,
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn has_tex_file(dir: &Path) -> bool {
    if dir.join("main.tex").is_file() || dir.join("document.tex").is_file() {
        return true;
    }

    std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .any(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return false;
            }
            matches!(
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.to_ascii_lowercase())
                    .as_deref(),
                Some("tex" | "ltx")
            )
        })
}

fn project_modified_ms(dir: &Path) -> u64 {
    let mut latest = modified_ms(dir);
    for relative in [
        "main.tex",
        "document.tex",
        ".prism/build/main.pdf",
        ".claudeprism/history.git/.git/refs/heads/master",
    ] {
        latest = latest.max(modified_ms(&dir.join(relative)));
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                latest = latest.max(modified_ms(&path));
            }
        }
    }

    latest
}

pub(crate) fn list_default_projects(app: crate::Backend) -> Result<Vec<ProjectCandidate>, String> {
    let home = &app.inner.config.home_dir;

    let mut projects = Vec::new();
    // Continue discovering projects created under the previous display name.
    for folder in ["codex-prism", "Codex-Prism"] {
        let base = home.join("Documents").join(folder);
        if !base.is_dir() {
            continue;
        }
        let entries = std::fs::read_dir(&base)
            .map_err(|e| format!("Failed to read default project directory: {}", e))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !has_tex_file(&path) {
                continue;
            }

            projects.push(ProjectCandidate {
                path: path.to_string_lossy().to_string(),
                name,
                last_modified: project_modified_ms(&path),
                has_main_tex: path.join("main.tex").is_file()
                    || path.join("document.tex").is_file(),
            });
        }
    }
    projects.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(projects)
}
