//! Desktop IPC adapters. Backend implementation lives in prism-core.

#[tauri::command]
pub async fn project_service(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    operation: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    backend.project_service(project_id, operation, args).await
}
