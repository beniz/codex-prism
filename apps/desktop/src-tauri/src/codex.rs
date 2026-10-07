//! Supervised app-server connection. No model credentials pass through the webview.
use crate::projects::{self, save_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
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
    pub service_lock: AsyncMutex<()>,
}
struct Connection {
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
    pub before: BTreeMap<String, Vec<u8>>,
    pub after: BTreeMap<String, Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<Box<Review>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    project_id: String,
    id: String,
    title: String,
}
fn sessions(app: &tauri::AppHandle) -> Result<Vec<Session>, String> {
    let p = projects::data_dir(app)?.join("sessions.json");
    if !p.exists() {
        return Ok(vec![]);
    }
    serde_json::from_slice(&std::fs::read(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn review_path(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
    Ok(projects::data_dir(app)?.join(format!("review-{id}.json")))
}
pub fn assert_unlocked(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if review_path(app, id)?.exists() {
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
        let result = tokio::time::timeout(Duration::from_secs(90), rx).await;
        self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
        result
            .map_err(|_| "Codex request timed out; check the session before retrying".to_string())?
            .map_err(|_| "Codex disconnected".to_string())?
    }
}
fn executable(app: &tauri::AppHandle) -> Result<String, String> {
    let p = projects::data_dir(app)?.join("codex-path.txt");
    let configured = std::fs::read_to_string(p).unwrap_or_default();
    if !configured.trim().is_empty() {
        return Ok(configured.trim().into());
    }
    which::which("codex")
        .map(|p| p.to_string_lossy().into())
        .map_err(|_| {
            "Codex is not installed or not on PATH. Set its executable path in Settings.".into()
        })
}
async fn connection(app: &tauri::AppHandle) -> Result<Arc<Connection>, String> {
    let state = app.state::<CodexState>();
    let _start = state.startup.lock().await;
    if let Some(c) = state.inner.lock().await.as_ref() {
        return Ok(c.clone());
    }
    let mut cmd = Command::new(executable(app)?);
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
        stdin: AsyncMutex::new(stdin),
        child: AsyncMutex::new(child),
        pending: Mutex::new(HashMap::new()),
        requests: Mutex::new(HashMap::new()),
        turns: Mutex::new(HashMap::new()),
        next: std::sync::atomic::AtomicU64::new(1),
    });
    let read = c.clone();
    let handle = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
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
                        let _=read.write(json!({"id":id,"error":{"code":-32601,"message":"Interaction not supported by Codex-Prism"}})).await;
                        let _=handle.emit("codex-event",json!({"method":"prism/unsupportedRequest","params":{"method":method,"threadId":v["params"]["threadId"]}}));
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
                    if let Some(thread) = v["params"]["threadId"].as_str() {
                        if let Ok(all) = sessions(&handle) {
                            if let Some(s) = all.iter().find(|s| s.id == thread) {
                                let _ = finish_review(&handle, &s.project_id);
                            }
                        }
                    }
                }
                let _ = handle.emit("codex-event", &v);
            } else {
                read.receive_response(&v);
            }
        }
        let _ = read.stop().await;
        if let Ok(mut pending) = read.pending.lock() {
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err("Codex process exited".into()));
            }
        }
        let state = handle.state::<CodexState>();
        if let Ok(all) = sessions(&handle) {
            for s in all {
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
        let _ = handle.emit(
            "codex-event",
            json!({"method":"connection/closed","params":{}}),
        );
    });
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(_line)) = lines.next_line().await { /* Drain stderr; never forward potentially sensitive diagnostics to clients. */
        }
    });
    let initialized=c.call("initialize",json!({"clientInfo":{"name":"codex_prism","title":"Codex-Prism","version":"0.1.0"},"capabilities":{}})).await;
    if let Err(e) = initialized {
        let _ = c.stop().await;
        return Err(e);
    }
    c.write(json!({"method":"initialized"})).await?;
    *state.inner.lock().await = Some(c.clone());
    Ok(c)
}
// Reserve the project and durably retain the previous review until turn/start succeeds.
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
        active: true,
        before,
        after: BTreeMap::new(),
        previous: previous.map(Box::new),
    })
}

