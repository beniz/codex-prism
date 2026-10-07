use crate::Backend;
use crate::{codex, latex, projects, services, skills, uv};
use serde_json::Value;
impl Backend {
    pub fn project_register(&self, root: String) -> Result<projects::Project, String> {
        let _operation = self.enter()?;
        projects::project_register(self.clone(), root)
    }
    pub fn project_relocate(
        &self,
        project_id: String,
        root: String,
    ) -> Result<projects::Project, String> {
        let _operation = self.enter()?;
        projects::project_relocate(self.clone(), project_id, root)
    }
    pub fn project_read(
        &self,
        project_id: String,
        path: String,
    ) -> Result<serde_json::Value, String> {
        let _operation = self.enter()?;
        projects::project_read(self.clone(), project_id, path)
    }
    pub fn project_write(
        &self,
        project_id: String,
        path: String,
        bytes: Vec<u8>,
        expected_revision: Option<String>,
    ) -> Result<String, String> {
        let _operation = self.enter()?;
        projects::project_write(self.clone(), project_id, path, bytes, expected_revision)
    }
    pub fn project_mutate(
        &self,
        project_id: String,
        path: String,
        action: String,
        destination: Option<String>,
    ) -> Result<(), String> {
        let _operation = self.enter()?;
        projects::project_mutate(self.clone(), project_id, path, action, destination)
    }
    pub fn project_list(&self, project_id: String) -> Result<serde_json::Value, String> {
        let _operation = self.enter()?;
        projects::project_list(self.clone(), project_id)
    }
    pub fn project_rename(
        &self,
        project_id: String,
        name: String,
    ) -> Result<projects::Project, String> {
        let _operation = self.enter()?;
        projects::project_rename(self.clone(), project_id, name)
    }
    pub fn detect_texlive(&self) -> latex::TexliveStatus {
        latex::detect_texlive()
    }
    pub async fn codex_status(&self) -> Result<serde_json::Value, String> {
        let _operation = self.enter()?;
        codex::codex_status(self.clone()).await
    }
    pub async fn codex_set_path(&self, path: String) -> Result<(), String> {
        let _operation = self.enter()?;
        codex::codex_set_path(self.clone(), path).await
    }
    pub async fn codex_account(&self, action: String) -> Result<serde_json::Value, String> {
        let _operation = self.enter()?;
        codex::codex_account(self.clone(), action).await
    }
    pub async fn codex_sessions(&self, project_id: String) -> Result<serde_json::Value, String> {
        let _operation = self.enter()?;
        codex::codex_sessions(self.clone(), project_id).await
    }
    pub async fn codex_thread(
        &self,
        project_id: String,
        thread_id: String,
        action: String,
        title: Option<String>,
    ) -> Result<serde_json::Value, String> {
        let _operation = self.enter()?;
        codex::codex_thread(self.clone(), project_id, thread_id, action, title).await
    }
    pub async fn codex_send(
        &self,
        project_id: String,
        thread_id: Option<String>,
        prompt: String,
        model: Option<String>,
        effort: Option<String>,
        images: Option<Vec<String>>,
    ) -> Result<serde_json::Value, String> {
        let _operation = self.enter()?;
        codex::codex_send(
            self.clone(),
            project_id,
            thread_id,
            prompt,
            model,
            effort,
            images,
        )
        .await
    }
    pub async fn codex_control(
        &self,
        project_id: String,
        thread_id: String,
        turn_id: String,
        prompt: Option<String>,
    ) -> Result<serde_json::Value, String> {
        let _operation = self.enter()?;
        codex::codex_control(self.clone(), project_id, thread_id, turn_id, prompt).await
    }
    pub async fn codex_respond(&self, id: Value, result: Value) -> Result<(), String> {
        let _operation = self.enter()?;
        codex::codex_respond(self.clone(), id, result).await
    }
    pub fn project_review(&self, project_id: String) -> Result<serde_json::Value, String> {
        let _operation = self.enter()?;
        codex::project_review(self.clone(), project_id)
    }
    pub fn project_resolve_review(
        &self,
        project_id: String,
        path: String,
        undo: bool,
    ) -> Result<(), String> {
        let _operation = self.enter()?;
        codex::project_resolve_review(self.clone(), project_id, path, undo)
    }
    pub async fn project_service(
        &self,
        project_id: String,
        operation: String,
        args: Value,
    ) -> Result<serde_json::Value, String> {
        let admitted = self.enter()?;
        let backend = self.clone();
        // Keep admitted work owned by the backend if its host drops the response future.
        // In particular, compilation and environment child processes must drain on shutdown.
        tokio::spawn(async move {
            let _operation = admitted;
            services::project_service(backend, project_id, operation, args).await
        })
        .await
        .map_err(|e| format!("Project service task failed: {e}"))?
    }
    pub async fn check_uv_status(&self) -> Result<uv::UvStatus, String> {
        let _operation = self.enter()?;
        uv::check_uv_status(self.clone()).await
    }
    pub async fn install_uv(
        &self,
        events: std::sync::Arc<dyn crate::EventSink>,
    ) -> Result<(), String> {
        let _operation = self.enter()?;
        uv::install_uv(crate::OperationContext {
            backend: self.clone(),
            events,
        })
        .await
    }
    pub async fn install_scientific_skills_global(
        &self,
        events: std::sync::Arc<dyn crate::EventSink>,
    ) -> Result<skills::InstallResult, String> {
        let _operation = self.enter()?;
        let mut cancel = self.inner.cancel.subscribe();
        tokio::select! {
            result = skills::install_scientific_skills_global(crate::OperationContext { backend: self.clone(), events }) => result,
            _ = async { if !*cancel.borrow_and_update() { let _ = cancel.changed().await; } } => Err("Backend is shutting down".into()),
        }
    }
    pub async fn import_skill_from_folder(
        &self,
        source_path: String,
    ) -> Result<Vec<skills::SkillInfo>, String> {
        let _operation = self.enter()?;
        skills::import_skill_from_folder(self.clone(), source_path).await
    }
    pub async fn check_skills_installed(
        &self,
        project_path: Option<String>,
    ) -> Result<skills::SkillsStatus, String> {
        let _operation = self.enter()?;
        skills::check_skills_installed(self.clone(), project_path).await
    }
    pub async fn list_installed_skills(
        &self,
        project_path: Option<String>,
    ) -> Result<Vec<skills::SkillInfo>, String> {
        let _operation = self.enter()?;
        skills::list_installed_skills(self.clone(), project_path).await
    }
    pub async fn delete_installed_skill(&self, skill_folder: String) -> Result<(), String> {
        let _operation = self.enter()?;
        skills::delete_installed_skill(self.clone(), skill_folder).await
    }
    pub async fn uninstall_scientific_skills(
        &self,
        project_path: Option<String>,
    ) -> Result<(), String> {
        let _operation = self.enter()?;
        skills::uninstall_scientific_skills(self.clone(), project_path).await
    }
    pub fn get_skill_categories(&self) -> Vec<skills::SkillCategory> {
        skills::get_skill_categories()
    }
    pub async fn get_skill_content(
        &self,
        skill_folder: String,
        project_path: Option<String>,
    ) -> Result<String, String> {
        let _operation = self.enter()?;
        skills::get_skill_content(self.clone(), skill_folder, project_path).await
    }
}
