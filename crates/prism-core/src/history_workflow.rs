//! Document-scoped Git writes. The real index is never used to assemble a commit.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

#[path = "history_figures.rs"]
mod figures;

type Inputs = BTreeMap<String, Vec<u8>>;
type Patch = BTreeMap<String, Option<Vec<u8>>>;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    #[serde(default)]
    include_prompt: bool,
    #[serde(default)]
    warning: Option<String>,
    #[serde(default)]
    pending: Vec<Operation>,
    #[serde(default)]
    completed: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Operation {
    id: String,
    branch: String,
    head: Option<String>,
    message: String,
    patch: Patch,
}
fn state_path(root: &str) -> PathBuf {
    Path::new(root).join(".codexprism/history-state.json")
}
fn state(root: &str) -> Result<State, String> {
    match fs::read(state_path(root)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(e) => Err(e.to_string()),
    }
}
fn save(root: &str, s: &State) -> Result<(), String> {
    fs::create_dir_all(Path::new(root).join(".codexprism")).map_err(|e| e.to_string())?;
    crate::projects::save_json(&state_path(root), s)
}
fn mutex(root: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = open_repo(root)
        .map(|r| r.commondir().to_owned())
        .unwrap_or_else(|_| PathBuf::from(root));
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(key)
        .or_default()
        .clone()
}
fn prefix(repo: &Repository, root: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let work = fs::canonicalize(
        repo.workdir()
            .ok_or("Bare repositories cannot hold document files")?,
    )
    .map_err(|e| e.to_string())?;
    root.strip_prefix(work)
        .map(Path::to_path_buf)
        .map_err(|_| "Document is outside repository".into())
}
pub(super) fn scope_paths(
    repo: &Repository,
    root: &str,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let pre = prefix(repo, root)?;
    Ok(paths
        .into_iter()
        .filter_map(|p| {
            Path::new(&p)
                .strip_prefix(&pre)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .collect())
}
pub(super) fn repo_path(repo: &Repository, root: &str, path: &str) -> Result<PathBuf, String> {
    if Path::new(path)
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Invalid document path".into());
    }
    Ok(prefix(repo, root)?.join(path))
}
fn internal(path: &str) -> bool {
    crate::file_policy::history_protected_path(path)
}
fn generated(path: &str) -> bool {
    crate::file_policy::Policy::History.excludes_path(path)
}
pub(crate) fn untracked_output(root: &str, name: &str) -> bool {
    if !generated(name) {
        return false;
    }
    let tracked = open_repo(root).ok().is_some_and(|repo| {
        head(&repo).and_then(|c| c.tree().ok()).is_some_and(|tree| {
            repo_path(&repo, root, name)
                .ok()
                .is_some_and(|p| tree.get_path(&p).is_ok())
        })
    });
    !tracked
}
fn branch(repo: &Repository) -> Result<String, String> {
    if repo.head_detached().map_err(|e| e.to_string())? {
        return Err("History paused: check out a branch before committing".into());
    }
    repo.find_reference("HEAD")
        .map_err(|e| e.to_string())?
        .symbolic_target()
        .map(str::to_owned)
        .ok_or("HEAD has no branch".into())
}
fn head(repo: &Repository) -> Option<git2::Commit<'_>> {
    repo.head().ok().and_then(|r| r.peel_to_commit().ok())
}
fn safe(repo: &Repository) -> Result<(), String> {
    branch(repo)?;
    if repo.state() != git2::RepositoryState::Clean {
        return Err("History paused during a Git merge, rebase or other operation".into());
    }
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.read(true).map_err(|e| e.to_string())?;
    if index.has_conflicts() {
        return Err("History paused: resolve Git conflicts first".into());
    }
    let tree = head(repo).and_then(|c| c.tree().ok());
    let diff = repo
        .diff_tree_to_index(tree.as_ref(), Some(&index), None)
        .map_err(|e| e.to_string())?;
    if diff.deltas().len() > 0 {
        return Err("History paused: commit or unstage externally staged changes first".into());
    }
    Ok(())
}
fn tree_files(
    repo: &Repository,
    root: &str,
    tree: Option<&git2::Tree<'_>>,
) -> Result<Inputs, String> {
    let mut result = Inputs::new();
    let pre = prefix(repo, root)?;
    let mut error = None;
    if let Some(tree) = tree {
        tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                let path = PathBuf::from(format!("{}{}", dir, entry.name().unwrap_or("")));
                if let Ok(rel) = path.strip_prefix(&pre) {
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    if !internal(&rel) {
                        if entry.filemode() == 0o120000 {
                            error =
                                Some("History does not modify tracked symbolic links".to_string());
                            return git2::TreeWalkResult::Abort;
                        }
                        match repo.find_blob(entry.id()) {
                            Ok(b) => {
                                result.insert(rel, b.content().to_vec());
                            }
                            Err(e) => {
                                error = Some(e.to_string());
                            }
                        }
                    }
                }
            }
            git2::TreeWalkResult::Ok
        })
        .map_err(|e| error.clone().unwrap_or_else(|| e.to_string()))?;
    }
    if let Some(e) = error {
        return Err(e);
    }
    Ok(result)
}
pub(crate) fn capture(root: &str) -> Result<Inputs, String> {
    let repo = open_repo(root)?;
    let old = tree_files(
        &repo,
        root,
        head(&repo).and_then(|c| c.tree().ok()).as_ref(),
    )?;
    let mut files = crate::projects::snapshot(Path::new(root))?;
    // Snapshot normally excludes build/hidden files; retain explicitly tracked files.
    for name in old.keys() {
        let path = crate::projects::resolve(Path::new(root), name)?;
        if path.is_file() {
            files.insert(name.clone(), fs::read(path).map_err(|e| e.to_string())?);
        }
    }
    let figures = figures::collect(root, &files, files.keys().cloned().collect())?;
    files.extend(figures.clone());
    files.retain(|name, _| {
        figures.contains_key(name)
            || old.contains_key(name)
            || (!generated(name)
                && repo_path(&repo, root, name)
                    .ok()
                    .is_some_and(|p| !repo.is_path_ignored(&p).unwrap_or(true)))
    });
    Ok(files)
}
fn snapshot_patch(root: &str, mut files: Inputs) -> Result<Patch, String> {
    let repo = open_repo(root)?;
    let old = tree_files(
        &repo,
        root,
        head(&repo).and_then(|c| c.tree().ok()).as_ref(),
    )?;
    let figures = figures::collect(root, &files, files.keys().cloned().collect())?;
    files.extend(figures.clone());
    let mut patch: Patch = old.keys().map(|k| (k.clone(), None)).collect();
    for (name, bytes) in files {
        if figures.contains_key(&name)
            || old.contains_key(&name)
            || (!generated(&name)
                && !repo
                    .is_path_ignored(repo_path(&repo, root, &name)?)
                    .map_err(|e| e.to_string())?)
        {
            patch.insert(name, Some(bytes));
        }
    }
    patch.retain(|name, bytes| old.get(name) != bytes.as_ref());
    Ok(patch)
}

