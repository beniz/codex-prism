//! Project-scoped native service facade. Paths are resolved only on this side of IPC.
use crate::{history, latex, projects, uv};
use serde_json::{json, Value};
pub(crate) async fn project_service(
    app: crate::Backend,
    project_id: String,
    operation: String,
    args: Value,
) -> Result<Value, String> {
    if operation == "instructions_get" || operation == "instructions_set" {
        let update = if operation == "instructions_set" {
            Some(args["text"].as_str().ok_or("Missing instructions text")?)
        } else { None };
        return Ok(json!(projects::instructions(&app, &project_id, update)?));
    }
    if operation == "project_preview" {
        return tokio::task::spawn_blocking(move || {
            crate::project_preview::discover(&app, &project_id)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if operation == "proposal_compile" {
        return crate::proposals::compile(app, project_id, args).await;
    }
    if operation.starts_with("proposal_") {
        let worker = app.clone();
        return tokio::task::spawn_blocking(move || {
            crate::proposals::service(&worker, &project_id, &operation, args)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if operation == "optimize_pdf" {
        projects::get(&app, &project_id)?;
        let encoded = args["pdfBase64"]
            .as_str()
            .ok_or("Missing PDF data")?
            .to_owned();
        let profile = match args.get("profile") {
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|_| "Invalid PDF export profile")?,
            None => crate::pdf_export::ExportProfile::default(),
        };
        return crate::pdf_export::optimize(&app, encoded, profile).await;
    }
    if operation.starts_with("visual_") {
        return crate::visual_review::service(&app, &project_id, &operation, args).await;
    }
    if operation == "compile_latex" || operation == "load_existing_pdf" {
        let project = projects::get(&app, &project_id)?;
        let main = args["mainFile"]
            .as_str()
            .ok_or("Missing mainFile")?
            .to_owned();
        projects::resolve(&project.root, &main)?;
        let root = project.root.to_string_lossy().to_string();
        return if operation == "compile_latex" {
            Ok(json!(
                latex::compile_latex(&app.inner.latex, root, main).await?
            ))
        } else {
            Ok(json!(
                latex::load_existing_pdf(&app.inner.latex, root, main).await?
            ))
        };
    }
    let state = &app.inner.codex;
    let _services = state.service_lock.lock().await;
    let project = projects::get(&app, &project_id)?;
    let root = project.root.to_string_lossy().to_string();
    if operation == "review_refresh" {
        let worker = app.clone();
        return tokio::task::spawn_blocking(move || {
            crate::codex::refresh_review(worker, project_id)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if operation.starts_with("history_") {
        if ["history_restore", "history_snapshot"].contains(&operation.as_str()) {
            crate::codex::assert_unlocked(&app, &project_id)?;
        }
        let worker = app.clone();
        let id = project_id.clone();
        return tokio::task::spawn_blocking(move || {
            if [
                "history_init",
                "history_snapshot",
                "history_restore",
                "history_retry",
            ]
            .contains(&operation.as_str())
            {
                if let Err(error) = crate::codex::settle_implicit_history(&worker, &id) {
                    history::workflow::warn(&root, &error);
                }
            }
            let str_arg = |key: &str| {
                args[key]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("Missing {key}"))
            };
            let result = (|| -> Result<Value, String> {
                match operation.as_str() {
                    "history_init" => {
                        let baseline = {
                            let _files =
                                worker.inner.projects.0.lock().map_err(|e| e.to_string())?;
                            crate::codex::history_baseline(&worker, &id)?
                        };
                        history::workflow::initialize(&root, Some(baseline))?;
                        Ok(Value::Null)
                    }
                    "history_status" => history::workflow::status(&root),
                    "history_set_prompt" => {
                        history::workflow::set_prompt(
                            &root,
                            args["enabled"].as_bool().ok_or("Missing enabled")?,
                        )?;
                        Ok(Value::Null)
                    }
                    "history_retry" => {
                        history::workflow::retry(&root)?;
                        Ok(Value::Null)
                    }
                    "history_snapshot" => Ok(json!(history::history_snapshot(
                        root.clone(),
                        str_arg("message")?
                    )?)),
                    "history_restore" => Ok(json!(history::history_restore(
                        root.clone(),
                        str_arg("snapshotId")?
                    )?)),
                    "history_list" => Ok(json!(history::history_list(
                        root.clone(),
                        args["limit"].as_u64().unwrap_or(50) as u32,
                        args["offset"].as_u64().unwrap_or(0) as u32
                    )?)),
                    "history_diff" => Ok(json!(history::history_diff(
                        root.clone(),
                        str_arg("fromId")?,
                        str_arg("toId")?
                    )?)),
                    "history_file_at" => {
                        let p = str_arg("filePath")?;
                        projects::resolve(&project.root, &p)?;
                        Ok(json!(history::history_file_at(
                            root.clone(),
                            str_arg("snapshotId")?,
                            p
                        )?))
                    }
                    "history_add_label" => {
                        history::history_add_label(
                            root.clone(),
                            str_arg("snapshotId")?,
                            str_arg("label")?,
                        )?;
                        Ok(Value::Null)
                    }
                    "history_remove_label" => {
                        history::history_remove_label(root.clone(), str_arg("label")?)?;
                        Ok(Value::Null)
                    }
                    _ => Err("Unsupported history operation".into()),
                }
            })();
            if ![
                "history_status",
                "history_list",
                "history_diff",
                "history_file_at",
            ]
            .contains(&operation.as_str())
            {
                if let Err(e) = &result {
                    history::workflow::warn(&root, e);
                }
                worker
                    .inner
                    .events
                    .emit(crate::BackendEvent::HistoryChanged {
                        project_id: id,
                        warning: result.as_ref().err().cloned(),
                    });
            }
            result
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let str_arg = |key: &str| -> Result<String, String> {
        args[key]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("Missing {key}"))
    };
    if ["history_restore", "history_snapshot", "setup_project_venv"].contains(&operation.as_str()) {
        crate::codex::assert_unlocked(&app, &project_id)?;
    }
    match operation.as_str() {
        "load_existing_pdf" => {
            let main = str_arg("mainFile")?;
            projects::resolve(&project.root, &main)?;
            let state = &app.inner.latex;
            Ok(json!(latex::load_existing_pdf(&state, root, main).await?))
        }
        "compile_latex" => {
            let main = str_arg("mainFile")?;
            projects::resolve(&project.root, &main)?;
            let state = &app.inner.latex;
            Ok(json!(latex::compile_latex(&state, root, main).await?))
        }
        "synctex_view" => {
            let main = str_arg("mainFile")?;
            let file = str_arg("filePath")?;
            projects::resolve(&project.root, &main)?;
            projects::resolve(&project.root, &file)?;
            let line = args["line"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 0)
                .ok_or("Invalid source line")?;
            let source_line = str_arg("sourceLine")?;
            let revision = str_arg("pdfRevision")?;
            tokio::task::spawn_blocking(move || {
                latex::synctex_view(&root, &main, &file, line, &source_line, &revision)
                    .map(|location| json!(location))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "synctex_edit" => {
            let state = &app.inner.latex;
            let result = latex::synctex_edit(
                &state,
                root,
                args["page"].as_u64().ok_or("Missing page")? as u32,
                args["x"].as_f64().ok_or("Missing x")?,
                args["y"].as_f64().ok_or("Missing y")?,
            )
            .await?;
            Ok(json!(result))
        }
        "project_venv_status" => Ok(json!(uv::project_venv_status(root))),
        "setup_project_venv" => Ok(json!(uv::setup_project_venv(app.clone(), root).await?)),
        _ => Err("Unsupported project service".into()),
    }
}
