//! Desktop IPC adapters. Backend implementation lives in prism-core.

#[tauri::command]
pub async fn codex_status(
    backend: tauri::State<'_, prism_core::Backend>,
) -> Result<serde_json::Value, String> {
    backend.codex_status().await
}

#[tauri::command]
pub async fn codex_set_path(
    backend: tauri::State<'_, prism_core::Backend>,
    path: String,
) -> Result<(), String> {
    backend.codex_set_path(path).await
}

#[tauri::command]
pub async fn codex_account(
    backend: tauri::State<'_, prism_core::Backend>,
    action: String,
) -> Result<serde_json::Value, String> {
    backend.codex_account(action).await
}

#[tauri::command]
pub async fn codex_sessions(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
) -> Result<serde_json::Value, String> {
    backend.codex_sessions(project_id).await
}

#[tauri::command]
pub async fn codex_thread(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    thread_id: String,
    action: String,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    backend
        .codex_thread(project_id, thread_id, action, title)
        .await
}

#[tauri::command]
pub async fn codex_send(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    thread_id: Option<String>,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    images: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    backend
        .codex_send(project_id, thread_id, prompt, model, effort, images)
        .await
}

#[tauri::command]
pub async fn codex_control(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    thread_id: String,
    turn_id: String,
    prompt: Option<String>,
) -> Result<serde_json::Value, String> {
    backend
        .codex_control(project_id, thread_id, turn_id, prompt)
        .await
}

#[tauri::command]
pub async fn codex_respond(
    backend: tauri::State<'_, prism_core::Backend>,
    id: serde_json::Value,
    result: serde_json::Value,
) -> Result<(), String> {
    backend.codex_respond(id, result).await
}

#[tauri::command]
pub fn project_review(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
) -> Result<serde_json::Value, String> {
    backend.project_review(project_id)
}

#[tauri::command]
pub fn project_resolve_review(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    path: String,
    undo: bool,
) -> Result<(), String> {
    backend.project_resolve_review(project_id, path, undo)
}
