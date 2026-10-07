//! Project-scoped native service facade. Paths are resolved only on this side of IPC.
use crate::{history, latex, projects, uv};
use serde_json::{json, Value};
use tauri::Manager;
#[tauri::command]
pub async fn project_service(
    app: tauri::AppHandle,
    project_id: String,
    operation: String,
    args: Value,
) -> Result<Value, String> {
    let state = app.state::<crate::codex::CodexState>();
    let _services = state.service_lock.lock().await;
    let project = projects::get(&app, &project_id)?;
    let root = project.root.to_string_lossy().to_string();
    let str_arg = |key: &str| -> Result<String, String> {
        args[key]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("Missing {key}"))
    };
    if [
        "history_restore",
        "history_snapshot",
        "setup_project_venv",
        "uv_add_packages",
    ]
    .contains(&operation.as_str())
    {
        crate::codex::assert_unlocked(&app, &project_id)?;
    }
    match operation.as_str() {
        "compile_latex" => {
            let main = str_arg("mainFile")?;
            projects::resolve(&project.root, &main)?;
            let state = app.state::<latex::LatexCompilerState>();
            Ok(json!(
                latex::compile_latex(&state, root, main, args["useTexlive"].as_bool()).await?
            ))
        }
        "synctex_edit" => {
            let state = app.state::<latex::LatexCompilerState>();
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
        "history_init" => {
            history::history_init(root)?;
            Ok(Value::Null)
        }
        "history_snapshot" => Ok(json!(history::history_snapshot(root, str_arg("message")?)?)),
        "history_list" => Ok(json!(history::history_list(
            root,
            args["limit"].as_u64().unwrap_or(50) as u32,
            args["offset"].as_u64().unwrap_or(0) as u32
        )?)),
        "history_diff" => Ok(json!(history::history_diff(
            root,
            str_arg("fromId")?,
            str_arg("toId")?
        )?)),
        "history_file_at" => {
            let file = str_arg("filePath")?;
            projects::resolve(&project.root, &file)?;
            Ok(json!(history::history_file_at(
                root,
                str_arg("snapshotId")?,
                file
            )?))
        }
        "history_restore" => Ok(json!(history::history_restore(
            root,
            str_arg("snapshotId")?
        )?)),
        "history_add_label" => {
            history::history_add_label(root, str_arg("snapshotId")?, str_arg("label")?)?;
            Ok(Value::Null)
        }
        "history_remove_label" => {
            history::history_remove_label(root, str_arg("label")?)?;
            Ok(Value::Null)
        }
        "setup_project_venv" => Ok(json!(uv::setup_project_venv(root).await?)),
        "uv_add_packages" => Ok(json!(
            uv::uv_add_packages(
                serde_json::from_value(args["packages"].clone()).map_err(|e| e.to_string())?,
                root
            )
            .await?
        )),
        _ => Err("Unsupported project service".into()),
    }
}
