//! Headless application services. Hosts supply paths, events and optional native integration.
//! Construct once per application and call `shutdown().await` before dropping the host runtime.
mod api;
mod codex;
mod collaboration;
mod data_sources;
mod source_completion;
mod remote_sources;
pub mod source_mcp;
pub mod discovery;
mod events;
mod file_policy;
mod history;
pub mod latex;
mod pdf_export;
mod project_preview;
pub mod projects;
pub mod proposals;
mod review_storage;
mod services;
pub mod skills;
pub mod templates;
pub mod uv;
mod visual_review;
#[cfg(target_os = "windows")]
mod windows_tools;
pub use events::{BackendEvent, EventSink, NoopEventSink, RecordingEventSink};

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug)]
pub struct BackendConfig {
    pub data_dir: PathBuf,
    pub home_dir: PathBuf,
    pub temp_dir: PathBuf,
}

/// Optional host hook, called only after ordinary directory creation fails.
/// Headless hosts never display native authorization dialogs by default.
pub trait DirectoryPreparer: Send + Sync {
    fn prepare(&self, target: &Path, ownership_root: &Path) -> Result<(), String>;
}
pub struct HeadlessDirectoryPreparer;
/// Native hosts provide an OS credential store; headless use stays session-only.
pub trait CredentialStore: Send + Sync {
    fn get(&self, server: &str) -> Result<Option<String>, String>;
    fn set(&self, server: &str, secret: &str) -> Result<(), String>;
    fn remove(&self, server: &str) -> Result<(), String>;
}
impl DirectoryPreparer for HeadlessDirectoryPreparer {
    fn prepare(&self, target: &Path, _: &Path) -> Result<(), String> {
        Err(format!(
            "Cannot create directory {}. Check its permissions.",
            target.display()
        ))
    }
}

#[derive(Clone)]
pub struct Backend {
    pub(crate) inner: Arc<Inner>,
}
pub(crate) struct Inner {
    config: BackendConfig,
    events: Arc<dyn EventSink>,
    directory_preparer: Arc<dyn DirectoryPreparer>,
    credential_store: Mutex<Option<Arc<dyn CredentialStore>>>,
    git_askpass: Mutex<Option<PathBuf>>,
    projects: projects::Projects,
    codex: codex::CodexState,
    collaboration: collaboration::State,
    remote: source_mcp::State,
    latex: latex::LatexCompilerState,
    templates: templates::TemplateState,
    lifecycle: Mutex<Lifecycle>,
    idle: tokio::sync::Notify,
    shutdown_lock: tokio::sync::Mutex<()>,
    cancel: tokio::sync::watch::Sender<bool>,
}
#[derive(Default)]
struct Lifecycle {
    stopping: bool,
    updating: bool,
    stopped: bool,
    active: usize,
}
pub(crate) struct OperationGuard(Backend);
impl Drop for OperationGuard {
    fn drop(&mut self) {
        let mut state = self
            .0
            .inner
            .lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        state.active -= 1;
        if state.active == 0 {
            self.0.inner.idle.notify_one();
        }
    }
}
/// Holding this guard prevents new backend operations without destroying the session.
pub struct UpdatePause(Backend);
impl Drop for UpdatePause {
    fn drop(&mut self) {
        self.0
            .inner
            .lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .updating = false;
    }
}