pub(crate) fn initialize(root: &str, baseline: Option<Inputs>) -> Result<(), String> {
    let lock = mutex(root);
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    let private = history_path(root);
    let legacy = Path::new(root).join(".claudeprism/history.git");
    if open_repo(root).is_err() {
        if fs::symlink_metadata(Path::new(root).join(".git")).is_ok() {
            return Err(
                "Existing .git cannot be opened; repair it before using document history".into(),
            );
        }
        let source = if private.exists() {
            Some(private.clone())
        } else if legacy.exists() && !empty_legacy_history(&legacy)? {
            Some(legacy.clone())
        } else {
            None
        };
        if let Some(source) = source {
            let old = Repository::open(&source)
                .map_err(|e| format!("Corrupt legacy history repo: {e}"))?;
            let dest = Path::new(root).join(".git");
            // Atomic rename on this filesystem; no source files or refs are rewritten.
            fs::rename(old.path(), &dest).map_err(|e| format!("History migration failed: {e}"))?;
            let repo = Repository::open(root).map_err(|e| e.to_string())?;
            let mut config = repo.config().map_err(|e| e.to_string())?;
            let _ = config.remove("core.worktree");
            let _ = config.remove("core.excludesfile");
            for old_excludes in [
                Path::new(root).join(".codexprism/history-exclude"),
                Path::new(root).join(".claudeprism/history-exclude"),
            ] {
                if old_excludes.exists() {
                    fs::create_dir_all(dest.join("info")).map_err(|e| e.to_string())?;
                    fs::copy(old_excludes, dest.join("info/exclude")).map_err(|e| e.to_string())?;
                    break;
                }
            }
            // Keep the empty former directory as a migration marker, not a second repository.
        } else {
            Repository::init(root).map_err(|e| e.to_string())?;
            let ignore = Path::new(root).join(".gitignore");
            let defaults = crate::file_policy::initial_gitignore();
            let mut contents = fs::read_to_string(&ignore).unwrap_or_default();
            contents.push_str(&defaults);
            fs::write(ignore, contents).map_err(|e| e.to_string())?;
        }
    }
    let repo = open_repo(root)?;
    // Keep local application state out of external `git add .` too. This does
    // not change tracked files or the user's shared .gitignore rules.
    let exclude = repo.commondir().join("info/exclude");
    if let Some(parent) = exclude.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut rules = match fs::read_to_string(&exclude) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.to_string()),
    };
    let scope = prefix(&repo, root)?.to_string_lossy().replace('\\', "/");
    let scope = scope
        .chars()
        .flat_map(|c| {
            if "*?[]!# ".contains(c) {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect::<String>();
    let scope = if scope.is_empty() {
        String::new()
    } else {
        format!("{scope}/")
    };
    for directory in crate::file_policy::application_directories() {
        let rule = format!("/{scope}{directory}/");
        if !rules.lines().any(|line| line == rule) {
            rules.push_str(&format!("\n{rule}\n"));
        }
    }
    fs::write(exclude, rules).map_err(|e| e.to_string())?;
    // Older versions configured absolute worktree paths; repair only our migrated repo.
    if !private.join(".git").exists()
        && private.exists()
        && repo.path() == Path::new(root).join(".git")
    {
        let _ = repo.config().and_then(|mut c| c.remove("core.worktree"));
    }
    if head(&repo).is_none() {
        let mut files = match baseline {
            Some(files) => files,
            None => capture(root)?,
        };
        if let Ok(bytes) = fs::read(Path::new(root).join(".gitignore")) {
            files.insert(".gitignore".into(), bytes);
        }
        let patch = snapshot_patch(root, files)?;
        record_locked(
            root,
            "initial".into(),
            "docs(history): initial document".into(),
            patch,
        )?;
    }
    Ok(())
}

struct IndexLock(PathBuf);
impl Drop for IndexLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn transaction_paths(
    repo: &Repository,
    op: &Operation,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let index = repo
        .index()
        .map_err(|e| e.to_string())?
        .path()
        .ok_or("Missing index path")?
        .to_owned();
    let lock = index.with_extension("lock");
    let temp = index.with_extension(format!(
        "prism-{}.tmp",
        crate::projects::revision(op.id.as_bytes())
    ));
    Ok((index, lock, temp))
}
fn recover_index(repo: &Repository, op: &Operation) -> Result<(), String> {
    let (index_path, lock, temp) = transaction_paths(repo, op)?;
    let owner = format!("codex-prism:{}", op.id);
    let owned = fs::read_to_string(&lock).ok().as_deref() == Some(owner.as_str());
    if lock.exists() && !owned {
        return Err("Git index is busy; retry after the external Git operation finishes".into());
    }
    let current = head(repo);
    let published = current.as_ref().is_some_and(|c| {
        c.message().is_some_and(|m| {
            m.lines()
                .any(|l| l == format!("Prism-Operation: {}", op.id))
        })
    });
    if published && temp.exists() {
        let mut index = repo.index().map_err(|e| e.to_string())?;
        index.read(true).map_err(|e| e.to_string())?;
        let previous = op
            .head
            .as_ref()
            .and_then(|id| Oid::from_str(id).ok())
            .and_then(|id| repo.find_commit(id).ok())
            .and_then(|c| c.tree().ok());
        if repo
            .diff_tree_to_index(previous.as_ref(), Some(&index), None)
            .map_err(|e| e.to_string())?
            .deltas()
            .len()
            != 0
        {
            return Err("Git index changed during interrupted history recording; preserve staged changes and resolve the index first".into());
        }
        fs::rename(temp, index_path).map_err(|e| e.to_string())?;
    } else if current.as_ref().map(|c| c.id().to_string()) == op.head {
        if temp.exists() {
            fs::remove_file(temp).map_err(|e| e.to_string())?;
        }
    }
    if owned {
        fs::remove_file(lock).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn apply(root: &str, op: &Operation) -> Result<Option<SnapshotInfo>, String> {
    let repo = open_repo(root)?;
    let parent = head(&repo);
    let marker = format!("Prism-Operation: {}", op.id);
    if parent
        .as_ref()
        .is_some_and(|c| c.message().is_some_and(|m| m.lines().any(|l| l == marker)))
    {
        recover_index(&repo, op)?;
        return Ok(None);
    }
    safe(&repo)?;
    if branch(&repo)? != op.branch || parent.as_ref().map(|c| c.id().to_string()) != op.head {
        return Err("History retry paused: branch or HEAD changed. Captured changes remain available in .codexprism/history-state.json".into());
    }
    let index_path = repo
        .index()
        .map_err(|e| e.to_string())?
        .path()
        .ok_or("Missing index path")?
        .to_owned();
    let lock_path = index_path.with_extension("lock");
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("Git index is busy: {e}"))?;
    let lock = IndexLock(lock_path.clone());
    std::io::Write::write_all(&mut file, format!("codex-prism:{}", op.id).as_bytes())
        .map_err(|e| e.to_string())?;
    let mut index = git2::Index::new().map_err(|e| e.to_string())?;
    if let Some(c) = &parent {
        index
            .read_tree(&c.tree().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    let mut changed = vec![];
    for (name, bytes) in &op.patch {
        if internal(name) {
            continue;
        }
        let path = repo_path(&repo, root, name)?;
        let previous = index.get_path(&path, 0);
        // The durable patch has already been filtered at capture/acceptance.
        // Re-filtering here would drop explicitly referenced PDF figures and
        // make retries depend on subsequent changes to ignore rules.
        if let Some(bytes) = bytes {
            let oid = repo.blob(bytes).map_err(|e| e.to_string())?;
            if previous.as_ref().is_some_and(|p| p.id == oid) {
                continue;
            }
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: previous.as_ref().map(|p| p.mode).unwrap_or(0o100644),
                uid: 0,
                gid: 0,
                file_size: bytes.len() as u32,
                id: oid,
                flags: 0,
                flags_extended: 0,
                path: path.to_string_lossy().replace('\\', "/").into_bytes(),
            };
            index.add(&entry).map_err(|e| e.to_string())?;
        } else if previous.is_some() {
            index.remove_path(&path).map_err(|e| e.to_string())?;
        } else {
            continue;
        }
        changed.push(name.clone());
    }
    if changed.is_empty() {
        return Ok(None);
    }
    let tree_id = index.write_tree_to(&repo).map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let sig = repo
        .signature()
        .map_err(|e| e.to_string())
        .or_else(|_| default_signature())?;
    let parents: Vec<_> = parent.iter().collect();
    let message = format!("{}\n\n{}", op.message, marker);
    let id = repo
        .commit(None, &sig, &sig, &message, &tree, &parents)
        .map_err(|e| e.to_string())?;
    // Serialize a fresh index to a temporary sibling, without touching the user's index.
    let (_, _, temp) = transaction_paths(&repo, op)?;
    let mut disk_index = git2::Index::open(&temp).map_err(|e| e.to_string())?;
    disk_index.read_tree(&tree).map_err(|e| e.to_string())?;
    disk_index.write().map_err(|e| e.to_string())?;
    if branch(&repo)? != op.branch {
        let _ = fs::remove_file(&temp);
        return Err("Branch changed while preparing history".into());
    }
    let update = if let Some(c) = &parent {
        repo.reference_matching(&op.branch, id, true, c.id(), &op.message)
    } else {
        repo.reference(&op.branch, id, false, &op.message)
    };
    if let Err(e) = update {
        let _ = fs::remove_file(&temp);
        return Err(e.to_string());
    }
    fs::rename(&temp, &index_path).map_err(|e| e.to_string())?;
    drop(lock);
    Ok(Some(SnapshotInfo {
        id: id.to_string(),
        message,
        timestamp: sig.when().seconds(),
        labels: vec![],
        changed_files: changed,
    }))
}
fn drain(root: &str, state: &mut State) -> Result<Option<SnapshotInfo>, String> {
    let mut last = None;
    while let Some(op) = state.pending.first().cloned() {
        match apply(root, &op) {
            Ok(result) => {
                state.pending.remove(0);
                state.completed.push(op.id);
                if state.completed.len() > 256 {
                    state.completed.remove(0);
                }
                let repo = open_repo(root)?;
                if let Some(next) = state.pending.first_mut() {
                    next.head = head(&repo).map(|c| c.id().to_string());
                }
                state.warning = None;
                save(root, state)?;
                if result.is_some() {
                    last = result;
                }
            }
            Err(e) => {
                state.warning = Some(e.clone());
                save(root, state)?;
                return Err(e);
            }
        }
    }
    Ok(last)
}
fn record_locked(
    root: &str,
    id: String,
    message: String,
    patch: Patch,
) -> Result<Option<SnapshotInfo>, String> {
    let mut s = state(root)?;
    if s.completed.contains(&id) {
        return Ok(None);
    }
    if !s.pending.iter().any(|op| op.id == id) {
        let repo = open_repo(root)?;
        let reference = repo.find_reference("HEAD").map_err(|e| e.to_string())?;
        s.pending.push(Operation {
            id,
            branch: reference.symbolic_target().unwrap_or("HEAD").into(),
            head: head(&repo).map(|c| c.id().to_string()),
            message,
            patch,
        });
        save(root, &s)?;
    }
    drain(root, &mut s)
}
pub(crate) fn checkpoint(
    root: &str,
    message: &str,
    inputs: Option<Inputs>,
) -> Result<Option<SnapshotInfo>, String> {
    let lock = mutex(root);
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    let files = match inputs {
        Some(files) => files,
        None => capture(root)?,
    };
    record_locked(
        root,
        uuid::Uuid::new_v4().to_string(),
        message.into(),
        snapshot_patch(root, files)?,
    )
}
pub(crate) use super::message::prompt_subject;

pub(crate) fn accept(
    root: &str,
    id: &str,
    patch: Patch,
    prompts: &[String],
) -> Result<Option<SnapshotInfo>, String> {
    accept_with_subject(root, id, patch, prompts, None)
}
pub(crate) fn accept_with_subject(
    root: &str,
    id: &str,
    patch: Patch,
    prompts: &[String],
    subject: Option<&str>,
) -> Result<Option<SnapshotInfo>, String> {
    let lock = mutex(root);
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    accept_locked(root, id, patch, prompts, subject)
}
pub(crate) fn recorded(root: &str, id: &str) -> Result<bool, String> {
    Ok(state(root)?.completed.iter().any(|done| done == id))
}
pub(crate) fn target(root: &str) -> Result<String, String> {
    let repo = open_repo(root)?;
    Ok(format!(
        "{}:{:?}",
        branch(&repo)?,
        head(&repo).map(|c| c.id())
    ))
}
pub(crate) fn accept_transaction(
    root: &str,
    expected: &str,
    id: &str,
    patch: Patch,
    prompts: &[String],
    subject: Option<&str>,
    write: impl FnOnce() -> Result<(), String>,
) -> Result<Result<Option<SnapshotInfo>, String>, String> {
    let lock = mutex(root);
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    if target(root)? != expected {
        return Err("Git target changed during merge; retry".into());
    }
    write()?;
    Ok(accept_locked(root, id, patch, prompts, subject))
}
fn accept_locked(
    root: &str,
    id: &str,
    mut patch: Patch,
    prompts: &[String],
    subject: Option<&str>,
) -> Result<Option<SnapshotInfo>, String> {
    let repo = open_repo(root)?;
    let tracked = tree_files(
        &repo,
        root,
        head(&repo).and_then(|c| c.tree().ok()).as_ref(),
    )?;
    // Resolve against the accepted source, not unrelated editor changes on disk.
    let mut intended = tracked.clone();
    for (name, bytes) in &patch {
        match bytes {
            Some(bytes) => {
                intended.insert(name.clone(), bytes.clone());
            }
            None => {
                intended.remove(name);
            }
        }
    }
    let figures = figures::collect(root, &intended, intended.keys().cloned().collect())?;
    for (name, bytes) in &figures {
        if !tracked.contains_key(name) && !patch.contains_key(name) {
            patch.insert(name.clone(), Some(bytes.clone()));
        }
    }
    patch.retain(|name, _| {
        figures.contains_key(name)
            || tracked.contains_key(name)
            || (!generated(name)
                && repo_path(&repo, root, name)
                    .ok()
                    .is_some_and(|p| !repo.is_path_ignored(p).unwrap_or(true)))
    });
    let mut message = super::message::acceptance_message(&tracked, &patch);
    if let Some(subject) = subject {
        let details = message
            .split_once("\n\n")
            .map(|(_, body)| body)
            .unwrap_or("");
        message = format!("{subject}\n\n{details}");
    }
    if !prompts.is_empty() {
        message.push_str("\n\nUser prompts:\n");
        message.push_str(&prompts.join("\n\n---\n\n"));
    }
    record_locked(root, id.into(), message, patch)
}
pub(crate) fn warn(root: &str, error: &str) {
    let lock = mutex(root);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(mut s) = state(root) {
        s.warning = Some(error.into());
        let _ = save(root, &s);
    }
}
pub(crate) fn status(root: &str) -> Result<serde_json::Value, String> {
    let s = state(root)?;
    let repo = open_repo(root)?;
    let archive = [
        history_path(root),
        Path::new(root).join(".claudeprism/history.git"),
    ]
    .into_iter()
    .find(|p| p.join(".git").exists());
    Ok(
        serde_json::json!({"includePrompt":s.include_prompt,"warning":s.warning.or_else(|| (!s.pending.is_empty()).then(|| "History recording was interrupted. Retry to record captured changes.".to_string())),"pending":s.pending.len(),"repositoryPath":repo.path(),"archivePath":archive,"blockedReason":safe(&repo).err()}),
    )
}
pub(crate) fn set_prompt(root: &str, enabled: bool) -> Result<(), String> {
    let lock = mutex(root);
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    let mut s = state(root)?;
    s.include_prompt = enabled;
    save(root, &s)
}
pub(crate) fn include_prompt(root: &str) -> bool {
    state(root).map(|s| s.include_prompt).unwrap_or(false)
}
pub(crate) fn retry(root: &str) -> Result<(), String> {
    let lock = mutex(root);
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    let mut s = state(root)?;
    if let Some(op) = s.pending.first_mut() {
        let repo = open_repo(root)?;
        recover_index(&repo, op)?;
        safe(&repo)?;
        let current = head(&repo);
        if branch(&repo)? != op.branch {
            return Err("History retry paused: return to the original branch".into());
        }
        if current.as_ref().map(|c| c.id().to_string()) != op.head {
            // An explicit retry may follow an external commit, but only when
            // every captured path is unchanged or already has the intended bytes.
            let base = op
                .head
                .as_ref()
                .map(|id| {
                    Oid::from_str(id)
                        .map_err(|e| e.to_string())
                        .and_then(|id| repo.find_commit(id).map_err(|e| e.to_string()))
                })
                .transpose()?;
            let old = tree_files(
                &repo,
                root,
                base.as_ref().and_then(|c| c.tree().ok()).as_ref(),
            )?;
            let now = tree_files(
                &repo,
                root,
                current.as_ref().and_then(|c| c.tree().ok()).as_ref(),
            )?;
            if op.patch.iter().any(|(name, bytes)| {
                now.get(name) != old.get(name) && now.get(name) != bytes.as_ref()
            }) {
                return Err("History retry paused: HEAD changed a captured file. Captured changes remain available in .codexprism/history-state.json".into());
            }
            op.head = current.as_ref().map(|c| c.id().to_string());
            save(root, &s)?;
        }
    }
    drain(root, &mut s)?;
    Ok(())
}
pub(crate) fn restore(root: &str, target: &str) -> Result<SnapshotInfo, String> {
    // Refuse untracked collisions before a checkpoint can start tracking them.
    {
        let repo = open_repo(root)?;
        safe(&repo)?;
        let target = repo
            .find_commit(Oid::from_str(target).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let old = tree_files(
            &repo,
            root,
            head(&repo).and_then(|c| c.tree().ok()).as_ref(),
        )?;
        let files = tree_files(
            &repo,
            root,
            Some(&target.tree().map_err(|e| e.to_string())?),
        )?;
        for name in files.keys() {
            if !old.contains_key(name) && crate::projects::resolve(Path::new(root), name)?.exists()
            {
                return Err(format!("Untracked file would be overwritten: {name}"));
            }
        }
    }
    // Checkpoint acquires the same repository lock separately, before restoration.
    checkpoint(root, "docs(history): checkpoint before restore", None)?;
    let lock = mutex(root);
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    let repo = open_repo(root)?;
    safe(&repo)?;
    let target = repo
        .find_commit(Oid::from_str(target).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let files = tree_files(
        &repo,
        root,
        Some(&target.tree().map_err(|e| e.to_string())?),
    )?;
    let old = tree_files(
        &repo,
        root,
        head(&repo).and_then(|c| c.tree().ok()).as_ref(),
    )?;
    for name in files.keys() {
        let path = crate::projects::resolve(Path::new(root), name)?;
        if !old.contains_key(name) && path.exists() {
            return Err(format!("Untracked file would be overwritten: {name}"));
        }
    }
    let before = capture(root)?;
    if before != old {
        return Err("Files changed since the recovery checkpoint; retry restore".into());
    }
    let original_head = head(&repo).map(|c| c.id());
    let operation_id = uuid::Uuid::new_v4().to_string();
    let result = (|| {
        for name in old.keys().filter(|p| !files.contains_key(*p)) {
            let path = crate::projects::resolve(Path::new(root), name)?;
            if path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
        for (name, bytes) in &files {
            let path = crate::projects::resolve(Path::new(root), name)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(path, bytes).map_err(|e| e.to_string())?;
        }
        let message = format!(
            "docs(history): restore version {}",
            &target.id().to_string()[..8]
        );
        match record_locked(
            root,
            operation_id.clone(),
            message.clone(),
            snapshot_patch(root, files.clone())?,
        )? {
            Some(info) => Ok(info),
            None => Ok(SnapshotInfo {
                id: original_head.ok_or("Missing HEAD")?.to_string(),
                message,
                timestamp: chrono::Utc::now().timestamp(),
                labels: vec![],
                changed_files: vec![],
            }),
        }
    })();
    if result.is_err() && head(&repo).map(|c| c.id()) == original_head {
        if let Ok(mut s) = state(root) {
            s.pending.retain(|op| op.id != operation_id);
            let _ = save(root, &s);
        }
        // Leave the durable recovery commit intact; attempt to restore saved bytes.
        for name in files.keys().filter(|p| !before.contains_key(*p)) {
            let _ = fs::remove_file(Path::new(root).join(name));
        }
        for (name, bytes) in before {
            let path = Path::new(root).join(name);
            if let Some(p) = path.parent() {
                let _ = fs::create_dir_all(p);
            }
            let _ = fs::write(path, bytes);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("main.tex"), b"before").unwrap();
        fs::write(d.path().join("other.tex"), b"unchanged").unwrap();
        initialize(d.path().to_str().unwrap(), None).unwrap();
        d
    }
    fn contents(repo: &Repository, path: &str) -> Vec<u8> {
        let tree = head(repo).unwrap().tree().unwrap();
        repo.find_blob(tree.get_path(Path::new(path)).unwrap().id())
            .unwrap()
            .content()
            .to_vec()
    }
    #[test]
    fn history_preserves_tracked_auxiliaries_but_excludes_new_outputs_and_environments() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().to_str().unwrap();
        let repo = Repository::init(root).unwrap();
        fs::write(d.path().join("main.tex"), "source").unwrap();
        fs::write(d.path().join("tracked.nav"), "tracked starter").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("main.tex")).unwrap();
        index.add_path(Path::new("tracked.nav")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "Existing files", &tree, &[])
            .unwrap();
        initialize(root, None).unwrap();
        fs::write(d.path().join("tracked.nav"), "modified tracked starter").unwrap();
        for name in [
            "slides.nav",
            "slides.snm",
            "slides.vrb",
            "main.AUX",
            "main.SYNCTEX.GZ",
            "main.run.xml",
        ] {
            fs::write(d.path().join(name), "generated").unwrap();
        }
        for folder in [".venv", "env", "target"] {
            fs::create_dir(d.path().join(folder)).unwrap();
            fs::write(d.path().join(folder).join("data.txt"), "environment").unwrap();
        }
        checkpoint(root, "Update tracked input", None).unwrap();
        assert_eq!(contents(&repo, "tracked.nav"), b"modified tracked starter");
        let tree = head(&repo).unwrap().tree().unwrap();
        for name in [
            "slides.nav",
            "slides.snm",
            "slides.vrb",
            "main.AUX",
            "main.SYNCTEX.GZ",
            "main.run.xml",
            ".venv/data.txt",
            "env/data.txt",
            "target/data.txt",
        ] {
            assert!(tree.get_path(Path::new(name)).is_err(), "{name}");
        }
    }

    #[test]
    fn referenced_figures_are_committed_but_output_pdf_is_not() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        fs::create_dir(d.path().join("figures")).unwrap();
        fs::write(d.path().join("figures/plot.pdf"), b"figure pdf").unwrap();
        fs::write(
            d.path().join("figures/plot.tex"),
            b"standalone figure source",
        )
        .unwrap();
        fs::write(d.path().join("figures/photo.png"), b"figure png").unwrap();
        fs::write(d.path().join("main.pdf"), b"compiled document").unwrap();
        fs::write(d.path().join("unused.pdf"), b"unused").unwrap();
        fs::write(
            d.path().join("section.tex"),
            br"\includegraphics[width=2cm]{photo}",
        )
        .unwrap();
        fs::write(
            d.path().join("main.tex"),
            br"\graphicspath{{figures/}}
\includegraphics{plot}
\input{section}
% \includegraphics{missing}",
        )
        .unwrap();
        checkpoint(root, "docs: add figures", None).unwrap();
        let repo = open_repo(root).unwrap();
        assert_eq!(contents(&repo, "figures/plot.pdf"), b"figure pdf");
        assert_eq!(contents(&repo, "figures/photo.png"), b"figure png");
        let tree = head(&repo).unwrap().tree().unwrap();
        assert!(tree.get_path(Path::new("main.pdf")).is_err());
        assert!(tree.get_path(Path::new("unused.pdf")).is_err());
        let patch = BTreeMap::from([("figures/plot.pdf".into(), Some(b"updated pdf".to_vec()))]);
        accept(root, "update-figure", patch, &[]).unwrap();
        assert_eq!(contents(&repo, "figures/plot.pdf"), b"updated pdf");
    }
    #[test]
    fn acceptance_adds_existing_untracked_figure_and_retries_captured_bytes() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        fs::write(d.path().join("plot.pdf"), b"original figure").unwrap();
        fs::write(d.path().join("other.tex"), b"unrelated editor change").unwrap();
        let repo = open_repo(root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("other.tex")).unwrap();
        index.write().unwrap();
        let patch =
            BTreeMap::from([("main.tex".into(), Some(br"\includegraphics{plot}".to_vec()))]);
        assert!(accept(root, "figures", patch, &[]).is_err());
        assert_eq!(
            state(root).unwrap().pending[0].patch["plot.pdf"],
            Some(b"original figure".to_vec())
        );
        fs::write(d.path().join("plot.pdf"), b"later figure").unwrap();
        index
            .read_tree(&head(&repo).unwrap().tree().unwrap())
            .unwrap();
        index.write().unwrap();
        retry(root).unwrap();
        assert_eq!(contents(&repo, "plot.pdf"), b"original figure");
        assert_eq!(contents(&repo, "other.tex"), b"unchanged");
        assert_eq!(
            fs::read(d.path().join("other.tex")).unwrap(),
            b"unrelated editor change"
        );
    }
    #[test]
    fn missing_and_external_figures_do_not_create_incomplete_commits() {
        for reference in ["missing.png", "../outside.png", "/tmp/outside.png"] {
            let d = fixture();
            let root = d.path().to_str().unwrap();
            let repo = open_repo(root).unwrap();
            let before = head(&repo).unwrap().id();
            let patch = BTreeMap::from([(
                "main.tex".into(),
                Some(format!("\\includegraphics{{{reference}}}").into_bytes()),
            )]);
            assert!(accept(root, "invalid", patch, &[]).is_err());
            assert_eq!(head(&repo).unwrap().id(), before);
        }
    }
    #[test]
    fn interrupted_ref_publication_recovers_owned_index_without_duplicate_commit() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        let repo = open_repo(root).unwrap();
        let previous = head(&repo).unwrap();
        let op = Operation {
            id: "interrupted".into(),
            branch: branch(&repo).unwrap(),
            head: Some(previous.id().to_string()),
            message: "docs: interrupted acceptance".into(),
            patch: BTreeMap::from([("main.tex".into(), Some(b"accepted".to_vec()))]),
        };
        let mut s = state(root).unwrap();
        s.pending.push(op.clone());
        save(root, &s).unwrap();
        let committed = apply(root, &op).unwrap().unwrap();
        let (index_path, lock, temp) = transaction_paths(&repo, &op).unwrap();
        fs::copy(&index_path, &temp).unwrap();
        let mut index = repo.index().unwrap();
        index.read_tree(&previous.tree().unwrap()).unwrap();
        index.write().unwrap();
        fs::write(lock, format!("codex-prism:{}", op.id)).unwrap();
        retry(root).unwrap();
        let repo = open_repo(root).unwrap();
        safe(&repo).unwrap();
        assert_eq!(head(&repo).unwrap().id().to_string(), committed.id);
        assert!(state(root).unwrap().pending.is_empty());
    }
    #[test]
    fn linked_worktree_uses_its_own_branch_and_index() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        let repo = open_repo(root).unwrap();
        let original = head(&repo).unwrap().id();
        let location = tempfile::tempdir().unwrap();
        let linked = location.path().join("linked");
        repo.worktree("linked", &linked, None).unwrap();
        assert!(linked.join(".git").is_file());
        initialize(linked.to_str().unwrap(), None).unwrap();
        fs::write(linked.join("main.tex"), "linked edit").unwrap();
        checkpoint(linked.to_str().unwrap(), "docs: linked edit", None).unwrap();
        assert_eq!(head(&repo).unwrap().id(), original);
        assert_eq!(fs::read(d.path().join("main.tex")).unwrap(), b"before");
        let linked_repo = open_repo(linked.to_str().unwrap()).unwrap();
        safe(&linked_repo).unwrap();
        assert_eq!(contents(&linked_repo, "main.tex"), b"linked edit");
    }
    #[test]
    fn restore_refuses_untracked_collision_without_making_a_checkpoint() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        let repo = open_repo(root).unwrap();
        let initial = head(&repo).unwrap().id().to_string();
        fs::remove_file(d.path().join("other.tex")).unwrap();
        checkpoint(root, "docs: remove file", None).unwrap();
        let before = head(&repo).unwrap().id();
        fs::write(d.path().join("other.tex"), "untracked work").unwrap();
        assert!(restore(root, &initial)
            .unwrap_err()
            .contains("Untracked file"));
        assert_eq!(head(&repo).unwrap().id(), before);
        assert_eq!(
            fs::read(d.path().join("other.tex")).unwrap(),
            b"untracked work"
        );
    }
    #[test]
    fn acceptance_only_commits_selected_content_and_retries_exact_bytes() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        let repo = open_repo(root).unwrap();
        fs::write(d.path().join("main.tex"), "accepted").unwrap();
        fs::write(d.path().join("other.tex"), "unrelated").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("other.tex")).unwrap();
        index.write().unwrap();
        let staged = fs::read(repo.path().join("index")).unwrap();
        let patch = BTreeMap::from([("main.tex".into(), Some(b"accepted".to_vec()))]);
        assert!(accept(root, "accept-one", patch.clone(), &[])
            .unwrap_err()
            .contains("staged"));
        assert_eq!(fs::read(repo.path().join("index")).unwrap(), staged);
        fs::write(d.path().join("main.tex"), "later external edit").unwrap();
        index
            .read_tree(&head(&repo).unwrap().tree().unwrap())
            .unwrap();
        index.write().unwrap();
        retry(root).unwrap();
        assert_eq!(contents(&repo, "main.tex"), b"accepted");
        assert_eq!(contents(&repo, "other.tex"), b"unchanged");
        assert_eq!(
            fs::read(d.path().join("main.tex")).unwrap(),
            b"later external edit"
        );
        let id = head(&repo).unwrap().id();
        accept(root, "accept-one", patch, &[]).unwrap();
        assert_eq!(head(&repo).unwrap().id(), id);
        safe(&repo).unwrap();
    }
    #[test]
    fn document_in_parent_repo_does_not_commit_or_restore_siblings() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        let sub = d.path().join("paper");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("main.tex"), "v1").unwrap();
        checkpoint(root, "docs: add paper", None).unwrap();
        let first = head(&open_repo(root).unwrap()).unwrap().id().to_string();
        fs::write(d.path().join("other.tex"), "sibling edit").unwrap();
        fs::write(sub.join("main.tex"), "v2").unwrap();
        let snap = checkpoint(sub.to_str().unwrap(), "docs: paper only", None)
            .unwrap()
            .unwrap();
        assert_eq!(snap.changed_files, vec!["main.tex"]);
        assert_eq!(
            contents(&open_repo(root).unwrap(), "other.tex"),
            b"unchanged"
        );
        restore(sub.to_str().unwrap(), &first).unwrap();
        assert_eq!(fs::read(sub.join("main.tex")).unwrap(), b"v1");
        assert_eq!(
            fs::read(d.path().join("other.tex")).unwrap(),
            b"sibling edit"
        );
    }
    #[test]
    fn private_migration_preserves_ids_labels_and_remotes() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        let repo = open_repo(root).unwrap();
        let id = head(&repo).unwrap().id();
        repo.remote("backup", "/tmp/not-contacted").unwrap();
        repo.tag_lightweight("draft", head(&repo).unwrap().as_object(), false)
            .unwrap();
        let private = history_path(root);
        fs::create_dir_all(&private).unwrap();
        fs::rename(d.path().join(".git"), private.join(".git")).unwrap();
        initialize(root, None).unwrap();
        let repo = open_repo(root).unwrap();
        assert_eq!(head(&repo).unwrap().id(), id);
        assert_eq!(repo.revparse_single("draft").unwrap().id(), id);
        assert_eq!(
            repo.find_remote("backup").unwrap().url(),
            Some("/tmp/not-contacted")
        );
        assert!(!private.join(".git").exists());
    }
    #[test]
    fn restored_version_deletes_later_files_and_preserves_outputs() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        let first = head(&open_repo(root).unwrap()).unwrap().id().to_string();
        fs::write(d.path().join("added.tex"), "saved later").unwrap();
        fs::remove_file(d.path().join("other.tex")).unwrap();
        fs::write(d.path().join("main.pdf"), "excluded output").unwrap();
        checkpoint(root, "docs: later", None).unwrap();
        restore(root, &first).unwrap();
        assert!(!d.path().join("added.tex").exists());
        assert_eq!(fs::read(d.path().join("other.tex")).unwrap(), b"unchanged");
        assert_eq!(
            fs::read(d.path().join("main.pdf")).unwrap(),
            b"excluded output"
        );
        assert_eq!(
            super::super::history_list(root.into(), 50, 0)
                .unwrap()
                .len(),
            3
        );
    }
    #[test]
    fn external_push_clone_and_prompt_opt_in_use_ordinary_git() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        assert!(!include_prompt(root));
        set_prompt(root, true).unwrap();
        assert!(include_prompt(root));
        let patch = BTreeMap::from([
            ("main.tex".into(), Some(b"new".to_vec())),
            ("image.png".into(), Some(vec![0, 255, 3])),
        ]);
        accept(
            root,
            "batch",
            patch,
            &["Improve the introduction".into(), "Keep it short".into()],
        )
        .unwrap();
        let repo = open_repo(root).unwrap();
        let message = head(&repo).unwrap().message().unwrap().to_owned();
        assert!(message.starts_with("docs(agent): "));
        assert!(message.contains("main.tex: revise"));
        assert!(message.contains("image.png: add asset"));
        assert!(message.contains("Improve the introduction"));
        assert!(message.contains("Keep it short"));
        let remote = tempfile::tempdir().unwrap();
        Repository::init_bare(remote.path()).unwrap();
        let branch = branch(&repo).unwrap();
        let output = std::process::Command::new("git")
            .current_dir(d.path())
            .args([
                "push",
                remote.path().to_str().unwrap(),
                &format!("{branch}:{branch}"),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let clone = tempfile::tempdir().unwrap();
        let output = std::process::Command::new("git")
            .args([
                "clone",
                "--branch",
                branch.strip_prefix("refs/heads/").unwrap(),
                remote.path().to_str().unwrap(),
                clone.path().to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(clone.path().join("main.tex")).unwrap(), b"new");
        assert_eq!(
            fs::read(clone.path().join("image.png")).unwrap(),
            vec![0, 255, 3]
        );
    }
    #[test]
    fn retry_refuses_different_head_and_preserves_captured_changes() {
        let d = fixture();
        let root = d.path().to_str().unwrap();
        let repo = open_repo(root).unwrap();
        let mut index = repo.index().unwrap();
        fs::write(d.path().join("other.tex"), "staged").unwrap();
        index.add_path(Path::new("other.tex")).unwrap();
        index.write().unwrap();
        assert!(accept(
            root,
            "pending",
            BTreeMap::from([("main.tex".into(), Some(b"accepted".to_vec()))]),
            &[]
        )
        .is_err());
        fs::write(d.path().join("main.tex"), "conflicting external commit").unwrap();
        index.add_path(Path::new("main.tex")).unwrap();
        index.write().unwrap();
        let treeid = index.write_tree().unwrap();
        let tree = repo.find_tree(treeid).unwrap();
        let sig = default_signature().unwrap();
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            "external commit",
            &tree,
            &[&head(&repo).unwrap()],
        )
        .unwrap();
        assert!(retry(root).unwrap_err().contains("HEAD changed"));
        assert_eq!(state(root).unwrap().pending.len(), 1);
        assert_eq!(contents(&repo, "main.tex"), b"conflicting external commit");
    }
}
