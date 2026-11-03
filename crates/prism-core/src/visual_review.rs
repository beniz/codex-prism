//! Immutable, project-scoped build artifacts for pending agent reviews.
use crate::{codex, latex, projects, review_storage, Backend};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VisualReview {
    pub generation: String,
    pub main: String,
    pub state: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub error: Option<String>,
}
#[derive(Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    project: String,
    main: String,
    inputs: BTreeMap<String, String>,
    engine: String,
    options: String,
}
fn directory(app: &Backend, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
    Ok(projects::data_dir(app)?.join("visual-reviews").join(id))
}
fn artifact(app: &Backend, project: &str, id: &str) -> Result<PathBuf, String> {
    if id.len() != 40 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid artifact identifier".into());
    }
    Ok(directory(app, project)?.join(id))
}
pub(crate) fn capture(
    app: &Backend,
    id: &str,
    main: &str,
    inputs: &BTreeMap<String, Vec<u8>>,
) -> Result<String, String> {
    let content = inputs
        .get(main)
        .ok_or("Main document missing from captured inputs")?;
    let manifest = Manifest {
        project: id.into(),
        main: main.into(),
        inputs: inputs
            .iter()
            .map(|(p, b)| (p.clone(), projects::revision(b)))
            .collect(),
        engine: match latex::detect_tex_engine(&String::from_utf8_lossy(content)) {
            Some(latex::TexEngine::XeLaTeX) => "xelatex",
            Some(latex::TexEngine::LuaLaTeX) => "lualatex",
            _ => "pdflatex",
        }
        .into(),
        options: "v1:synctex=1;interaction=nonstopmode;existing-bibliography-passes".into(),
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    let key = projects::revision(&bytes);
    let dir = artifact(app, id, &key)?;
    if dir.join("manifest.json").exists() {
        return Ok(key);
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let work = dir.join("inputs");
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    for (path, bytes) in inputs {
        let dest = projects::resolve(&work, path)?;
        fs::create_dir_all(dest.parent().ok_or("Invalid input path")?)
            .map_err(|e| e.to_string())?;
        fs::write(dest, bytes).map_err(|e| e.to_string())?;
    }
    projects::save_json(&dir.join("manifest.json"), &manifest)?;
    Ok(key)
}
static ACTIVE_BUILDS: std::sync::Mutex<BTreeMap<PathBuf, usize>> =
    std::sync::Mutex::new(BTreeMap::new());
struct BuildPin(PathBuf);
impl BuildPin {
    fn new(path: PathBuf) -> Result<Self, String> {
        *ACTIVE_BUILDS
            .lock()
            .map_err(|e| e.to_string())?
            .entry(path.clone())
            .or_default() += 1;
        Ok(Self(path))
    }
}
impl Drop for BuildPin {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_BUILDS.lock() {
            if let Some(count) = active.get_mut(&self.0) {
                *count -= 1;
                if *count == 0 {
                    active.remove(&self.0);
                }
            }
        }
    }
}
static BUILD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct BuildDirectory(PathBuf);
impl BuildDirectory {
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for BuildDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn build(app: &Backend, project: &str, key: &str) -> Result<(), String> {
    let _pin = BuildPin::new(artifact(app, project, key)?)?;
    let mut cancel = app.inner.cancel.subscribe();
    if *cancel.borrow() {
        return Err("Backend is shutting down".into());
    }
    let _build_guard = tokio::select! {
        guard=BUILD_LOCK.lock()=>guard,
        _=cancel.changed()=>return Err("Backend is shutting down".into()),
    };
    let started = std::time::Instant::now();
    let dir = artifact(app, project, key)?;
    // No builder can own these directories while BUILD_LOCK is held.
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("build-") {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    if dir.join("output.pdf").exists() {
        projects::save_json(&directory(app, project)?.join("latest.json"), &key)?;
        return Ok(());
    }
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    // Each attempt has its own work directory; failed/interrupted output is never reused.
    let work = BuildDirectory(dir.join(format!("build-{}", uuid::Uuid::new_v4())));
    fs::create_dir(&work.0).map_err(|e| e.to_string())?;
    for (path, hash) in &manifest.inputs {
        let bytes =
            fs::read(projects::resolve(&dir.join("inputs"), path)?).map_err(|e| e.to_string())?;
        if projects::revision(&bytes) != *hash {
            return Err("Captured build input is corrupt".into());
        }
        let dest = projects::resolve(work.path(), path)?;
        fs::create_dir_all(dest.parent().ok_or("Invalid input path")?)
            .map_err(|e| e.to_string())?;
        fs::write(dest, bytes).map_err(|e| e.to_string())?;
    }
    let content =
        fs::read_to_string(work.path().join(&manifest.main)).map_err(|e| e.to_string())?;
    let pdf = latex::compile_preview(
        &app.inner.latex,
        work.path(),
        &manifest.main,
        &content,
        app.inner.cancel.subscribe(),
    )
    .await?;
    let stem = std::path::Path::new(&manifest.main)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid root")?;
    let sync = work.path().join(format!("{stem}.synctex.gz"));
    let mapping_started = std::time::Instant::now();
    let locations = if sync.exists() {
        use std::io::Read;
        let mut text = String::new();
        flate2::read::GzDecoder::new(fs::File::open(&sync).map_err(|e| e.to_string())?)
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        fs::copy(&sync, dir.join("output.synctex.gz")).map_err(|e| e.to_string())?;
        latex::forward_synctex(&text, work.path())
    } else {
        vec![]
    };
    eprintln!(
        "visual-review mapping: {}ms, {} locations",
        mapping_started.elapsed().as_millis(),
        locations.len()
    );
    projects::save_json(&dir.join("locations.json"), &locations)?;
    fs::write(dir.join("build-root.txt"), work.path().to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    fs::write(dir.join("output.tmp"), pdf).map_err(|e| e.to_string())?;
    fs::rename(dir.join("output.tmp"), dir.join("output.pdf")).map_err(|e| e.to_string())?;
    projects::save_json(&directory(app, project)?.join("latest.json"), &key)?;
    eprintln!(
        "visual-review build: {}ms, {} locations",
        started.elapsed().as_millis(),
        locations.len()
    );
    Ok(())
}
#[cfg(test)]
pub(crate) async fn prepare(app: &Backend, id: &str, main: &str) {
    let prepare = || -> Result<(String, String), String> {
        let _guard = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
        let path = codex::review_path(app, id)?;
        let mut r = review_storage::load(&path)?;
        let captured = capture(app, id, main, &r.before);
        let key = captured.as_ref().ok().cloned();
        let generation = uuid::Uuid::new_v4().to_string();
        r.visual = Some(VisualReview {
            generation: generation.clone(),
            main: main.into(),
            state: if key.is_some() {
                "preparing"
            } else {
                "unavailable"
            }
            .into(),
            before: key.clone(),
            after: None,
            error: captured.as_ref().err().cloned(),
        });
        review_storage::save(&path, &r)?;
        Ok((generation, captured?))
    };
    if let Ok((generation, key)) = prepare() {
        if let Err(error) = build(app, id, &key).await {
            let _ = update(app, id, &generation, |v| {
                v.before = None;
                v.state = "unavailable".into();
                v.error = Some(error);
            });
        }
    }
    let _ = cleanup(app, id).await;
}
fn update(
    app: &Backend,
    id: &str,
    generation: &str,
    edit: impl FnOnce(&mut VisualReview),
) -> Result<(), String> {
    let _guard = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let path = codex::review_path(app, id)?;
    let mut value: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if let Some(mut visual) =
        serde_json::from_value::<Option<VisualReview>>(value["visual"].clone())
            .map_err(|e| e.to_string())?
    {
        if visual.generation == generation {
            edit(&mut visual);
            let encoded = json!(visual);
            if value["visual"] != encoded {
                value["visual"] = encoded;
                projects::save_json(&path, &value)?;
            }
        }
    }
    Ok(())
}
fn load_header(path: &std::path::Path) -> Result<codex::Review, String> {
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(codex::Review {
        active: value["active"].as_bool().unwrap_or(false),
        visual: serde_json::from_value(value["visual"].clone()).map_err(|e| e.to_string())?,
        ..Default::default()
    })
}
pub(crate) async fn service(
    app: &Backend,
    id: &str,
    operation: &str,
    args: Value,
) -> Result<Value, String> {
    let (r, stale) = {
        let _guard = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
        let path = codex::review_path(app, id)?;
        if !path.exists() {
            return if operation == "visual_report" {
                Ok(json!({"state":"unavailable"}))
            } else {
                Err("Review is no longer pending".into())
            };
        }
        let r = load_header(&path)?;
        let current = if operation == "visual_report" {
            Some(projects::snapshot(&projects::get(app, id)?.root)?)
        } else {
            None
        };
        let stale = if let (Some(key), Some(current)) =
            (r.visual.as_ref().and_then(|v| v.after.as_ref()), current)
        {
            let m: Manifest = serde_json::from_slice(
                &fs::read(artifact(app, id, key)?.join("manifest.json"))
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            m.inputs
                != current
                    .iter()
                    .map(|(p, b)| (p.clone(), projects::revision(b)))
                    .collect()
        } else {
            false
        };
        (r, stale)
    };
    let Some(mut v) = r.visual else {
        return if operation == "visual_report" {
            Ok(json!({"state":"unavailable","error":"This review has no captured baseline."}))
        } else {
            Err("This review has no captured baseline".into())
        };
    };
    if r.active {
        return if operation == "visual_report" {
            Ok(json!({"state":"preparing"}))
        } else {
            Err("Review is still active".into())
        };
    }
    if stale {
        return Ok(json!({"state":"stale","error":"Project files changed outside this review."}));
    }
    if operation == "visual_report" {
        if let Some(after) = &v.after {
            let result = build(app, id, after).await;
            v.state = if result.is_ok() && v.before.is_some() {
                "ready"
            } else {
                "unavailable"
            }
            .into();
            if let Err(error) = result {
                v.error = Some(error);
            } else if v.before.is_some() {
                v.error = None;
            }
            let after_key = v.after.clone();
            update(app, id, &v.generation, |stored| {
                if stored.after == after_key {
                    stored.state = v.state.clone();
                    stored.error = v.error.clone();
                }
            })?;
        } else {
            v.state = "unavailable".into();
        }
        // Re-check generation and revision after asynchronous compilation.
        let path = codex::review_path(app, id)?;
        let _guard = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
        let current = load_header(&path)?;
        if current.active
            || current
                .visual
                .as_ref()
                .is_none_or(|c| c.generation != v.generation || c.after != v.after)
        {
            return Ok(json!({"state":"stale"}));
        }
        if let Some(key) = &v.after {
            let m: Manifest = serde_json::from_slice(
                &fs::read(artifact(app, id, key)?.join("manifest.json"))
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let now = projects::snapshot(&projects::get(app, id)?.root)?;
            if m.inputs
                != now
                    .iter()
                    .map(|(p, b)| (p.clone(), projects::revision(b)))
                    .collect()
            {
                return Ok(
                    json!({"state":"stale","error":"Project files changed outside this review."}),
                );
            }
        }
        return Ok(json!(v));
    }
    let key = args["artifactId"].as_str().ok_or("Missing artifactId")?;
    if ![v.before.as_deref(), v.after.as_deref()].contains(&Some(key)) {
        return Err("Artifact does not belong to this review".into());
    }
    let dir = artifact(app, id, key)?;
    match operation {
        "visual_pdf" => Ok(json!(
            fs::read(dir.join("output.pdf")).map_err(|e| e.to_string())?
        )),
        "visual_locations" => {
            let locations: Vec<latex::SourceBox> = serde_json::from_slice(
                &fs::read(dir.join("locations.json")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let path = args["path"].as_str().ok_or("Missing path")?;
            let start = args["start"].as_u64().ok_or("Missing start")?;
            let end = args["end"].as_u64().ok_or("Missing end")?;
            Ok(json!(locations
                .into_iter()
                .filter(|b| b.file == path && b.line as u64 >= start && b.line as u64 <= end)
                .collect::<Vec<_>>()))
        }
        _ => Err("Unknown visual operation".into()),
    }
}

/// Serialize with builders and snapshot capture so nothing referenced by a job or
/// a rollback review is collected. Keep one successful baseline after resolution.
pub(crate) async fn cleanup(app: &Backend, id: &str) -> Result<(), String> {
    let _build = BUILD_LOCK.lock().await;
    let _project = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let dir = directory(app, id)?;
    let mut used = std::collections::HashSet::<String>::new();
    fn collect(r: &codex::Review, used: &mut std::collections::HashSet<String>) {
        if let Some(v) = &r.visual {
            used.extend(v.before.iter().chain(v.after.iter()).cloned());
        }
        if let Some(previous) = &r.previous {
            collect(previous, used);
        }
    }
    let path = codex::review_path(app, id)?;
    if path.exists() {
        collect(&review_storage::load(&path)?, &mut used);
    }
    if let Ok(bytes) = fs::read(dir.join("latest.json")) {
        if let Ok(key) = serde_json::from_slice::<String>(&bytes) {
            used.insert(key);
        }
    }
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let pinned = ACTIVE_BUILDS
                .lock()
                .map_err(|e| e.to_string())?
                .contains_key(&entry.path());
            if entry.path().is_dir() && !used.contains(&name) && !pinned {
                let _ = fs::remove_dir_all(entry.path());
            } else if entry.path().is_dir() {
                if let Ok(children) = fs::read_dir(entry.path()) {
                    for child in children.flatten() {
                        if child.file_name().to_string_lossy().starts_with("build-") {
                            let _ = fs::remove_dir_all(child.path());
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(app: &Backend, root: &std::path::Path, text: &str) -> String {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("main.tex"), text).unwrap();
        app.project_register(root.to_string_lossy().into())
            .unwrap()
            .id
    }
    const BEFORE: &str = "\\documentclass{article}\n\\begin{document}\nOriginal passage for visual review.\n\\end{document}\n";
    #[tokio::test]
    async fn immutable_artifacts_reuse_invalidate_and_survive_restart_and_undo() {
        let (tmp, app) = crate::test_backend();
        let root = tmp.path().join("project");
        let id = fixture(&app, &root, BEFORE);
        let inputs = projects::snapshot(&root).unwrap();
        let key = capture(&app, &id, "main.tex", &inputs).unwrap();
        assert_eq!(key, capture(&app, &id, "main.tex", &inputs).unwrap());
        let mut changed = inputs.clone();
        changed.insert("figure.bin".into(), vec![0, 255]);
        assert_ne!(key, capture(&app, &id, "main.tex", &changed).unwrap());
        if which::which("pdflatex").is_err() {
            return;
        }
        let path = codex::review_path(&app, &id).unwrap();
        let mut review = codex::Review {
            project_id: id.clone(),
            active: true,
            before: inputs,
            ..Default::default()
        };
        review_storage::save(&path, &review).unwrap();
        prepare(&app, &id, "main.tex").await;
        review = review_storage::load(&path).unwrap();
        assert!(review.visual.as_ref().unwrap().before.is_some());
        fs::write(root.join("main.tex"), BEFORE.replace("Original", "Updated")).unwrap();
        review.after = projects::snapshot(&root).unwrap();
        review.active = false;
        review.visual.as_mut().unwrap().after =
            Some(capture(&app, &id, "main.tex", &review.after).unwrap());
        review_storage::save(&path, &review).unwrap();
        let report = service(&app, &id, "visual_report", json!({}))
            .await
            .unwrap();
        assert_eq!(report["state"], "ready");
        let before = report["before"].as_str().unwrap();
        let after = report["after"].as_str().unwrap();
        assert_ne!(before, after);
        let geometry = service(
            &app,
            &id,
            "visual_locations",
            json!({"artifactId":after,"path":"main.tex","start":3,"end":3}),
        )
        .await
        .unwrap();
        assert!(!geometry.as_array().unwrap().is_empty());
        let rebuilt = fs::metadata(artifact(&app, &id, after).unwrap().join("output.pdf"))
            .unwrap()
            .modified()
            .unwrap();
        service(&app, &id, "visual_report", json!({}))
            .await
            .unwrap();
        assert_eq!(
            rebuilt,
            fs::metadata(artifact(&app, &id, after).unwrap().join("output.pdf"))
                .unwrap()
                .modified()
                .unwrap()
        );
        assert!(service(
            &app,
            &id,
            "visual_pdf",
            json!({"artifactId":"../output.pdf"})
        )
        .await
        .is_err());
        let persisted = review_storage::load(&path).unwrap();
        assert_eq!(persisted.visual.unwrap().state, "ready");
        fs::write(root.join("main.tex"), "external change").unwrap();
        assert_eq!(
            service(&app, &id, "visual_report", json!({}))
                .await
                .unwrap()["state"],
            "stale"
        );
        fs::write(root.join("main.tex"), BEFORE.replace("Original", "Updated")).unwrap();
        app.project_resolve_review(id.clone(), "main.tex".into(), true)
            .unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), BEFORE);
        cleanup(&app, &id).await.unwrap();
        assert!(artifact(&app, &id, after).unwrap().exists()); // latest reusable baseline
    }
    #[tokio::test]
    async fn included_files_partial_decisions_and_after_failure_are_revision_safe() {
        if which::which("pdflatex").is_err() {
            return;
        }
        let (tmp, app) = crate::test_backend();
        let root = tmp.path().join("project");
        let main="\\documentclass[twocolumn]{article}\n\\begin{document}\n\\input{part}\n\\[ E=mc^2 \\]\n\\begin{tabular}{cc} A & B \\\\ C & D \\end{tabular}\n\\end{document}";
        let id = fixture(&app, &root, main);
        fs::write(
            root.join("part.tex"),
            "Included original passage.\n\nSecond paragraph.",
        )
        .unwrap();
        fs::write(root.join("notes.txt"), "original notes").unwrap();
        fs::write(root.join("second.txt"), "original second file").unwrap();
        let path = codex::review_path(&app, &id).unwrap();
        review_storage::save(
            &path,
            &codex::Review {
                project_id: id.clone(),
                active: true,
                before: projects::snapshot(&root).unwrap(),
                ..Default::default()
            },
        )
        .unwrap();
        prepare(&app, &id, "main.tex").await;
        let mut r = review_storage::load(&path).unwrap();
        let baseline = r.visual.as_ref().unwrap().before.clone().unwrap();
        fs::write(
            root.join("part.tex"),
            "Included revised passage.\n\nSecond paragraph.",
        )
        .unwrap();
        fs::write(root.join("notes.txt"), "revised notes").unwrap();
        fs::write(root.join("second.txt"), "revised second file").unwrap();
        r.active = false;
        r.after = projects::snapshot(&root).unwrap();
        r.visual.as_mut().unwrap().after = Some(capture(&app, &id, "main.tex", &r.after).unwrap());
        review_storage::save(&path, &r).unwrap();
        let report = service(&app, &id, "visual_report", json!({}))
            .await
            .unwrap();
        assert_eq!(report["state"], "ready");
        let locations = service(
            &app,
            &id,
            "visual_locations",
            json!({"artifactId":report["after"],"path":"part.tex","start":1,"end":1}),
        )
        .await
        .unwrap();
        assert!(!locations.as_array().unwrap().is_empty());
        app.project_resolve_review(id.clone(), "part.tex".into(), true)
            .unwrap();
        let remaining = service(&app, &id, "visual_report", json!({}))
            .await
            .unwrap();
        assert_eq!(remaining["state"], "ready");
        assert_eq!(remaining["before"], baseline);
        assert_ne!(remaining["after"], report["after"]);
        // Keep does not change the after artifact or touch the retained baseline.
        app.project_resolve_review(id.clone(), "notes.txt".into(), false)
            .unwrap();
        let kept = review_storage::load(&path).unwrap();
        assert_eq!(
            kept.visual.as_ref().unwrap().after.as_deref(),
            remaining["after"].as_str()
        );
        // A failed after artifact can never stand in for the last successful PDF.
        let mut failed = kept;
        let mut inputs = projects::snapshot(&root).unwrap();
        inputs.insert(
            "main.tex".into(),
            b"\\documentclass{missing-visual-class}".to_vec(),
        );
        fs::write(root.join("main.tex"), &inputs["main.tex"]).unwrap();
        failed.visual.as_mut().unwrap().after =
            Some(capture(&app, &id, "main.tex", &inputs).unwrap());
        review_storage::save(&path, &failed).unwrap();
        assert_eq!(
            service(&app, &id, "visual_report", json!({}))
                .await
                .unwrap()["state"],
            "unavailable"
        );
        assert!(!artifact(
            &app,
            &id,
            failed.visual.as_ref().unwrap().after.as_ref().unwrap()
        )
        .unwrap()
        .join("output.pdf")
        .exists());
        // An obsolete asynchronous result cannot alter a newer generation.
        let mut newer = failed;
        newer.visual.as_mut().unwrap().generation = "new-generation".into();
        newer.visual.as_mut().unwrap().state = "preparing".into();
        review_storage::save(&path, &newer).unwrap();
        update(&app, &id, report["generation"].as_str().unwrap(), |v| {
            v.state = "ready".into()
        })
        .unwrap();
        assert_ne!(
            review_storage::load(&path).unwrap().visual.unwrap().state,
            "ready"
        );
    }

    #[tokio::test]
    #[ignore = "requires PRISM_TEST_PROJECT and PRISM_TEST_MAIN; immutable copies only"]
    async fn retained_large_document_builds_are_bounded_and_reusable() {
        let (tmp, app) = crate::test_backend();
        let source = PathBuf::from(std::env::var("PRISM_TEST_PROJECT").unwrap());
        let main = std::env::var("PRISM_TEST_MAIN").unwrap();
        let inputs = projects::snapshot(&source).unwrap();
        let root = tmp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let id = app
            .project_register(root.to_string_lossy().into())
            .unwrap()
            .id;
        let key = capture(&app, &id, &main, &inputs).unwrap();
        build(&app, &id, &key).await.unwrap();
        let start = std::time::Instant::now();
        for _ in 0..5 {
            assert_eq!(capture(&app, &id, &main, &inputs).unwrap(), key);
            build(&app, &id, &key).await.unwrap();
        }
        let pdf = fs::read(artifact(&app, &id, &key).unwrap().join("output.pdf")).unwrap();
        eprintln!(
            "visual-review large fixture: {} bytes, five retained builds {}ms",
            pdf.len(),
            start.elapsed().as_millis()
        );
        if let Ok(output) = std::env::var("PRISM_TEST_OUTPUT") {
            fs::write(output, pdf).unwrap();
        }
    }

    #[tokio::test]
    async fn failed_baseline_does_not_block_turn_and_old_pdf_is_not_a_build() {
        let (tmp, app) = crate::test_backend();
        let root = tmp.path().join("project");
        let id = fixture(
            &app,
            &root,
            "\\documentclass{missing-class-for-visual-test}\n\\begin{document}bad\\end{document}",
        );
        fs::write(root.join("main.pdf"), b"%PDF-old output").unwrap();
        let path = codex::review_path(&app, &id).unwrap();
        review_storage::save(
            &path,
            &codex::Review {
                project_id: id.clone(),
                active: true,
                before: projects::snapshot(&root).unwrap(),
                ..Default::default()
            },
        )
        .unwrap();
        prepare(&app, &id, "main.tex").await;
        let r = review_storage::load(&path).unwrap();
        assert!(r.active);
        assert!(r.visual.as_ref().unwrap().before.is_none());
        assert_eq!(r.visual.unwrap().state, "unavailable");
        assert_eq!(fs::read(root.join("main.pdf")).unwrap(), b"%PDF-old output");
    }
}

/// Proposal artifacts are addressed by immutable inputs and owned by a workspace.
/// They never consult or overwrite the legacy project review.
pub(crate) async fn proposal_pdf(
    app: &Backend,
    workspace: &str,
    main: &str,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<Value, String> {
    let key = capture(app, workspace, main, files)?;
    build(app, workspace, &key).await?;
    let dir = artifact(app, workspace, &key)?;
    let locations: Vec<latex::SourceBox> =
        serde_json::from_slice(&fs::read(dir.join("locations.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    Ok(
        json!({"artifactId":key,"bytes":fs::read(dir.join("output.pdf")).map_err(|e|e.to_string())?,"locations":locations}),
    )
}

/// Promote only complete immutable builds whose entire input set matches acceptance.
/// Failure is an optimization miss: the caller will compile normally.
pub(crate) fn promote_proposal_builds(app: &Backend, workspace: &str, root: &std::path::Path, files: &BTreeMap<String, Vec<u8>>) -> Vec<String> {
    let mut promoted = Vec::new();
    let Ok(base) = directory(app, workspace) else { return promoted; };
    let Ok(entries) = fs::read_dir(base) else { return promoted; };
    let hashes: BTreeMap<_, _> = files.iter().map(|(p,b)| (p.clone(), projects::revision(b))).collect();
    for entry in entries.flatten() {
        let attempt = || -> Result<String, String> {
            let dir = entry.path();
            let manifest: Manifest = serde_json::from_slice(&fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if manifest.inputs != hashes || manifest.project != workspace { return Err("Different inputs".into()); }
            let pdf = fs::read(dir.join("output.pdf")).map_err(|e| e.to_string())?;
            if !pdf.starts_with(b"%PDF-") { return Err("Invalid PDF".into()); }
            let original = fs::read_to_string(dir.join("build-root.txt")).map_err(|e| e.to_string())?;
            if original.is_empty() { return Err("Missing build origin".into()); }
            use std::io::Read;
            let mut sync = String::new();
            flate2::read::GzDecoder::new(fs::File::open(dir.join("output.synctex.gz")).map_err(|e|e.to_string())?).read_to_string(&mut sync).map_err(|e|e.to_string())?;
            let relative = format!(".prism/accepted/{}", uuid::Uuid::new_v4());
            let dest = projects::resolve(root, &relative)?;
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            let dest = fs::canonicalize(dest).map_err(|e| e.to_string())?;
            for (name, bytes) in files {
                let path = projects::resolve(&dest, name)?;
                fs::create_dir_all(path.parent().ok_or("Invalid source")?).map_err(|e|e.to_string())?;
                fs::write(path, bytes).map_err(|e|e.to_string())?;
            }
            let stem = std::path::Path::new(&manifest.main).file_stem().and_then(|s|s.to_str()).ok_or("Invalid main")?;
            fs::write(dest.join(format!("{stem}.synctex")), sync.replace(&original, &dest.to_string_lossy())).map_err(|e|e.to_string())?;
            fs::write(dest.join(format!("{stem}.pdf")), pdf).map_err(|e|e.to_string())?;
            let pointer = projects::resolve(root, &format!(".prism/accepted-{}.json", projects::revision(manifest.main.as_bytes())))?;
            projects::save_json(&pointer, &format!("{relative}/{stem}.pdf"))?;
            Ok(manifest.main)
        };
        if let Ok(main) = attempt() { promoted.push(main); }
    }
    promoted
}

#[cfg(test)]
mod promotion_tests {
    use super::*;
    #[tokio::test]
    async fn accepted_build_requires_identical_inputs_and_preserves_navigation() {
        let (tmp, app) = crate::test_backend();
        let root = tmp.path().join("document");
        fs::create_dir(&root).unwrap();
        let workspace = uuid::Uuid::new_v4().to_string();
        let files = BTreeMap::from([("main.tex".into(), b"\\section{Title}\n".to_vec()), ("image.png".into(), vec![1,2,3])]);
        let key = capture(&app, &workspace, "main.tex", &files).unwrap();
        let dir = artifact(&app, &workspace, &key).unwrap();
        assert!(promote_proposal_builds(&app, &workspace, &root, &files).is_empty());
        fs::write(dir.join("output.pdf"), b"%PDF-1.4 reviewed").unwrap();
        fs::write(dir.join("build-root.txt"), "/old/build").unwrap();
        use std::io::Write;
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(b"Input:1:/old/build/main.tex\n").unwrap();
        fs::write(dir.join("output.synctex.gz"), gzip.finish().unwrap()).unwrap();
        let mut merged = files.clone();
        merged.insert("image.png".into(), vec![4]);
        assert!(promote_proposal_builds(&app, &workspace, &root, &merged).is_empty());
        assert_eq!(promote_proposal_builds(&app, &workspace, &root, &files), vec!["main.tex"]);
        let pdf = latex::load_existing_pdf(&app.inner.latex, root.to_string_lossy().into(), "main.tex".into()).await.unwrap().unwrap();
        assert_eq!(pdf, b"%PDF-1.4 reviewed");
        let pointer: String = serde_json::from_slice(&fs::read(root.join(format!(".prism/accepted-{}.json", projects::revision(b"main.tex")))).unwrap()).unwrap();
        let accepted = root.join(pointer);
        let work = accepted.parent().unwrap();
        assert_eq!(fs::read(work.join("main.tex")).unwrap(), files["main.tex"]);
        let sync = fs::read_to_string(accepted.with_extension("synctex")).unwrap();
        assert!(sync.contains(&work.to_string_lossy().to_string()));
        assert!(!sync.contains("/old/build"));
        fs::remove_file(dir.join("output.pdf")).unwrap();
        assert!(promote_proposal_builds(&app, &workspace, &root, &files).is_empty());
    }
}
