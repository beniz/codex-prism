//! Project identity and filesystem boundary, independent of the desktop transport.
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub root: PathBuf,
    pub name: String,
}
#[derive(Default)]
pub(crate) struct Projects(pub Mutex<()>);
pub(crate) fn data_dir(app: &crate::Backend) -> Result<PathBuf, String> {
    let dir = app.inner.config.data_dir.clone();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
pub(crate) fn save_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}
fn registry(app: &crate::Backend) -> Result<Vec<Project>, String> {
    let p = data_dir(app)?.join("projects.json");
    if !p.exists() {
        return Ok(vec![]);
    }
    serde_json::from_slice(&fs::read(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
pub(crate) fn get(app: &crate::Backend, id: &str) -> Result<Project, String> {
    registry(app)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("Unknown project".into())
}
pub(crate) fn project_register(app: crate::Backend, root: String) -> Result<Project, String> {
    let state = &app.inner.projects;
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Project must be a directory".into());
    }
    let mut projects = registry(&app)?;
    if let Some(p) = projects.iter().find(|p| p.root == root) {
        return Ok(p.clone());
    }
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name: root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        root,
    };
    projects.push(project.clone());
    save_json(&data_dir(&app)?.join("projects.json"), &projects)?;
    Ok(project)
}
pub(crate) fn project_relocate(
    app: crate::Backend,
    project_id: String,
    root: String,
) -> Result<Project, String> {
    let state = &app.inner.projects;
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    crate::codex::assert_unlocked(&app, &project_id)?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Project must be a directory".into());
    }
    let mut all = registry(&app)?;
    if all.iter().any(|p| p.id != project_id && p.root == root) {
        return Err("Directory already registered".into());
    }
    let p = all
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or("Unknown project")?;
    p.root = root;
    p.name = p
        .root
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into();
    let result = p.clone();
    save_json(&data_dir(&app)?.join("projects.json"), &all)?;
    Ok(result)
}
pub(crate) fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.contains('\\')
        || relative.contains(':')
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Expected a project-relative path".into());
    }
    // macOS exposes temporary directories through /var -> /private/var. Compare
    // canonical paths on both sides while still rejecting symlinks within a project.
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let path = root.join(relative);
    let mut component_path = root.to_path_buf();
    for component in Path::new(relative).components() {
        component_path.push(component);
        if fs::symlink_metadata(&component_path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("Symlink operations are not supported".into());
        }
    }
    let mut ancestor = path.clone();
    while !ancestor.exists() {
        if !ancestor.pop() {
            return Err("Invalid path".into());
        }
    }
    let actual = fs::canonicalize(&ancestor).map_err(|e| e.to_string())?;
    if !actual.starts_with(&root) {
        return Err("Path escapes project directory".into());
    }
    // A dangling symlink must not become a write-through escape.
    if fs::symlink_metadata(&path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("Symlink operations are not supported".into());
    }
    Ok(path)
}
pub(crate) fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha1::digest(bytes))
}
pub(crate) fn project_read(
    app: crate::Backend,
    project_id: String,
    path: String,
) -> Result<serde_json::Value, String> {
    let p = get(&app, &project_id)?;
    let bytes = fs::read(resolve(&p.root, &path)?).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"revision":revision(&bytes),"bytes":bytes}))
}
pub(crate) fn project_write(
    app: crate::Backend,
    project_id: String,
    path: String,
    bytes: Vec<u8>,
    expected_revision: Option<String>,
) -> Result<String, String> {
    let state = &app.inner.projects;
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    crate::codex::assert_unlocked(&app, &project_id)?;
    let p = get(&app, &project_id)?;
    let target = resolve(&p.root, &path)?;
    write_checked(&target, &bytes, expected_revision.as_deref())
}
fn write_checked(
    target: &Path,
    bytes: &[u8],
    expected_revision: Option<&str>,
) -> Result<String, String> {
    let actual = match fs::read(target) {
        Ok(bytes) => Some(revision(&bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if actual.as_deref() != expected_revision {
        return Err("File changed on disk. Reload before saving.".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(target, bytes).map_err(|e| e.to_string())?;
    Ok(revision(bytes))
}
// Review captures source and assets, never build/environment/internal directories.
pub(crate) fn snapshot(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let ft = entry.file_type().map_err(|e| e.to_string())?;
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if name.starts_with('.')
                    || ["node_modules", "venv", "env", "__pycache__", "target"]
                        .contains(&name.as_str())
                {
                    continue;
                }
                walk(root, &path, out)?;
            } else if ft.is_file() {
                let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("");
                if [
                    "aux",
                    "log",
                    "out",
                    "toc",
                    "lof",
                    "lot",
                    "fls",
                    "fdb_latexmk",
                    "synctex",
                    "blg",
                    "bbl",
                    "bcf",
                    "pyc",
                ]
                .contains(&ext)
                {
                    continue;
                }
                let rel = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, fs::read(path).map_err(|e| e.to_string())?);
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out)?;
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revisions_refuse_stale_saves_and_accidental_overwrites() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("main.tex");
        let original = write_checked(&file, b"original", None).unwrap();
        assert!(write_checked(&file, b"overwrite", None).is_err());
        fs::write(&file, b"external").unwrap();
        assert!(write_checked(&file, b"stale", Some(&original)).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"external");
        write_checked(&file, b"accepted", Some(&revision(b"external"))).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn dangling_parent_symlinks_are_rejected() {
        let d = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(d.path().join("missing"), d.path().join("link")).unwrap();
        assert!(resolve(d.path(), "link/new.tex").is_err());
    }
    #[test]
    fn paths_are_scoped() {
        let d = tempfile::tempdir().unwrap();
        assert!(resolve(d.path(), "../secret").is_err());
        assert!(resolve(d.path(), "/etc/passwd").is_err());
        assert!(resolve(d.path(), "a/b.tex").is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn project_roots_under_an_aliased_parent_are_scoped_canonically() {
        let d = tempfile::tempdir().unwrap();
        let real = d.path().join("real");
        fs::create_dir_all(real.join("project")).unwrap();
        let alias = d.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let root = alias.join("project");
        assert_eq!(
            resolve(&root, "new.tex").unwrap(),
            fs::canonicalize(real.join("project"))
                .unwrap()
                .join("new.tex")
        );
        assert!(resolve(&root, "../outside.tex").is_err());
        std::os::unix::fs::symlink(d.path(), root.join("escape")).unwrap();
        assert!(resolve(&root, "escape/outside.tex").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_escape() {
        let d = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/tmp", d.path().join("escape")).unwrap();
        assert!(resolve(d.path(), "escape/new").is_err());
    }
    #[test]
    fn snapshots_include_assets_not_environment() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("a.tex"), "x").unwrap();
        fs::create_dir(d.path().join(".venv")).unwrap();
        fs::write(d.path().join(".venv/x"), "x").unwrap();
        assert_eq!(snapshot(d.path()).unwrap().len(), 1);
    }
}

pub(crate) fn project_mutate(
    app: crate::Backend,
    project_id: String,
    path: String,
    action: String,
    destination: Option<String>,
) -> Result<(), String> {
    let state = &app.inner.projects;
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    crate::codex::assert_unlocked(&app, &project_id)?;
    let p = get(&app, &project_id)?;
    let target = resolve(&p.root, &path)?;
    if path.is_empty() {
        return Err("Cannot mutate project root through file operations".into());
    }
    match action.as_str() {
        "mkdir" => fs::create_dir_all(target).map_err(|e| e.to_string()),
        "delete" => {
            if target.is_dir() {
                fs::remove_dir_all(target).map_err(|e| e.to_string())
            } else {
                fs::remove_file(target).map_err(|e| e.to_string())
            }
        }
        "rename" => {
            let dest = resolve(&p.root, &destination.ok_or("Missing destination")?)?;
            if dest.exists() {
                return Err("Destination exists".into());
            }
            fs::rename(target, dest).map_err(|e| e.to_string())
        }
        _ => Err("Unknown file operation".into()),
    }
}
pub(crate) fn project_list(
    app: crate::Backend,
    project_id: String,
) -> Result<serde_json::Value, String> {
    let p = get(&app, &project_id)?;
    fn walk(
        root: &Path,
        dir: &Path,
        files: &mut Vec<serde_json::Value>,
        folders: &mut Vec<String>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let e = entry.map_err(|e| e.to_string())?;
            let ft = e.file_type().map_err(|e| e.to_string())?;
            if ft.is_symlink() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let path = e.path();
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if ft.is_dir() {
                if name.starts_with('.')
                    || ["node_modules", "venv", "env", "__pycache__", "target"]
                        .contains(&name.as_str())
                {
                    continue;
                }
                folders.push(rel);
                walk(root, &path, files, folders)?
            } else if ft.is_file() {
                files.push(serde_json::json!({"path":rel,"size":e.metadata().map_err(|e|e.to_string())?.len()}));
            }
        }
        Ok(())
    }
    let mut files = vec![];
    let mut folders = vec![];
    walk(&p.root, &p.root, &mut files, &mut folders)?;
    Ok(serde_json::json!({"files":files,"folders":folders}))
}
pub(crate) fn project_rename(
    app: crate::Backend,
    project_id: String,
    name: String,
) -> Result<Project, String> {
    let state = &app.inner.projects;
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    crate::codex::assert_unlocked(&app, &project_id)?;
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':']) {
        return Err("Invalid directory name".into());
    }
    let mut all = registry(&app)?;
    let p = all
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or("Unknown project")?;
    let old = p.root.clone();
    let target = old
        .parent()
        .ok_or("Cannot rename filesystem root")?
        .join(&name);
    if target.exists() {
        return Err("Destination exists".into());
    }
    fs::rename(&old, &target).map_err(|e| e.to_string())?;
    p.root = target.clone();
    p.name = name;
    let result = p.clone();
    if let Err(e) = save_json(&data_dir(&app)?.join("projects.json"), &all) {
        let _ = fs::rename(target, old);
        return Err(e);
    }
    Ok(result)
}
