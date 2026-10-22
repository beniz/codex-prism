//! Supervised app-server connection. No model credentials pass through the webview.
use crate::projects::{self, save_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex as AsyncMutex},
};

type Reply = oneshot::Sender<Result<Value, String>>;
#[derive(Default)]
pub struct CodexState {
    inner: AsyncMutex<Option<Arc<Connection>>>,
    pub reviews: Mutex<HashMap<String, Review>>,
    startup: AsyncMutex<()>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    pub service_lock: AsyncMutex<()>,
}
struct Connection {
    cancel: tokio::sync::watch::Receiver<bool>,
    stdin: AsyncMutex<ChildStdin>,
    child: AsyncMutex<Child>,
    pending: Mutex<HashMap<u64, Reply>>,
    requests: Mutex<HashMap<String, Value>>,
    turns: Mutex<HashMap<String, String>>,
    next: std::sync::atomic::AtomicU64,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub project_id: String,
    pub active: bool,
    #[serde(default)]
    pub history_prompts: Vec<String>,
    #[serde(default)]
    pub history_id: String,
    #[serde(default)]
    pub visual: Option<crate::visual_review::VisualReview>,
    pub before: BTreeMap<String, Vec<u8>>,
    pub after: BTreeMap<String, Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) previous: Option<Box<Review>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    project_id: String,
    id: String,
    title: String,
}
fn sessions(app: &crate::Backend) -> Result<Vec<Session>, String> {
    let p = projects::data_dir(app)?.join("sessions.json");
    if !p.exists() {
        return Ok(vec![]);
    }
    serde_json::from_slice(&std::fs::read(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
pub(crate) fn review_path(app: &crate::Backend, id: &str) -> Result<std::path::PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
    Ok(projects::data_dir(app)?.join(format!("review-{id}.json")))
}
pub(crate) fn assert_unlocked(app: &crate::Backend, id: &str) -> Result<(), String> {
    if review_path(app, id)?.exists() || crate::proposals::locked(app, id)? {
        return Err("Project is locked by an agent turn or pending review".into());
    }
    Ok(())
}
impl Connection {
    fn receive_response(&self, v: &Value) {
        if let Some(id) = v["id"].as_u64() {
            if let Ok(mut pending) = self.pending.lock() {
                if let Some(tx) = pending.remove(&id) {
                    let result = if let Some(err) = v.get("error") {
                        Err(err.to_string())
                    } else {
                        Ok(v["result"].clone())
                    };
                    let _ = tx.send(result);
                }
            }
        }
    }

    async fn stop(&self) -> Result<(), String> {
        let mut child = self.child.lock().await;
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await;
        }
        child.kill().await.map_err(|e| e.to_string())
    }
    async fn write(&self, v: Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(&v).map_err(|e| e.to_string())?;
        line.push(b'\n');
        self.stdin
            .lock()
            .await
            .write_all(&line)
            .await
            .map_err(|e| e.to_string())
    }
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, tx);
        if let Err(e) = self
            .write(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
            return Err(e);
        }
        let mut cancel = self.cancel.clone();
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(90), rx) => result,
            _ = async { if !*cancel.borrow_and_update() { let _ = cancel.changed().await; } } => {
                self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
                return Err("Codex disconnected: backend is shutting down".into());
            }
        };
        self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
        result
            .map_err(|_| "Codex request timed out; check the session before retrying".to_string())?
            .map_err(|_| "Codex disconnected".to_string())?
    }
}
fn executable(app: &crate::Backend) -> Result<String, String> {
    let p = projects::data_dir(app)?.join("codex-path.txt");
    let configured = std::fs::read_to_string(p).unwrap_or_default();
    if !configured.trim().is_empty() {
        return Ok(configured.trim().into());
    }
    #[cfg(target_os = "windows")]
    if let Some(path) = crate::windows_tools::find("codex") {
        return Ok(path.to_string_lossy().into());
    }
    if let Ok(path) = which::which("codex") {
        return Ok(path.to_string_lossy().into());
    }
    // Finder-launched apps may not have Codex on PATH. ChatGPT bundles a CLI
    // that can also run the app-server used by this backend.
    #[cfg(target_os = "macos")]
    if let Ok(path) = which::which(
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    ) {
        return Ok(path.to_string_lossy().into());
    }
    Err("Codex was not found automatically. Set its executable path in Settings.".into())
}
async fn connection(app: &crate::Backend) -> Result<Arc<Connection>, String> {
    let state = &app.inner.codex;
    let _start = state.startup.lock().await;
    if let Some(c) = state.inner.lock().await.as_ref() {
        return Ok(c.clone());
    }
    let mut cmd = Command::new(executable(app)?);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.args(["app-server", "--listen", "stdio://"]);
    #[cfg(unix)]
    cmd.process_group(0);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Cannot start Codex: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing stdout")?;
    let stderr = child.stderr.take().ok_or("Missing stderr")?;
    let stdin = child.stdin.take().ok_or("Missing stdin")?;
    let c = Arc::new(Connection {
        cancel: app.inner.cancel.subscribe(),
        stdin: AsyncMutex::new(stdin),
        child: AsyncMutex::new(child),
        pending: Mutex::new(HashMap::new()),
        requests: Mutex::new(HashMap::new()),
        turns: Mutex::new(HashMap::new()),
        next: std::sync::atomic::AtomicU64::new(1),
    });
    let read = c.clone();
    let handle = app.clone();
    let reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut completions = tokio::task::JoinSet::new();
        while let Ok(Some(line)) = lines.next_line().await {
            while completions.try_join_next().is_some() {}
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v.get("method").is_some() {
                if let Some(id) = v.get("id") {
                    let method = v["method"].as_str().unwrap_or("");
                    if ![
                        "item/commandExecution/requestApproval",
                        "item/fileChange/requestApproval",
                        "item/permissions/requestApproval",
                        "item/tool/requestUserInput",
                        "mcpServer/elicitation/request",
                    ]
                    .contains(&method)
                    {
                        let _=read.write(json!({"id":id,"error":{"code":-32601,"message":"Interaction not supported by codex-prism"}})).await;
                        let _=handle.emit_agent(json!({"method":"prism/unsupportedRequest","params":{"method":method,"threadId":v["params"]["threadId"]}}));
                        continue;
                    }
                    if let Ok(mut requests) = read.requests.lock() {
                        requests.insert(id.to_string(), v.clone());
                    }
                }
                if v["method"] == "turn/started" {
                    if let (Some(thread), Some(turn)) = (
                        v["params"]["threadId"].as_str(),
                        v["params"]["turn"]["id"].as_str(),
                    ) {
                        if let Ok(mut turns) = read.turns.lock() {
                            turns.insert(thread.into(), turn.into());
                        }
                        if let Ok(all) = sessions(&handle) {
                            if let Some(session) = all.iter().find(|s| s.id == thread) {
                                let _ = confirm_review_start(&handle, &session.project_id);
                            }
                        }
                    }
                }
                if v["method"] == "serverRequest/resolved" {
                    if let Ok(mut requests) = read.requests.lock() {
                        requests.remove(&v["params"]["requestId"].to_string());
                    }
                }
                if v["method"] == "turn/completed" {
                    if let Some(thread) = v["params"]["threadId"].as_str() {
                        if let Ok(mut turns) = read.turns.lock() {
                            turns.remove(thread);
                        }
                        if let Ok(mut requests) = read.requests.lock() {
                            requests.retain(|_, r| r["params"]["threadId"] != thread);
                        }
                    }
                    let worker = handle.clone();
                    completions.spawn_blocking(move || {
                        if let Some(thread) = v["params"]["threadId"].as_str() {
                            if let Ok(all) = sessions(&worker) {
                                if let Some(s) = all.iter().find(|s| s.id == thread) {
                                    let _ = crate::proposals::finish_turn(
                                        &worker,
                                        &s.project_id,
                                        &s.id,
                                        v["params"]["turn"]["id"].as_str(),
                                    );
                                    let _ = finish_review(&worker, &s.project_id);
                                }
                            }
                        }
                        let _ = worker.emit_agent(&v);
                    });
                    continue;
                }
                let _ = handle.emit_agent(&v);
            } else {
                read.receive_response(&v);
            }
        }
        let _ = read.stop().await;
        while completions.join_next().await.is_some() {}
        if let Ok(mut pending) = read.pending.lock() {
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err("Codex process exited".into()));
            }
        }
        let state = &handle.inner.codex;
        if let Ok(all) = sessions(&handle) {
            for s in all {
                let _ = crate::proposals::finish_thread(&handle, &s.project_id, &s.id, true);
                let _ = finish_review(&handle, &s.project_id);
            }
        }
        let mut inner = state.inner.lock().await;
        if inner
            .as_ref()
            .map(|c| Arc::ptr_eq(c, &read))
            .unwrap_or(false)
        {
            *inner = None;
        }
        drop(inner);
        let _ = handle.emit_agent(json!({"method":"connection/closed","params":{}}));
    });
    let stderr_reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(_line)) = lines.next_line().await { /* Drain stderr; never forward potentially sensitive diagnostics to clients. */
        }
    });
    state
        .tasks
        .lock()
        .map_err(|e| e.to_string())?
        .extend([reader, stderr_reader]);
    let initialized=c.call("initialize",json!({"clientInfo":{"name":"codex_prism","title":"codex-prism","version":"0.1.0"},"capabilities":{}})).await;
    if let Err(e) = initialized {
        let _ = c.stop().await;
        return Err(e);
    }
    c.write(json!({"method":"initialized"})).await?;
    *state.inner.lock().await = Some(c.clone());
    Ok(c)
}
// Reserve the project and durably retain the previous review until turn/start succeeds.
#[cfg(test)]
fn prepare_review(
    id: String,
    previous: Option<Review>,
    before: BTreeMap<String, Vec<u8>>,
) -> Result<Review, String> {
    if previous.as_ref().is_some_and(|r| r.active) {
        return Err("Project already has an active turn".into());
    }
    Ok(Review {
        project_id: id,
        history_prompts: vec![],
        history_id: uuid::Uuid::new_v4().to_string(),
        visual: None,
        active: true,
        before,
        after: BTreeMap::new(),
        previous: previous.map(Box::new),
    })
}