#[derive(Clone)]
pub(crate) struct OperationContext {
    backend: Backend,
    events: Arc<dyn EventSink>,
}
impl Backend {
    /// Host executable that handles PRISM_GIT_ASKPASS before normal startup.
    pub fn set_git_askpass(&self, executable: PathBuf) {
        if let Ok(mut current) = self.inner.git_askpass.lock() {
            *current = Some(executable);
        }
    }
    pub fn set_credential_store(&self, store: Arc<dyn CredentialStore>) {
        if let Ok(mut current) = self.inner.credential_store.lock() {
            *current = Some(store);
        }
    }
    pub fn new(config: BackendConfig, events: Arc<dyn EventSink>) -> Result<Self, String> {
        Self::with_directory_preparer(config, events, Arc::new(HeadlessDirectoryPreparer))
    }
    pub fn with_directory_preparer(
        config: BackendConfig,
        events: Arc<dyn EventSink>,
        directory_preparer: Arc<dyn DirectoryPreparer>,
    ) -> Result<Self, String> {
        for path in [&config.data_dir, &config.home_dir, &config.temp_dir] {
            if !path.is_absolute() {
                return Err("Backend paths must be absolute".into());
            }
        }
        std::fs::create_dir_all(&config.data_dir).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&config.temp_dir).map_err(|e| e.to_string())?;
        let (cancel, _) = tokio::sync::watch::channel(false);
        let backend = Self {
            inner: Arc::new(Inner {
                config,
                events,
                directory_preparer,
                credential_store: Mutex::new(None),
                git_askpass: Mutex::new(None),
                projects: Default::default(),
                codex: Default::default(),
                collaboration: Default::default(),
                remote: Default::default(),
                latex: Default::default(),
                templates: Default::default(),
                lifecycle: Default::default(),
                idle: Default::default(),
                shutdown_lock: Default::default(),
                cancel,
            }),
        };
        codex::recover(&backend);
        proposals::recover(&backend);
        Ok(backend)
    }
    pub(crate) fn enter(&self) -> Result<OperationGuard, String> {
        let mut state = self.inner.lifecycle.lock().map_err(|e| e.to_string())?;
        if state.stopping || state.updating {
            return Err("Application is restarting or updating".into());
        }
        state.active += 1;
        Ok(OperationGuard(self.clone()))
    }
    /// Atomically refuse an update while work is admitted and reject new work until released.
    pub fn pause_for_update(&self) -> Result<UpdatePause, String> {
        {
            let mut state = self.inner.lifecycle.lock().map_err(|e| e.to_string())?;
            if state.stopping || state.updating || state.active != 0 {
                return Err("Wait for application work to finish before restarting".into());
            }
            state.updating = true;
        }
        let pause = UpdatePause(self.clone());
        if self
            .inner
            .codex
            .reviews
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .any(|r| r.active)
        {
            return Err("Wait for agent turns to finish before restarting".into());
        }
        for project in projects::registry(self)? {
            if proposals::all(self, &project.id)?.iter().any(|p| {
                matches!(p.state.as_str(), "running" | "repairing" | "applying")
            }) {
                return Err("Wait for agent turns and proposal changes to finish before restarting".into());
            }
        }
        Ok(pause)
    }
    pub(crate) fn prepare_directory(
        &self,
        target: &Path,
        ownership_root: &Path,
    ) -> Result<(), String> {
        if std::fs::create_dir_all(target).is_ok() {
            return Ok(());
        }
        self.inner
            .directory_preparer
            .prepare(target, ownership_root)
    }
    pub(crate) fn emit_agent(&self, value: impl serde::Serialize) -> Result<(), String> {
        let payload = serde_json::to_value(value).map_err(|e| e.to_string())?;
        self.inner.events.emit(BackendEvent::Agent(payload));
        Ok(())
    }
    pub(crate) fn emit_review(&self, value: serde_json::Value) -> Result<(), String> {
        self.inner.events.emit(BackendEvent::ProjectReview {
            project_id: value["projectId"]
                .as_str()
                .ok_or("Missing project ID")?
                .into(),
        });
        Ok(())
    }
    pub fn list_default_projects(&self) -> Result<Vec<discovery::ProjectCandidate>, String> {
        let _operation = self.enter()?;
        discovery::list_default_projects(self.clone())
    }
    /// Release idle child processes before an installer may exit the process directly.
    /// Unlike shutdown, a failed installer handoff can reconnect and continue working.
    pub async fn cleanup_for_update(&self) {
        source_mcp::shutdown(self).await;
        codex::shutdown(self).await;
        latex::cleanup_all_builds(&self.inner.latex).await;
    }
    /// Idempotent explicit shutdown. Admitted foreground work drains before state is released.
    /// Persistent projects, history, reviews and build artifacts are retained.
    pub async fn shutdown(&self) {
        let _shutdown = self.inner.shutdown_lock.lock().await;
        {
            let mut state = self
                .inner
                .lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if state.stopped {
                return;
            }
            state.stopping = true;
        }
        self.inner.cancel.send_replace(true);
        collaboration::shutdown(self);
        loop {
            let idle = self.inner.idle.notified();
            if self
                .inner
                .lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .active
                == 0
            {
                break;
            }
            idle.await;
        }
        source_mcp::shutdown(self).await;
        codex::shutdown(self).await;
        latex::cleanup_all_builds(&self.inner.latex).await;
        self.inner
            .lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stopped = true;
    }
}

