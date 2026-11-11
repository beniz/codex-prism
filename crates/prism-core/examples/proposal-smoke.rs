#![allow(clippy::unwrap_used)]
//! Local-only backend for the WebKit visual-review smoke test. Uses a disposable
//! project and deterministic app-server fixture, never a user's agent account.
use prism_core::{Backend, BackendConfig, RecordingEventSink};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    sync::Arc,
};
#[cfg(not(unix))]
fn main() {
    eprintln!("This WebKitGTK test fixture requires Unix.");
}
#[cfg(unix)]
#[tokio::main]
async fn main() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    let config = BackendConfig {
        data_dir: dir.join("data"),
        home_dir: dir.join("home"),
        temp_dir: dir.join("tmp"),
    };
    let events = Arc::new(RecordingEventSink::default());
    let mut backend = Backend::new(config.clone(), events.clone()).unwrap();
    let root = dir.join("project");
    std::fs::create_dir(&root).unwrap();
    let source="\\documentclass{article}\n\\begin{document}\nOriginal passage for visual review.\n\nAnother unchanged paragraph.\n\\end{document}\n";
    std::fs::write(root.join("main.tex"), source).unwrap();
    if std::env::var_os("PRISM_SMOKE_HISTORY").is_some() {
        std::fs::write(root.join("notes.tex"), "Original note").unwrap();
    }
    let script = dir.join("agent");
    let fixture = include_str!("../tests/fixtures/app_server.py").replace(
        r#"(root / "main.tex").write_text("running edit")"#,
        r#"(root / "main.tex").write_text((root / "main.tex").read_text().replace("Original passage", "A passage" if mode.endswith("A") else "B passage").replace("A passage", "Repaired A and B passage") if "Repair the proposal" in mode else (root / "main.tex").read_text().replace("Original passage", "A passage" if mode.endswith("A") else "B passage"))"#
    );
    std::fs::write(&script, fixture).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    backend
        .codex_set_path(script.to_string_lossy().into())
        .await
        .unwrap();
    let project = backend
        .project_register(root.to_string_lossy().into())
        .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:19372").unwrap();
    println!("Proposal smoke backend ready");
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        let mut request = Vec::new();
        let mut buf = [0u8; 8192];
        let (header_end, length) = loop {
            let n = stream.read(&mut buf).unwrap();
            if n == 0 {
                break (0, 0);
            }
            request.extend_from_slice(&buf[..n]);
            if let Some(pos) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..pos]);
                let length = headers
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|v| v.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                break (pos + 4, length);
            }
        };
        while request.len() < header_end + length {
            let n = stream.read(&mut buf).unwrap();
            request.extend_from_slice(&buf[..n]);
        }
        let value: Value = serde_json::from_slice(&request[header_end..]).unwrap_or(json!({}));
        let command = value["command"].as_str().unwrap_or("");
        let args = &value["args"];
        // Let real proposal builds overlap instead of serializing them in the HTTP fixture.
        if command == "project_service"
            && ["proposal_compile", "proposal_load_build"]
                .contains(&args["operation"].as_str().unwrap_or(""))
        {
            let backend = backend.clone();
            let project_id = project.id.clone();
            let operation = args["operation"].as_str().unwrap().to_owned();
            let args = args["args"].clone();
            tokio::spawn(async move {
                respond(
                    stream,
                    backend.project_service(project_id, operation, args).await,
                );
            });
            continue;
        }
        let result: Result<Value, String> = match command {
            "performance" => {
                let variable = if args["name"] == "large" {
                    "PRISM_SMOKE_LARGE_PDF"
                } else {
                    "PRISM_SMOKE_LONG_PDF"
                };
                std::env::var(variable)
                    .map_err(|e| e.to_string())
                    .and_then(|path| {
                        std::fs::read(path)
                            .map(|b| json!(b))
                            .map_err(|e| e.to_string())
                    })
            }
            "events" => Ok(json!(events
                .take()
                .into_iter()
                .map(|e| json!({"event":e.name(),"payload":e.payload()}))
                .collect::<Vec<_>>())),
            "restart" => {
                backend.shutdown().await;
                backend = Backend::new(config.clone(), events.clone()).unwrap();
                Ok(Value::Null)
            }
            "git_log" => {
                let out = std::process::Command::new("git")
                    .current_dir(&root)
                    .args(["log", "--format=%s"])
                    .output()
                    .unwrap();
                Ok(json!(String::from_utf8_lossy(&out.stdout)))
            }
            "fixture" => Ok(json!({"project":project,"source":source})),
            "fixture_pdf" | "compile_latex" | "load_existing_pdf" => {
                let output = std::process::Command::new("pdflatex")
                    .current_dir(&root)
                    .args(["-interaction=nonstopmode", "main.tex"])
                    .output()
                    .unwrap();
                if !output.status.success() {
                    Err(String::from_utf8_lossy(&output.stdout).into())
                } else {
                    Ok(json!(std::fs::read(root.join("main.pdf")).unwrap()))
                }
            }
            "codex_send" => {
                backend
                    .codex_send_for_chat(
                        project.id.clone(),
                        args["threadId"].as_str().map(str::to_owned),
                        args["prompt"].as_str().unwrap().into(),
                        None,
                        None,
                        None,
                        Some("main.tex".into()),
                        None,
                        args["chatId"].as_str().map(str::to_owned),
                    )
                    .await
            }
            "codex_control" => {
                backend
                    .codex_control(
                        project.id.clone(),
                        args["threadId"].as_str().unwrap().into(),
                        args["turnId"].as_str().unwrap().into(),
                        args["prompt"].as_str().map(str::to_owned),
                    )
                    .await
            }
            "project_register" => Ok(json!(project)),
            "project_service" => {
                backend
                    .project_service(
                        project.id.clone(),
                        args["operation"].as_str().unwrap().into(),
                        args["args"].clone(),
                    )
                    .await
            }
            "project_review" => backend.project_review(project.id.clone()),
            "project_resolve_review_batch" => {
                backend
                    .project_resolve_review_batch(
                        project.id.clone(),
                        serde_json::from_value(args["paths"].clone()).unwrap(),
                        args["undo"].as_bool().unwrap(),
                        args["expectedRevision"].as_str().map(str::to_owned),
                    )
                    .await
            }
            "project_resolve_review" => backend
                .project_resolve_review(
                    project.id.clone(),
                    args["path"].as_str().unwrap().into(),
                    args["undo"].as_bool().unwrap(),
                )
                .map(|_| Value::Null),
            "project_list" => backend.project_list(project.id.clone()),
            "project_read" => {
                backend.project_read(project.id.clone(), args["path"].as_str().unwrap().into())
            }
            "detect_texlive" => Ok(json!(backend.detect_texlive())),
            "plugin:event|listen" => Ok(json!(1)),
            _ => Ok(Value::Null),
        };
        respond(stream, result);
    }
}

fn respond(mut stream: std::net::TcpStream, result: Result<Value, String>) {
    let response = serde_json::to_vec(&match result {
        Ok(v) => json!({"value":v}),
        Err(e) => json!({"error":e}),
    })
    .unwrap();
    let headers=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len());
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(&response);
}
