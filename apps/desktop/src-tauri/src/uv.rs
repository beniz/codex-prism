//! Desktop IPC adapters. Backend implementation lives in prism-core.

use tauri::Manager;

use prism_core::uv::*;

#[tauri::command]
pub async fn check_uv_status(
    backend: tauri::State<'_, prism_core::Backend>,
) -> Result<UvStatus, String> {
    backend.check_uv_status().await
}

#[tauri::command]
pub async fn install_uv(window: tauri::WebviewWindow) -> Result<(), String> {
    let backend = window.state::<prism_core::Backend>().inner().clone();
    backend
        .install_uv(std::sync::Arc::new(
            crate::backend_host::DesktopEvents::for_window(window),
        ))
        .await
}
