use prism_core::{Backend, BackendConfig, BackendEvent, NoopEventSink, RecordingEventSink};
use serde_json::{json, Value};
use std::{fs, sync::Arc};

fn config(dir: &tempfile::TempDir) -> BackendConfig {
    BackendConfig {
        data_dir: dir.path().join("data"),
        home_dir: dir.path().join("home"),
        temp_dir: dir.path().join("tmp"),
    }
}
fn project(backend: &Backend, dir: &tempfile::TempDir) -> prism_core::projects::Project {
    let root = dir.path().join("project");
    fs::create_dir_all(&root).unwrap();
    backend
        .project_register(root.to_string_lossy().into())
        .unwrap()
}
async fn service(backend: &Backend, id: &str, op: &str, args: Value) -> Value {
    backend
        .project_service(id.into(), op.into(), args)
        .await
        .unwrap()
}

#[tokio::test]
async fn files_history_and_identity_survive_reopen_without_a_gui() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Backend::new(config(&dir), Arc::new(NoopEventSink)).unwrap();
    let p = project(&backend, &dir);
    let revision = backend
        .project_write(p.id.clone(), "main.tex".into(), b"first".to_vec(), None)
        .unwrap();
    service(&backend, &p.id, "history_init", json!({})).await;
    fs::write(p.root.join("main.tex"), "external").unwrap();
    assert!(backend
        .project_write(
            p.id.clone(),
            "main.tex".into(),
            b"stale".to_vec(),
            Some(revision)
        )
        .is_err());
    let snapshot = service(
        &backend,
        &p.id,
        "history_snapshot",
        json!({"message":"external edit"}),
    )
    .await;
    assert!(snapshot["id"].is_string());
    assert!(p.root.join(".claudeprism/history.git").is_dir());
    backend.shutdown().await;
    backend.shutdown().await;
    assert!(backend
        .project_read(p.id.clone(), "main.tex".into())
        .is_err());
    let reopened = Backend::new(config(&dir), Arc::new(NoopEventSink)).unwrap();
    assert_eq!(
        reopened
            .project_register(p.root.to_string_lossy().into())
            .unwrap()
            .id,
        p.id
    );
    let read = reopened
        .project_read(p.id.clone(), "main.tex".into())
        .unwrap();
    assert_eq!(read["bytes"], json!(b"external".to_vec()));
    let history = service(&reopened, &p.id, "history_list", json!({})).await;
    assert_eq!(history[0]["id"], snapshot["id"]);
    reopened.shutdown().await;
}

#[tokio::test]
async fn startup_recovers_interrupted_review_and_keeps_build_files() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Backend::new(config(&dir), Arc::new(NoopEventSink)).unwrap();
    let p = project(&backend, &dir);
    fs::write(p.root.join("main.tex"), b"after").unwrap();
    fs::create_dir_all(p.root.join(".prism/build")).unwrap();
    fs::write(p.root.join(".prism/build/main.pdf"), b"%PDF-kept").unwrap();
    backend.shutdown().await;
    fs::write(
        config(&dir).data_dir.join(format!("review-{}.json", p.id)),
        serde_json::to_vec(&json!({
            "projectId":p.id,"active":true,"before":{"main.tex":b"before".to_vec()},"after":{}
        }))
        .unwrap(),
    )
    .unwrap();
    let events = Arc::new(RecordingEventSink::default());
    let reopened = Backend::new(config(&dir), events.clone()).unwrap();
    let review = reopened.project_review(p.id.clone()).unwrap();
    assert_eq!(review["active"], false);
    assert_eq!(review["changes"][0]["newContent"], "after");
    assert!(events
        .take()
        .iter()
        .any(|e| matches!(e, BackendEvent::ProjectReview {project_id} if project_id == &p.id)));
    assert!(reopened
        .project_write(p.id.clone(), "new.tex".into(), vec![], None)
        .is_err());
    reopened
        .project_resolve_review(p.id, "main.tex".into(), true)
        .unwrap();
    assert_eq!(fs::read(p.root.join("main.tex")).unwrap(), b"before");
    reopened.shutdown().await;
    assert!(p.root.join(".prism/build/main.pdf").exists());
}

#[tokio::test]
async fn configured_home_owns_skills_and_project_discovery() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(&dir);
    let root = cfg.home_dir.join("Documents/codex-prism/example");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("main.tex"), "source").unwrap();
    let source = dir.path().join("example-skill");
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\nname: example\ndescription: Example skill\n---\nInstructions",
    )
    .unwrap();
    let backend = Backend::new(cfg.clone(), Arc::new(NoopEventSink)).unwrap();
    assert_eq!(backend.list_default_projects().unwrap().len(), 1);
    let imported = backend
        .import_skill_from_folder(source.to_string_lossy().into())
        .await
        .unwrap();
    assert_eq!(imported.len(), 1);
    assert!(cfg
        .home_dir
        .join(".agents/skills/example-skill/SKILL.md")
        .is_file());
    assert!(
        backend
            .check_skills_installed(None)
            .await
            .unwrap()
            .installed
    );
    backend
        .delete_installed_skill("example-skill".into())
        .await
        .unwrap();
    assert!(
        !backend
            .check_skills_installed(None)
            .await
            .unwrap()
            .installed
    );
    assert!(backend
        .import_skill_from_folder(dir.path().join("missing").to_string_lossy().into())
        .await
        .is_err());
    backend.shutdown().await;
}

#[test]
fn wire_payloads_remain_compatible() {
    let cases = [
        (
            BackendEvent::Agent(json!({"method":"delta","params":{"text":"hello"}})),
            "codex-event",
            json!({"method":"delta","params":{"text":"hello"}}),
        ),
        (
            BackendEvent::ProjectReview {
                project_id: "p".into(),
            },
            "project-review",
            json!({"projectId":"p"}),
        ),
        (
            BackendEvent::SkillsInstallLog("log".into()),
            "skills-install-log",
            json!("log"),
        ),
        (
            BackendEvent::UvInstallOutput("line".into()),
            "uv-install-output",
            json!("line"),
        ),
        (
            BackendEvent::UvInstallComplete(false),
            "uv-install-complete",
            json!(false),
        ),
    ];
    for (event, name, payload) in cases {
        assert_eq!(event.name(), name);
        assert_eq!(event.payload(), payload);
    }
}

#[tokio::test]
#[ignore = "requires system pdfLaTeX"]
async fn project_service_pdf_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Backend::new(config(&dir), Arc::new(NoopEventSink)).unwrap();
    let p = project(&backend, &dir);
    backend
        .project_write(
            p.id.clone(),
            "main.tex".into(),
            b"\\documentclass{article}\n\\begin{document}Headless backend\\end{document}\n"
                .to_vec(),
            None,
        )
        .unwrap();
    let pdf = service(
        &backend,
        &p.id,
        "compile_latex",
        json!({"mainFile":"main.tex"}),
    )
    .await;
    let bytes: Vec<u8> = serde_json::from_value(pdf.clone()).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    assert!(p.root.join(".prism/build/main.pdf").is_file());
    assert_eq!(
        service(
            &backend,
            &p.id,
            "load_existing_pdf",
            json!({"mainFile":"main.tex"})
        )
        .await,
        pdf
    );
    backend.shutdown().await;
}