#[cfg(test)]
fn test_backend() -> (tempfile::TempDir, Backend) {
    let tmp = tempfile::tempdir().unwrap();
    let app = Backend::new(
        BackendConfig {
            data_dir: tmp.path().join("data"),
            home_dir: tmp.path().join("home"),
            temp_dir: tmp.path().join("tmp"),
        },
        Arc::new(NoopEventSink),
    )
    .unwrap();
    (tmp, app)
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn update_gate_is_exclusive_and_reversible() {
        let (_tmp, backend) = test_backend();
        let operation = backend.enter().unwrap();
        assert!(backend.pause_for_update().is_err());
        drop(operation);
        let pause = backend.pause_for_update().unwrap();
        assert!(backend.enter().is_err());
        assert!(backend.pause_for_update().is_err());
        drop(pause);
        assert!(backend.enter().is_ok());
    }

    #[tokio::test]
    async fn shutdown_drains_admitted_work_and_rejects_new_work() {
        let (_tmp, backend) = test_backend();
        let guard = backend.enter().unwrap();
        let other = backend.clone();
        let shutdown = tokio::spawn(async move { other.shutdown().await });
        // Synchronize on shutdown's cancellation signal rather than scheduling guesses.
        let mut cancelled = backend.inner.cancel.subscribe();
        if !*cancelled.borrow_and_update() {
            cancelled.changed().await.unwrap();
        }
        assert!(!shutdown.is_finished());
        assert!(backend.enter().is_err());
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(1), shutdown)
            .await
            .unwrap()
            .unwrap();
        backend.shutdown().await;
    }
    #[tokio::test]
    async fn dropping_a_service_response_does_not_abandon_admitted_work() {
        let (tmp, backend) = test_backend();
        let project = backend
            .project_register(tmp.path().to_string_lossy().into())
            .unwrap();
        let lock = backend.inner.codex.service_lock.lock().await;
        let host_backend = backend.clone();
        let host = tokio::spawn(async move {
            host_backend
                .project_service(project.id, "history_init".into(), serde_json::json!({}))
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while backend.inner.lifecycle.lock().unwrap().active == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        host.abort();
        let _ = host.await;
        let other = backend.clone();
        let shutdown = tokio::spawn(async move { other.shutdown().await });
        let mut cancelled = backend.inner.cancel.subscribe();
        if !*cancelled.borrow_and_update() {
            cancelled.changed().await.unwrap();
        }
        assert!(!shutdown.is_finished());
        drop(lock);
        tokio::time::timeout(std::time::Duration::from_secs(10), shutdown)
            .await
            .unwrap()
            .unwrap();
        assert!(tmp.path().join(".git").is_dir());
    }
    #[test]
    fn headless_permission_failure_never_invokes_native_ui() {
        let (tmp, backend) = test_backend();
        let file = tmp.path().join("file");
        std::fs::write(&file, "blocking file").unwrap();
        assert!(backend
            .prepare_directory(&file.join("child"), &file)
            .unwrap_err()
            .contains("Check its permissions"));
    }
}
