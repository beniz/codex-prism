//! Desktop IPC adapters. Backend implementation lives in prism-core.

use prism_core::projects::*;

#[tauri::command]
pub fn project_register(
    backend: tauri::State<'_, prism_core::Backend>,
    root: String,
) -> Result<Project, String> {
    backend.project_register(root)
}

#[tauri::command]
pub fn project_relocate(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    root: String,
) -> Result<Project, String> {
    backend.project_relocate(project_id, root)
}

#[tauri::command]
pub async fn project_read(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    path: String,
) -> Result<serde_json::Value, String> {
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.project_read(project_id, path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn project_write(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    path: String,
    bytes: Vec<u8>,
    expected_revision: Option<String>,
) -> Result<String, String> {
    backend.project_write(project_id, path, bytes, expected_revision)
}

#[tauri::command]
pub fn project_mutate(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    path: String,
    action: String,
    destination: Option<String>,
) -> Result<(), String> {
    backend.project_mutate(project_id, path, action, destination)
}

#[tauri::command]
pub async fn project_list(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
) -> Result<serde_json::Value, String> {
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.project_list(project_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn project_rename(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    name: String,
) -> Result<Project, String> {
    backend.project_rename(project_id, name)
}
