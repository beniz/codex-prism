//! Isolated, durable chat proposals. Main files are only written by acceptance.
use crate::{codex::Review, history::workflow, projects, review_storage, Backend};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
/// Identity required for all review decisions. Generations reject stale views.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalRequest {
    pub project_id: String,
    pub proposal_id: String,
    pub generation: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalState {
    Running,
    Ready,
    Conflicts,
    Repairing,
    Interrupted,
    Original,
    Applying,
    Invalid,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalChange {
    pub path: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub kind: String,
    pub binary: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalSummary {
    pub id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub thread_id: Option<String>,
    pub chat_id: Option<String>,
    pub turn_id: Option<String>,
    pub generation: u64,
    pub state: ProposalState,
    pub conflicts: Vec<String>,
    pub parent: Option<String>,
    pub error: Option<String>,
    pub changes: Vec<ProposalChange>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub conflicts: Vec<String>,
    pub history_warning: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairOutcome {
    pub proposal_id: String,
    pub prompt: String,
}
type Files = BTreeMap<String, Vec<u8>>;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Proposal {
    #[serde(default)]
    pub planning: bool,
    #[serde(default)]
    planning_conflicts: Vec<String>,
    pub id: String,
    pub project_id: String,
    pub thread_id: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub cancel_requested: bool,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub commit_subject: Option<String>,
    pub generation: u64,
    pub state: String,
    pub conflicts: Vec<String>,
    pub parent: Option<String>,
}
fn directory(app: &Backend) -> Result<PathBuf, String> {
    let p = projects::data_dir(app)?.join("proposals");
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}
fn dir(app: &Backend, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
    Ok(directory(app)?.join(id))
}
pub(crate) fn root(app: &Backend, p: &Proposal) -> Result<PathBuf, String> {
    Ok(dir(app, &p.id)?.join("files"))
}
fn save(app: &Backend, p: &Proposal) -> Result<(), String> {
    projects::save_json(&dir(app, &p.id)?.join("state.json"), p)?;
    app.emit_agent(json!({"method":"prism/proposal","params":{"projectId":p.project_id,"threadId":p.thread_id,"chatId":p.chat_id,"workspaceId":p.id,"proposalId":p.id,"generation":p.generation,"state":p.state}}))
}
fn load(app: &Backend, id: &str) -> Result<Proposal, String> {
    serde_json::from_slice(&fs::read(dir(app, id)?.join("state.json")).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn snapshot_path(app: &Backend, p: &Proposal) -> Result<PathBuf, String> {
    Ok(dir(app, &p.id)?.join(format!("snapshot-{}.json", p.generation)))
}
fn snapshot(app: &Backend, p: &Proposal) -> Result<Review, String> {
    review_storage::load(&snapshot_path(app, p)?)
}
pub(crate) fn all(app: &Backend, project: &str) -> Result<Vec<Proposal>, String> {
    let mut result = vec![];
    for e in fs::read_dir(directory(app)?).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        if !e.path().join("state.json").exists() {
            continue;
        }
        let p = load(app, &e.file_name().to_string_lossy())?;
        if p.project_id == project
            && !["applied", "discarded", "superseded"].contains(&p.state.as_str())
        {
            result.push(p);
        }
    }
    Ok(result)
}
pub(crate) fn locked(app: &Backend, project: &str) -> Result<bool, String> {
    Ok(!all(app, project)?.is_empty())
}
fn write_files(root: &Path, before: &Files, after: &Files) -> Result<(), String> {
    let names: BTreeSet<_> = before.keys().chain(after.keys()).collect();
    // Resolve every path before touching any file.
    for name in &names {
        projects::resolve(root, name)?;
    }
    for name in names {
        if before.get(name) == after.get(name) {
            continue;
        }
        let path = projects::resolve(root, name)?;
        if let Some(bytes) = after.get(name) {
            fs::create_dir_all(path.parent().ok_or("Missing parent")?)
                .map_err(|e| e.to_string())?;
            projects::atomic_bytes(&path, bytes)?;
        } else if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn create(
    app: &Backend,
    project: &str,
    thread: Option<String>,
    base: Files,
    result: Files,
    parent: Option<String>,
) -> Result<Proposal, String> {
    let p = Proposal {
        planning: false,
        planning_conflicts: vec![],
        id: uuid::Uuid::new_v4().to_string(),
        project_id: project.into(),
        thread_id: thread,
        chat_id: None,
        error: None,
        cancel_requested: false,
        commit_subject: None,
        turn_id: None,
        generation: 0,
        state: "ready".into(),
        conflicts: vec![],
        parent,
    };
    let root = root(app, &p)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    write_files(&root, &Files::new(), &result)?;
    review_storage::save(
        &snapshot_path(app, &p)?,
        &Review {
            project_id: project.into(),
            before: base,
            after: result,
            history_id: p.id.clone(),
            ..Default::default()
        },
    )?;
    save(app, &p)?;
    Ok(p)
}
#[cfg(test)]
pub(crate) fn begin(
    app: &Backend,
    project: &str,
    thread: Option<&str>,
    prompt: Option<String>,
) -> Result<Proposal, String> {
    begin_for_chat(app, project, thread, prompt, None)
}
pub(crate) fn begin_for_chat(
    app: &Backend,
    project: &str,
    thread: Option<&str>,
    prompt: Option<String>,
    chat: Option<String>,
) -> Result<Proposal, String> {
    let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    if crate::codex::review_path(app, project)?.exists() {
        return Err(
            "Resolve the legacy project review before starting concurrent proposals".into(),
        );
    }
    let mut p = if let Some(p) = all(app, project)?.into_iter().find(|p| {
        ((p.thread_id.as_deref() == thread && thread.is_some())
            || (chat.is_some() && p.chat_id == chat))
            && p.state != "original"
    }) {
        if ["running", "repairing", "applying"].contains(&p.state.as_str()) {
            return Err("This chat already has an active turn or application".into());
        }
        p
    } else {
        let main = projects::get(app, project)?;
        if projects::data_dir(app)?.starts_with(&main.root) {
            return Err(
                "Application data must be outside the document to isolate agent workspaces".into(),
            );
        }
        let base = projects::isolated_snapshot(&main.root)?;
        create(
            app,
            project,
            thread.map(str::to_owned),
            base.clone(),
            base,
            None,
        )?
    };
    p.chat_id = chat.or(p.chat_id);
    p.error = None;
    p.cancel_requested = false;
    p.turn_id = None;
    let mut r = snapshot(app, &p)?;
    // Repair prompts are generated diagnostics, not a new user request.
    if p.commit_subject.is_none() && p.parent.is_none() {
        p.commit_subject = r
            .history_prompts
            .first()
            .map(String::as_str)
            .or(prompt.as_deref())
            .and_then(workflow::prompt_subject);
    }
    if workflow::include_prompt(&projects::get(app, project)?.root.to_string_lossy()) {
        if let Some(prompt) = prompt {
            r.history_prompts.push(prompt);
        }
    }
    p.generation += 1;
    review_storage::save(&snapshot_path(app, &p)?, &r)?;
    p.state = if p.parent.is_some() {
        "repairing"
    } else {
        "running"
    }
    .into();
    p.planning_conflicts = p.conflicts.clone();
    p.conflicts.clear();
    save(app, &p)?;
    Ok(p)
}
pub(crate) fn set_planning(app: &Backend, p: &mut Proposal, planning: bool) -> Result<(), String> {
    p.planning = planning;
    save(app, p)
}
pub(crate) fn bind(app: &Backend, p: &mut Proposal, thread: String) -> Result<(), String> {
    let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    p.thread_id = Some(thread);
    save(app, p)
}
pub(crate) fn finish(app: &Backend, id: &str, interrupted: bool) -> Result<(), String> {
    let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let mut p = load(app, id)?;
    if !["running", "repairing"].contains(&p.state.as_str()) {
        return Ok(());
    }
    let mut r = snapshot(app, &p)?;
    let previous_after = r.after.clone();
    r.after = match projects::isolated_snapshot(&root(app, &p)?) {
        Ok(files) => files,
        Err(error) => {
            p.state = "invalid".into();
            p.error = Some(error.clone());
            save(app, &p)?;
            app.emit_review(json!({"projectId":p.project_id}))?;
            return Err(error);
        }
    };
    p.generation += 1;
    review_storage::save(&snapshot_path(app, &p)?, &r)?;
    p.state = if p.planning && r.before == r.after && p.parent.is_none() {
        "discarded"
    } else if p.planning && previous_after == r.after && !p.planning_conflicts.is_empty() {
        p.conflicts = p.planning_conflicts.clone();
        "conflicts"
    } else if interrupted || p.cancel_requested {
        "interrupted"
    } else {
        "ready"
    }
    .into();
    save(app, &p)?;
    app.emit_review(json!({"projectId":p.project_id}))
}
pub(crate) fn finish_thread(
    app: &Backend,
    project: &str,
    thread: &str,
    interrupted: bool,
) -> Result<(), String> {
    for p in all(app, project)? {
        if p.thread_id.as_deref() == Some(thread) {
            finish(app, &p.id, interrupted)?;
        }
    }
    Ok(())
}
pub(crate) fn finish_turn(
    app: &Backend,
    project: &str,
    thread: &str,
    turn: Option<&str>,
) -> Result<(), String> {
    for p in all(app, project)? {
        if p.thread_id.as_deref() == Some(thread)
            && (p.turn_id.is_none() || p.turn_id.as_deref() == turn)
        {
            finish(app, &p.id, false)?;
        }
    }
    Ok(())
}
// libgit2 performs the same line-based three-way merge as ordinary Git, without
// creating conflict markers in either the proposal or main document.
fn merge(
    repo: &git2::Repository,
    base: &Files,
    result: &Files,
    current: &Files,
) -> Result<(Files, Vec<String>), String> {
    let mut merged = current.clone();
    let mut conflicts = vec![];
    for name in base.keys().chain(result.keys()).collect::<BTreeSet<_>>() {
        let b = base.get(name);
        let r = result.get(name);
        let c = current.get(name);
        if b == r || r == c {
            continue;
        }
        if r.is_some()
            && current.keys().any(|path| {
                path.starts_with(&format!("{name}/")) || name.starts_with(&format!("{path}/"))
            })
        {
            conflicts.push(name.clone());
            continue;
        }
        let value = if c == b {
            r.cloned()
        } else if let (Some(b), Some(r), Some(c)) = (b, r, c) {
            if [b, r, c]
                .iter()
                .any(|v| v.contains(&0) || std::str::from_utf8(v).is_err())
            {
                conflicts.push(name.clone());
                continue;
            }
            let entry = |bytes: &[u8]| -> Result<git2::IndexEntry, String> {
                Ok(git2::IndexEntry {
                    ctime: git2::IndexTime::new(0, 0),
                    mtime: git2::IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode: 0o100644,
                    uid: 0,
                    gid: 0,
                    file_size: bytes.len() as u32,
                    id: repo.blob(bytes).map_err(|e| e.to_string())?,
                    flags: 0,
                    flags_extended: 0,
                    path: name.as_bytes().to_vec(),
                })
            };
            let output = repo
                .merge_file_from_index(&entry(b)?, &entry(c)?, &entry(r)?, None)
                .map_err(|e| e.to_string())?;
            if !output.is_automergeable() {
                conflicts.push(name.clone());
                continue;
            }
            Some(output.content().to_vec())
        } else {
            conflicts.push(name.clone());
            continue;
        };
        if let Some(value) = value {
            merged.insert(name.clone(), value);
        } else {
            merged.remove(name);
        }
    }
    // Detect file/directory collisions before materialization.
    let names: Vec<_> = merged.keys().cloned().collect();
    for name in &names {
        if names
            .iter()
            .any(|other| other.starts_with(&format!("{name}/")))
        {
            conflicts.push(name.clone());
            for child in names
                .iter()
                .filter(|other| *other == name || other.starts_with(&format!("{name}/")))
            {
                conflicts.push(child.clone());
                if let Some(bytes) = current.get(child) {
                    merged.insert(child.clone(), bytes.clone());
                } else {
                    merged.remove(child);
                }
            }
        }
    }
    conflicts.sort();
    conflicts.dedup();
    for conflict in &conflicts {
        let affected: BTreeSet<_> = merged
            .keys()
            .chain(current.keys())
            .filter(|name| {
                *name == conflict
                    || name.starts_with(&format!("{conflict}/"))
                    || conflict.starts_with(&format!("{name}/"))
            })
            .cloned()
            .collect();
        for name in affected {
            if let Some(bytes) = current.get(&name) {
                merged.insert(name, bytes.clone());
            } else {
                merged.remove(&name);
            }
        }
    }
    Ok((merged, conflicts))
}
fn merge_repo(app: &Backend, p: &Proposal) -> Result<git2::Repository, String> {
    git2::Repository::init_bare(dir(app, &p.id)?.join("merge.git")).map_err(|e| e.to_string())
}
fn checked(app: &Backend, project: &str, id: &str, generation: u64) -> Result<Proposal, String> {
    let p = load(app, id)?;
    if p.project_id != project || p.generation != generation {
        return Err("Proposal changed; reload before reviewing".into());
    }
    if !["ready", "conflicts", "interrupted"].contains(&p.state.as_str()) {
        return Err("Proposal is not ready for review".into());
    }
    Ok(p)
}
#[derive(Serialize, Deserialize)]
struct Journal {
    proposal: Proposal,
    before: Files,
    after: Files,
    #[serde(default)]
    target: Option<String>,
}
fn journal_path(app: &Backend, p: &Proposal) -> Result<PathBuf, String> {
    Ok(dir(app, &p.id)?.join("application.json"))
}
fn record(app: &Backend, j: &Journal) -> Result<Option<String>, String> {
    record_with(app, j, None)
}
fn record_with(app: &Backend, j: &Journal, target: Option<&str>) -> Result<Option<String>, String> {
    let root = projects::get(app, &j.proposal.project_id)?.root;
    let r = snapshot(app, &j.proposal)?;
    let patch = j
        .before
        .keys()
        .chain(j.after.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|n| j.before.get(*n) != j.after.get(*n))
        .map(|n| (n.clone(), j.after.get(n).cloned()))
        .collect();
    let warning = if let Some(target) = target {
        workflow::accept_transaction(
            &root.to_string_lossy(),
            target,
            &j.proposal.id,
            patch,
            &r.history_prompts,
            j.proposal.commit_subject.as_deref(),
            || {
                if projects::isolated_snapshot(&root)? != j.before {
                    return Err("Main document changed during acceptance; retry".into());
                }
                projects::save_json(&journal_path(app, &j.proposal)?, j)?;
                let mut p = j.proposal.clone();
                p.state = "applying".into();
                save(app, &p)?;
                write_files(&root, &j.before, &j.after)
            },
        )?
        .err()
    } else {
        workflow::accept_with_subject(
            &root.to_string_lossy(),
            &j.proposal.id,
            patch,
            &r.history_prompts,
            j.proposal.commit_subject.as_deref(),
        )
        .err()
    };
    if let Some(warning) = &warning {
        workflow::warn(&root.to_string_lossy(), warning);
    }
    app.inner.events.emit(crate::BackendEvent::HistoryChanged {
        project_id: j.proposal.project_id.clone(),
        warning: warning.clone(),
    });
    let mut p = j.proposal.clone();
    p.state = "applied".into();
    save(app, &p)?;
    if let Some(parent) = &p.parent {
        let mut old = load(app, parent)?;
        old.state = "superseded".into();
        save(app, &old)?;
        cleanup_resolved(app, &old);
    }
    cleanup_resolved(app, &p);
    fs::remove_file(journal_path(app, &p)?).map_err(|e| e.to_string())?;
    Ok(warning)
}
pub(crate) fn service(
    app: &Backend,
    project: &str,
    operation: &str,
    args: Value,
) -> Result<Value, String> {
    projects::get(app, project)?;
    if operation == "proposal_recover" {
        let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
        recover_applications(app);
        return Ok(Value::Null);
    }
    if operation == "proposal_list" {
        let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
        return Ok(json!(all(app, project)?.into_iter().map(|p| {
            let r = snapshot(app, &p)?;
            let changes: Vec<_> = r.before.keys().chain(r.after.keys()).collect::<BTreeSet<_>>().into_iter().filter(|n|r.before.get(*n)!=r.after.get(*n)).map(|n|json!({"path":n,"oldContent":r.before.get(n).and_then(|b|std::str::from_utf8(b).ok()),"newContent":r.after.get(n).and_then(|b|std::str::from_utf8(b).ok()),"kind":if !r.before.contains_key(n){"added"}else if !r.after.contains_key(n){"deleted"}else{"modified"},"binary":r.before.get(n).into_iter().chain(r.after.get(n)).any(|b|b.contains(&0)||std::str::from_utf8(b).is_err())})).collect();
            Ok(json!({"id":p.id,"workspaceId":p.id,"projectId":project,"threadId":p.thread_id,"chatId":p.chat_id,"error":p.error,"turnId":p.turn_id,"generation":p.generation,"state":p.state,"conflicts":p.conflicts,"parent":p.parent,"changes":changes}))
        }).collect::<Result<Vec<_>,String>>()?));
    }
    let id = args["proposalId"].as_str().ok_or("Missing proposalId")?;
    let generation = args["generation"].as_u64().ok_or("Missing generation")?;
    let p = load(app, id)?;
    if p.project_id != project || p.generation != generation {
        return Err("Stale proposal request".into());
    }
    if operation == "proposal_read" {
        let name = args["path"].as_str().ok_or("Missing path")?;
        let r = snapshot(app, &p)?;
        let files = if args["side"] == "base" {
            &r.before
        } else {
            &r.after
        };
        return Ok(
            json!({"projectId":project,"threadId":p.thread_id,"workspaceId":p.id,"proposalId":id,"generation":generation,"files":files.keys().collect::<Vec<_>>(),"bytes":files.get(name)}),
        );
    }
    let r = snapshot(app, &p)?;
    let main = projects::get(app, project)?;
    if operation == "proposal_discard" {
        let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
        let mut p = load(app, id)?;
        if p.project_id != project
            || p.generation != generation
            || ["running", "repairing", "applying"].contains(&p.state.as_str())
        {
            return Err("Proposal is busy or changed".into());
        }
        p.state = "discarded".into();
        save(app, &p)?;
        if let Some(parent) = &p.parent {
            let mut old = load(app, parent)?;
            old.state = "conflicts".into();
            save(app, &old)?;
        }
        cleanup_resolved(app, &p);
        app.emit_review(json!({"projectId":project}))?;
        return Ok(Value::Null);
    }
    let target = workflow::target(&main.root.to_string_lossy())?;
    let current = projects::isolated_snapshot(&main.root)?;
    let (mut merged, mut conflicts) = merge(&merge_repo(app, &p)?, &r.before, &r.after, &current)?;
    for name in r
        .after
        .keys()
        .filter(|name| r.before.get(*name) != r.after.get(*name))
    {
        if projects::resolve(&main.root, name)?.is_dir() {
            conflicts.push(name.clone());
            merged.remove(name);
        }
    }
    conflicts.sort();
    conflicts.dedup();
    let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let mut p = checked(app, project, id, generation)?;
    if projects::isolated_snapshot(&main.root)? != current {
        return Err("Main document changed during merge; retry".into());
    }
    match operation {
        "proposal_apply" => {
            if !conflicts.is_empty() {
                p.state = "conflicts".into();
                p.conflicts = conflicts;
                save(app, &p)?;
                return Ok(json!({"conflicts":p.conflicts}));
            }
            let j = Journal {
                proposal: p.clone(),
                before: current,
                after: merged,
                target: Some(target.clone()),
            };
            let warning = record_with(app, &j, Some(&target))?;
            app.emit_review(json!({"projectId":project}))?;
            Ok(json!({"conflicts":[],"historyWarning":warning}))
        }
        "proposal_repair" => {
            let mut candidate = create(
                app,
                project,
                p.thread_id.clone(),
                current,
                merged,
                Some(p.id.clone()),
            )?;
            candidate.chat_id = p.chat_id.clone();
            candidate.commit_subject = p.commit_subject.clone();
            let intended = root(app, &candidate)?.join(".codexprism/repair-intent");
            for (side, files) in [("before", &r.before), ("after", &r.after)] {
                let dest = intended.join(side);
                fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                write_files(&dest, &Files::new(), files)?;
            }
            save(app, &candidate)?;
            // Retain the original snapshots, with a separate candidate merge base.
            p.state = "original".into();
            save(app, &p)?;
            let diagnostic = json!({"conflicts":conflicts,"intendedChanges":r.after.iter().filter(|(n,b)|r.before.get(*n)!=Some(*b)).map(|(n,b)|(n,String::from_utf8_lossy(b))).collect::<BTreeMap<_,_>>(),"deletedFiles":r.before.keys().filter(|n|!r.after.contains_key(*n)).collect::<Vec<_>>()});
            Ok(
                json!({"proposalId":candidate.id,"prompt":format!("Repair the proposal against the refreshed main document in this workspace. Cleanly merged changes are already present. Exact original base and intended result files, including binary assets, are available at .codexprism/repair-intent/before and .codexprism/repair-intent/after. Preserve other accepted work. Resolve these conflicts and intended changes, then leave the result for review; do not apply it. Diagnostics: {diagnostic}")}),
            )
        }
        _ => Err("Unknown proposal operation".into()),
    }
}
pub(crate) fn recover(app: &Backend) {
    recover_inner(app, true);
}
fn recover_applications(app: &Backend) {
    recover_inner(app, false);
}
fn recover_inner(app: &Backend, finish_runs: bool) {
    let Ok(entries) = fs::read_dir(match directory(app) {
        Ok(d) => d,
        Err(_) => return,
    }) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(p) = load(app, &e.file_name().to_string_lossy()) else {
            continue;
        };
        let journal = e.path().join("application.json");
        if journal.exists() {
            let result = (|| -> Result<(), String> {
                let j: Journal =
                    serde_json::from_slice(&fs::read(&journal).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                let main = projects::get(app, &p.project_id)?;
                if let Some(target) = &j.target {
                    if workflow::target(&main.root.to_string_lossy())? != *target
                        && !workflow::recorded(&main.root.to_string_lossy(), &p.id)?
                    {
                        return Err("Interrupted application: return to its original Git branch and revision before retrying".into());
                    }
                }
                let current = projects::isolated_snapshot(&main.root)?;
                for n in j.before.keys().chain(j.after.keys()) {
                    if j.before.get(n) != j.after.get(n)
                        && current.get(n) != j.before.get(n)
                        && current.get(n) != j.after.get(n)
                    {
                        return Err(format!("Interrupted application has an external edit: {n}"));
                    }
                }
                let mut remaining = current.clone();
                for n in j.before.keys().chain(j.after.keys()) {
                    if j.before.get(n) != j.after.get(n) {
                        if let Some(b) = j.after.get(n) {
                            remaining.insert(n.clone(), b.clone());
                        } else {
                            remaining.remove(n);
                        }
                    }
                }
                write_files(&main.root, &current, &remaining)?;
                record(app, &j)?;
                Ok(())
            })();
            if let Err(e) = result {
                let mut p = p.clone();
                p.error = Some(e.clone());
                let _ = save(app, &p);
                if let Ok(main) = projects::get(app, &p.project_id) {
                    workflow::warn(&main.root.to_string_lossy(), &e);
                }
            }
        } else if finish_runs {
            let _ = finish(app, &p.id, true);
        }
    }
}

pub(crate) async fn compile(app: Backend, project: String, args: Value) -> Result<Value, String> {
    let id = args["proposalId"].as_str().ok_or("Missing proposalId")?;
    let generation = args["generation"].as_u64().ok_or("Missing generation")?;
    let p = load(&app, id)?;
    if p.project_id != project || p.generation != generation {
        return Err("Stale proposal build".into());
    }
    let r = snapshot(&app, &p)?;
    let files = if args["side"] == "base" {
        &r.before
    } else {
        &r.after
    };
    let main = args["mainFile"].as_str().ok_or("Missing mainFile")?;
    let mut result = crate::visual_review::proposal_pdf(&app, id, main, files).await?;
    result["projectId"] = json!(project);
    result["proposalId"] = json!(id);
    result["generation"] = json!(generation);
    result["threadId"] = json!(p.thread_id);
    result["workspaceId"] = json!(p.id);
    Ok(result)
}

pub(crate) fn steer(app: &Backend, project: &str, thread: &str, text: &str) -> Result<(), String> {
    let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    for mut p in all(app, project)? {
        if p.thread_id.as_deref() == Some(thread)
            && ["running", "repairing"].contains(&p.state.as_str())
        {
            let mut r = snapshot(app, &p)?;
            if !r.history_prompts.is_empty() {
                r.history_prompts.push(text.into());
                p.generation += 1;
                review_storage::save(&snapshot_path(app, &p)?, &r)?;
                save(app, &p)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Backend, projects::Project) {
        let (d, app) = crate::test_backend();
        let root = d.path().join("document");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main.tex"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
        fs::write(root.join("asset.png"), [0, 1, 2]).unwrap();
        let p = projects::project_register(app.clone(), root.to_string_lossy().into()).unwrap();
        workflow::initialize(&p.root.to_string_lossy(), None).unwrap();
        (d, app, p)
    }
    #[test]
    fn planning_releases_empty_workspaces_but_retains_pending_edits() {
        let (_d, app, project) = fixture();
        let mut p = begin(&app, &project.id, Some("plan"), None).unwrap();
        set_planning(&app, &mut p, true).unwrap();
        finish(&app, &p.id, false).unwrap();
        assert!(!locked(&app, &project.id).unwrap());
        let edited = edit(&app, &project.id, "plan", "main.tex", b"pending");
        let mut p = begin(&app, &project.id, Some("plan"), None).unwrap();
        set_planning(&app, &mut p, true).unwrap();
        finish(&app, &p.id, true).unwrap();
        assert!(locked(&app, &project.id).unwrap());
        assert_eq!(snapshot(&app, &p).unwrap().before, snapshot(&app, &edited).unwrap().before);
        assert_eq!(fs::read(root(&app, &p).unwrap().join("main.tex")).unwrap(), b"pending");
    }
    fn edit(app: &Backend, project: &str, thread: &str, file: &str, content: &[u8]) -> Proposal {
        let mut p = begin(app, project, Some(thread), None).unwrap();
        bind(app, &mut p, thread.into()).unwrap();
        fs::write(root(app, &p).unwrap().join(file), content).unwrap();
        finish(app, &p.id, false).unwrap();
        load(app, &p.id).unwrap()
    }
    fn op(app: &Backend, p: &Proposal, action: &str) -> Value {
        service(
            app,
            &p.project_id,
            &format!("proposal_{action}"),
            json!({"proposalId":p.id,"generation":p.generation}),
        )
        .unwrap()
    }
    #[test]
    fn commit_subject_uses_first_prompt_and_resets_after_keep_or_discard() {
        let (_d, app, main) = fixture();
        let p = begin(
            &app,
            &main.id,
            Some("a"),
            Some("  Clarify\n the proof ".into()),
        )
        .unwrap();
        fs::write(root(&app, &p).unwrap().join("main.tex"), b"clarified").unwrap();
        finish(&app, &p.id, false).unwrap();
        let p = begin(&app, &main.id, Some("a"), Some("Make it shorter".into())).unwrap();
        steer(&app, &main.id, "a", "Use fewer examples").unwrap();
        finish(&app, &p.id, false).unwrap();
        let p = load(&app, &p.id).unwrap();
        assert_eq!(
            p.commit_subject.as_deref(),
            Some("docs(agent): Clarify the proof")
        );
        assert!(snapshot(&app, &p).unwrap().history_prompts.is_empty());
        op(&app, &p, "apply");
        let repo = git2::Repository::open(&main.root).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        let message = commit.message().unwrap();
        assert_eq!(
            message.lines().next(),
            Some("docs(agent): Clarify the proof")
        );
        assert!(message.contains("main.tex:"));
        assert!(!message.contains("User prompts:"));
        let p = begin(&app, &main.id, Some("a"), Some("Update the results".into())).unwrap();
        assert_eq!(
            p.commit_subject.as_deref(),
            Some("docs(agent): Update the results")
        );
        finish(&app, &p.id, false).unwrap();
        op(&app, &load(&app, &p.id).unwrap(), "discard");
        let p = begin(&app, &main.id, Some("a"), Some("Fix citations".into())).unwrap();
        assert_eq!(
            p.commit_subject.as_deref(),
            Some("docs(agent): Fix citations")
        );
        // Old persisted proposals without this field still load and use diff-based subjects.
        let mut value = serde_json::to_value(&p).unwrap();
        value.as_object_mut().unwrap().remove("commitSubject");
        let old: Proposal = serde_json::from_value(value).unwrap();
        assert!(old.commit_subject.is_none());
    }

    #[test]
    fn independent_chats_merge_separate_regions_in_either_order() {
        for reverse in [false, true] {
            let (_d, app, main) = fixture();
            let a = edit(
                &app,
                &main.id,
                "a",
                "main.tex",
                b"ONE\ntwo\nthree\nfour\nfive\n",
            );
            let b = edit(
                &app,
                &main.id,
                "b",
                "main.tex",
                b"one\ntwo\nthree\nfour\nFIVE\n",
            );
            assert_eq!(
                fs::read(main.root.join("main.tex")).unwrap(),
                b"one\ntwo\nthree\nfour\nfive\n"
            );
            assert!(crate::codex::assert_unlocked(&app, &main.id).is_err());
            let order = if reverse { [&b, &a] } else { [&a, &b] };
            for p in order {
                assert_eq!(op(&app, p, "apply")["conflicts"], json!([]));
            }
            assert_eq!(
                fs::read(main.root.join("main.tex")).unwrap(),
                b"ONE\ntwo\nthree\nfour\nFIVE\n"
            );
            assert!(!locked(&app, &main.id).unwrap());
            let history =
                crate::history::history_list(main.root.to_string_lossy().into(), 50, 0).unwrap();
            assert_eq!(history.len(), 3);
        }
    }
    #[test]
    fn conflicts_are_atomic_for_text_assets_additions_and_deletions() {
        for (name, a, b) in [
            ("main.tex", b"first".as_slice(), b"second".as_slice()),
            ("asset.png", &[0, 5], &[0, 6]),
            ("added.tex", b"a", b"b"),
        ] {
            let (_d, app, main) = fixture();
            let a = edit(&app, &main.id, "a", name, a);
            let mut b = edit(&app, &main.id, "b", name, b);
            let mut r = snapshot(&app, &b).unwrap();
            r.after
                .insert("clean.tex".into(), b"must not partially apply".to_vec());
            b.generation += 1;
            review_storage::save(&snapshot_path(&app, &b).unwrap(), &r).unwrap();
            save(&app, &b).unwrap();
            op(&app, &a, "apply");
            let before = projects::isolated_snapshot(&main.root).unwrap();
            assert!(op(&app, &b, "apply")["conflicts"]
                .as_array()
                .unwrap()
                .contains(&json!(name)));
            assert_eq!(projects::isolated_snapshot(&main.root).unwrap(), before);
        }
        let (_d, app, main) = fixture();
        let a = edit(&app, &main.id, "a", "main.tex", b"edited");
        let b = begin(&app, &main.id, Some("b"), None).unwrap();
        fs::remove_file(root(&app, &b).unwrap().join("main.tex")).unwrap();
        finish(&app, &b.id, false).unwrap();
        let b = load(&app, &b.id).unwrap();
        op(&app, &a, "apply");
        assert_eq!(op(&app, &b, "apply")["conflicts"], json!(["main.tex"]));
    }
    #[test]
    fn refinements_retain_original_base_and_do_not_accept_other_work() {
        let (_d, app, main) = fixture();
        let a = edit(&app, &main.id, "a", "main.tex", b"first");
        let b = edit(&app, &main.id, "b", "other.tex", b"other");
        let before = snapshot(&app, &a).unwrap().before;
        let a = edit(&app, &main.id, "a", "main.tex", b"refined");
        assert_eq!(snapshot(&app, &a).unwrap().before, before);
        assert_eq!(load(&app, &b.id).unwrap().state, "ready");
        assert!(!main.root.join("other.tex").exists());
        op(&app, &a, "discard");
        op(&app, &b, "apply");
        let next = begin(&app, &main.id, Some("a"), None).unwrap();
        assert_ne!(next.id, a.id);
        assert_eq!(snapshot(&app, &next).unwrap().before["other.tex"], b"other");
    }
    #[test]
    fn repair_keeps_original_and_preserves_a_later_acceptance() {
        let (_d, app, main) = fixture();
        let a = edit(&app, &main.id, "a", "main.tex", b"accepted");
        let mut b = edit(&app, &main.id, "b", "main.tex", b"intended");
        b.commit_subject = workflow::prompt_subject("Explain the intended result");
        save(&app, &b).unwrap();
        op(&app, &a, "apply");
        op(&app, &b, "apply");
        let repair = op(&app, &b, "repair");
        let candidate = load(&app, repair["proposalId"].as_str().unwrap()).unwrap();
        assert_eq!(candidate.commit_subject, b.commit_subject);
        assert_eq!(snapshot(&app, &b).unwrap().after["main.tex"], b"intended");
        assert_eq!(
            snapshot(&app, &candidate).unwrap().before["main.tex"],
            b"accepted"
        );
        let c = edit(&app, &main.id, "c", "later.tex", b"later");
        op(&app, &c, "apply");
        let candidate = edit(&app, &main.id, "b", "main.tex", b"accepted and intended");
        assert!(op(&app, &candidate, "apply")["conflicts"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(fs::read(main.root.join("later.tex")).unwrap(), b"later");
        assert_eq!(load(&app, &b.id).unwrap().state, "superseded");
    }
    #[test]
    fn recovery_retains_running_edits_and_finishes_partial_applications() {
        let (_d, app, main) = fixture();
        let p = begin(&app, &main.id, Some("a"), None).unwrap();
        fs::write(root(&app, &p).unwrap().join("main.tex"), b"captured").unwrap();
        recover(&app);
        let p = load(&app, &p.id).unwrap();
        assert_eq!(p.state, "interrupted");
        assert_eq!(snapshot(&app, &p).unwrap().after["main.tex"], b"captured");
        let before = projects::isolated_snapshot(&main.root).unwrap();
        let mut after = before.clone();
        after.insert("main.tex".into(), b"captured".to_vec());
        after.insert("added.tex".into(), b"added".to_vec());
        let j = Journal {
            proposal: p.clone(),
            before,
            after,
            target: None,
        };
        projects::save_json(&journal_path(&app, &p).unwrap(), &j).unwrap();
        fs::write(main.root.join("main.tex"), b"captured").unwrap();
        recover(&app);
        assert_eq!(load(&app, &p.id).unwrap().state, "applied");
        assert_eq!(fs::read(main.root.join("added.tex")).unwrap(), b"added");
        recover(&app);
        assert_eq!(
            crate::history::history_list(main.root.to_string_lossy().into(), 50, 0)
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn staged_and_unrelated_work_survive_acceptance_and_retry() {
        let (_d, app, main) = fixture();
        let p = edit(&app, &main.id, "a", "main.tex", b"accepted");
        fs::write(main.root.join("unrelated.tex"), b"staged").unwrap();
        let repo = git2::Repository::open(&main.root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("unrelated.tex")).unwrap();
        index.write().unwrap();
        let staged = fs::read(repo.path().join("index")).unwrap();
        let result = op(&app, &p, "apply");
        assert!(result["historyWarning"]
            .as_str()
            .unwrap()
            .contains("staged"));
        assert_eq!(fs::read(repo.path().join("index")).unwrap(), staged);
        assert_eq!(
            fs::read(main.root.join("unrelated.tex")).unwrap(),
            b"staged"
        );
        assert_eq!(fs::read(main.root.join("main.tex")).unwrap(), b"accepted");
        index
            .read_tree(&repo.head().unwrap().peel_to_tree().unwrap())
            .unwrap();
        index.write().unwrap();
        workflow::retry(&main.root.to_string_lossy()).unwrap();
        assert_eq!(
            crate::history::history_list(main.root.to_string_lossy().into(), 50, 0)
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn interrupted_application_does_not_overwrite_external_edits() {
        let (_d, app, main) = fixture();
        let p = edit(&app, &main.id, "a", "main.tex", b"proposal");
        let before = projects::isolated_snapshot(&main.root).unwrap();
        let mut after = before.clone();
        after.insert("main.tex".into(), b"proposal".to_vec());
        let j = Journal {
            proposal: p.clone(),
            before,
            after,
            target: None,
        };
        projects::save_json(&journal_path(&app, &p).unwrap(), &j).unwrap();
        fs::write(main.root.join("main.tex"), b"external").unwrap();
        recover(&app);
        assert_eq!(fs::read(main.root.join("main.tex")).unwrap(), b"external");
        assert!(journal_path(&app, &p).unwrap().exists());
        assert!(load(&app, &p.id)
            .unwrap()
            .error
            .unwrap()
            .contains("external edit"));
    }
    #[test]
    fn directory_file_conflict_can_create_a_repair_candidate() {
        let (_d, app, main) = fixture();
        let a = edit(&app, &main.id, "a", "figures", b"new file");
        fs::create_dir(main.root.join("figures")).unwrap();
        fs::write(main.root.join("figures/plot.png"), b"external asset").unwrap();
        assert!(!op(&app, &a, "apply")["conflicts"]
            .as_array()
            .unwrap()
            .is_empty());
        let result = op(&app, &a, "repair");
        let candidate = load(&app, result["proposalId"].as_str().unwrap()).unwrap();
        assert_eq!(
            fs::read(root(&app, &candidate).unwrap().join("figures/plot.png")).unwrap(),
            b"external asset"
        );
    }
    #[test]
    fn stale_generations_and_legacy_reviews_block_changes() {
        let (_d, app, main) = fixture();
        let p = edit(&app, &main.id, "a", "main.tex", b"first");
        edit(&app, &main.id, "a", "main.tex", b"second");
        assert!(service(
            &app,
            &main.id,
            "proposal_apply",
            json!({"proposalId":p.id,"generation":p.generation})
        )
        .is_err());
        review_storage::save(
            &crate::codex::review_path(&app, &main.id).unwrap(),
            &Review::default(),
        )
        .unwrap();
        assert!(begin(&app, &main.id, Some("other"), None)
            .unwrap_err()
            .contains("legacy"));
    }
    #[cfg(unix)]
    #[test]
    fn copies_reject_links_preserve_assets_and_are_not_hardlinks() {
        let (_d, app, main) = fixture();
        fs::write(main.root.join("figure.pdf"), b"asset").unwrap();
        fs::write(main.root.join("main.pdf"), b"output").unwrap();
        fs::create_dir(main.root.join(".agents")).unwrap();
        fs::write(main.root.join(".agents/instructions.md"), b"guidance").unwrap();
        let p = begin(&app, &main.id, Some("a"), None).unwrap();
        let copy = root(&app, &p).unwrap();
        assert!(copy.join("figure.pdf").exists());
        assert!(!copy.join("main.pdf").exists());
        assert!(copy.join(".agents/instructions.md").exists());
        assert!(!copy.join(".git").exists());
        fs::write(copy.join("asset.png"), b"edit").unwrap();
        assert_eq!(fs::read(main.root.join("asset.png")).unwrap(), [0, 1, 2]);
        std::os::unix::fs::symlink("main.tex", main.root.join("linked.tex")).unwrap();
        assert!(begin(&app, &main.id, Some("b"), None).is_err());
    }
}

pub(crate) fn cancel_thread(app: &Backend, project: &str, thread: &str) -> Result<(), String> {
    let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    for mut p in all(app, project)? {
        if p.thread_id.as_deref() == Some(thread)
            && ["running", "repairing"].contains(&p.state.as_str())
        {
            p.cancel_requested = true;
            save(app, &p)?;
        }
    }
    Ok(())
}

pub(crate) fn set_turn(app: &Backend, id: &str, turn: &str) -> Result<(), String> {
    let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let mut p = load(app, id)?;
    p.turn_id = Some(turn.into());
    save(app, &p)
}
fn cleanup_resolved(app: &Backend, p: &Proposal) {
    if !["applied", "discarded", "superseded"].contains(&p.state.as_str()) {
        return;
    }
    if all(app, &p.project_id)
        .map(|pending| {
            pending
                .iter()
                .any(|other| other.parent.as_deref() == Some(&p.id))
        })
        .unwrap_or(true)
    {
        return;
    }
    // Builds and repair candidates own immutable copies; retain snapshots and
    // visual artifacts, but the resolved mutable execution copy is unreferenced.
    if let Ok(root) = root(app, p) {
        let _ = fs::remove_dir_all(root);
    }
}