fn history_result(app: &crate::Backend, id: &str, result: Result<(), String>) {
    let warning = result.as_ref().err().cloned();
    if let Err(error) = result {
        if let Ok(project) = projects::get(app, id) {
            crate::history::workflow::warn(&project.root.to_string_lossy(), &error);
        }
    }
    app.inner.events.emit(crate::BackendEvent::HistoryChanged {
        project_id: id.into(),
        warning,
    });
}
pub(crate) fn history_baseline(
    app: &crate::Backend,
    id: &str,
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let root = projects::get(app, id)?.root;
    let mut inputs = crate::history::workflow::capture(&root.to_string_lossy())
        .or_else(|_| projects::snapshot(&root))?;
    let path = review_path(app, id)?;
    if path.exists() {
        let r = crate::review_storage::load(&path)?;
        let baseline = r.previous.as_deref().unwrap_or(&r);
        for p in baseline.before.keys().chain(baseline.after.keys()) {
            if let Some(bytes) = baseline.before.get(p) {
                inputs.insert(p.clone(), bytes.clone());
            } else {
                inputs.remove(p);
            }
        }
    }
    Ok(inputs)
}
fn history_before_turn(app: &crate::Backend, id: &str) -> Result<(), String> {
    let root = projects::get(app, id)?.root;
    let inputs = projects::isolated_snapshot(&root)?;
    crate::history::workflow::initialize(&root.to_string_lossy(), Some(inputs))?;
    Ok(())
}
fn acceptance_id(r: &Review, paths: &[String]) -> String {
    use sha1::{Digest, Sha1};
    let mut digest = Sha1::new();
    for field in [&r.project_id, &r.history_id] {
        digest.update(field.len().to_le_bytes());
        digest.update(field.as_bytes());
    }
    for files in [&r.before, &r.after] {
        digest.update(files.len().to_le_bytes());
        for (path, bytes) in files {
            digest.update(path.len().to_le_bytes());
            digest.update(path.as_bytes());
            digest.update(bytes.len().to_le_bytes());
            digest.update(bytes);
        }
    }
    for path in paths {
        digest.update(path.len().to_le_bytes());
        digest.update(path.as_bytes());
    }
    format!("{:x}", digest.finalize())
}
pub(crate) fn review_revision(r: &Review) -> String {
    acceptance_id(r, &[])
}
fn record_acceptance(
    app: &crate::Backend,
    id: &str,
    r: &Review,
    paths: &[String],
) -> Result<(), String> {
    let root = projects::get(app, id)?.root.to_string_lossy().to_string();
    let patch = paths
        .iter()
        .map(|p| (p.clone(), r.after.get(p).cloned()))
        .collect();
    crate::history::workflow::accept(&root, &acceptance_id(r, paths), patch, &r.history_prompts)?;
    Ok(())
}
#[derive(Serialize, Deserialize)]
struct AcceptanceIntent {
    review: Review,
    paths: Vec<String>,
    implicit: bool,
}
fn intent_path(app: &crate::Backend, id: &str) -> Result<std::path::PathBuf, String> {
    Ok(projects::data_dir(app)?.join(format!("history-accept-{id}.json")))
}
fn confirm_review_start(app: &crate::Backend, id: &str) -> Result<(), String> {
    let path = review_path(app, id)?;
    let previous = {
        let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
        if !path.exists() {
            return Ok(());
        }
        let r = crate::review_storage::load(&path)?;
        if let Some(previous) = &r.previous {
            let mut paths: Vec<_> = previous
                .before
                .keys()
                .chain(previous.after.keys())
                .filter(|p| previous.before.get(*p) != previous.after.get(*p))
                .cloned()
                .collect();
            paths.sort();
            paths.dedup();
            // Record acknowledged startup before retiring the previous pending review.
            if let Err(error) = save_json(
                &intent_path(app, id)?,
                &AcceptanceIntent {
                    review: (**previous).clone(),
                    paths,
                    implicit: true,
                },
            ) {
                history_result(app, id, Err(error));
            }
        }
        crate::review_storage::confirm_start(&path)?;
        r.previous
    };
    if previous.is_some() {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let worker = app.clone();
            let id = id.to_owned();
            let admitted = app.enter()?;
            let task = runtime.spawn(async move {
                let _operation = admitted;
                let _services = worker.inner.codex.service_lock.lock().await;
                let job = worker.clone();
                let _ =
                    tokio::task::spawn_blocking(move || finish_acceptance_intent(&job, &id)).await;
            });
            app.inner
                .codex
                .tasks
                .lock()
                .map_err(|e| e.to_string())?
                .push(task);
        } else {
            finish_acceptance_intent(app, id)?;
        }
    }
    Ok(())
}
pub(crate) fn settle_implicit_history(app: &crate::Backend, id: &str) -> Result<(), String> {
    let path = intent_path(app, id)?;
    if path.exists() {
        let intent: AcceptanceIntent =
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if intent.implicit {
            finish_acceptance_intent(app, id)?;
        }
    }
    Ok(())
}
fn finish_acceptance_intent(app: &crate::Backend, id: &str) -> Result<(), String> {
    let path = intent_path(app, id)?;
    if !path.exists() {
        return Ok(());
    }
    let intent: AcceptanceIntent =
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let result = record_acceptance(app, id, &intent.review, &intent.paths);
    let recorded = result.is_ok();
    history_result(app, id, result);
    // Failed Git operations have their own durable immutable queue. Keep this
    // intent too when that queue could not be written (e.g. a read-only disk).
    let queued = projects::get(app, id)
        .ok()
        .and_then(|p| crate::history::workflow::status(&p.root.to_string_lossy()).ok())
        .is_some_and(|s| s["pending"].as_u64().unwrap_or(0) > 0);
    if recorded || queued {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn finish_review_state(r: &mut Review, after: BTreeMap<String, Vec<u8>>) {
    if let Some(previous) = r.previous.take() {
        if after == r.before {
            // Startup failed without editing anything: restore the exact pending review.
            *r = *previous;
            return;
        }
        // This merged revision has no matching compiled baseline.
        r.visual = None;
        // An interrupted, unacknowledged start may have edited files. Preserve both
        // the old pending changes and new edits for review rather than accepting them.
        for path in previous.before.keys().chain(previous.after.keys()) {
            if previous.before.get(path) != previous.after.get(path) {
                if let Some(bytes) = previous.before.get(path) {
                    r.before.insert(path.clone(), bytes.clone());
                } else {
                    r.before.remove(path);
                }
            }
        }
    }
    if let Some(visual) = &mut r.visual {
        visual.after = None;
        visual.state = "preparing".into();
    }
    r.after = after;
    r.active = false;
}

fn finish_review(app: &crate::Backend, id: &str) -> Result<(), String> {
    let projects = &app.inner.projects;
    let _files = projects.0.lock().map_err(|e| e.to_string())?;
    let path = review_path(app, id)?;
    if !path.exists() {
        return Ok(());
    }
    let mut r: Review = crate::review_storage::load(&path)?;
    if !r.active {
        return Ok(());
    }
    let after = projects::snapshot(&projects::get(app, id)?.root)?;
    let captured = r
        .visual
        .as_ref()
        .map(|v| crate::visual_review::capture(app, id, &v.main, &after));
    finish_review_state(&mut r, after);
    if let (Some(v), Some(result)) = (&mut r.visual, captured) {
        if v.state == "preparing" {
            match result {
                Ok(artifact) => v.after = Some(artifact),
                Err(error) => {
                    v.state = "unavailable".into();
                    v.error = Some(error);
                }
            }
        }
    }
    let unchanged: Vec<_> = r
        .before
        .keys()
        .filter(|p| r.before.get(*p) == r.after.get(*p))
        .cloned()
        .collect();
    for path in unchanged {
        r.before.remove(&path);
        r.after.remove(&path);
    }
    if r.before == r.after {
        crate::review_storage::remove(&path)?;
    } else {
        crate::review_storage::save(&path, &r)?;
    }
    app.inner
        .codex
        .reviews
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id);
    let has_visual = r.visual.is_some() && r.before != r.after;
    drop(_files);
    let _ = app.emit_review(json!({"projectId":id}));
    if has_visual {
        schedule_visual_report(app, id, true)?;
    }
    Ok(())
}
fn schedule_visual_report(app: &crate::Backend, id: &str, rebuild: bool) -> Result<(), String> {
    if let (Ok(runtime), Ok(admitted)) = (tokio::runtime::Handle::try_current(), app.enter()) {
        let worker = app.clone();
        let id = id.to_owned();
        let task = runtime.spawn(async move {
            let _operation = admitted;
            if rebuild {
                let _ =
                    crate::visual_review::service(&worker, &id, "visual_report", json!({})).await;
                let _ = worker.emit_review(json!({"projectId":id}));
            }
            let _ = crate::visual_review::cleanup(&worker, &id).await;
        });
        let mut tasks = app.inner.codex.tasks.lock().map_err(|e| e.to_string())?;
        tasks.retain(|task| !task.is_finished());
        tasks.push(task);
    }
    Ok(())
}
pub(crate) async fn codex_status(app: crate::Backend) -> Result<Value, String> {
    let binary = executable(&app)?;
    let version = Command::new(&binary)
        .arg("--version")
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let c = connection(&app).await?;
    let account = c
        .call("account/read", json!({"refreshToken":false}))
        .await?;
    let models = c.call("model/list", json!({})).await?;
    Ok(
        json!({"binary":binary,"version":String::from_utf8_lossy(&version.stdout).trim(),"account":account,"models":models}),
    )
}
pub(crate) async fn codex_set_path(app: crate::Backend, path: String) -> Result<(), String> {
    // Persist for the next launch; an active server continues using its current executable.
    std::fs::write(projects::data_dir(&app)?.join("codex-path.txt"), path)
        .map_err(|e| e.to_string())
}
pub(crate) async fn codex_account(app: crate::Backend, action: String) -> Result<Value, String> {
    let c = connection(&app).await?;
    match action.as_str() {
        "login" => {
            c.call("account/login/start", json!({"type":"chatgpt"}))
                .await
        }
        "device" => {
            c.call("account/login/start", json!({"type":"chatgptDeviceCode"}))
                .await
        }
        "logout" => c.call("account/logout", json!({})).await,
        _ => Err("Unknown account action".into()),
    }
}
pub(crate) async fn codex_sessions(
    app: crate::Backend,
    project_id: String,
) -> Result<Value, String> {
    projects::get(&app, &project_id)?;
    Ok(json!(sessions(&app)?
        .into_iter()
        .rev()
        .filter(|s| s.project_id == project_id)
        .collect::<Vec<_>>()))
}
pub(crate) async fn codex_thread(
    app: crate::Backend,
    project_id: String,
    thread_id: String,
    action: String,
    title: Option<String>,
) -> Result<Value, String> {
    let mut all = sessions(&app)?;
    let s = all
        .iter_mut()
        .find(|s| s.id == thread_id && s.project_id == project_id)
        .ok_or("Unknown project session")?;
    if action == "rename" {
        s.title = title.unwrap_or_else(|| "Chat".into());
        save_json(&projects::data_dir(&app)?.join("sessions.json"), &all)?;
        return Ok(Value::Null);
    }
    let c = connection(&app).await?;
    let result = match action.as_str() {
        "read" => {
            c.call(
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":true}),
            )
            .await?
        }
        "archive" => {
            assert_unlocked(&app, &project_id)?;
            c.call("thread/archive", json!({"threadId":thread_id}))
                .await?
        }
        _ => return Err("Unknown thread action".into()),
    };
    if action == "archive" {
        all.retain(|s| s.id != thread_id);
        save_json(&projects::data_dir(&app)?.join("sessions.json"), &all)?;
    }
    Ok(result)
}
pub(crate) async fn codex_send(
    app: crate::Backend,
    project_id: String,
    thread_id: Option<String>,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    images: Option<Vec<String>>,
    main_document: Option<String>,
    history_prompt: Option<String>,
) -> Result<Value, String> {
    codex_send_for_chat(
        app,
        project_id,
        thread_id,
        prompt,
        model,
        effort,
        images,
        main_document,
        history_prompt,
        None,
    )
    .await
}
pub(crate) async fn codex_send_for_chat(
    app: crate::Backend,
    project_id: String,
    thread_id: Option<String>,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    images: Option<Vec<String>>,
    main_document: Option<String>,
    history_prompt: Option<String>,
    chat_id: Option<String>,
) -> Result<Value, String> {
    let project = projects::get(&app, &project_id)?;
    if review_path(&app, &project_id)?.exists() {
        return Err(
            "Resolve the legacy project review before starting concurrent proposals".into(),
        );
    }
    let c = connection(&app).await?;
    // Serialize only startup/binding. Running turns are reserved per proposal.
    let _startup = app.inner.codex.service_lock.lock().await;
    if let Some(id) = &thread_id {
        if !sessions(&app)?
            .iter()
            .any(|s| s.id == *id && s.project_id == project_id)
        {
            return Err("Unknown project session".into());
        }
    }
    history_result(&app, &project_id, history_before_turn(&app, &project_id));
    let mut proposal = crate::proposals::begin_for_chat(
        &app,
        &project_id,
        thread_id.as_deref(),
        history_prompt,
        chat_id.clone(),
    )?;
    let workspace = crate::proposals::root(&app, &proposal)?;
    let prompt = prompt.replace(&project.root.to_string_lossy().to_string(), ".");
    let _ = main_document;
    let _ = app.emit_review(json!({"projectId":project_id}));
    let result: Result<Value, String> = async {
        let mut config = json!({"cwd":workspace,"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write","config":{"sandbox_workspace_write.network_access":false,"sandbox_workspace_write.writable_roots":[],"sandbox_workspace_write.exclude_tmpdir_env_var":false,"sandbox_workspace_write.exclude_slash_tmp":false},"developerInstructions":concat!("You are the scientific writing assistant in codex-prism. This is an isolated proposal workspace. It may have been refreshed from the latest main document since your previous turn: inspect current files before editing. Keep project edits in this workspace. Temporary files may use /tmp and TMPDIR. Commands requiring unrestricted execution may request user approval. Project changes require user acceptance.\n\n",include_str!("writing-guidance.txt"))});
        if let Some(m) = model.filter(|s| !s.is_empty()) { config["model"] = json!(m); }
        let thread = if let Some(id) = thread_id { config["threadId"] = json!(id); c.call("thread/resume", config).await? } else { c.call("thread/start", config).await? };
        let id = thread["thread"]["id"].as_str().ok_or("Missing thread ID")?.to_string();
        crate::proposals::bind(&app, &mut proposal, id.clone())?;
        { let _guard = app.inner.codex.reviews.lock().map_err(|e|e.to_string())?;
          let mut all = sessions(&app)?;
          if !all.iter().any(|s|s.id==id) { all.push(Session { project_id:project_id.clone(), id:id.clone(), title:prompt.chars().take(70).collect() }); save_json(&projects::data_dir(&app)?.join("sessions.json"), &all)?; }
        }
        let _ = app.emit_agent(json!({"method":"prism/session","params":{"projectId":project_id,"threadId":id,"chatId":chat_id,"proposalId":proposal.id}}));
        let mut input = vec![json!({"type":"text","text":prompt})];
        for url in images.unwrap_or_default() { input.push(json!({"type":"image","imageUrl":url})); }
        let mut params = json!({"threadId":id,"cwd":workspace,"sandboxPolicy":{"type":"workspaceWrite","writableRoots":[workspace],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"input":input});
        if let Some(e) = effort.filter(|s|!s.is_empty()) { params["effort"] = json!(e); }
        let turn = c.call("turn/start", params).await?;
        if let Some(id) = turn["turn"]["id"].as_str() { crate::proposals::set_turn(&app, &proposal.id, id)?; }
        Ok(json!({"threadId":id,"turn":turn["turn"],"proposalId":proposal.id}))
    }.await;
    if let Err(ref error) = result {
        if error.contains("timed out")
            || error.contains("disconnected")
            || error.contains("process exited")
        {
            let _ = c.stop().await;
        }
        let _ = crate::proposals::finish(&app, &proposal.id, true);
    }
    result
}

pub(crate) async fn codex_control(
    app: crate::Backend,
    project_id: String,
    thread_id: String,
    turn_id: String,
    prompt: Option<String>,
) -> Result<Value, String> {
    if !sessions(&app)?
        .iter()
        .any(|s| s.id == thread_id && s.project_id == project_id)
    {
        return Err("Unknown session".into());
    }
    let c = connection(&app).await?;
    if let Some(text) = prompt {
        let project = projects::get(&app, &project_id)?;
        let text = text.replace(&project.root.to_string_lossy().to_string(), ".");
        let history_id = {
            let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
            crate::review_storage::load(&review_path(&app, &project_id)?)
                .ok()
                .filter(|r| !r.history_prompts.is_empty())
                .map(|r| r.history_id)
        };
        let result = c.call("turn/steer",json!({"threadId":thread_id,"expectedTurnId":turn_id,"input":[{"type":"text","text":text}]})).await?;
        crate::proposals::steer(&app, &project_id, &thread_id, &text)?;
        if let Some(history_id) = history_id {
            let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
            let path = review_path(&app, &project_id)?;
            if let Ok(mut r) = crate::review_storage::load(&path) {
                if r.history_id == history_id {
                    r.history_prompts.push(text);
                    if let Err(e) = crate::review_storage::save(&path, &r) {
                        history_result(&app, &project_id, Err(e));
                    }
                }
            }
        }
        Ok(result)
    } else {
        crate::proposals::cancel_thread(&app, &project_id, &thread_id)?;
        c.call(
            "turn/interrupt",
            json!({"threadId":thread_id,"turnId":turn_id}),
        )
        .await
    }
}
pub(crate) async fn codex_respond(
    app: crate::Backend,
    id: Value,
    result: Value,
) -> Result<(), String> {
    let c = connection(&app).await?;
    let request = c
        .requests
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id.to_string())
        .cloned()
        .ok_or("Request already resolved")?;
    let params = &request["params"];
    if let Some(thread) = params["threadId"].as_str() {
        if let Some(session) = sessions(&app)?.iter().find(|s| s.id == thread) {
            if let Some(proposal) = crate::proposals::all(&app, &session.project_id)?
                .into_iter()
                .find(|p| {
                    p.thread_id.as_deref() == Some(thread)
                        && ["running", "repairing"].contains(&p.state.as_str())
                })
            {
                let workspace = crate::proposals::root(&app, &proposal)?;
                if request["method"] == "item/permissions/requestApproval" {
                    // Only grant explicitly scoped writes inside the owning workspace.
                    let permissions = &result["permissions"];
                    if result["scope"] != "turn" {
                        return Err(
                            "Proposal permissions must be limited to the current turn".into()
                        );
                    }
                    if permissions
                        .as_object()
                        .ok_or("Invalid permissions")?
                        .keys()
                        .any(|key| {
                            !["network", "fileSystem", "file_system"].contains(&key.as_str())
                        })
                    {
                        return Err(
                            "Unsupported permission expansion for an isolated proposal".into()
                        );
                    }
                    if let Some(fs) = permissions
                        .get("fileSystem")
                        .or_else(|| permissions.get("file_system"))
                    {
                        if fs
                            .as_object()
                            .ok_or("Invalid filesystem permissions")?
                            .keys()
                            .any(|key| !["read", "write", "writableRoots"].contains(&key.as_str()))
                        {
                            return Err("Unsupported filesystem permission expansion for an isolated proposal".into());
                        }
                        let writes = fs.get("write").or_else(|| fs.get("writableRoots"));
                        if let Some(writes) = writes {
                            let paths = writes.as_array().ok_or(
                                "Unscoped filesystem permissions are not allowed for proposals",
                            )?;
                            for path in paths {
                                let path = std::path::Path::new(
                                    path.as_str().ok_or("Invalid permission path")?,
                                );
                                let rel = path.strip_prefix(&workspace).map_err(|_| {
                                    "Proposal agents cannot write outside their workspace"
                                })?;
                                if !rel.as_os_str().is_empty() {
                                    projects::resolve(
                                        &workspace,
                                        rel.to_str().ok_or("Invalid permission path")?,
                                    )?;
                                }
                            }
                        }
                    }
                }
                if !result["decision"].is_null() && !result["decision"].is_string() {
                    return Err(
                        "Persistent approval amendments are unavailable in isolated proposals"
                            .into(),
                    );
                }
                if result["decision"]
                    .as_str()
                    .is_some_and(|d| d.starts_with("accept"))
                {
                    if let Some(grant) = params["grantRoot"].as_str() {
                        let path = std::path::Path::new(grant);
                        let rel = path
                            .strip_prefix(&workspace)
                            .map_err(|_| "Proposal agents cannot write outside their workspace")?;
                        if !rel.as_os_str().is_empty() {
                            projects::resolve(
                                &workspace,
                                rel.to_str().ok_or("Invalid permission path")?,
                            )?;
                        }
                    }
                }
            }
        }
    }
    c.requests
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id.to_string());
    c.write(json!({"id":id,"result":result})).await
}
pub(crate) fn project_review(app: crate::Backend, project_id: String) -> Result<Value, String> {
    let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let path = review_path(&app, &project_id)?;
    if !path.exists() {
        return Ok(json!({"active":false,"changes":[]}));
    }
    let r: Review = crate::review_storage::display(&path)?;
    let mut paths: Vec<_> = r.before.keys().chain(r.after.keys()).cloned().collect();
    paths.sort();
    paths.dedup();
    Ok(
        json!({"active":r.active,"revision":review_revision(&r),"changes":paths.into_iter().filter(|p|r.before.get(p)!=r.after.get(p)).map(|p|{let old=r.before.get(&p);let new=r.after.get(&p);json!({"path":p,"oldContent":old.and_then(|b|std::str::from_utf8(b).ok()),"newContent":new.and_then(|b|std::str::from_utf8(b).ok()),"kind":if old.is_none(){"added"}else if new.is_none(){"deleted"}else{"modified"},"binary":old.map(|b|std::str::from_utf8(b).is_err()).unwrap_or(false)||new.map(|b|std::str::from_utf8(b).is_err()).unwrap_or(false)})}).collect::<Vec<_>>()}),
    )
}
pub(crate) fn project_resolve_review(
    app: crate::Backend,
    project_id: String,
    path: String,
    undo: bool,
) -> Result<(), String> {
    project_resolve_batch(app, project_id, vec![path], undo, None).map(|_| ())
}
pub(crate) fn project_resolve_batch(
    app: crate::Backend,
    project_id: String,
    paths: Vec<String>,
    undo: bool,
    expected: Option<String>,
) -> Result<Value, String> {
    let _service = app
        .inner
        .codex
        .service_lock
        .try_lock()
        .map_err(|_| "Project operation in progress. Retry accepting changes.")?;
    resolve_batch_reserved(app.clone(), project_id, paths, undo, expected)
}
pub(crate) fn resolve_batch_reserved(
    app: crate::Backend,
    project_id: String,
    mut paths: Vec<String>,
    undo: bool,
    expected: Option<String>,
) -> Result<Value, String> {
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return Err("No changes selected".into());
    }
    history_result(
        &app,
        &project_id,
        settle_implicit_history(&app, &project_id),
    );
    let file = review_path(&app, &project_id)?;
    let root = projects::get(&app, &project_id)?.root;
    let r = {
        let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
        let r = crate::review_storage::load(&file)?;
        if r.active {
            return Err("Wait for the agent to finish".into());
        }
        if expected.as_ref().is_some_and(|e| e != &review_revision(&r)) {
            return Err("Review changed. Refresh before accepting.".into());
        }
        for p in &paths {
            if r.before.get(p) == r.after.get(p) {
                return Err("No pending change for this file".into());
            }
            let path = projects::resolve(&root, p)?;
            let actual = match std::fs::read(path) {
                Ok(b) => Some(b),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.to_string()),
            };
            if actual.as_ref() != r.after.get(p)
                && (undo || !crate::history::workflow::untracked_output(&root.to_string_lossy(), p))
            {
                return Err(format!(
                    "File changed on disk: {p}. Refresh the review before accepting."
                ));
            }
        }
        r
    };
    if !undo {
        if let Err(error) = save_json(
            &intent_path(&app, &project_id)?,
            &AcceptanceIntent {
                review: r.clone(),
                paths: paths.clone(),
                implicit: false,
            },
        ) {
            history_result(&app, &project_id, Err(error));
        }
    }
    let warning = if !undo {
        let result = (|| {
            let inputs = history_baseline(&app, &project_id)?;
            crate::history::workflow::initialize(&root.to_string_lossy(), Some(inputs))?;
            record_acceptance(&app, &project_id, &r, &paths)
        })();
        let warning = result.as_ref().err().cloned();
        history_result(&app, &project_id, result);
        warning
    } else {
        None
    };
    let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let mut current = crate::review_storage::load(&file)?;
    if review_revision(&current) != review_revision(&r) {
        return Err("Review changed while saving history".into());
    }
    for p in &paths {
        if undo {
            undo_change(&root, &r, p)?;
        }
        current.before.remove(p);
        current.after.remove(p);
    }
    if undo {
        if let Some(v) = &mut current.visual {
            match projects::snapshot(&root).and_then(|inputs| {
                crate::visual_review::capture(&app, &project_id, &v.main, &inputs)
            }) {
                Ok(a) => {
                    v.after = Some(a);
                    v.state = "preparing".into();
                }
                Err(e) => {
                    v.after = None;
                    v.state = "unavailable".into();
                    v.error = Some(e);
                }
            }
        }
    }
    if current.before == current.after {
        crate::review_storage::remove(&file)?;
    } else {
        crate::review_storage::save(&file, &current)?;
    }
    drop(_files);
    if !undo {
        // The Git queue remains authoritative for retries once decisions are saved.
        let queued = crate::history::workflow::status(&root.to_string_lossy())
            .ok()
            .is_some_and(|s| s["pending"].as_u64().unwrap_or(0) > 0);
        if warning.is_none() || queued {
            let _ = std::fs::remove_file(intent_path(&app, &project_id)?);
        }
    }
    let _ = app.emit_review(json!({"projectId":project_id}));
    schedule_visual_report(&app, &project_id, undo)?;
    Ok(json!({"accepted":!undo,"historyWarning":warning}))
}
pub(crate) fn refresh_review(app: crate::Backend, id: String) -> Result<Value, String> {
    let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let path = review_path(&app, &id)?;
    let mut review = crate::review_storage::load(&path)?;
    if review.active {
        return Err("Wait for the agent to finish".into());
    }
    let root = projects::get(&app, &id)?.root;
    let mut paths: Vec<_> = review
        .before
        .keys()
        .chain(review.after.keys())
        .cloned()
        .collect();
    paths.sort();
    paths.dedup();
    for name in paths {
        let bytes = match std::fs::read(projects::resolve(&root, &name)?) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if let Some(bytes) = bytes {
            review.after.insert(name.clone(), bytes);
        } else {
            review.after.remove(&name);
        }
        if review.before.get(&name) == review.after.get(&name) {
            review.before.remove(&name);
            review.after.remove(&name);
        }
    }
    if let Some(visual) = &mut review.visual {
        visual.generation = uuid::Uuid::new_v4().to_string();
        match projects::snapshot(&root)
            .and_then(|inputs| crate::visual_review::capture(&app, &id, &visual.main, &inputs))
        {
            Ok(artifact) => {
                visual.after = Some(artifact);
                visual.state = "preparing".into();
                visual.error = None;
            }
            Err(e) => {
                visual.after = None;
                visual.state = "unavailable".into();
                visual.error = Some(e);
            }
        }
    }
    if review.before == review.after {
        crate::review_storage::remove(&path)?;
    } else {
        crate::review_storage::save(&path, &review)?;
    }
    drop(_files);
    let _ = app.emit_review(json!({"projectId":id}));
    schedule_visual_report(&app, &id, true)?;
    project_review(app, id)
}

