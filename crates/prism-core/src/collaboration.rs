//! Repository collaboration. Network work never owns the document mutation lock.
use crate::{history::workflow, projects, Backend};
use git2::{Oid, Repository};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

#[derive(Default)]
pub(crate) struct State {
    tokens: Mutex<HashMap<String, Credential>>,
    refresh_lock: tokio::sync::Mutex<()>,
    jobs: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
    oauth: Mutex<HashMap<String, OAuth>>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Credential {
    token: String,
    username: String,
    #[serde(default)]
    refresh: Option<RefreshCredential>,
    #[serde(default)]
    remembered: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct RefreshCredential {
    server: String,
    client: String,
    token: String,
    expires_at: i64,
}
struct OAuth {
    listener: tokio::net::TcpListener,
    server: String,
    client: String,
    verifier: String,
    redirect: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    remote: String,
    branch: String,
    url: String,
    #[serde(default)]
    last_remote: Option<String>,
    #[serde(default)]
    checked_at: Option<i64>,
    #[serde(default)]
    message: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Integration {
    branch: String,
    before: String,
    after: String,
}
fn config_path(root: &Path) -> PathBuf {
    root.join(".codexprism/collaboration.json")
}
fn journal_path(root: &Path) -> PathBuf {
    root.join(".codexprism/integration.json")
}
fn read_connection(root: &Path) -> Result<Option<Connection>, String> {
    match std::fs::read(config_path(root)) {
        Ok(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
pub(crate) fn incoming_revision(root: &Path) -> Result<Option<Oid>, String> {
    Ok(read_connection(root)?
        .and_then(|c| c.last_remote)
        .and_then(|s| Oid::from_str(&s).ok()))
}
fn write_connection(root: &Path, c: &Connection) -> Result<(), String> {
    std::fs::create_dir_all(root.join(".codexprism")).map_err(|e| e.to_string())?;
    projects::save_json(&config_path(root), c)
}
fn repository(root: &Path) -> Result<Repository, String> {
    let repo = Repository::open(root).map_err(|e| e.to_string())?;
    let work = repo.workdir().ok_or("A working repository is required")?;
    if std::fs::canonicalize(work).map_err(|e| e.to_string())?
        != std::fs::canonicalize(root).map_err(|e| e.to_string())?
    {
        return Err("Collaboration requires the project folder to be the repository root".into());
    }
    Ok(repo)
}
fn head(repo: &Repository) -> Result<Oid, String> {
    repo.head()
        .and_then(|h| h.peel_to_commit())
        .map(|c| c.id())
        .map_err(|e| e.to_string())
}
fn branch(repo: &Repository) -> Result<String, String> {
    if repo.head_detached().map_err(|e| e.to_string())? {
        return Err("Check out the shared branch before synchronizing".into());
    }
    repo.head()
        .map_err(|e| e.to_string())?
        .name()
        .map(str::to_owned)
        .ok_or("Missing branch".into())
}
fn tracked_clean(repo: &Repository) -> Result<(), String> {
    workflow::safe(repo)?;
    let mut options = git2::StatusOptions::new();
    options.include_untracked(false);
    if !repo
        .statuses(Some(&mut options))
        .map_err(|e| e.to_string())?
        .is_empty()
    {
        return Err("Local edits await an explicit Save checkpoint".into());
    }
    Ok(())
}
fn validate_tree(repo: &Repository, oid: Oid) -> Result<(), String> {
    let tree = repo
        .find_commit(oid)
        .and_then(|c| c.tree())
        .map_err(|e| e.to_string())?;
    let mut invalid = None;
    tree.walk(git2::TreeWalkMode::PreOrder, |dir, e| {
        let name = format!("{dir}{}", e.name().unwrap_or(""));
        if name.split('/').any(|p| [".git", ".codexprism", ".claudeprism", ".prism"].contains(&p.to_ascii_lowercase().as_str())) {
            invalid = Some(format!("Repository tracks private application state: {name}. Collaboration cannot overwrite local recovery data."));
        }
        if [0o120000, 0o160000].contains(&e.filemode()) || name == ".gitmodules" {
            invalid = Some(format!("Collaboration does not yet support symlinks or submodules: {name}"));
        }
        if e.kind() == Some(git2::ObjectType::Blob) {
            if let Ok(b) = repo.find_blob(e.id()) {
                if b.content().starts_with(b"version https://git-lfs.github.com/spec/v1") {
                    invalid = Some(format!("Collaboration does not yet support LFS inputs: {name}"));
                }
            }
        }
        git2::TreeWalkResult::Ok
    }).map_err(|e| e.to_string())?;
    invalid.map_or(Ok(()), Err)
}

/// Do not replace an existing identity on reconnection.
fn set_identity(repo: &Repository, args: &Value) -> Result<(), String> {
    let mut config = repo.config().map_err(|e| e.to_string())?;
    for (field, key) in [("name", "user.name"), ("email", "user.email")] {
        if let Some(value) = args[field].as_str().filter(|s| !s.trim().is_empty()) {
            if value.contains(['\n', '\r', '\0']) {
                return Err("Invalid contributor identity".into());
            }
            config.set_str(key, value).map_err(|e| e.to_string())?;
        }
    }
    repo.signature()
        .map_err(|_| "Enter your contributor name and email".to_owned())?;
    Ok(())
}

struct Job {
    app: Backend,
    key: String,
}
impl Drop for Job {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.app.inner.collaboration.jobs.lock() {
            jobs.remove(&self.key);
        }
    }
}
fn job(app: &Backend, key: &str) -> Result<(Job, tokio::sync::watch::Receiver<bool>), String> {
    let mut jobs = app
        .inner
        .collaboration
        .jobs
        .lock()
        .map_err(|e| e.to_string())?;
    if jobs.contains_key(key) {
        return Err("Collaboration operation already running".into());
    }
    let (tx, rx) = tokio::sync::watch::channel(false);
    jobs.insert(key.into(), tx);
    Ok((
        Job {
            app: app.clone(),
            key: key.into(),
        },
        rx,
    ))
}

// Git executes askpass directly, so preserve a literal executable path rather
// than shell-quoting it (including spaces and canonical Windows prefixes).
fn askpass_command(path: &Path) -> &std::ffi::OsStr {
    path.as_os_str()
}

pub(crate) async fn git(
    app: &Backend,
    root: &Path,
    args: &[&str],
    url: Option<&str>,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let binary = which::which("git")
        .map_err(|_| "Install Git to use collaboration and review branches".to_owned())?;
    let mut command = tokio::process::Command::new(binary);
    command
        .arg("-C")
        .arg(root)
        .kill_on_drop(true)
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0");
    let token = if let Some(server) = url.and_then(origin) {
        credential(app, &server).await?
    } else {
        None
    };
    if let Some(credential) = &token {
        command
            .args([
                "-c",
                "credential.helper=",
                "-c",
                "http.followRedirects=false",
            ])
            .env(
                "GIT_ASKPASS",
                askpass_command(
                    &app.inner
                        .git_askpass
                        .lock()
                        .map_err(|e| e.to_string())?
                        .clone()
                        .ok_or("Host has not configured a Git credential helper")?,
                ),
            )
            .env("PRISM_GIT_ASKPASS", "1")
            .env("PRISM_GIT_TOKEN", &credential.token)
            .env("PRISM_GIT_USER", &credential.username);
    }
    command.args(args);
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        command.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes -oConnectTimeout=15");
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    let mut shutdown = app.inner.cancel.subscribe();
    if *cancel.borrow() || *shutdown.borrow() {
        return Err("Operation cancelled".into());
    }
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    let stdout = child.stdout.take().ok_or("Missing Git output")?;
    let stderr = child.stderr.take().ok_or("Missing Git diagnostics")?;
    let outcome = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(90), async {
            let (status,out,err) = tokio::join!(child.wait(), read_output(stdout), read_output(stderr));
            Ok::<_,String>((status.map_err(|e|e.to_string())?,out?,err?))
        }) => result.map_err(|_|"Git operation timed out".to_owned()).and_then(|r|r),
        _ = cancel.changed() => Err("Operation cancelled".into()),
        _ = shutdown.changed() => Err("Application is stopping".into()),
    };
    let (status, stdout, stderr) = match outcome {
        Ok(value) => value,
        Err(error) => {
            if let Some(pid) = pid {
                #[cfg(unix)]
                let _ = tokio::time::timeout(
                    Duration::from_secs(3),
                    tokio::process::Command::new("/bin/kill")
                        .args(["-KILL", "--", &format!("-{pid}")])
                        .output(),
                )
                .await;
                #[cfg(windows)]
                let _ = tokio::time::timeout(
                    Duration::from_secs(3),
                    tokio::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .output(),
                )
                .await;
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    };
    if !status.success() {
        let mut error = String::from_utf8_lossy(&stderr).to_string();
        if let Some(token) = token {
            error = error.replace(&token.token, "[redacted]");
        }
        return Err(error.chars().take(1600).collect());
    }
    Ok(String::from_utf8_lossy(&stdout).trim().to_owned())
}
async fn read_output(mut reader: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncReadExt;
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    let mut overflow = false;
    loop {
        let count = reader.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        if result.len() + count <= 8 * 1024 * 1024 {
            result.extend_from_slice(&buffer[..count]);
        } else {
            overflow = true;
        }
    }
    if overflow {
        Err("Git response exceeded the supported size".into())
    } else {
        Ok(result)
    }
}

fn origin(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url).ok()?;
    (u.scheme() == "https").then(|| u.origin().ascii_serialization())
}
fn validate_url(url: &str) -> Result<(), String> {
    if url.contains(['\0', '\n', '\r']) || url.starts_with('-') {
        return Err("Invalid repository URL".into());
    }
    if let Some(rest) = url.strip_prefix("git@") {
        let (host, path) = rest.split_once(':').ok_or("Invalid SSH repository URL")?;
        if host.is_empty()
            || host.starts_with('-')
            || !host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
            || path.is_empty()
        {
            return Err("Invalid SSH repository URL".into());
        }
        return Ok(());
    }
    let u =
        reqwest::Url::parse(url).map_err(|_| "Use an HTTPS or SSH repository URL".to_owned())?;
    if !["https", "ssh"].contains(&u.scheme())
        || u.password().is_some()
        || (u.scheme() == "https" && !u.username().is_empty())
    {
        return Err("Use HTTPS or SSH; do not include credentials in the repository URL".into());
    }
    Ok(())
}
fn decode_path(path: &str) -> Result<String, String> {
    let bytes = path.as_bytes();
    let mut result = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("Invalid escaped branch link".into());
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            result.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| "Invalid escaped branch link".to_owned())?,
            );
            i += 3;
        } else {
            result.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(result).map_err(|e| e.to_string())
}

async fn resolve(
    app: &Backend,
    args: &Value,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Value, String> {
    let input = args["url"].as_str().ok_or("Enter a repository URL")?.trim();
    validate_url(input)?;
    let mut url = input.to_owned();
    let requested = args["branch"].as_str().unwrap_or("").to_owned();
    let mut suffix = None;
    if let Ok(mut parsed) = reqwest::Url::parse(input) {
        let path = parsed.path().to_owned();
        let marker = if parsed.host_str() == Some("github.com") {
            "/tree/"
        } else {
            "/src/branch/"
        };
        if let Some((repo, tail)) = path.split_once(marker) {
            suffix = Some(decode_path(tail)?);
            parsed.set_path(repo);
            parsed.set_query(None);
            parsed.set_fragment(None);
            url = parsed.to_string();
        }
    }
    if args["transport"] == "ssh" && url.starts_with("https://") {
        let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
        let path = parsed.path().trim_end_matches('/').trim_end_matches(".git");
        if parsed.host_str() == Some("github.com") {
            url = format!("git@github.com:{path}.git").replace("github.com:/", "github.com:");
        } else {
            let pieces: Vec<_> = path.trim_start_matches('/').split('/').collect();
            if pieces.len() < 2 {
                return Err("Enter a repository URL".into());
            }
            let prefix = pieces[..pieces.len() - 2].join("/");
            let api = format!(
                "{}{}/api/v1/repos/{}/{}",
                parsed.origin().ascii_serialization(),
                if prefix.is_empty() {
                    String::new()
                } else {
                    format!("/{prefix}")
                },
                pieces[pieces.len() - 2],
                pieces[pieces.len() - 1]
            );
            let token = credential(app, &parsed.origin().ascii_serialization()).await?;
            let mut request = http()?.get(api);
            if let Some(token) = token {
                request = request.bearer_auth(token.token);
            }
            let response = request
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?;
            let metadata: Value =
                serde_json::from_str(&response.text().await.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            url = metadata["ssh_url"]
                .as_str()
                .ok_or("This server did not provide an SSH clone URL; paste it directly")?
                .into();
            validate_url(&url)?;
        }
    }
    let refs = git(
        app,
        &app.inner.config.temp_dir,
        &["ls-remote", "--symref", &url, "HEAD", "refs/heads/*"],
        Some(&url),
        cancel,
    )
    .await?;
    resolve_refs(&url, requested, suffix, &refs)
}

fn resolve_refs(
    url: &str,
    mut requested: String,
    suffix: Option<String>,
    refs: &str,
) -> Result<Value, String> {
    let branches: Vec<_> = refs
        .lines()
        .filter_map(|l| l.split_once('\t').map(|(_, r)| r))
        .filter_map(|r| r.strip_prefix("refs/heads/"))
        .collect();
    let default = refs.lines().find_map(|l| {
        l.strip_prefix("ref: refs/heads/")
            .and_then(|r| r.strip_suffix("\tHEAD"))
    });
    if requested.is_empty() {
        requested = if let Some(tail) = suffix {
            branches
                .iter()
                .filter(|b| tail == **b || tail.starts_with(&format!("{b}/")))
                .max_by_key(|b| b.len())
                .map(|s| (*s).to_owned())
                .ok_or("Branch link does not match a remote branch")?
        } else {
            default.unwrap_or("main").to_owned()
        };
    }
    if !git2::Reference::is_valid_name(&format!("refs/heads/{requested}")) {
        return Err("Invalid branch name".into());
    }
    if !branches.is_empty() && !branches.contains(&requested.as_str()) {
        return Err("Selected branch does not exist on the remote".into());
    }
    Ok(json!({"url":url,"branch":requested,"branches":branches,"empty":branches.is_empty()}))
}

fn status(app: &Backend, project: &str) -> Result<Value, String> {
    let root = projects::get(app, project)?.root;
    let Some(c) = read_connection(&root)? else {
        let repo = Repository::discover(&root).ok();
        let identity = repo
            .as_ref()
            .and_then(|r| r.signature().ok())
            .filter(|s| s.email() != Some("history@codex-prism.local"));
        let branch = repo
            .as_ref()
            .and_then(|r| r.head().ok())
            .and_then(|h| h.shorthand().map(str::to_owned));
        let remote = repo.as_ref().and_then(|r| {
            let configured = branch.as_ref().and_then(|b| {
                r.config()
                    .ok()?
                    .get_string(&format!("branch.{b}.remote"))
                    .ok()
            });
            let only = r
                .remotes()
                .ok()
                .filter(|names| names.len() == 1)
                .and_then(|names| names.get(0).map(str::to_owned));
            r.find_remote(&configured.or(only)?)
                .ok()
                .and_then(|remote| remote.url().map(str::to_owned))
        });
        return Ok(
            json!({"connected":false,"url":remote,"branch":branch,"name":identity.as_ref().and_then(|s|s.name()),"email":identity.as_ref().and_then(|s|s.email())}),
        );
    };
    let repo = repository(&root)?;
    let warning = if journal_path(&root).exists() {
        Some("Interrupted integration needs recovery".into())
    } else {
        workflow::status(&root.to_string_lossy())
            .ok()
            .and_then(|s| s["warning"].as_str().map(str::to_owned))
    };
    let dirty = tracked_clean(&repo).err();
    let busy = app
        .inner
        .collaboration
        .jobs
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(project);
    let (ahead, behind) = c
        .last_remote
        .as_ref()
        .and_then(|r| Oid::from_str(r).ok())
        .and_then(|r| repo.graph_ahead_behind(head(&repo).ok()?, r).ok())
        .unwrap_or((0, 0));
    let identity = repo.signature().ok();
    Ok(
        json!({"connected":true,"remote":c.remote,"url":c.url,"branch":c.branch,"checkedAt":c.checked_at,"message":c.message,"warning":warning,"localEdits":dirty,"busy":busy,"ahead":ahead,"behind":behind,"name":identity.as_ref().and_then(|s|s.name()),"email":identity.as_ref().and_then(|s|s.email())}),
    )
}

fn staged_matches(repo: &Repository, tree: &git2::Tree<'_>) -> Result<bool, String> {
    Ok(repo
        .diff_tree_to_index(Some(tree), None, None)
        .map_err(|e| e.to_string())?
        .deltas()
        .len()
        == 0)
}
/// Called while the project and history locks are held. Git checkout preserves
/// untracked collisions; a durable journal covers the checkout/ref publication gap.
pub(crate) fn integrate(root: &Path, before: Oid, after: Oid) -> Result<(), String> {
    let repo = repository(root)?;
    if head(&repo)? != before {
        return Err("Document revision changed; retry integration".into());
    }
    tracked_clean(&repo)?;
    validate_tree(&repo, after)?;
    let op = Integration {
        branch: branch(&repo)?,
        before: before.to_string(),
        after: after.to_string(),
    };
    std::fs::create_dir_all(root.join(".codexprism")).map_err(|e| e.to_string())?;
    projects::save_json(&journal_path(root), &op)?;
    let object = repo.find_object(after, None).map_err(|e| e.to_string())?;
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.safe();
    repo.checkout_tree(&object, Some(&mut checkout))
        .map_err(|e| format!("Integration paused; original revision retained: {e}"))?;
    repo.reference_matching(
        &op.branch,
        after,
        true,
        before,
        "Prism collaboration integration",
    )
    .map_err(|e| e.to_string())?;
    std::fs::remove_file(journal_path(root)).map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn recover(root: &Path) -> Result<(), String> {
    let path = journal_path(root);
    if !path.exists() {
        return Ok(());
    }
    let op: Integration = serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let repo = repository(root)?;
    let old = Oid::from_str(&op.before).map_err(|e| e.to_string())?;
    let new = Oid::from_str(&op.after).map_err(|e| e.to_string())?;
    if branch(&repo)? != op.branch {
        return Err("Return to the original branch to recover integration".into());
    }
    let current = head(&repo)?;
    if current == new {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if current != old {
        return Err("History changed during interrupted integration; preserved recovery requires inspection".into());
    }
    let next = repo
        .find_commit(new)
        .and_then(|c| c.tree())
        .map_err(|e| e.to_string())?;
    let mut options = git2::DiffOptions::new();
    options.include_untracked(false);
    if staged_matches(&repo, &next)?
        && repo
            .diff_index_to_workdir(None, Some(&mut options))
            .map_err(|e| e.to_string())?
            .deltas()
            .len()
            == 0
    {
        repo.reference_matching(&op.branch, new, true, old, "Recover Prism integration")
            .map_err(|e| e.to_string())?;
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if tracked_clean(&repo).is_ok() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("Integration was interrupted and local files changed. Recovery is preserved; resolve local changes before retrying".into())
}

#[cfg(test)]
async fn sync(
    app: &Backend,
    project: &str,
    defer_apply: bool,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Value, String> {
    sync_mode(app, project, defer_apply, false, false, cancel).await
}
async fn sync_mode(
    app: &Backend,
    project: &str,
    defer_apply: bool,
    prepare_only: bool,
    fetched: bool,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Value, String> {
    let root = projects::get(app, project)?.root;
    let mut c = read_connection(&root)?.ok_or("Project is not connected")?;
    let mut changed = false;
    let mut source_changed = false;
    let result = async {
        for attempt in 0..3 {
            let remote_ref = format!("refs/remotes/{}/{}", c.remote, c.branch);
            let refspec = format!("refs/heads/{}:{remote_ref}", c.branch);
            if !fetched || attempt > 0 {
                git(
                    app,
                    &root,
                    &["fetch", "--no-tags", &c.url, &refspec],
                    Some(&c.url),
                    cancel,
                )
                .await?;
            }
            let outcome = {
                let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
                let lock = workflow::mutex(&root.to_string_lossy());
                let _history = lock.lock().map_err(|e| e.to_string())?;
                recover(&root)?;
                let repo = repository(&root)?;
                if branch(&repo)? != format!("refs/heads/{}", c.branch) {
                    return Err("Switch back to the connected branch to synchronize".into());
                }
                let incoming = repo.refname_to_id(&remote_ref).map_err(|e| e.to_string())?;
                validate_tree(&repo, incoming)?;
                if let Some(previous) = c.last_remote.as_ref().and_then(|s| Oid::from_str(s).ok()) {
                    if incoming != previous
                        && !repo
                            .graph_descendant_of(incoming, previous)
                            .unwrap_or(false)
                    {
                        return Err("Remote history was rewritten; synchronization paused".into());
                    }
                }
                c.last_remote = Some(incoming.to_string());
                c.checked_at = Some(chrono::Utc::now().timestamp());
                c.message = None;
                write_connection(&root, &c)?;
                let local = head(&repo)?;
                if local == incoming
                    || repo
                        .graph_descendant_of(local, incoming)
                        .map_err(|e| e.to_string())?
                {
                    (local, false, false)
                } else {
                    if prepare_only {
                        return Ok(json!({"needsApply":true}));
                    }
                    if defer_apply || crate::proposals::locked(app, project)? {
                        return Err(
                            "Updates available; finish saving or reviewing pending changes".into(),
                        );
                    }
                    if workflow::status(&root.to_string_lossy())?["pending"]
                        .as_u64()
                        .unwrap_or(0)
                        > 0
                    {
                        return Err("Retry pending local history before integrating updates".into());
                    }
                    tracked_clean(&repo)?;
                    let target = if repo
                        .graph_descendant_of(incoming, local)
                        .map_err(|e| e.to_string())?
                    {
                        incoming
                    } else {
                        let ours = repo.find_commit(local).map_err(|e| e.to_string())?;
                        let theirs = repo.find_commit(incoming).map_err(|e| e.to_string())?;
                        let mut index = repo
                            .merge_commits(&ours, &theirs, None)
                            .map_err(|e| e.to_string())?;
                        if index.has_conflicts() {
                            let resolution = crate::proposals::incoming(
                                app, project, &repo, local, incoming, &index,
                            )?;
                            return Ok(
                                json!({"resolution":resolution,"status":status(app, project)?}),
                            );
                        }
                        let tree_id = index.write_tree_to(&repo).map_err(|e| e.to_string())?;
                        let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
                        let sig = repo.signature().map_err(|e| e.to_string())?;
                        repo.commit(
                            None,
                            &sig,
                            &sig,
                            "Merge collaborator changes",
                            &tree,
                            &[&ours, &theirs],
                        )
                        .map_err(|e| e.to_string())?
                    };
                    let before = repo
                        .find_commit(local)
                        .and_then(|c| c.tree())
                        .map_err(|e| e.to_string())?;
                    let after = repo
                        .find_commit(target)
                        .and_then(|c| c.tree())
                        .map_err(|e| e.to_string())?;
                    let diff = repo
                        .diff_tree_to_tree(Some(&before), Some(&after), None)
                        .map_err(|e| e.to_string())?;
                    let source_changed = diff.deltas().any(|d| {
                        [d.old_file().path(), d.new_file().path()]
                            .into_iter()
                            .flatten()
                            .any(|p| {
                                !crate::file_policy::Policy::IsolatedSnapshot
                                    .excludes_path(&p.to_string_lossy())
                            })
                    });
                    integrate(&root, local, target)?;
                    (target, true, source_changed)
                }
            };
            if outcome.1 {
                changed = true;
                source_changed |= outcome.2;
                app.inner.events.emit(crate::BackendEvent::HistoryChanged {
                    project_id: project.into(),
                    warning: None,
                });
            }
            let tip = outcome.0.to_string();
            let destination = format!("{tip}:refs/heads/{}", c.branch);
            match git(
                app,
                &root,
                &["push", "--porcelain", &c.url, &destination],
                Some(&c.url),
                cancel,
            )
            .await
            {
                Ok(_) => {
                    c.last_remote = Some(tip);
                    c.message = None;
                    write_connection(&root, &c)?;
                    let mut result = status(app, project)?;
                    result["changed"] = json!(changed);
                    result["sourceChanged"] = json!(source_changed);
                    return Ok(result);
                }
                Err(e)
                    if attempt < 2
                        && (e.contains("fetch first") || e.contains("non-fast-forward")) =>
                {
                    continue
                }
                Err(e) => return Err(e),
            }
        }
        Err("Remote changed repeatedly; retry synchronization".into())
    }
    .await;
    // An upload failure must not hide a completed local integration from the
    // editor. Preserve the error in status while returning the refresh signal.
    if changed {
        if let Err(error) = &result {
            c.message = Some(error.clone());
            write_connection(&root, &c)?;
            let mut result = status(app, project)?;
            result["changed"] = json!(true);
            result["sourceChanged"] = json!(source_changed);
            return Ok(result);
        }
    }
    result
}

async fn connect(
    app: &Backend,
    project: Option<&str>,
    args: &Value,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Value, String> {
    let resolved = resolve(app, args, cancel).await?;
    let url = resolved["url"].as_str().ok_or("Missing resolved URL")?;
    let selected = resolved["branch"].as_str().ok_or("Missing branch")?;
    let p = if let Some(id) = project {
        projects::get(app, id)?
    } else {
        if resolved["empty"] == true {
            return Err("This remote is empty; connect an existing local project instead".into());
        }
        let destination = PathBuf::from(
            args["destination"]
                .as_str()
                .ok_or("Choose a local folder")?,
        );
        if !destination.is_absolute() || destination.exists() {
            return Err("Choose a new absolute destination folder".into());
        }
        let parent = destination.parent().ok_or("Invalid destination")?;
        git(
            app,
            parent,
            &[
                "clone",
                "--no-tags",
                "--branch",
                selected,
                &url,
                destination.to_str().ok_or("Invalid path")?,
            ],
            Some(url),
            cancel,
        )
        .await?;
        projects::project_register(app.clone(), destination.to_string_lossy().into())?
    };
    let fetched = if resolved["empty"] != true {
        let temporary_ref = format!("refs/prism/connect/{}", uuid::Uuid::new_v4());
        git(
            app,
            &p.root,
            &[
                "fetch",
                "--no-tags",
                url,
                &format!("refs/heads/{selected}:{temporary_ref}"),
            ],
            Some(url),
            cancel,
        )
        .await?;
        let repo = repository(&p.root)?;
        let oid = repo
            .refname_to_id(&temporary_ref)
            .map_err(|e| e.to_string())?;
        repo.find_reference(&temporary_ref)
            .and_then(|mut r| r.delete())
            .map_err(|e| e.to_string())?;
        if repo.merge_base(head(&repo)?, oid).is_err() {
            return Err("The local and remote projects have unrelated histories. Open the shared project in a new folder instead.".into());
        }
        validate_tree(&repo, oid)?;
        Some(oid)
    } else {
        None
    };
    {
        let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
        crate::codex::assert_unlocked(app, &p.id)?;
        let lock = workflow::mutex(&p.root.to_string_lossy());
        let _history = lock.lock().map_err(|e| e.to_string())?;
        let repo = repository(&p.root)?;
        validate_tree(&repo, head(&repo)?)?;
        if branch(&repo)? != format!("refs/heads/{selected}") {
            tracked_clean(&repo)?;
            let local = repo.find_commit(head(&repo)?).map_err(|e| e.to_string())?;
            match repo.find_branch(selected,git2::BranchType::Local) {
                Ok(b) if b.get().target() != Some(local.id()) => return Err("A different local version already uses this branch name. Open the shared project in a new folder instead.".into()),
                Ok(_) => {},
                Err(_) => { repo.branch(selected,&local,false).map_err(|e| e.to_string())?; },
            }
            repo.set_head(&format!("refs/heads/{selected}"))
                .map_err(|e| e.to_string())?;
        }
        set_identity(&repo, args)?;
        let existing = repo
            .remotes()
            .map_err(|e| e.to_string())?
            .iter()
            .flatten()
            .find(|n| {
                repo.find_remote(n)
                    .ok()
                    .and_then(|r| r.url().map(str::to_owned))
                    .as_deref()
                    == Some(url)
            })
            .map(str::to_owned);
        let remote = if let Some(name) = existing {
            name
        } else {
            let name = if repo.find_remote("origin").is_err() {
                "origin"
            } else {
                "prism"
            };
            if repo.find_remote(name).is_ok() {
                return Err("Remote prism already exists with a different URL".into());
            }
            repo.remote(name, url).map_err(|e| e.to_string())?;
            name.into()
        };
        write_connection(
            &p.root,
            &Connection {
                remote,
                branch: selected.into(),
                url: url.into(),
                last_remote: fetched.map(|o| o.to_string()),
                ..Default::default()
            },
        )?;
    }
    if resolved["empty"] == true {
        let c = read_connection(&p.root)?.ok_or("Missing connection")?;
        let dest = format!("{}:refs/heads/{selected}", head(&repository(&p.root)?)?);
        git(app, &p.root, &["push", &c.url, &dest], Some(url), cancel).await?;
    }
    // Applying incoming files goes through the editor-aware two-phase sync.
    let result = status(app, &p.id)?;
    Ok(json!({"project":p,"status":result}))
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("codex-prism")
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}
async fn credential(app: &Backend, server: &str) -> Result<Option<Credential>, String> {
    let _refresh = app.inner.collaboration.refresh_lock.lock().await;
    let store = app
        .inner
        .credential_store
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let cached = app
        .inner
        .collaboration
        .tokens
        .lock()
        .map_err(|e| e.to_string())?
        .get(server)
        .cloned();
    let mut credential = if let Some(cached) = cached {
        cached
    } else if let Some(store) = store.clone() {
        let server = server.to_owned();
        let stored = tokio::task::spawn_blocking(move || store.get(&server))
            .await
            .map_err(|e| e.to_string())?
            .ok()
            .flatten();
        let Some(stored) = stored else {
            return Ok(None);
        };
        let Ok(value) = serde_json::from_str::<Credential>(&stored) else {
            return Ok(None);
        };
        value
    } else {
        return Ok(None);
    };
    if let Some(refresh) = credential
        .refresh
        .as_ref()
        .filter(|r| r.expires_at <= chrono::Utc::now().timestamp() + 60)
    {
        if origin(&refresh.server).as_deref() != Some(server) {
            return Err("Stored sign-in belongs to another server; reconnect".into());
        }
        let response = http()?
            .post(format!("{}/login/oauth/access_token", refresh.server))
            .form(&[
                ("client_id", refresh.client.as_str()),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.token.as_str()),
            ])
            .send()
            .await
            .map_err(|_| "Cannot renew sign-in; check your connection or reconnect".to_owned())?
            .error_for_status()
            .map_err(|_| "Sign-in expired or was revoked; reconnect".to_owned())?;
        let value: Value = serde_json::from_str(&response.text().await.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        credential.token = value["access_token"]
            .as_str()
            .ok_or("Sign-in expired; reconnect")?
            .into();
        if let Some(refresh) = &mut credential.refresh {
            if let Some(token) = value["refresh_token"].as_str() {
                refresh.token = token.into();
            }
            refresh.expires_at =
                chrono::Utc::now().timestamp() + value["expires_in"].as_i64().unwrap_or(3600);
        }
        if credential.remembered {
            if let Some(store) = store {
                let server = server.to_owned();
                let secret = serde_json::to_string(&credential).map_err(|e| e.to_string())?;
                // A locked credential store must not interrupt the current session.
                let _ = tokio::task::spawn_blocking(move || store.set(&server, &secret)).await;
            }
        }
    }
    app.inner
        .collaboration
        .tokens
        .lock()
        .map_err(|e| e.to_string())?
        .insert(server.into(), credential.clone());
    Ok(Some(credential))
}

async fn profile(app: &Backend, args: &Value) -> Result<Value, String> {
    let base = args["server"]
        .as_str()
        .unwrap_or("https://github.com")
        .trim_end_matches('/');
    validate_url(base)?;
    let token = args["token"].as_str().ok_or("Enter an access token")?;
    let api = if base == "https://github.com" {
        "https://api.github.com".to_owned()
    } else {
        format!("{base}/api/v1")
    };
    let client = http()?;
    let user_text = client
        .get(format!("{api}/user"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let user: Value = serde_json::from_str(&user_text).map_err(|e| e.to_string())?;
    let emails: Value = match client
        .get(format!("{api}/user/emails"))
        .bearer_auth(token)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            serde_json::from_str(&r.text().await.unwrap_or_default()).unwrap_or(Value::Null)
        }
        _ => Value::Null,
    };
    let _refresh = app.inner.collaboration.refresh_lock.lock().await;
    if *app.inner.cancel.borrow() {
        return Err("Application is stopping".into());
    }
    let server = origin(base).ok_or("Invalid server")?;
    let credential = Credential {
        token: token.into(),
        username: user["login"].as_str().unwrap_or("oauth2").into(),
        refresh: serde_json::from_value(args["refresh"].clone()).ok(),
        remembered: args["remember"] != false,
    };
    app.inner
        .collaboration
        .tokens
        .lock()
        .map_err(|e| e.to_string())?
        .insert(server.clone(), credential.clone());
    let store = app
        .inner
        .credential_store
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let warning = if args["remember"] != false {
        if let Some(store) = store {
            let secret = serde_json::to_string(&credential).map_err(|e| e.to_string())?;
            tokio::task::spawn_blocking(move || store.set(&server, &secret))
                .await
                .map_err(|e| e.to_string())?
                .err()
                .map(|_| {
                    "Native credential storage is unavailable; signed in for this session only"
                })
        } else {
            Some("Signed in for this session only")
        }
    } else {
        if let Some(store) = store {
            let removed = tokio::task::spawn_blocking(move || store.remove(&server))
                .await
                .map_err(|e| e.to_string())?;
            if removed.is_err() {
                return Ok(
                    json!({"name":user["name"],"email":user["email"],"emails":emails,"login":user["login"],"id":user["id"],"credentialWarning":"Signed in for this session; a previously saved credential could not be removed from the system store"}),
                );
            }
        }
        Some("Signed in for this session only")
    };
    Ok(
        json!({"name":user["name"].as_str().filter(|s|!s.is_empty()).or(user["full_name"].as_str()).or(user["login"].as_str()),"email":user["email"],"privateEmail":user["hide_email"] == true || user["keep_email_private"] == true,"emails":emails,"login":user["login"],"id":user["id"],"credentialWarning":warning}),
    )
}

async fn oauth_start(app: &Backend, args: &Value) -> Result<Value, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let server = args["server"]
        .as_str()
        .ok_or("Missing Gitea server")?
        .trim_end_matches('/')
        .to_owned();
    validate_url(&server)?;
    if !server.starts_with("https://") {
        return Err("Use the HTTPS address of your Gitea server".into());
    }
    let client = args["clientId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Enter the public OAuth client ID configured on this Gitea instance")?
        .to_owned();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let redirect = format!(
        "http://127.0.0.1:{}/",
        listener.local_addr().map_err(|e| e.to_string())?.port()
    );
    let state = uuid::Uuid::new_v4().to_string();
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let mut url = reqwest::Url::parse(&format!("{server}/login/oauth/authorize"))
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", client.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("scope", "read:user write:repository"),
    ]);
    let mut pending = app
        .inner
        .collaboration
        .oauth
        .lock()
        .map_err(|e| e.to_string())?;
    pending.clear();
    pending.insert(
        state.clone(),
        OAuth {
            listener,
            server,
            client,
            verifier,
            redirect,
        },
    );
    Ok(json!({"state":state,"authorizationUrl":url.as_str()}))
}
async fn oauth_finish(
    app: &Backend,
    args: &Value,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Value, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let state = args["state"].as_str().ok_or("Missing OAuth state")?;
    let pending = app
        .inner
        .collaboration
        .oauth
        .lock()
        .map_err(|e| e.to_string())?
        .remove(state)
        .ok_or("Sign-in expired; start again")?;
    let mut shutdown = app.inner.cancel.subscribe();
    if *cancel.borrow() || *shutdown.borrow() {
        return Err("Sign-in cancelled".into());
    }
    let code = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(180), async {
            loop {
                let (mut socket,_) = pending.listener.accept().await.map_err(|e| e.to_string())?;
                let mut buffer = [0u8;8192];
                let n = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buffer)).await.map_err(|_| "Callback timed out".to_owned())?.map_err(|e| e.to_string())?;
                let text = String::from_utf8_lossy(&buffer[..n]);
                let target = text.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split_whitespace().next()).unwrap_or("");
                let callback = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|e| e.to_string())?;
                let query: HashMap<_,_> = callback.query_pairs().into_owned().collect();
                if query.get("state").map(String::as_str) != Some(state) {
                    let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
                    continue;
                }
                let body = "Return to codex-prism to finish signing in.";
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len());
                let _ = socket.write_all(response.as_bytes()).await;
                return query.get("code").cloned().ok_or_else(|| "Sign-in was declined".to_owned());
            }
        }) => result.map_err(|_| "Sign-in expired".to_owned())??,
        _ = cancel.changed() => return Err("Sign-in cancelled".into()),
        _ = shutdown.changed() => return Err("Application is stopping".into()),
    };
    let response = http()?
        .post(format!("{}/login/oauth/access_token", pending.server))
        .form(&[
            ("client_id", pending.client.as_str()),
            ("code", code.as_str()),
            ("code_verifier", pending.verifier.as_str()),
            ("redirect_uri", pending.redirect.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&response.text().await.map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let token = value["access_token"]
        .as_str()
        .ok_or("Gitea did not issue an access token")?;
    profile(
        app,
        &json!({"server":pending.server,"token":token,"remember":args["remember"],"refresh":value["refresh_token"].as_str().map(|token| RefreshCredential {
            server:pending.server.clone(), client:pending.client.clone(), token:token.into(), expires_at:chrono::Utc::now().timestamp() + value["expires_in"].as_i64().unwrap_or(3600)
        })}),
    )
    .await
}

pub(crate) fn shutdown(app: &Backend) {
    if let Ok(mut pending) = app.inner.collaboration.oauth.lock() {
        pending.clear();
    }
    if let Ok(mut tokens) = app.inner.collaboration.tokens.lock() {
        tokens.clear();
    }
}

pub(crate) async fn service(
    app: Backend,
    project: Option<String>,
    operation: &str,
    args: Value,
) -> Result<Value, String> {
    let key = project.as_deref().unwrap_or("setup");
    if operation == "cancel" {
        if let Some(tx) = app
            .inner
            .collaboration
            .jobs
            .lock()
            .map_err(|e| e.to_string())?
            .get(key)
        {
            let _ = tx.send(true);
        }
        if project.is_none() {
            app.inner
                .collaboration
                .oauth
                .lock()
                .map_err(|e| e.to_string())?
                .clear();
        }
        return Ok(Value::Null);
    }
    if operation == "status" {
        return status(&app, project.as_deref().ok_or("Missing project")?);
    }
    if operation == "profile" {
        return profile(&app, &args).await;
    }
    if operation == "oauth_start" {
        return oauth_start(&app, &args).await;
    }
    if operation == "reviews" || (operation == "report" && args["reviewId"].is_string()) {
        let root = projects::get(&app, project.as_deref().ok_or("Missing project")?)?.root;
        if operation == "report" {
            let id = args["reviewId"].as_str().ok_or("Missing review")?;
            uuid::Uuid::parse_str(id).map_err(|_| "Invalid review ID")?;
            let path = projects::resolve(&root, &format!(".prism-collab/reviews/{id}/report.md"))?;
            return Ok(json!({"report":std::fs::read_to_string(path).map_err(|e|e.to_string())?}));
        }
        let path = projects::resolve(&root, ".prism-collab/reviews")?;
        let mut reviews = Vec::new();
        if path.is_dir() {
            for entry in std::fs::read_dir(path)
                .map_err(|e| e.to_string())?
                .take(200)
            {
                let entry = entry.map_err(|e| e.to_string())?;
                let id = entry.file_name().to_string_lossy().to_string();
                if uuid::Uuid::parse_str(&id).is_err() {
                    continue;
                }
                let path =
                    projects::resolve(&root, &format!(".prism-collab/reviews/{id}/review.json"))?;
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(metadata) = serde_json::from_slice::<Value>(&bytes) {
                        reviews.push(json!({"id":id,"scope":metadata["scope"],"reviewedCommit":metadata["reviewedCommit"],"schemaVersion":metadata["schemaVersion"]}));
                    }
                }
            }
        }
        return Ok(json!(reviews));
    }
    if operation == "report" {
        return crate::proposals::report(
            &app,
            project.as_deref().ok_or("Missing project")?,
            args["proposalId"].as_str().ok_or("Missing proposal")?,
        );
    }
    if operation == "review_start" {
        return crate::proposals::prepare_reviewer(
            &app,
            project.as_deref().ok_or("Missing project")?,
            args["chatId"].as_str().ok_or("Missing chat")?,
            args["scope"]
                .as_str()
                .unwrap_or("General scientific review"),
        );
    }
    if operation == "attach" {
        crate::proposals::attach(
            &app,
            project.as_deref().ok_or("Missing project")?,
            args["proposalId"].as_str().ok_or("Missing proposal")?,
            args["chatId"].as_str().ok_or("Missing chat")?,
        )?;
        return Ok(Value::Null);
    }
    if operation == "device_start" || operation == "device_poll" {
        let id = option_env!("PRISM_GITHUB_CLIENT_ID")
            .filter(|s| !s.is_empty())
            .ok_or(
                "GitHub browser sign-in is not configured in this build. Use an access token.",
            )?;
        let client = http()?;
        let response = if operation == "device_start" {
            client
                .post("https://github.com/login/device/code")
                .header("Accept", "application/json")
                .form(&[("client_id", id), ("scope", "repo read:user user:email")])
                .send()
                .await
        } else {
            client
                .post("https://github.com/login/oauth/access_token")
                .header("Accept", "application/json")
                .form(&[
                    ("client_id", id),
                    (
                        "device_code",
                        args["deviceCode"].as_str().ok_or("Missing device code")?,
                    ),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .send()
                .await
        }
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_str(&response.text().await.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if operation == "device_start" && value["device_code"].as_str().is_none() {
            return Err(value["error_description"]
                .as_str()
                .unwrap_or("GitHub device sign-in is unavailable; use an access token")
                .into());
        }
        if let Some(token) = value["access_token"].as_str() {
            return Ok(
                json!({"profile":profile(&app,&json!({"server":"https://github.com","token":token,"remember":args["remember"]})).await?}),
            );
        }
        return Ok(value);
    }
    let (_job, mut cancel) = job(&app, key)?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    if let Some(project) = &project {
        app.inner
            .events
            .emit(crate::BackendEvent::CollaborationChanged {
                project_id: project.clone(),
                operation_id: operation_id.clone(),
                state: "running".into(),
            });
    }
    let result = match operation {
        "oauth_finish" => oauth_finish(&app, &args, &mut cancel).await,
        "resolve" => resolve(&app, &args, &mut cancel).await,
        "connect" => connect(&app, project.as_deref(), &args, &mut cancel).await,
        "sync" => {
            sync_mode(
                &app,
                project.as_deref().ok_or("Missing project")?,
                args["deferApply"] == true,
                args["prepareOnly"] == true,
                false,
                &mut cancel,
            )
            .await
        }
        "sync_apply" => {
            sync_mode(
                &app,
                project.as_deref().ok_or("Missing project")?,
                args["deferApply"] == true,
                false,
                true,
                &mut cancel,
            )
            .await
        }
        "disconnect" => {
            let root = projects::get(&app, project.as_deref().ok_or("Missing project")?)?.root;
            if config_path(&root).exists() {
                std::fs::remove_file(config_path(&root)).map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        _ => Err("Unknown collaboration operation".into()),
    };
    if let (Some(project), Err(error)) = (project.as_deref(), &result) {
        if let Ok(p) = projects::get(&app, project) {
            if let Ok(Some(mut c)) = read_connection(&p.root) {
                c.message = Some(error.clone());
                let _ = write_connection(&p.root, &c);
            }
        }
    }
    drop(_job);
    if let Some(project) = &project {
        app.inner
            .events
            .emit(crate::BackendEvent::CollaborationChanged {
                project_id: project.clone(),
                operation_id,
                state: if result.is_ok() { "complete" } else { "error" }.into(),
            });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn command(root: &Path, args: &[&str]) -> String {
        let result = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8_lossy(&result.stdout).trim().into()
    }
    fn commit(root: &Path, file: &str, contents: &str) {
        std::fs::write(root.join(file), contents).unwrap();
        command(root, &["add", file]);
        command(root, &["commit", "-m", "Test checkpoint"]);
    }
    fn setup() -> (tempfile::TempDir, Backend, projects::Project, PathBuf) {
        let (dir, app) = crate::test_backend();
        let remote = dir.path().join("remote.git");
        command(
            dir.path(),
            &[
                "init",
                "--bare",
                "--initial-branch=main",
                remote.to_str().unwrap(),
            ],
        );
        let a = dir.path().join("author");
        let b = dir.path().join("collaborator");
        command(
            dir.path(),
            &["clone", remote.to_str().unwrap(), a.to_str().unwrap()],
        );
        command(&a, &["config", "user.name", "Author"]);
        command(&a, &["config", "user.email", "author@example.test"]);
        commit(&a, ".gitignore", ".codexprism/\n");
        commit(&a, "main.tex", "First paragraph.\n\nSecond paragraph.\n");
        command(&a, &["push", "origin", "main"]);
        command(
            dir.path(),
            &["clone", remote.to_str().unwrap(), b.to_str().unwrap()],
        );
        command(&b, &["config", "user.name", "Collaborator"]);
        command(&b, &["config", "user.email", "other@example.test"]);
        let project = projects::project_register(app.clone(), a.to_string_lossy().into()).unwrap();
        write_connection(
            &a,
            &Connection {
                remote: "origin".into(),
                branch: "main".into(),
                url: remote.to_string_lossy().into(),
                last_remote: Some(command(&a, &["rev-parse", "HEAD"])),
                ..Default::default()
            },
        )
        .unwrap();
        (dir, app, project, b)
    }
    #[tokio::test]
    async fn two_clones_integrate_then_push_without_rewriting_history() {
        let (_dir, app, p, other) = setup();
        commit(&p.root, "local.tex", "Local work\n");
        commit(&other, "remote.tex", "Remote work\n");
        command(&other, &["push", "origin", "main"]);
        let (_tx, mut cancel) = tokio::sync::watch::channel(false);
        let result = sync(&app, &p.id, false, &mut cancel).await.unwrap();
        assert_eq!(result["changed"], true);
        assert!(p.root.join("local.tex").exists() && p.root.join("remote.tex").exists());
        assert_eq!(
            repository(&p.root)
                .unwrap()
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent_count(),
            2
        );
        command(&other, &["pull", "--ff-only"]);
        assert!(other.join("local.tex").exists());
        assert!(!journal_path(&p.root).exists());
    }
    #[tokio::test]
    async fn uncheckpointed_and_staged_edits_survive_incoming_changes() {
        let (_dir, app, p, other) = setup();
        std::fs::write(p.root.join("main.tex"), "Autosaved, not checkpointed\n").unwrap();
        commit(&other, "remote.tex", "Incoming\n");
        command(&other, &["push", "origin", "main"]);
        let (_tx, mut cancel) = tokio::sync::watch::channel(false);
        assert!(sync(&app, &p.id, false, &mut cancel)
            .await
            .unwrap_err()
            .contains("Save"));
        assert_eq!(
            std::fs::read_to_string(p.root.join("main.tex")).unwrap(),
            "Autosaved, not checkpointed\n"
        );
        command(&p.root, &["add", "main.tex"]);
        assert!(sync(&app, &p.id, false, &mut cancel).await.is_err());
        assert!(!command(&p.root, &["diff", "--cached"]).is_empty());
    }
    #[tokio::test]
    async fn conflict_becomes_proposal_and_keeps_both_parents() {
        let (_dir, app, p, other) = setup();
        std::fs::write(p.root.join("notes.md"), "Untracked local context\n").unwrap();
        commit(&p.root, "main.tex", "Local argument\n");
        commit(&other, "main.tex", "Incoming argument\n");
        command(&other, &["push", "origin", "main"]);
        let (_tx, mut cancel) = tokio::sync::watch::channel(false);
        let result = sync(&app, &p.id, false, &mut cancel).await.unwrap();
        let id = result["resolution"]["proposalId"].as_str().unwrap();
        assert_eq!(
            std::fs::read_to_string(p.root.join("main.tex")).unwrap(),
            "Local argument\n"
        );
        crate::proposals::attach(&app, &p.id, id, "resolution-chat").unwrap();
        let proposal = crate::proposals::begin_for_chat(
            &app,
            &p.id,
            None,
            None,
            Some("resolution-chat".into()),
        )
        .unwrap();
        std::fs::write(
            crate::proposals::root(&app, &proposal)
                .unwrap()
                .join("main.tex"),
            "Combined argument\n",
        )
        .unwrap();
        crate::proposals::finish(&app, id, false).unwrap();
        let list = crate::proposals::service(&app, &p.id, "proposal_list", json!({})).unwrap();
        let result = crate::proposals::service(
            &app,
            &p.id,
            "proposal_apply",
            json!({"proposalId":id,"generation":list[0]["generation"]}),
        )
        .unwrap();
        assert!(result["conflicts"].as_array().unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(p.root.join("main.tex")).unwrap(),
            "Combined argument\n"
        );
        assert_eq!(
            repository(&p.root)
                .unwrap()
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent_count(),
            2
        );
        assert_eq!(
            std::fs::read_to_string(p.root.join("notes.md")).unwrap(),
            "Untracked local context\n"
        );
        assert!(command(&p.root, &["ls-files", "notes.md"]).is_empty());
    }
    #[test]
    fn reviewer_preserves_untracked_context_without_publishing_it() {
        let (_dir, app, p, _) = setup();
        std::fs::write(p.root.join("notes.md"), "Local scratch context\n").unwrap();
        let prepared =
            crate::proposals::prepare_reviewer(&app, &p.id, "review", "Clarity").unwrap();
        let id = prepared["proposalId"].as_str().unwrap();
        let proposal =
            crate::proposals::begin_for_chat(&app, &p.id, None, None, Some("review".into()))
                .unwrap();
        let work = crate::proposals::root(&app, &proposal).unwrap();
        assert_eq!(
            std::fs::read_to_string(work.join("notes.md")).unwrap(),
            "Local scratch context\n"
        );
        std::fs::write(work.join("main.tex"), "Improved manuscript\n").unwrap();
        crate::proposals::finish(&app, id, false).unwrap();
        let list = crate::proposals::service(&app, &p.id, "proposal_list", json!({})).unwrap();
        assert!(!list[0]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["path"] == "notes.md"));
        crate::proposals::service(
            &app,
            &p.id,
            "proposal_apply",
            json!({"proposalId":id,"generation":list[0]["generation"]}),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(p.root.join("notes.md")).unwrap(),
            "Local scratch context\n"
        );
        assert!(command(&p.root, &["ls-files", "notes.md"]).is_empty());
    }
    #[test]
    fn reviewer_uses_local_worktree_and_only_keep_changes_main() {
        let (_dir, app, p, _other) = setup();
        let original = command(&p.root, &["rev-parse", "HEAD"]);
        let result =
            crate::proposals::prepare_reviewer(&app, &p.id, "review-chat", "Clarity").unwrap();
        let id = result["proposalId"].as_str().unwrap();
        let proposal =
            crate::proposals::begin_for_chat(&app, &p.id, None, None, Some("review-chat".into()))
                .unwrap();
        let work = crate::proposals::root(&app, &proposal).unwrap();
        assert!(work.join(".git").is_file());
        std::fs::write(work.join("main.tex"), "Improved manuscript\n").unwrap();
        let report = work.join(format!(".prism-collab/reviews/{id}/report.md"));
        std::fs::create_dir_all(report.parent().unwrap()).unwrap();
        std::fs::write(report, "Clarified the argument.").unwrap();
        crate::proposals::finish(&app, id, false).unwrap();
        assert_eq!(command(&p.root, &["rev-parse", "HEAD"]), original);
        assert_eq!(command(&p.root, &["branch", "--show-current"]), "main");
        let list = crate::proposals::service(&app, &p.id, "proposal_list", json!({})).unwrap();
        assert_eq!(list[0]["origin"], "reviewer");
        crate::proposals::service(
            &app,
            &p.id,
            "proposal_apply",
            json!({"proposalId":id,"generation":list[0]["generation"]}),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(p.root.join("main.tex")).unwrap(),
            "Improved manuscript\n"
        );
        assert!(p
            .root
            .join(format!(".prism-collab/reviews/{id}/report.md"))
            .exists());
    }
    #[test]
    fn recover_checkout_before_ref_update_and_preserve_external_edit() {
        let (_dir, _app, p, _other) = setup();
        let old = command(&p.root, &["rev-parse", "HEAD"]);
        commit(&p.root, "main.tex", "Next\n");
        let next = command(&p.root, &["rev-parse", "HEAD"]);
        command(&p.root, &["update-ref", "refs/heads/main", &old, &next]);
        projects::save_json(
            &journal_path(&p.root),
            &Integration {
                branch: "refs/heads/main".into(),
                before: old.clone(),
                after: next.clone(),
            },
        )
        .unwrap();
        std::fs::write(p.root.join("main.tex"), "External edit\n").unwrap();
        assert!(recover(&p.root).is_err());
        assert_eq!(
            std::fs::read_to_string(p.root.join("main.tex")).unwrap(),
            "External edit\n"
        );
        std::fs::write(p.root.join("main.tex"), "Next\n").unwrap();
        recover(&p.root).unwrap();
        assert_eq!(command(&p.root, &["rev-parse", "HEAD"]), next);
    }
    #[test]
    fn report_only_reviews_do_not_lock_editing_and_discard_keeps_main_unchanged() {
        let (_dir, app, p, _) = setup();
        let original = command(&p.root, &["rev-parse", "HEAD"]);
        let prepared =
            crate::proposals::prepare_reviewer(&app, &p.id, "report-chat", "Evidence").unwrap();
        let id = prepared["proposalId"].as_str().unwrap();
        let proposal =
            crate::proposals::begin_for_chat(&app, &p.id, None, None, Some("report-chat".into()))
                .unwrap();
        assert!(crate::proposals::locked(&app, &p.id).unwrap());
        let report = crate::proposals::root(&app, &proposal)
            .unwrap()
            .join(format!(".prism-collab/reviews/{id}/report.md"));
        std::fs::create_dir_all(report.parent().unwrap()).unwrap();
        std::fs::write(
            report,
            "No unsupported claims found in the provided source.",
        )
        .unwrap();
        crate::proposals::finish(&app, id, false).unwrap();
        assert!(!crate::proposals::locked(&app, &p.id).unwrap());
        let list = crate::proposals::service(&app, &p.id, "proposal_list", json!({})).unwrap();
        assert_eq!(list[0]["blocksEditing"], false);
        crate::proposals::service(
            &app,
            &p.id,
            "proposal_discard",
            json!({"proposalId":id,"generation":list[0]["generation"]}),
        )
        .unwrap();
        assert_eq!(command(&p.root, &["rev-parse", "HEAD"]), original);
        assert!(!p.root.join(".prism-collab").exists());
    }
    #[tokio::test]
    async fn fetch_only_never_mutates_main_and_cancel_is_honored() {
        let (_dir, app, p, other) = setup();
        let original = command(&p.root, &["rev-parse", "HEAD"]);
        commit(&other, "remote.tex", "Incoming\n");
        command(&other, &["push", "origin", "main"]);
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        assert_eq!(
            sync_mode(&app, &p.id, false, true, false, &mut rx)
                .await
                .unwrap()["needsApply"],
            true
        );
        assert_eq!(command(&p.root, &["rev-parse", "HEAD"]), original);
        tx.send(true).unwrap();
        assert!(sync(&app, &p.id, false, &mut rx)
            .await
            .unwrap_err()
            .contains("cancelled"));
        assert!(!p.root.join("remote.tex").exists());
    }
    #[tokio::test]
    async fn remote_history_rewrite_does_not_modify_main() {
        let (_dir, app, p, other) = setup();
        let original = command(&p.root, &["rev-parse", "HEAD"]);
        command(&other, &["reset", "--hard", "HEAD~1"]);
        commit(&other, "rewritten.tex", "Different history\n");
        command(&other, &["push", "--force", "origin", "main"]);
        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        assert!(sync(&app, &p.id, false, &mut rx).await.is_err());
        assert_eq!(command(&p.root, &["rev-parse", "HEAD"]), original);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn rejected_upload_still_reports_applied_incoming_changes() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, app, p, other) = setup();
        commit(&p.root, "local.tex", "Local work\n");
        commit(&other, "remote.tex", "Remote work\n");
        command(&other, &["push", "origin", "main"]);
        let hook = dir.path().join("remote.git/hooks/pre-receive");
        std::fs::write(&hook, "#!/bin/sh\necho 'Protected branch' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        let result = sync(&app, &p.id, false, &mut rx).await.unwrap();
        assert_eq!(result["changed"], true);
        assert_eq!(result["sourceChanged"], true);
        assert!(result["message"]
            .as_str()
            .unwrap()
            .contains("Protected branch"));
        assert!(p.root.join("remote.tex").exists());
        std::fs::remove_file(hook).unwrap();
        sync(&app, &p.id, false, &mut rx).await.unwrap();
        command(&other, &["pull", "--ff-only"]);
        assert!(other.join("local.tex").exists());
    }
    #[tokio::test]
    async fn metadata_only_sync_preserves_manuscript_build_inputs() {
        let (_dir, app, p, other) = setup();
        std::fs::create_dir_all(other.join(".prism-collab/reviews/one")).unwrap();
        commit(&other, ".prism-collab/reviews/one/report.md", "Findings\n");
        command(&other, &["push", "origin", "main"]);
        let before = projects::isolated_snapshot(&p.root).unwrap();
        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        let result = sync(&app, &p.id, false, &mut rx).await.unwrap();
        assert_eq!(result["changed"], true);
        assert_eq!(result["sourceChanged"], false);
        assert_eq!(projects::isolated_snapshot(&p.root).unwrap(), before);
        assert!(p.root.join(".prism-collab/reviews/one/report.md").is_file());
    }
    #[test]
    fn interrupted_reviewer_retains_output_and_follows_up_on_the_same_branch() {
        let (_dir, app, p, _) = setup();
        let prepared =
            crate::proposals::prepare_reviewer(&app, &p.id, "review", "Clarity").unwrap();
        let id = prepared["proposalId"].as_str().unwrap();
        let proposal =
            crate::proposals::begin_for_chat(&app, &p.id, None, None, Some("review".into()))
                .unwrap();
        let work = crate::proposals::root(&app, &proposal).unwrap();
        std::fs::write(work.join("main.tex"), "Partial review\n").unwrap();
        crate::proposals::finish(&app, id, true).unwrap();
        let list = crate::proposals::service(&app, &p.id, "proposal_list", json!({})).unwrap();
        assert_eq!(list[0]["state"], "interrupted");
        crate::proposals::begin_for_chat(&app, &p.id, None, None, Some("review".into())).unwrap();
        std::fs::write(work.join("main.tex"), "Completed review\n").unwrap();
        crate::proposals::finish(&app, id, false).unwrap();
        let list = crate::proposals::service(&app, &p.id, "proposal_list", json!({})).unwrap();
        crate::proposals::service(
            &app,
            &p.id,
            "proposal_apply",
            json!({"proposalId":id,"generation":list[0]["generation"]}),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(p.root.join("main.tex")).unwrap(),
            "Completed review\n"
        );
        let metadata: Value = serde_json::from_slice(
            &std::fs::read(
                p.root
                    .join(format!(".prism-collab/reviews/{id}/review.json")),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["scope"], "Clarity");
    }
    #[test]
    fn reviewer_cannot_redirect_checkpoint_to_main_index() {
        let (_dir, app, p, _) = setup();
        let prepared =
            crate::proposals::prepare_reviewer(&app, &p.id, "review", "Clarity").unwrap();
        let id = prepared["proposalId"].as_str().unwrap();
        let proposal =
            crate::proposals::begin_for_chat(&app, &p.id, None, None, Some("review".into()))
                .unwrap();
        let work = crate::proposals::root(&app, &proposal).unwrap();
        let original_git = std::fs::read(work.join(".git")).unwrap();
        let original_index = std::fs::read(p.root.join(".git/index")).unwrap();
        std::fs::write(work.join("main.tex"), "Retain this output\n").unwrap();
        std::fs::write(
            work.join(".git"),
            format!("gitdir: {}\n", p.root.join(".git").display()),
        )
        .unwrap();
        assert!(crate::proposals::finish(&app, id, false).is_err());
        assert_eq!(
            std::fs::read(p.root.join(".git/index")).unwrap(),
            original_index
        );
        let list = crate::proposals::service(&app, &p.id, "proposal_list", json!({})).unwrap();
        assert_eq!(list[0]["state"], "interrupted");
        assert!(crate::proposals::service(
            &app,
            &p.id,
            "proposal_apply",
            json!({"proposalId":id,"generation":list[0]["generation"]})
        )
        .is_err());
        std::fs::write(work.join(".git"), original_git).unwrap();
        crate::proposals::begin_for_chat(&app, &p.id, None, None, Some("review".into())).unwrap();
        crate::proposals::finish(&app, id, false).unwrap();
    }
    #[tokio::test]
    async fn newer_remote_resolution_requires_repair_and_renewed_review() {
        let (_dir, app, p, other) = setup();
        commit(&p.root, "main.tex", "Local argument\n");
        commit(&other, "main.tex", "Incoming argument\n");
        command(&other, &["push", "origin", "main"]);
        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        let result = sync(&app, &p.id, false, &mut rx).await.unwrap();
        let id = result["resolution"]["proposalId"].as_str().unwrap();
        crate::proposals::attach(&app, &p.id, id, "resolve").unwrap();
        let proposal =
            crate::proposals::begin_for_chat(&app, &p.id, None, None, Some("resolve".into()))
                .unwrap();
        std::fs::write(
            crate::proposals::root(&app, &proposal)
                .unwrap()
                .join("main.tex"),
            "Combined argument\n",
        )
        .unwrap();
        crate::proposals::finish(&app, id, false).unwrap();
        commit(&other, "new.tex", "New incoming section\n");
        command(&other, &["push", "origin", "main"]);
        sync_mode(&app, &p.id, false, true, false, &mut rx)
            .await
            .unwrap();
        let list = crate::proposals::service(&app, &p.id, "proposal_list", json!({})).unwrap();
        let args = json!({"proposalId":id,"generation":list[0]["generation"]});
        assert!(
            crate::proposals::service(&app, &p.id, "proposal_apply", args.clone())
                .unwrap_err()
                .contains("Repair")
        );
        let repaired = crate::proposals::service(&app, &p.id, "proposal_repair", args).unwrap();
        let fresh = repaired["proposalId"].as_str().unwrap();
        let proposal =
            crate::proposals::begin_for_chat(&app, &p.id, None, None, Some("resolve".into()))
                .unwrap();
        assert_eq!(proposal.id, fresh);
        let work = crate::proposals::root(&app, &proposal).unwrap();
        assert_eq!(
            std::fs::read_to_string(work.join(".codexprism/previous-resolution/main.tex")).unwrap(),
            "Combined argument\n"
        );
        assert!(work.join("new.tex").exists());
        std::fs::write(work.join("main.tex"), "Combined argument\n").unwrap();
        crate::proposals::finish(&app, fresh, false).unwrap();
        let list = crate::proposals::service(&app, &p.id, "proposal_list", json!({})).unwrap();
        let entry = list
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == fresh)
            .unwrap();
        crate::proposals::service(
            &app,
            &p.id,
            "proposal_apply",
            json!({"proposalId":fresh,"generation":entry["generation"]}),
        )
        .unwrap();
        assert!(!crate::proposals::locked(&app, &p.id).unwrap());
        assert!(p.root.join("new.tex").exists());
    }
    #[tokio::test]
    async fn binary_and_delete_edit_conflicts_preserve_all_inputs() {
        let (_dir, app, p, other) = setup();
        std::fs::write(p.root.join("figure.png"), b"original\0figure").unwrap();
        command(&p.root, &["add", "figure.png"]);
        command(&p.root, &["commit", "-m", "Add figure"]);
        command(&p.root, &["push", "origin", "main"]);
        command(&other, &["pull", "--ff-only"]);
        command(&p.root, &["rm", "main.tex"]);
        std::fs::write(p.root.join("figure.png"), b"local\0figure").unwrap();
        command(&p.root, &["add", "figure.png"]);
        command(&p.root, &["commit", "-m", "Local figure and deletion"]);
        commit(&other, "main.tex", "Remote text edit\n");
        std::fs::write(other.join("figure.png"), b"remote\0figure").unwrap();
        command(&other, &["add", "figure.png"]);
        command(&other, &["commit", "-m", "Remote figure"]);
        command(&other, &["push", "origin", "main"]);
        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        let result = sync(&app, &p.id, false, &mut rx).await.unwrap();
        let id = result["resolution"]["proposalId"].as_str().unwrap();
        crate::proposals::attach(&app, &p.id, id, "resolve-assets").unwrap();
        let proposal = crate::proposals::begin_for_chat(
            &app,
            &p.id,
            None,
            None,
            Some("resolve-assets".into()),
        )
        .unwrap();
        let work = crate::proposals::root(&app, &proposal).unwrap();
        assert_eq!(
            std::fs::read(work.join(".codexprism/merge-inputs/base/figure.png")).unwrap(),
            b"original\0figure"
        );
        assert_eq!(
            std::fs::read(work.join(".codexprism/merge-inputs/local/figure.png")).unwrap(),
            b"local\0figure"
        );
        assert_eq!(
            std::fs::read(work.join(".codexprism/merge-inputs/incoming/figure.png")).unwrap(),
            b"remote\0figure"
        );
        assert!(!p.root.join("main.tex").exists());
        std::fs::write(work.join("main.tex"), "Accepted remote text\n").unwrap();
        std::fs::write(work.join("figure.png"), b"chosen\0figure").unwrap();
        crate::proposals::finish(&app, id, false).unwrap();
        let list = crate::proposals::service(&app, &p.id, "proposal_list", json!({})).unwrap();
        crate::proposals::service(
            &app,
            &p.id,
            "proposal_apply",
            json!({"proposalId":id,"generation":list[0]["generation"]}),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(p.root.join("figure.png")).unwrap(),
            b"chosen\0figure"
        );
        assert_eq!(
            std::fs::read_to_string(p.root.join("main.tex")).unwrap(),
            "Accepted remote text\n"
        );
    }
    #[test]
    fn branch_links_use_advertised_names_and_default_branch() {
        let refs =
            "ref: refs/heads/draft\tHEAD\nabc\trefs/heads/draft\nabc\trefs/heads/draft/one\n";
        let result = resolve_refs(
            "https://github.com/team/paper",
            String::new(),
            Some("draft/one/section.tex".into()),
            refs,
        )
        .unwrap();
        assert_eq!(result["branch"], "draft/one");
        assert_eq!(
            resolve_refs(
                "https://git.example.test/team/paper",
                String::new(),
                None,
                refs
            )
            .unwrap()["branch"],
            "draft"
        );
        assert!(resolve_refs(
            "https://git.example.test/team/paper",
            String::new(),
            Some("missing".into()),
            refs
        )
        .is_err());
        assert!(resolve_refs(
            "https://git.example.test/team/paper",
            "../bad".into(),
            None,
            refs
        )
        .is_err());
    }
    #[tokio::test]
    async fn oauth_wait_cancels_on_shutdown_without_an_external_request() {
        let (_dir, app) = crate::test_backend();
        let start = oauth_start(
            &app,
            &json!({"server":"https://gitea.example.test","clientId":"fixture"}),
        )
        .await
        .unwrap();
        let (_tx, mut cancel) = tokio::sync::watch::channel(false);
        app.inner.cancel.send_replace(true);
        let result = oauth_finish(&app, &json!({"state":start["state"]}), &mut cancel).await;
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(app.inner.collaboration.oauth.lock().unwrap().is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn askpass_executable_paths_with_spaces_and_shell_characters_are_literal() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join("Ask ' Prism $ helper");
        std::fs::write(&helper,"#!/bin/sh\ncase \"$1\" in *Username*) printf 'fixture-user';; *) printf 'fixture-token';; esac\n").unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = std::process::Command::new("git")
            .args(["-c", "credential.helper=", "credential", "fill"])
            .env("GIT_ASKPASS", askpass_command(&helper))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"protocol=https\nhost=fixture.example.test\n\n")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result = String::from_utf8(output.stdout).unwrap();
        assert!(
            result.contains("username=fixture-user") && result.contains("password=fixture-token")
        );
    }
    #[test]
    fn nested_project_scope_and_untracked_collisions_are_rejected() {
        let (_dir, _app, p, _) = setup();
        let nested = p.root.join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(repository(&nested).is_err());
        let before = command(&p.root, &["rev-parse", "HEAD"]);
        commit(&p.root, "collision.tex", "Remote content\n");
        let next = command(&p.root, &["rev-parse", "HEAD"]);
        command(&p.root, &["reset", "--hard", &before]);
        std::fs::write(p.root.join("collision.tex"), "Local untracked content\n").unwrap();
        assert!(integrate(
            &p.root,
            Oid::from_str(&before).unwrap(),
            Oid::from_str(&next).unwrap()
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(p.root.join("collision.tex")).unwrap(),
            "Local untracked content\n"
        );
        assert_eq!(command(&p.root, &["rev-parse", "HEAD"]), before);
    }
    #[test]
    fn rejects_embedded_credentials_and_decodes_branch_links() {
        assert!(validate_url("https://user:secret@github.com/team/paper").is_err());
        assert!(validate_url("ext::command").is_err());
        assert!(validate_url("git@-option:repo").is_err());
        assert!(validate_url("git@github.com:team/paper.git").is_ok());
        assert!(validate_url("ssh://git@example.test:2222/team/paper.git").is_ok());
        assert_eq!(
            decode_path("draft%2Fsection%20one").unwrap(),
            "draft/section one"
        );
    }
}
