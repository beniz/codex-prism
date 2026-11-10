//! Local template discovery and snapshots. Library folders are never registered as projects.
use crate::file_policy::Policy;
use crate::{projects, Backend};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Default)]
pub(crate) struct TemplateState {
    pub preview_lock: tokio::sync::Mutex<()>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub tags: Vec<String>,
    pub main_file: String,
    pub revision: String,
}
#[derive(Serialize)]
pub struct TemplateIssue {
    pub folder: String,
    pub message: String,
}
#[derive(Serialize)]
pub struct TemplateLibrary {
    pub root: PathBuf,
    pub templates: Vec<PrivateTemplate>,
    pub issues: Vec<TemplateIssue>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    name: Option<String>,
    description: Option<String>,
    category: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    main_file: Option<String>,
}
struct Snapshot {
    template: PrivateTemplate,
    files: BTreeMap<String, Vec<u8>>,
    directories: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateProject {
    pub project: projects::Project,
    pub main_file: String,
}

fn library_root(backend: &Backend) -> PathBuf {
    backend.inner.config.home_dir.join(".codexprism/templates")
}
fn relative(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains(['\\', ':'])
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("mainFile must be a relative .tex path inside the template".into());
    }
    Ok(())
}
fn walk(
    root: &Path,
    dir: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    directories: &mut Vec<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if Policy::Template.excludes_reserved_entry(&name) {
            continue;
        }
        let path = entry.path();
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err(format!("Symlinks are not supported: {}", path.display()));
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        relative(&rel)?;
        if kind.is_dir() {
            directories.push(rel);
            walk(root, &path, files, directories)?;
        } else if kind.is_file() {
            files.insert(
                rel,
                fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?,
            );
        } else {
            return Err(format!("Unsupported file: {}", path.display()));
        }
    }
    Ok(())
}
fn snapshot(backend: &Backend, id: &str) -> Result<Snapshot, String> {
    let folder = id
        .strip_prefix("private:")
        .ok_or("Unknown private template")?;
    if folder.is_empty() || Path::new(folder).components().count() != 1 {
        return Err("Unknown private template".into());
    }
    relative(folder)?;
    let root = library_root(backend).join(folder);
    let kind = fs::symlink_metadata(&root)
        .map_err(|e| format!("Template is unavailable: {e}"))?
        .file_type();
    if !kind.is_dir() || kind.is_symlink() {
        return Err("Template must be a directory, not a symlink".into());
    }
    let mut files = BTreeMap::new();
    let mut directories = Vec::new();
    walk(&root, &root, &mut files, &mut directories)?;
    directories.sort();
    let metadata: Metadata = match files.get("template.json") {
        Some(bytes) => {
            serde_json::from_slice(bytes).map_err(|e| format!("Invalid template.json: {e}"))?
        }
        None => Metadata::default(),
    };
    let tex_files: Vec<_> = files
        .keys()
        .filter(|p| p.to_lowercase().ends_with(".tex"))
        .cloned()
        .collect();
    let main_file = if let Some(main) = metadata.main_file {
        relative(&main)?;
        if !tex_files.contains(&main) {
            return Err("mainFile must name an existing .tex file".into());
        }
        main
    } else {
        let roots: Vec<_> = tex_files
            .iter()
            .filter(|p| {
                // Ignore comments before identifying a standalone LaTeX document.
                String::from_utf8_lossy(&files[*p]).lines().any(|line| {
                    let code = line.split('%').next().unwrap_or("");
                    code.match_indices("\\documentclass")
                        .any(|(index, command)| {
                            code[index + command.len()..]
                                .starts_with(|c: char| c.is_whitespace() || c == '{' || c == '[')
                        })
                })
            })
            .cloned()
            .collect();
        if roots.len() == 1 {
            roots[0].clone()
        } else if tex_files.len() == 1 {
            tex_files[0].clone()
        } else {
            return Err(if tex_files.is_empty() {
                "Add a .tex file to this folder"
            } else {
                "Several main documents found; set mainFile in template.json"
            }
            .into());
        }
    };
    let category = metadata.category.unwrap_or_else(|| "starter".into());
    if !["academic", "professional", "creative", "starter"].contains(&category.as_str()) {
        return Err("Unknown category in template.json".into());
    }
    let mut hash = Sha1::new();
    for (path, bytes) in &files {
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path);
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    for path in &directories {
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path);
    }
    let revision = format!("{:x}", hash.finalize());
    files.remove("template.json");
    Ok(Snapshot {
        template: PrivateTemplate {
            id: id.into(),
            name: metadata
                .name
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| folder.into()),
            description: metadata.description.unwrap_or_default(),
            category,
            tags: metadata.tags,
            main_file,
            revision,
        },
        files,
        directories,
    })
}
fn checked_snapshot(backend: &Backend, id: &str, revision: &str) -> Result<Snapshot, String> {
    let value = snapshot(backend, id)?;
    if value.template.revision != revision {
        return Err("Template changed. Refresh the template gallery and try again.".into());
    }
    Ok(value)
}
fn copy_snapshot(value: &Snapshot, target: &Path) -> Result<(), String> {
    for path in &value.directories {
        fs::create_dir_all(target.join(path)).map_err(|e| e.to_string())?;
    }
    for (path, bytes) in &value.files {
        let target = target.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(target, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(crate) fn list(backend: &Backend) -> Result<TemplateLibrary, String> {
    let root = library_root(backend);
    let mut result = TemplateLibrary {
        root: root.clone(),
        templates: vec![],
        issues: vec![],
    };
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let folder = entry.file_name().to_string_lossy().into_owned();
        if folder.starts_with('.') {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if !kind.is_dir() && !kind.is_symlink() {
            continue;
        }
        match snapshot(backend, &format!("private:{folder}")) {
            Ok(value) => result.templates.push(value.template),
            Err(message) => result.issues.push(TemplateIssue { folder, message }),
        }
    }
    result.templates.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    result.issues.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(result)
}
pub(crate) fn create_project(
    backend: &Backend,
    id: &str,
    revision: &str,
    destination: &str,
) -> Result<TemplateProject, String> {
    let value = checked_snapshot(backend, id, revision)?;
    let target = Path::new(destination);
    if !target.is_absolute()
        || target
            .components()
            .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("Destination must be an absolute project path".into());
    }
    let library = fs::canonicalize(library_root(backend)).map_err(|e| e.to_string())?;
    if target.starts_with(library_root(backend)) {
        return Err("Choose a destination outside the template library".into());
    }
    let parent = target.parent().ok_or("Invalid destination")?;
    let mut ancestor = parent;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("Invalid destination parent")?;
    }
    if fs::canonicalize(ancestor)
        .map_err(|e| e.to_string())?
        .starts_with(&library)
    {
        return Err("Choose a destination outside the template library".into());
    }
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if fs::canonicalize(parent)
        .map_err(|e| e.to_string())?
        .starts_with(library)
    {
        return Err("Choose a destination outside the template library".into());
    }
    fs::create_dir(target)
        .map_err(|e| format!("Cannot create project (destination must not exist): {e}"))?;
    let result = (|| {
        copy_snapshot(&value, target)?;
        checked_snapshot(backend, id, revision)?;
        let project = projects::project_register(backend.clone(), destination.into())?;
        Ok(TemplateProject {
            project,
            main_file: value.template.main_file.clone(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(target);
    }
    result
}

pub(crate) async fn preview(
    backend: Backend,
    id: String,
    revision: String,
    retry: bool,
) -> Result<Vec<u8>, String> {
    let mut cancel = backend.inner.cancel.subscribe();
    if *cancel.borrow() {
        return Err("Backend is shutting down".into());
    }
    let _lock = tokio::select! {
        lock = backend.inner.templates.preview_lock.lock() => lock,
        _ = cancel.changed() => return Err("Backend is shutting down".into()),
    };
    if *cancel.borrow() {
        return Err("Backend is shutting down".into());
    }
    let app = backend.clone();
    let template_id = id.clone();
    let version = revision.clone();
    let value = tokio::task::spawn_blocking(move || checked_snapshot(&app, &template_id, &version))
        .await
        .map_err(|e| e.to_string())??;
    let content = String::from_utf8(value.files[&value.template.main_file].clone())
        .map_err(|_| "Main document must be UTF-8")?;
    let identity = crate::latex::preview_toolchain(&content, cancel.clone()).await?;
    let key = projects::revision(format!("preview-v1:{id}:{revision}:{identity}").as_bytes());
    let cache = backend.inner.config.data_dir.join("template-previews");
    tokio::fs::create_dir_all(&cache)
        .await
        .map_err(|e| e.to_string())?;
    let pdf = cache.join(format!("{key}.pdf"));
    if !retry {
        if let Ok(bytes) = tokio::fs::read(&pdf).await {
            if bytes.starts_with(b"%PDF-") {
                let app = backend.clone();
                let template_id = id.clone();
                let version = revision.clone();
                tokio::task::spawn_blocking(move || checked_snapshot(&app, &template_id, &version))
                    .await
                    .map_err(|e| e.to_string())??;
                return Ok(bytes);
            }
        }
    }
    let workspace = cache.join(format!("work-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir(&workspace)
        .await
        .map_err(|e| e.to_string())?;
    let main = value.template.main_file.clone();
    let work = workspace.clone();
    let copied = tokio::task::spawn_blocking(move || copy_snapshot(&value, &work)).await;
    let result = async {
        copied.map_err(|e| e.to_string())??;
        let bytes = crate::latex::compile_preview(
            &backend.inner.latex,
            &workspace,
            &main,
            &content,
            cancel,
        )
        .await?;
        let app = backend.clone();
        tokio::task::spawn_blocking(move || checked_snapshot(&app, &id, &revision))
            .await
            .map_err(|e| e.to_string())??;
        let temp = cache.join(format!("{key}.{}.tmp", uuid::Uuid::new_v4()));
        tokio::fs::write(&temp, &bytes)
            .await
            .map_err(|e| e.to_string())?;
        if pdf.exists() {
            tokio::fs::remove_file(&pdf)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::rename(&temp, &pdf)
            .await
            .map_err(|e| e.to_string())?;
        Ok(bytes)
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&workspace).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    const TEX: &str = "\\documentclass{article}\n\\begin{document}Starter content\\end{document}";
    fn fixture() -> (tempfile::TempDir, Backend, PathBuf) {
        let (dir, backend) = crate::test_backend();
        let source = library_root(&backend).join("paper");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("paper.tex"), TEX).unwrap();
        (dir, backend, source)
    }
    #[test]
    fn discovery_uses_configured_home_and_resolves_nonstandard_and_nested_main_files() {
        let (dir, backend) = crate::test_backend();
        assert!(backend.template_list().unwrap().templates.is_empty());
        assert!(!library_root(&backend).exists());
        let source = library_root(&backend).join("custom");
        fs::create_dir_all(source.join("sections")).unwrap();
        fs::write(source.join("paper.tex"), TEX).unwrap();
        fs::write(
            source.join("sections/introduction.tex"),
            "% \\documentclass{article}\nA fragment",
        )
        .unwrap();
        let value = backend.template_list().unwrap();
        assert_eq!(value.templates[0].main_file, "paper.tex");
        assert_eq!(value.templates[0].id, "private:custom");
        assert_eq!(value.templates[0].name, "custom");
        fs::rename(source.join("paper.tex"), source.join("sections/paper.tex")).unwrap();
        assert_eq!(
            backend.template_list().unwrap().templates[0].main_file,
            "sections/paper.tex"
        );
        fs::write(source.join("sections/paper.tex"), "a single fragment").unwrap();
        fs::remove_file(source.join("sections/introduction.tex")).unwrap();
        assert_eq!(backend.template_list().unwrap().templates.len(), 1);
        assert!(dir.path().exists());
    }
    #[test]
    fn metadata_disambiguates_roots_and_errors_do_not_hide_valid_templates() {
        let (_dir, backend, source) = fixture();
        fs::write(source.join("second.tex"), TEX).unwrap();
        assert!(backend.template_list().unwrap().issues[0]
            .message
            .contains("mainFile"));
        fs::write(source.join("template.json"), r#"{"name":"Lab Paper","description":"Private","category":"academic","tags":["lab"],"mainFile":"second.tex"}"#).unwrap();
        let library = backend.template_list().unwrap();
        assert_eq!(library.templates[0].main_file, "second.tex");
        assert_eq!(library.templates[0].name, "Lab Paper");
        fs::create_dir(source.parent().unwrap().join("empty")).unwrap();
        assert_eq!(backend.template_list().unwrap().templates.len(), 1);
        assert_eq!(backend.template_list().unwrap().issues.len(), 1);
        for metadata in [
            "{broken",
            r#"{"mainFile":"../outside.tex"}"#,
            r#"{"mainFile":"/outside.tex"}"#,
            r#"{"mainFile":"missing.tex"}"#,
            r#"{"category":"unknown"}"#,
        ] {
            fs::write(source.join("template.json"), metadata).unwrap();
            assert!(backend.template_list().unwrap().templates.is_empty());
        }
    }
    #[test]
    fn template_policy_keeps_pdf_assets_and_hidden_guidance_without_copying_outputs() {
        let (dir, backend, source) = fixture();
        fs::create_dir_all(source.join(".agents/skills")).unwrap();
        fs::write(source.join(".agents/skills/guide.md"), "guidance").unwrap();
        for name in [
            "refs.bib",
            "style.bst",
            "figure.pdf",
            "paper.pdf",
            "native.so",
        ] {
            fs::write(source.join(name), "input").unwrap();
        }
        for name in [
            "paper.NAV",
            "paper.snm",
            "paper.vrb",
            "paper.SYNCTEX.GZ",
            "paper.run.xml",
        ] {
            fs::write(source.join(name), "output").unwrap();
        }
        fs::create_dir(source.join(".venv")).unwrap();
        fs::write(source.join(".venv/private.txt"), "environment").unwrap();
        let template = backend.template_list().unwrap().templates.remove(0);
        let destination = dir.path().join("filtered-copy");
        backend
            .template_create_project(
                template.id,
                template.revision,
                destination.to_string_lossy().into(),
            )
            .unwrap();
        for name in [
            "refs.bib",
            "style.bst",
            "figure.pdf",
            "paper.pdf",
            "native.so",
            ".agents/skills/guide.md",
        ] {
            assert!(destination.join(name).exists(), "{name}");
        }
        for name in [
            "paper.NAV",
            "paper.snm",
            "paper.vrb",
            "paper.SYNCTEX.GZ",
            "paper.run.xml",
            ".venv",
        ] {
            assert!(!destination.join(name).exists(), "{name}");
            assert!(
                source.join(name).exists(),
                "template library was changed: {name}"
            );
        }
    }

    #[test]
    fn project_copy_preserves_body_assets_and_instructions_and_rejects_stale_or_existing_destinations(
    ) {
        let (dir, backend, source) = fixture();
        fs::create_dir(source.join("assets")).unwrap();
        fs::write(source.join("assets/figure.pdf"), b"%PDF-asset").unwrap();
        fs::write(source.join("assets/logo.png"), b"binary\0image").unwrap();
        for name in ["local.sty", "class.cls", "refs.bib", "AGENTS.md"] {
            fs::write(source.join(name), name).unwrap();
        }
        fs::write(source.join("template.json"), "{}").unwrap();
        fs::write(source.join("paper.aux"), "generated").unwrap();
        fs::create_dir(source.join(".git")).unwrap();
        fs::write(source.join(".git/config"), "private git configuration").unwrap();
        let template = backend.template_list().unwrap().templates.remove(0);
        let destination = dir.path().join("new-project");
        let result = backend
            .template_create_project(
                template.id.clone(),
                template.revision.clone(),
                destination.to_string_lossy().into(),
            )
            .unwrap();
        assert_eq!(result.main_file, "paper.tex");
        assert_eq!(
            fs::read(destination.join("paper.tex")).unwrap(),
            TEX.as_bytes()
        );
        assert_eq!(
            fs::read(destination.join("assets/figure.pdf")).unwrap(),
            b"%PDF-asset"
        );
        assert_eq!(
            fs::read(destination.join("assets/logo.png")).unwrap(),
            b"binary\0image"
        );
        assert_eq!(
            fs::read_to_string(destination.join("AGENTS.md")).unwrap(),
            "AGENTS.md"
        );
        assert!(!destination.join("template.json").exists());
        assert!(!destination.join("paper.aux").exists());
        assert!(!destination.join(".git").exists());
        assert!(!source.join(".codexprism").exists());
        assert!(backend
            .template_create_project(
                template.id.clone(),
                template.revision.clone(),
                destination.to_string_lossy().into()
            )
            .is_err());
        assert!(backend
            .template_create_project(
                template.id.clone(),
                template.revision.clone(),
                source.join("new").to_string_lossy().into()
            )
            .is_err());
        fs::write(source.join("paper.tex"), "changed").unwrap();
        let stale_destination = dir.path().join("stale");
        assert!(backend
            .template_create_project(
                template.id,
                template.revision,
                stale_destination.to_string_lossy().into()
            )
            .err()
            .unwrap()
            .contains("Refresh"));
        assert!(!stale_destination.exists());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_rejected_without_reading_or_copying_their_targets() {
        let (dir, backend, source) = fixture();
        let secret = dir.path().join("outside.tex");
        fs::write(&secret, TEX).unwrap();
        std::os::unix::fs::symlink(&secret, source.join("escape.tex")).unwrap();
        let library = backend.template_list().unwrap();
        assert!(library.templates.is_empty());
        assert!(library.issues[0].message.contains("Symlink"));
        assert!(backend
            .template_create_project(
                "private:../escape".into(),
                "revision".into(),
                dir.path().join("new").to_string_lossy().into()
            )
            .is_err());
    }
    #[tokio::test]
    async fn shutdown_cancels_queued_previews_and_rejects_new_requests() {
        let (_dir, backend, _source) = fixture();
        let template = backend.template_list().unwrap().templates.remove(0);
        let lock = backend.inner.templates.preview_lock.lock().await;
        let other = backend.clone();
        let queued = tokio::spawn(async move {
            other
                .template_preview(template.id, template.revision, false)
                .await
        });
        while backend.inner.lifecycle.lock().unwrap().active == 0 {
            tokio::task::yield_now().await;
        }
        tokio::time::timeout(std::time::Duration::from_secs(1), backend.shutdown())
            .await
            .unwrap();
        assert!(queued.await.unwrap().unwrap_err().contains("shutting down"));
        drop(lock);
        assert!(backend
            .template_preview("private:paper".into(), "old".into(), false)
            .await
            .is_err());
    }
    #[tokio::test]
    #[ignore = "requires system TeX Live"]
    async fn real_preview_is_cached_invalidated_and_never_writes_to_the_template() {
        let (dir, backend, source) = fixture();
        fs::write(
            source.join("local.sty"),
            "\\ProvidesPackage{local}\n\\newcommand{\\starter}{Private starter}",
        )
        .unwrap();
        fs::write(source.join("paper.tex"), "\\documentclass{article}\n\\usepackage{local}\n\\begin{document}\\starter\\end{document}").unwrap();
        let template = backend.template_list().unwrap().templates.remove(0);
        let (first, duplicate) = tokio::join!(
            backend.template_preview(template.id.clone(), template.revision.clone(), false),
            backend.template_preview(template.id.clone(), template.revision.clone(), false),
        );
        let first = first.unwrap();
        assert_eq!(first, duplicate.unwrap());
        assert!(first.starts_with(b"%PDF-"));
        let cache = backend.inner.config.data_dir.join("template-previews");
        let pdf = fs::read_dir(&cache)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let modified = fs::metadata(&pdf).unwrap().modified().unwrap();
        let cached = backend
            .template_preview(template.id.clone(), template.revision.clone(), false)
            .await
            .unwrap();
        assert_eq!(cached, first);
        assert_eq!(fs::metadata(&pdf).unwrap().modified().unwrap(), modified);
        assert_eq!(fs::read_dir(&source).unwrap().count(), 2);
        assert!(!backend.inner.config.data_dir.join("projects.json").exists());
        fs::write(
            source.join("local.sty"),
            "\\ProvidesPackage{local}\n\\newcommand{\\starter}{New starter}",
        )
        .unwrap();
        assert!(backend
            .template_preview(template.id.clone(), template.revision.clone(), false)
            .await
            .is_err());
        let updated = backend.template_list().unwrap().templates.remove(0);
        let next = backend
            .template_preview(updated.id.clone(), updated.revision.clone(), false)
            .await
            .unwrap();
        assert_ne!(first, next);
        let created = backend
            .template_create_project(
                updated.id,
                updated.revision,
                dir.path().join("new-project").to_string_lossy().into(),
            )
            .unwrap();
        let compiled = backend
            .project_service(
                created.project.id,
                "compile_latex".into(),
                serde_json::json!({ "mainFile": created.main_file }),
            )
            .await
            .unwrap();
        let bytes: Vec<u8> = serde_json::from_value(compiled).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert_eq!(fs::read_dir(&source).unwrap().count(), 2);
        backend.shutdown().await;
    }
}
