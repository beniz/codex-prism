use serde_json::{json, Value};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq)]
pub enum BackendEvent {
    CollaborationChanged {
        project_id: String,
        operation_id: String,
        state: String,
    },
    Agent(Value),
    HistoryChanged {
        project_id: String,
        warning: Option<String>,
    },
    ProjectReview {
        project_id: String,
    },
    SkillsInstallLog(String),
    UvInstallOutput(String),
    UvInstallComplete(bool),
}
impl BackendEvent {
    /// Existing desktop wire contract; network hosts may use their own envelope.
    pub fn name(&self) -> &'static str {
        match self {
            Self::CollaborationChanged { .. } => "project-collaboration",
            Self::HistoryChanged { .. } => "project-history",
            Self::Agent(_) => "codex-event",
            Self::ProjectReview { .. } => "project-review",
            Self::SkillsInstallLog(_) => "skills-install-log",
            Self::UvInstallOutput(_) => "uv-install-output",
            Self::UvInstallComplete(_) => "uv-install-complete",
        }
    }
    pub fn payload(&self) -> Value {
        match self {
            Self::CollaborationChanged {
                project_id,
                operation_id,
                state,
            } => json!({"projectId":project_id,"operationId":operation_id,"state":state}),
            Self::Agent(value) => value.clone(),
            Self::HistoryChanged {
                project_id,
                warning,
            } => json!({"projectId":project_id,"warning":warning}),
            Self::ProjectReview { project_id } => json!({"projectId": project_id}),
            Self::SkillsInstallLog(value) | Self::UvInstallOutput(value) => json!(value),
            Self::UvInstallComplete(value) => json!(value),
        }
    }
}
/// Implementations must return promptly, never panic and tolerate a disconnected recipient.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: BackendEvent);
}
pub struct NoopEventSink;
impl EventSink for NoopEventSink {
    fn emit(&self, _: BackendEvent) {}
}
#[derive(Default)]
pub struct RecordingEventSink(Mutex<Vec<BackendEvent>>);
impl RecordingEventSink {
    pub fn take(&self) -> Vec<BackendEvent> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}
impl EventSink for RecordingEventSink {
    fn emit(&self, event: BackendEvent) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(event);
    }
}
