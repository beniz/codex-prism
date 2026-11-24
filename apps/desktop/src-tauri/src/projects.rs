//! Desktop IPC adapters. Backend implementation lives in prism-core.

use prism_core::projects::*;

#[tauri::command]
pub async fn project_register(
    backend: tauri::State<'_, prism_core::Backend>,
    root: String,
) -> Result<Project, String> {
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.project_register(root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_relocate(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    root: String,
) -> Result<Project, String> {
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.project_relocate(project_id, root))
        .await
        .map_err(|e| e.to_string())?
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
pub async fn project_write(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    path: String,
    bytes: Vec<u8>,
    expected_revision: Option<String>,
    expected_branch: Option<String>,
) -> Result<String, String> {
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        backend.project_write_on_branch(project_id, path, bytes, expected_revision, expected_branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_mutate(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    path: String,
    action: String,
    destination: Option<String>,
    expected_branch: Option<String>,
) -> Result<(), String> {
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        backend.project_mutate_on_branch(project_id, path, action, destination, expected_branch)
    })
    .await
    .map_err(|e| e.to_string())?
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
pub async fn project_rename(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    name: String,
) -> Result<Project, String> {
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.project_rename(project_id, name))
        .await
        .map_err(|e| e.to_string())?
}