pub(crate) fn recover(app: &crate::Backend) {
    if let Ok(dir) = projects::data_dir(app) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(id) = name
                    .strip_prefix("history-accept-")
                    .and_then(|n| n.strip_suffix(".json"))
                else {
                    continue;
                };
                let Ok(bytes) = std::fs::read(entry.path()) else {
                    continue;
                };
                let Ok(intent) = serde_json::from_slice::<AcceptanceIntent>(&bytes) else {
                    continue;
                };
                if intent.implicit {
                    if let Ok(path) = review_path(app, id) {
                        if path.exists() {
                            let _ = crate::review_storage::confirm_start(&path);
                        }
                    }
                    let _ = finish_acceptance_intent(app, id);
                } else if let Ok(path) = review_path(app, id) {
                    if path.exists() {
                        let _ = project_resolve_batch(
                            app.clone(),
                            id.into(),
                            intent.paths,
                            false,
                            Some(review_revision(&intent.review)),
                        );
                    } else {
                        let _ = finish_acceptance_intent(app, id);
                    }
                }
            }
        }
    }
    if let Ok(dir) = projects::data_dir(app) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if let Some(id) = n
                    .strip_prefix("review-")
                    .and_then(|s| s.strip_suffix(".json"))
                {
                    let _ = finish_review(app, id);
                }
            }
        }
    }
}
pub(crate) async fn shutdown(app: &crate::Backend) {
    let connection = app.inner.codex.inner.lock().await.take();
    if let Some(c) = connection {
        let turns = c.turns.lock().map(|t| t.clone()).unwrap_or_default();
        for (thread, turn) in turns {
            if let Ok(all) = sessions(app) {
                if let Some(s) = all.iter().find(|s| s.id == thread) {
                    let _ = crate::proposals::cancel_thread(app, &s.project_id, &thread);
                }
            }
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                c.call("turn/interrupt", json!({"threadId":thread,"turnId":turn})),
            )
            .await;
        }
        let _ = c.stop().await;
        if let Ok(all) = sessions(app) {
            for s in all {
                let _ = crate::proposals::finish_thread(app, &s.project_id, &s.id, true);
                let _ = finish_review(app, &s.project_id);
            }
        }
    }
    let tasks = std::mem::take(
        &mut *app
            .inner
            .codex
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner()),
    );
    for task in tasks {
        let _ = task.await;
    }
}