fn confirm_review_start(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let projects = app.state::<projects::Projects>();
    let _files = projects.0.lock().map_err(|e| e.to_string())?;
    let path = review_path(app, id)?;
    if !path.exists() {
        return Ok(());
    }
    let mut r: Review = serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if r.active && r.previous.take().is_some() {
        save_json(&path, &r)?;
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
    r.after = after;
    r.active = false;
}

fn finish_review(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let projects = app.state::<projects::Projects>();
    let _files = projects.0.lock().map_err(|e| e.to_string())?;
    let path = review_path(app, id)?;
    if !path.exists() {
        return Ok(());
    }
    let mut r: Review = serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if !r.active {
        return Ok(());
    }
    let after = projects::snapshot(&projects::get(app, id)?.root)?;
    finish_review_state(&mut r, after);
    if r.before == r.after {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    } else {
        save_json(&path, &r)?;
    }
    app.state::<CodexState>()
        .reviews
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id);
    let _ = app.emit("project-review", json!({"projectId":id}));
    Ok(())
}
#[tauri::command]
pub async fn codex_status(app: tauri::AppHandle) -> Result<Value, String> {
    let binary = executable(&app)?;
    let version = Command::new(&binary)
        .arg("--version")
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
#[tauri::command]
pub async fn codex_set_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // Persist for the next launch; an active server continues using its current executable.
    std::fs::write(projects::data_dir(&app)?.join("codex-path.txt"), path)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn codex_account(app: tauri::AppHandle, action: String) -> Result<Value, String> {
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
#[tauri::command]
pub async fn codex_sessions(app: tauri::AppHandle, project_id: String) -> Result<Value, String> {
    projects::get(&app, &project_id)?;
    Ok(json!(sessions(&app)?
        .into_iter()
        .rev()
        .filter(|s| s.project_id == project_id)
        .collect::<Vec<_>>()))
}
#[tauri::command]
pub async fn codex_thread(
    app: tauri::AppHandle,
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
#[tauri::command]
pub async fn codex_send(
    app: tauri::AppHandle,
    project_id: String,
    thread_id: Option<String>,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    images: Option<Vec<String>>,
) -> Result<Value, String> {
    let project = projects::get(&app, &project_id)?;
    let c = connection(&app).await?;
    {
        let state = app.state::<CodexState>();
        let _services = state.service_lock.lock().await;
        let projects = app.state::<projects::Projects>();
        let _files = projects.0.lock().map_err(|e| e.to_string())?;
        let state = app.state::<CodexState>();
        let _guard = state.reviews.lock().map_err(|e| e.to_string())?;
        let path = review_path(&app, &project_id)?;
        let previous = if path.exists() {
            Some(
                serde_json::from_slice::<Review>(&std::fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        let r = prepare_review(
            project_id.clone(),
            previous,
            projects::snapshot(&project.root)?,
        )?;
        save_json(&review_path(&app, &project_id)?, &r)?;
    }
    let _ = app.emit("project-review", json!({"projectId":project_id}));
    let result: Result<Value,String>=async{
 let mut config=json!({"cwd":project.root,"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write","config":{"sandbox_workspace_write.network_access":false},"developerInstructions":"You are the scientific writing assistant in Codex-Prism, a LaTeX editor. Treat scientific publications as the default writing target unless the user or project specifies another purpose. Use precise, evidence-based academic prose appropriate to the discipline and venue, distinguishing established findings from hypotheses and original contributions. Add relevant academic references for substantive claims, prior work, methods, and comparisons, preferring primary research and authoritative reviews. Add entries to the project bibliography and cite them where they support the text, following its existing citation style. Verify that each added reference exists, its bibliographic metadata is accurate, and it supports the associated claim, using accessible source material or trusted scholarly records. Never invent papers, authors, DOIs, citations, or findings. If a reference cannot be verified, flag the gap to the user instead of presenting it as verified. Read files before editing. Make focused incremental edits, preserve equations, labels and citations, and use a plan for substantial tasks. Use the project .venv/bin/python when available. Create technical drawings and other structured figures, such as schematics, geometry, flowcharts, and architecture diagrams, with the LaTeX tikzpicture environment unless the user requests another format. Keep editable TikZ source in the document or in figures/*.tex, load the required TikZ package and libraries, match document typography, and check compilation and label readability. Use suitable plotting libraries for data-driven charts. Do not change .git, .prism, .claudeprism or .codex-prism app state. Do not commit to the user's repository unless explicitly requested. Project changes are reviewed after your turn. Follow project AGENTS.md and applicable scientific skills."});
 if let Some(m)=model.filter(|s|!s.is_empty()){config["model"]=json!(m)}
 let thread=if let Some(id)=thread_id {if !sessions(&app)?.iter().any(|s|s.id==id && s.project_id==project_id){return Err("Unknown project session".into())}config["threadId"]=json!(id);c.call("thread/resume",config).await?}else{c.call("thread/start",config).await?};
 let id=thread["thread"]["id"].as_str().ok_or("Missing thread ID")?.to_string();
 {let state=app.state::<CodexState>();let _guard=state.reviews.lock().map_err(|e|e.to_string())?;let mut all=sessions(&app)?;if !all.iter().any(|s|s.id==id){all.push(Session{project_id:project_id.clone(),id:id.clone(),title:prompt.chars().take(70).collect()});save_json(&projects::data_dir(&app)?.join("sessions.json"),&all)?;}}
 let _=app.emit("codex-event",json!({"method":"prism/session","params":{"projectId":project_id,"threadId":id}}));
 let mut input=vec![json!({"type":"text","text":prompt})];for url in images.unwrap_or_default(){input.push(json!({"type":"image","imageUrl":url}));}let mut params=json!({"threadId":id,"input":input});if let Some(e)=effort.filter(|s|!s.is_empty()){params["effort"]=json!(e)}
 let turn=c.call("turn/start",params).await?;confirm_review_start(&app, &project_id)?;Ok(json!({"threadId":id,"turn":turn["turn"]}))
 }.await;
    if let Err(ref error) = result {
        // A transport failure can leave an accepted turn running. Stop the process before unlocking files.
        if error.contains("timed out")
            || error.contains("disconnected")
            || error.contains("process exited")
        {
            let _ = c.stop().await;
        }
        let _ = finish_review(&app, &project_id);
    }
    result
}
#[tauri::command]
pub async fn codex_control(
    app: tauri::AppHandle,
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
        c.call("turn/steer",json!({"threadId":thread_id,"expectedTurnId":turn_id,"input":[{"type":"text","text":text}]})).await
    } else {
        c.call(
            "turn/interrupt",
            json!({"threadId":thread_id,"turnId":turn_id}),
        )
        .await
    }
}
#[tauri::command]
pub async fn codex_respond(app: tauri::AppHandle, id: Value, result: Value) -> Result<(), String> {
    let c = connection(&app).await?;
    let pending = c
        .requests
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id.to_string());
    if pending.is_none() {
        return Err("Request already resolved".into());
    }
    c.write(json!({"id":id,"result":result})).await
}
#[tauri::command]
pub fn project_review(app: tauri::AppHandle, project_id: String) -> Result<Value, String> {
    let path = review_path(&app, &project_id)?;
    if !path.exists() {
        return Ok(json!({"active":false,"changes":[]}));
    }
    let r: Review = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut paths: Vec<_> = r.before.keys().chain(r.after.keys()).cloned().collect();
    paths.sort();
    paths.dedup();
    Ok(
        json!({"active":r.active,"changes":paths.into_iter().filter(|p|r.before.get(p)!=r.after.get(p)).map(|p|{let old=r.before.get(&p);let new=r.after.get(&p);json!({"path":p,"oldContent":old.and_then(|b|std::str::from_utf8(b).ok()),"newContent":new.and_then(|b|std::str::from_utf8(b).ok()),"kind":if old.is_none(){"added"}else if new.is_none(){"deleted"}else{"modified"},"binary":old.map(|b|std::str::from_utf8(b).is_err()).unwrap_or(false)||new.map(|b|std::str::from_utf8(b).is_err()).unwrap_or(false)})}).collect::<Vec<_>>()}),
    )
}
#[tauri::command]
pub fn project_resolve_review(
    app: tauri::AppHandle,
    project_id: String,
    path: String,
    undo: bool,
) -> Result<(), String> {
    let projects = app.state::<projects::Projects>();
    let _files = projects.0.lock().map_err(|e| e.to_string())?;
    let state = app.state::<CodexState>();
    let _guard = state.reviews.lock().map_err(|e| e.to_string())?;
    let file = review_path(&app, &project_id)?;
    let mut r: Review = serde_json::from_slice(&std::fs::read(&file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if r.active {
        return Err("Wait for the agent to finish".into());
    }
    if r.before.get(&path) == r.after.get(&path) {
        return Err("No pending change for this file".into());
    }
    let root = projects::get(&app, &project_id)?.root;
    if undo {
        undo_change(&root, &r, &path)?;
    }
    r.before.remove(&path);
    r.after.remove(&path);
    if r.before == r.after {
        std::fs::remove_file(file).map_err(|e| e.to_string())?;
    } else {
        save_json(&file, &r)?;
    }
    let _ = app.emit("project-review", json!({"projectId":project_id}));
    Ok(())
}
pub fn recover(app: &tauri::AppHandle) {
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
pub async fn shutdown(app: &tauri::AppHandle) {
    let connection = app.state::<CodexState>().inner.lock().await.take();
    if let Some(c) = connection {
        let turns = c.turns.lock().map(|t| t.clone()).unwrap_or_default();
        for (thread, turn) in turns {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                c.call("turn/interrupt", json!({"threadId":thread,"turnId":turn})),
            )
            .await;
        }
        let _ = c.stop().await;
        if let Ok(all) = sessions(app) {
            for s in all {
                let _ = finish_review(app, &s.project_id);
            }
        }
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
    #[tokio::test]
    async fn rpc_correlates_concurrent_out_of_order_replies() {
        let mut child=Command::new("python3").args(["-u","-c", "import sys,json; a=json.loads(sys.stdin.readline()); b=json.loads(sys.stdin.readline()); print(json.dumps({'id':b['id'],'result':b['method']})); print(json.dumps({'id':a['id'],'error':{'message':'denied'}}))"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let c = Arc::new(Connection {
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
