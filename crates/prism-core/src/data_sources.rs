use crate::{projects, Backend};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Source {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileImport {
    pub path: String,
    pub destination: String,
}
#[derive(Default)]
struct ImportRollback {
    files: Vec<std::path::PathBuf>,
    committed: bool,
}
impl Drop for ImportRollback {
    fn drop(&mut self) {
        if !self.committed {
            for file in &self.files {
                let _ = fs::remove_file(file);
            }
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_imports: Vec<FileImport>,
    #[serde(default)]
    pub completion_aliases: BTreeMap<String, String>,
    pub revision: u64,
    #[serde(default)]
    pub file_sources_migrated: bool,
    pub instructions: String,
    pub sources: Vec<Source>,
    #[serde(default)]
    pub connections: Vec<crate::remote_sources::SshConnection>,
}
fn validate_file_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.split('/').any(|part| {
            [
                ".git",
                ".prism",
                ".codexprism",
                ".claudeprism",
                ".venv",
                "venv",
                "env",
                "node_modules",
                "target",
                "__pycache__",
            ]
            .contains(&part)
                || part == ".env"
                || part.starts_with(".env.")
        })
    {
        return Err(
            "Choose a document file outside metadata, build and environment directories".into(),
        );
    }
    Ok(())
}
pub(crate) fn settings(
    app: &Backend,
    id: &str,
    update: Option<Settings>,
) -> Result<Settings, String> {
    let project = projects::get(app, id)?;
    let _guard = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let path = projects::data_dir(app)?.join("project-settings.json");
    let mut all: BTreeMap<String, Settings> = match fs::read(&path) {
        Ok(b) => {
            serde_json::from_slice(&b).map_err(|e| format!("Cannot read project settings: {e}"))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e.to_string()),
    };
    let mut current = all.get(id).cloned().unwrap_or_default();
    if !all.contains_key(id) {
        match fs::read(projects::data_dir(app)?.join("project-instructions.json")) {
            Ok(b) => {
                let old: BTreeMap<String, String> =
                    serde_json::from_slice(&b).map_err(|e| e.to_string())?;
                current.instructions = old.get(id).cloned().unwrap_or_default();
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    for source in &mut current.sources {
        if source.kind.is_empty() {
            source.kind = if source.connection_id.is_some() {
                "remoteDirectory"
            } else {
                "directory"
            }
            .into();
        }
    }
    if !current.file_sources_migrated {
        fn discover(
            root: &Path,
            directory: &Path,
            sources: &mut Vec<Source>,
        ) -> Result<(), String> {
            match fs::symlink_metadata(directory) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(e.to_string()),
                Ok(meta) if meta.file_type().is_symlink() => return Ok(()),
                Ok(_) => {}
            }
            for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                if kind.is_dir() {
                    discover(root, &entry.path(), sources)?;
                } else if kind.is_file() {
                    let relative = entry
                        .path()
                        .strip_prefix(root)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/");
                    if validate_file_path(&relative).is_err() {
                        continue;
                    }
                    if !sources
                        .iter()
                        .any(|s| s.kind == "file" && s.path == relative)
                    {
                        sources.push(Source {
                            id: uuid::Uuid::new_v4().to_string(),
                            name: entry.file_name().to_string_lossy().into(),
                            path: relative,
                            kind: "file".into(),
                            connection_id: None,
                        });
                    }
                }
            }
            Ok(())
        }
        discover(
            &project.root,
            &project.root.join("attachments"),
            &mut current.sources,
        )?;
        current.file_sources_migrated = true;
        current.revision += 1;
        all.insert(id.into(), current.clone());
        projects::save_json(&path, &all)?;
    }
    let old_aliases = current.completion_aliases.clone();
    crate::source_completion::assign_aliases(&mut current);
    if current.completion_aliases != old_aliases {
        all.insert(id.into(), current.clone());
        projects::save_json(&path, &all)?;
    }
    if let Some(mut next) = update {
        if next.revision != current.revision {
            return Err("Project settings changed; reopen the dialog and retry".into());
        }
        let root = fs::canonicalize(project.root).map_err(|e| e.to_string())?;
        let managed = projects::data_dir(app)?;
        let managed = fs::canonicalize(&managed).unwrap_or(managed);
        let mut rollback = ImportRollback::default();
        if !next.pending_imports.is_empty() {
            crate::codex::assert_unlocked(app, id)?;
        }
        for import in std::mem::take(&mut next.pending_imports) {
            let source = fs::canonicalize(&import.path).map_err(|e| e.to_string())?;
            if !source.is_file() {
                return Err("Select a regular file".into());
            }
            let relative = if let Ok(relative) = source.strip_prefix(&root) {
                relative.to_string_lossy().replace('\\', "/")
            } else {
                validate_file_path(&import.destination)?;
                let requested = projects::resolve(&root, &import.destination)?;
                let parent = requested.parent().ok_or("Invalid import destination")?;
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                let stem = requested
                    .file_stem()
                    .ok_or("Invalid filename")?
                    .to_string_lossy();
                let extension = requested
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_default();
                let mut count = 0;
                loop {
                    let target = if count == 0 {
                        requested.clone()
                    } else {
                        parent.join(format!("{stem}-{count}{extension}"))
                    };
                    match fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&target)
                    {
                        Ok(mut output) => {
                            rollback.files.push(target.clone());
                            let mut input = fs::File::open(&source).map_err(|e| e.to_string())?;
                            std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
                            output.sync_all().map_err(|e| e.to_string())?;
                            break target
                                .strip_prefix(&root)
                                .map_err(|e| e.to_string())?
                                .to_string_lossy()
                                .replace('\\', "/");
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                            count += 1;
                        }
                        Err(e) => return Err(e.to_string()),
                    }
                }
            };
            validate_file_path(&relative)?;
            if !next
                .sources
                .iter()
                .any(|s| s.kind == "file" && s.path == relative)
            {
                next.sources.push(Source {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: source
                        .file_name()
                        .ok_or("Invalid filename")?
                        .to_string_lossy()
                        .into(),
                    path: relative,
                    kind: "file".into(),
                    connection_id: None,
                });
            }
        }
        let mut connection_ids = BTreeSet::new();
        for connection in &next.connections {
            connection.validate()?;
            if !connection_ids.insert(connection.id.clone()) {
                return Err("Duplicate SSH connection".into());
            }
        }
        let mut paths = BTreeSet::new();
        let mut ids = BTreeSet::new();
        for source in &mut next.sources {
            uuid::Uuid::parse_str(&source.id).map_err(|_| "Invalid source ID")?;
            if !ids.insert(source.id.clone()) || source.name.trim().is_empty() {
                return Err("Invalid or duplicate source".into());
            }
            source.name = source.name.trim().to_owned();
            if source.kind.is_empty() {
                source.kind = if source.connection_id.is_some() {
                    "remoteDirectory"
                } else {
                    "directory"
                }
                .into();
            }
            if source.kind == "file" {
                if source.connection_id.is_some() {
                    return Err("File sources must belong to the project".into());
                }
                validate_file_path(&source.path)?;
                let file = projects::resolve(&root, &source.path)?;
                let existing = current
                    .sources
                    .iter()
                    .any(|s| s.id == source.id && s.kind == "file" && s.path == source.path);
                if !existing && !file.is_file() {
                    return Err("File source must be an existing project file".into());
                }
                if !paths.insert(format!("file:{}", source.path)) {
                    return Err("Duplicate file source".into());
                }
                continue;
            }
            if source.kind
                != if source.connection_id.is_some() {
                    "remoteDirectory"
                } else {
                    "directory"
                }
            {
                return Err("Invalid source kind".into());
            }

            if let Some(connection) = &source.connection_id {
                if !connection_ids.contains(connection)
                    || !crate::remote_sources::unix_path(&source.path)
                {
                    return Err("Choose an SSH connection and an absolute remote directory".into());
                }
                source.path = source.path.trim_end_matches('/').to_owned();
                if source.path.is_empty() {
                    return Err(
                        "Choose a specific remote data directory, not the filesystem root".into(),
                    );
                }
                if !paths.insert(format!("ssh:{connection}:{}", source.path)) {
                    return Err("This remote directory is already registered".into());
                }
                continue;
            }
            let original = Path::new(&source.path);
            if !original.is_absolute() {
                return Err("Data source must be an absolute directory path".into());
            }
            let existing = current
                .sources
                .iter()
                .any(|s| s.id == source.id && s.path == source.path && s.connection_id.is_none());
            if !existing {
                fs::read_dir(original).map_err(|e| format!("Cannot read data source: {e}"))?;
            }
            let resolved = fs::canonicalize(original).unwrap_or_else(|_| original.to_path_buf());
            if resolved.starts_with(&root)
                || resolved.starts_with(&managed)
                || managed.starts_with(&resolved)
            {
                return Err(
                    "Choose a directory outside the document and Prism application data".into(),
                );
            }
            let identity = resolved.to_string_lossy().to_string();
            #[cfg(windows)]
            let identity = identity.to_lowercase();
            if !paths.insert(identity) {
                return Err("This directory is already registered".into());
            }
            source.path = resolved.to_string_lossy().to_string();
            source.name = source.name.trim().to_owned();
        }
        next.completion_aliases = current.completion_aliases.clone();
        crate::source_completion::assign_aliases(&mut next);
        next.file_sources_migrated = true;
        next.revision += 1;
        all.insert(id.into(), next.clone());
        projects::save_json(&path, &all)?;
        rollback.committed = true;
        current = next;
    }
    Ok(current)
}
static CHECKS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
pub(crate) async fn status(
    sources: Vec<Source>,
    connections: &[crate::remote_sources::SshConnection],
) -> Vec<serde_json::Value> {
    let mut result = Vec::new();
    for source in sources {
        let path = source.path.clone();
        let Ok(permit) = CHECKS.try_acquire() else {
            result.push(serde_json::json!({"id":source.id,"reachable":false,"error":"Directory checks are busy; refresh to retry"}));
            continue;
        };
        if let Some(id) = &source.connection_id {
            let error = match connections.iter().find(|c| &c.id == id) {
                Some(c) => crate::remote_sources::check(c, &path).await.err(),
                None => Some("SSH connection no longer exists".into()),
            };
            result.push(
                serde_json::json!({"id":source.id,"reachable":error.is_none(),"error":error}),
            );
            continue;
        }
        let check = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if source.kind == "file" {
                fs::File::open(path)
                    .and_then(|f| {
                        if f.metadata()?.is_file() {
                            Ok(())
                        } else {
                            Err(std::io::Error::other("Source is not a regular file"))
                        }
                    })
                    .map_err(|e| e.to_string())
            } else {
                fs::read_dir(path).map(|_| ()).map_err(|e| e.to_string())
            }
        });
        let error = match tokio::time::timeout(std::time::Duration::from_secs(5), check).await {
            Ok(Ok(Ok(()))) => None,
            Ok(Ok(Err(e))) => Some(e),
            Ok(Err(e)) => Some(e.to_string()),
            Err(_) => Some("Directory check timed out".into()),
        };
        result.push(serde_json::json!({"id":source.id,"reachable":error.is_none(),"error":error}));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn settings_preserve_sources_and_reject_stale_updates() {
        let temp = tempfile::tempdir().unwrap();
        let app = Backend::new(
            crate::BackendConfig {
                data_dir: temp.path().join("data"),
                home_dir: temp.path().join("home"),
                temp_dir: temp.path().join("tmp"),
            },
            std::sync::Arc::new(crate::NoopEventSink),
        )
        .unwrap();
        let root = temp.path().join("document");
        fs::create_dir(&root).unwrap();
        let directory = temp.path().join("reference data");
        fs::create_dir(&directory).unwrap();
        let project =
            projects::project_register(app.clone(), root.to_string_lossy().into()).unwrap();
        projects::instructions(&app, &project.id, Some("Existing guidance")).unwrap();
        let mut draft = settings(&app, &project.id, None).unwrap();
        assert_eq!(draft.instructions, "Existing guidance");
        draft.sources.push(Source {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Research".into(),
            path: directory.to_string_lossy().into(),
            connection_id: None,
            kind: "directory".into(),
        });
        let saved = settings(&app, &project.id, Some(draft.clone())).unwrap();
        assert!(settings(&app, &project.id, Some(draft)).is_err());
        assert_eq!(
            status(saved.sources.clone(), &[]).await[0]["reachable"],
            true
        );
        projects::instructions(&app, &project.id, Some("Changed guidance")).unwrap();
        let current = settings(&app, &project.id, None).unwrap();
        assert_eq!(current.sources.len(), 1);
        fs::remove_dir(&directory).unwrap();
        assert_eq!(
            status(current.sources.clone(), &[]).await[0]["reachable"],
            false
        );
        let mut updated = settings(&app, &project.id, Some(current)).unwrap();
        updated.sources.clear();
        assert!(settings(&app, &project.id, Some(updated))
            .unwrap()
            .sources
            .is_empty());
        assert!(!root.join("project-settings.json").exists());
    }
    #[test]
    fn remote_settings_migrate_and_reject_missing_connections() {
        let old: Settings = serde_json::from_value(
            serde_json::json!({"revision":0,"instructions":"guidance","sources":[]}),
        )
        .unwrap();
        assert!(old.connections.is_empty());
        let (temp, app) = crate::test_backend();
        let root = temp.path().join("document");
        fs::create_dir(&root).unwrap();
        let project =
            projects::project_register(app.clone(), root.to_string_lossy().into()).unwrap();
        let connection = crate::remote_sources::SshConnection {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Remote".into(),
            host: "research-host".into(),
            executable: String::new(),
            socket: String::new(),
            port: None,
            token_file: String::new(),
        };
        let mut settings = super::settings(&app, &project.id, None).unwrap();
        settings.instructions = old.instructions;
        settings.sources.push(Source {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Data".into(),
            path: "/remote/data".into(),
            connection_id: Some(connection.id.clone()),
            kind: "remoteDirectory".into(),
        });
        assert!(super::settings(&app, &project.id, Some(settings.clone())).is_err());
        settings.connections.push(connection);
        let saved = super::settings(&app, &project.id, Some(settings)).unwrap();
        projects::instructions(&app, &project.id, Some("Updated prompt")).unwrap();
        let mut next = super::settings(&app, &project.id, None).unwrap();
        assert_eq!(next.connections.len(), 1);
        assert_eq!(next.sources[0].path, "/remote/data");
        next.connections.clear();
        assert!(super::settings(&app, &project.id, Some(next)).is_err());
        assert_eq!(saved.sources.len(), 1);
    }
    #[test]
    fn file_imports_migrate_rollback_and_unregister_without_deletion() {
        let (temp, app) = crate::test_backend();
        let root = temp.path().join("document");
        fs::create_dir_all(root.join("attachments/nested")).unwrap();
        fs::write(root.join("attachments/nested/old.txt"), "old").unwrap();
        let project =
            projects::project_register(app.clone(), root.to_string_lossy().into()).unwrap();
        let mut draft = settings(&app, &project.id, None).unwrap();
        assert_eq!(draft.sources.len(), 1);
        assert_eq!(draft.sources[0].kind, "file");
        draft.sources.clear();
        settings(&app, &project.id, Some(draft)).unwrap();
        let mut draft = settings(&app, &project.id, None).unwrap();
        assert!(draft.sources.is_empty());
        assert!(root.join("attachments/nested/old.txt").exists());
        let input = temp.path().join("input.txt");
        fs::write(&input, "new").unwrap();
        draft.pending_imports = vec![
            FileImport {
                path: input.to_string_lossy().into(),
                destination: "attachments/input.txt".into(),
            },
            FileImport {
                path: temp.path().join("missing").to_string_lossy().into(),
                destination: "attachments/missing".into(),
            },
        ];
        assert!(settings(&app, &project.id, Some(draft.clone())).is_err());
        assert!(!root.join("attachments/input.txt").exists());
        draft.pending_imports.pop();
        let saved = settings(&app, &project.id, Some(draft)).unwrap();
        assert_eq!(saved.sources[0].path, "attachments/input.txt");
        assert!(saved.pending_imports.is_empty());
        let mut draft = saved.clone();
        draft.pending_imports.push(FileImport {
            path: root.join("attachments/input.txt").to_string_lossy().into(),
            destination: "attachments/input.txt".into(),
        });
        let saved = settings(&app, &project.id, Some(draft)).unwrap();
        assert_eq!(saved.sources.len(), 1);
        assert!(!root.join("attachments/input-1.txt").exists());
        let mut stale = saved.clone();
        stale.revision -= 1;
        stale.pending_imports.push(FileImport {
            path: input.to_string_lossy().into(),
            destination: "attachments/stale.txt".into(),
        });
        assert!(settings(&app, &project.id, Some(stale)).is_err());
        assert!(!root.join("attachments/stale.txt").exists());
        crate::proposals::begin_for_chat(&app, &project.id, None, None, None).unwrap();
        let mut draft = saved;
        draft.pending_imports.push(FileImport {
            path: input.to_string_lossy().into(),
            destination: "attachments/locked.txt".into(),
        });
        assert!(settings(&app, &project.id, Some(draft)).is_err());
        assert!(!root.join("attachments/locked.txt").exists());
    }
}
