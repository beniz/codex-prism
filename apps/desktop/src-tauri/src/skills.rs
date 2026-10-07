//! Desktop IPC adapters. Backend implementation lives in prism-core.

use tauri::Manager;

use prism_core::skills::*;

#[tauri::command]
pub async fn install_scientific_skills_global(
    window: tauri::WebviewWindow,
) -> Result<InstallResult, String> {
    let backend = window.state::<prism_core::Backend>().inner().clone();
    backend
        .install_scientific_skills_global(std::sync::Arc::new(
            crate::backend_host::DesktopEvents::for_window(window),
        ))
        .await
}

#[tauri::command]
pub async fn import_skill_from_folder(
    backend: tauri::State<'_, prism_core::Backend>,
    source_path: String,
) -> Result<Vec<SkillInfo>, String> {
    backend.import_skill_from_folder(source_path).await
}

#[tauri::command]
pub async fn check_skills_installed(
    backend: tauri::State<'_, prism_core::Backend>,
    project_path: Option<String>,
) -> Result<SkillsStatus, String> {
    backend.check_skills_installed(project_path).await
}

#[tauri::command]
pub async fn list_installed_skills(
    backend: tauri::State<'_, prism_core::Backend>,
    project_path: Option<String>,
) -> Result<Vec<SkillInfo>, String> {
    backend.list_installed_skills(project_path).await
}

#[tauri::command]
pub async fn delete_installed_skill(
    backend: tauri::State<'_, prism_core::Backend>,
    skill_folder: String,
) -> Result<(), String> {
    backend.delete_installed_skill(skill_folder).await
}

#[tauri::command]
pub async fn uninstall_scientific_skills(
    backend: tauri::State<'_, prism_core::Backend>,
    project_path: Option<String>,
) -> Result<(), String> {
    backend.uninstall_scientific_skills(project_path).await
}

#[tauri::command]
pub fn get_skill_categories(backend: tauri::State<'_, prism_core::Backend>) -> Vec<SkillCategory> {
    backend.get_skill_categories()
}

#[tauri::command]
pub async fn get_skill_content(
    backend: tauri::State<'_, prism_core::Backend>,
    skill_folder: String,
    project_path: Option<String>,
) -> Result<String, String> {
    backend.get_skill_content(skill_folder, project_path).await
}
