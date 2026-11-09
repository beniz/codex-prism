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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    pub revision: u64,
    pub instructions: String,
    pub sources: Vec<Source>,
    #[serde(default)]
    pub connections: Vec<crate::remote_sources::SshConnection>,
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
    if let Some(mut next) = update {
        if next.revision != current.revision {
            return Err("Project settings changed; reopen the dialog and retry".into());
        }
        let root = fs::canonicalize(project.root).map_err(|e| e.to_string())?;
        let managed = projects::data_dir(app)?;
        let managed = fs::canonicalize(&managed).unwrap_or(managed);
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
        next.revision += 1;
        all.insert(id.into(), next.clone());
        projects::save_json(&path, &all)?;
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
            fs::read_dir(path).map(|_| ()).map_err(|e| e.to_string())
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
        let mut settings = old;
        settings.sources.push(Source {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Data".into(),
            path: "/remote/data".into(),
            connection_id: Some(connection.id.clone()),
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
}