/// Restore a reviewed file only if its current bytes still match the completed turn.
fn undo_change(root: &std::path::Path, r: &Review, path: &str) -> Result<(), String> {
    let target = projects::resolve(root, path)?;
    let actual = match std::fs::read(&target) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if actual.as_ref() != r.after.get(path) {
        return Err("File changed since review. Keep current contents or reload.".into());
    }
    if let Some(bytes) = r.before.get(path) {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?
        }
        std::fs::write(target, bytes).map_err(|e| e.to_string())?;
    } else if target.exists() {
        std::fs::remove_file(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn history_review_fixture() -> (tempfile::TempDir, crate::Backend, projects::Project, Review) {
        let (dir, app) = crate::test_backend();
        let root = dir.path().join("paper");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("main.tex"), "before").unwrap();
        std::fs::write(root.join("part.tex"), "old part").unwrap();
        let project =
            projects::project_register(app.clone(), root.to_string_lossy().into()).unwrap();
        crate::history::history_init(root.to_string_lossy().into()).unwrap();
        let before = projects::snapshot(&root).unwrap();
        std::fs::write(root.join("main.tex"), "accepted").unwrap();
        std::fs::write(root.join("part.tex"), "new part").unwrap();
        let review = Review {
            project_id: project.id.clone(),
            before,
            after: projects::snapshot(&root).unwrap(),
            history_id: uuid::Uuid::new_v4().to_string(),
            history_prompts: vec!["Make it concise".into()],
            ..Default::default()
        };
        crate::review_storage::save(&review_path(&app, &project.id).unwrap(), &review).unwrap();
        (dir, app, project, review)
    }
    #[test]
    fn keep_all_records_one_commit_and_partial_keep_excludes_other_files() {
        let (_dir, app, p, r) = history_review_fixture();
        project_resolve_batch(
            app.clone(),
            p.id.clone(),
            vec!["main.tex".into(), "part.tex".into()],
            false,
            Some(review_revision(&r)),
        )
        .unwrap();
        let list = crate::history::history_list(p.root.to_string_lossy().into(), 50, 0).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].changed_files, vec!["main.tex", "part.tex"]);
        assert!(list[0].message.contains("Make it concise"));
        assert!(!review_path(&app, &p.id).unwrap().exists());
        let (_dir, app, p, _) = history_review_fixture();
        project_resolve_review(app.clone(), p.id.clone(), "main.tex".into(), false).unwrap();
        let list = crate::history::history_list(p.root.to_string_lossy().into(), 50, 0).unwrap();
        assert_eq!(list[0].changed_files, vec!["main.tex"]);
        project_resolve_review(app.clone(), p.id.clone(), "part.tex".into(), true).unwrap();
        assert_eq!(std::fs::read(p.root.join("part.tex")).unwrap(), b"old part");
        assert_eq!(
            crate::history::history_list(p.root.to_string_lossy().into(), 50, 0)
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn keep_refuses_external_edits_but_git_failure_does_not_block_acceptance() {
        let (_dir, app, p, r) = history_review_fixture();
        std::fs::write(p.root.join("main.tex"), "external edit").unwrap();
        assert!(
            project_resolve_review(app.clone(), p.id.clone(), "main.tex".into(), false)
                .unwrap_err()
                .contains("File changed on disk")
        );
        std::fs::write(p.root.join("main.tex"), "accepted").unwrap();
        let repo = git2::Repository::open(&p.root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("part.tex")).unwrap();
        index.write().unwrap();
        let result = project_resolve_batch(
            app.clone(),
            p.id.clone(),
            vec!["main.tex".into()],
            false,
            Some(review_revision(&r)),
        )
        .unwrap();
        assert!(result["historyWarning"]
            .as_str()
            .unwrap()
            .contains("staged"));
        assert_eq!(
            project_review(app.clone(), p.id).unwrap()["changes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            crate::history::history_list(p.root.to_string_lossy().into(), 50, 0)
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn reload_review_accepts_external_content_and_regenerated_output_does_not_block_keep() {
        let (_dir, app, p, mut r) = history_review_fixture();
        std::fs::write(p.root.join("main.tex"), "external edit").unwrap();
        refresh_review(app.clone(), p.id.clone()).unwrap();
        project_resolve_review(app.clone(), p.id.clone(), "main.tex".into(), false).unwrap();
        let commits = crate::history::history_list(p.root.to_string_lossy().into(), 50, 0).unwrap();
        assert_eq!(
            crate::history::history_file_at(
                p.root.to_string_lossy().into(),
                commits[0].id.clone(),
                "main.tex".into()
            )
            .unwrap(),
            "external edit"
        );
        r.before.clear();
        r.after.clear();
        r.before.insert("main.pdf".into(), b"before".to_vec());
        r.after.insert("main.pdf".into(), b"agent output".to_vec());
        std::fs::write(p.root.join("main.pdf"), "recompiled output").unwrap();
        crate::review_storage::save(&review_path(&app, &p.id).unwrap(), &r).unwrap();
        project_resolve_review(app.clone(), p.id.clone(), "main.pdf".into(), false).unwrap();
        assert_eq!(
            crate::history::history_list(p.root.to_string_lossy().into(), 50, 0)
                .unwrap()
                .len(),
            commits.len()
        );
    }
    #[test]
    fn interrupted_acceptance_intent_recovers_once() {
        let (_dir, app, p, r) = history_review_fixture();
        save_json(
            &intent_path(&app, &p.id).unwrap(),
            &AcceptanceIntent {
                review: r,
                paths: vec!["main.tex".into(), "part.tex".into()],
                implicit: false,
            },
        )
        .unwrap();
        recover(&app);
        recover(&app);
        assert!(!review_path(&app, &p.id).unwrap().exists());
        assert!(!intent_path(&app, &p.id).unwrap().exists());
        assert_eq!(
            crate::history::history_list(p.root.to_string_lossy().into(), 50, 0)
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn next_turn_confirmation_commits_previous_bytes_not_running_edits() {
        let (_dir, app, p, previous) = history_review_fixture();
        let r = prepare_review(
            p.id.clone(),
            Some(previous),
            projects::snapshot(&p.root).unwrap(),
        )
        .unwrap();
        crate::review_storage::save(&review_path(&app, &p.id).unwrap(), &r).unwrap();
        std::fs::write(p.root.join("main.tex"), "next running edit").unwrap();
        confirm_review_start(&app, &p.id).unwrap();
        let list = crate::history::history_list(p.root.to_string_lossy().into(), 50, 0).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(
            crate::history::history_file_at(
                p.root.to_string_lossy().into(),
                list[0].id.clone(),
                "main.tex".into()
            )
            .unwrap(),
            "accepted"
        );
        assert!(
            crate::review_storage::load(&review_path(&app, &p.id).unwrap())
                .unwrap()
                .previous
                .is_none()
        );
        assert_eq!(
            std::fs::read(p.root.join("main.tex")).unwrap(),
            b"next running edit"
        );
    }

    fn pending_review() -> Review {
        Review {
            project_id: "project".into(),
            before: BTreeMap::from([("main.tex".into(), b"original".to_vec())]),
            after: BTreeMap::from([("main.tex".into(), b"first turn".to_vec())]),
            ..Default::default()
        }
    }

    #[test]
    fn next_turn_uses_current_files_and_blocks_overlapping_start() {
        let previous = pending_review();
        let current = previous.after.clone();
        let next = prepare_review("project".into(), Some(previous), current.clone()).unwrap();
        assert_eq!(next.before, current);
        assert!(next.previous.is_some());
        assert!(prepare_review("project".into(), Some(next), current).is_err());
    }

    #[test]
    fn failed_start_restores_pending_review_after_serialization() {
        let previous = pending_review();
        let next = prepare_review(
            "project".into(),
            Some(previous.clone()),
            previous.after.clone(),
        )
        .unwrap();
        let mut restored: Review =
            serde_json::from_slice(&serde_json::to_vec(&next).unwrap()).unwrap();
        finish_review_state(&mut restored, previous.after.clone());
        assert!(!restored.active);
        assert_eq!(restored.before, previous.before);
        assert_eq!(restored.after, previous.after);
        assert!(restored.previous.is_none());
    }

    #[test]
    fn accepted_start_reviews_only_new_changes() {
        let previous = pending_review();
        let mut next = prepare_review(
            "project".into(),
            Some(previous.clone()),
            previous.after.clone(),
        )
        .unwrap();
        next.previous = None; // turn/started confirmation
        let after = BTreeMap::from([("main.tex".into(), b"second turn".to_vec())]);
        finish_review_state(&mut next, after.clone());
        assert_eq!(next.before, previous.after);
        assert_eq!(next.after, after);
        assert!(!next.active);
    }

    #[test]
    fn unconfirmed_interrupted_turn_preserves_prior_and_new_changes() {
        let previous = pending_review();
        let mut next = prepare_review(
            "project".into(),
            Some(previous.clone()),
            previous.after.clone(),
        )
        .unwrap();
        let after = BTreeMap::from([("main.tex".into(), b"partial second turn".to_vec())]);
        finish_review_state(&mut next, after.clone());
        assert_eq!(next.before, previous.before);
        assert_eq!(next.after, after);
        assert!(!next.active);
    }

    #[test]
    fn persisted_review_restores_modifications_additions_and_deletions() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("main.tex"), b"before").unwrap();
        std::fs::write(root.join("deleted.bib"), b"refs").unwrap();
        let before = projects::snapshot(&root).unwrap();
        std::fs::write(root.join("main.tex"), b"after").unwrap();
        std::fs::remove_file(root.join("deleted.bib")).unwrap();
        std::fs::write(root.join("added.png"), [0, 255, 1]).unwrap();
        let r = Review {
            project_id: uuid::Uuid::new_v4().to_string(),
            active: false,
            before: before.clone(),
            after: projects::snapshot(&root).unwrap(),
            previous: None,
            visual: None,
            history_prompts: vec![],
            history_id: String::new(),
        };
        let file = d.path().join("review.json");
        save_json(&file, &r).unwrap();
        let restored: Review = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
        for path in ["main.tex", "deleted.bib", "added.png"] {
            undo_change(&root, &restored, path).unwrap();
        }
        assert_eq!(projects::snapshot(&root).unwrap(), before);
    }
    #[test]
    fn completed_review_retains_only_changed_files() {
        let (dir, app) = crate::test_backend();
        let root = dir.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("main.tex"), b"before").unwrap();
        std::fs::write(root.join("asset.png"), vec![255; 1024 * 1024]).unwrap();
        let project =
            projects::project_register(app.clone(), root.to_string_lossy().into()).unwrap();
        let path = review_path(&app, &project.id).unwrap();
        let review =
            prepare_review(project.id.clone(), None, projects::snapshot(&root).unwrap()).unwrap();
        crate::review_storage::save(&path, &review).unwrap();
        std::fs::write(root.join("main.tex"), b"after").unwrap();
        finish_review(&app, &project.id).unwrap();
        let review = crate::review_storage::load(&path).unwrap();
        assert_eq!(review.before.len(), 1);
        assert_eq!(review.after.len(), 1);
        assert_eq!(
            std::fs::read_dir(path.with_extension("blobs"))
                .unwrap()
                .count(),
            2
        );
        project_resolve_review(app.clone(), project.id.clone(), "main.tex".into(), true).unwrap();
        assert_eq!(std::fs::read(root.join("main.tex")).unwrap(), b"before");
        assert!(!path.exists());
    }

    #[test]
    fn review_undo_preserves_external_edits() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.tex"), b"external").unwrap();
        let r = Review {
            before: BTreeMap::from([("a.tex".into(), b"before".to_vec())]),
            after: BTreeMap::from([("a.tex".into(), b"agent".to_vec())]),
            ..Default::default()
        };
        assert!(undo_change(d.path(), &r, "a.tex").is_err());
        assert_eq!(std::fs::read(d.path().join("a.tex")).unwrap(), b"external");
    }
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn completion_disk_work_does_not_block_rpc_responses() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, app) = crate::test_backend();
        let script = dir.path().join("fake-codex");
        std::fs::write(&script, include_str!("../tests/fixtures/app_server.py")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        codex_set_path(app.clone(), script.to_string_lossy().into())
            .await
            .unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("main.tex"), "original").unwrap();
        let project =
            projects::project_register(app.clone(), root.to_string_lossy().into()).unwrap();
        codex_send(
            app.clone(),
            project.id.clone(),
            None,
            "running".into(),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let connection = connection(&app).await.unwrap();
        // Drain turn/started before taking the lock used by review completion.
        connection.call("model/list", json!({})).await.unwrap();
        let (held, ready) = oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let locked_app = app.clone();
        let lock_task = tokio::task::spawn_blocking(move || {
            let _lock = locked_app.inner.projects.0.lock().unwrap();
            held.send(()).unwrap();
            released.recv().unwrap();
        });
        ready.await.unwrap();
        connection
            .call(
                "turn/interrupt",
                json!({"threadId":"thread-1","turnId":"turn-1"}),
            )
            .await
            .unwrap();
        // The fixture writes turn/completed before answering model/list. An
        // inline finalizer would deadlock here waiting for the held disk lock.
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            connection.call("model/list", json!({})),
        )
        .await;
        release.send(()).unwrap();
        lock_task.await.unwrap();
        assert!(response.unwrap().is_ok());
        app.shutdown().await;
        let review =
            crate::proposals::service(&app, &project.id, "proposal_list", json!({})).unwrap();
        assert_eq!(review[0]["changes"][0]["newContent"], "running edit");
        assert_eq!(
            std::fs::read_to_string(root.join("main.tex")).unwrap(),
            "original"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rpc_correlates_concurrent_out_of_order_replies() {
        let (_tmp, app) = crate::test_backend();
        let mut child=Command::new("python3").args(["-u","-c", "import sys,json; a=json.loads(sys.stdin.readline()); b=json.loads(sys.stdin.readline()); print(json.dumps({'id':b['id'],'result':b['method']})); print(json.dumps({'id':a['id'],'error':{'message':'denied'}}))"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let c = Arc::new(Connection {
            cancel: app.inner.cancel.subscribe(),
            stdin: AsyncMutex::new(child.stdin.take().unwrap()),
            child: AsyncMutex::new(child),
            pending: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
            turns: Mutex::new(HashMap::new()),
            next: std::sync::atomic::AtomicU64::new(1),
        });
        let reader = c.clone();
        let task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Some(line) = lines.next_line().await.unwrap() {
                reader.receive_response(&serde_json::from_str::<Value>(&line).unwrap());
            }
        });
        let (first, second) = tokio::join!(c.call("first", json!({})), c.call("second", json!({})));
        assert!(first.unwrap_err().contains("denied"));
        assert_eq!(second.unwrap(), "second");
        task.await.unwrap();
        assert!(c.pending.lock().unwrap().is_empty());
    }
}
