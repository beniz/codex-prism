//! Commands on the writing checkout. Serialize network jobs per project, then
//! revalidate the checkout under the same locks as proposal acceptance.
use super::*;

fn local_ref(name: &str) -> Result<String, String> {
    let reference = format!("refs/heads/{name}");
    if name.starts_with("prism/reviews/")
        || name.starts_with('-')
        || name == "HEAD"
        || !git2::Reference::is_valid_name(&reference)
    {
        return Err("Invalid branch name".into());
    }
    Ok(reference)
}

#[derive(Serialize, Deserialize)]
struct Checkout {
    before: String,
    before_head: String,
    name: String,
    tip: String,
    pr: Option<u64>,
    remote: Option<String>,
    url: Option<String>,
}
fn intent_path(app: &Backend, project: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(project).map_err(|e| e.to_string())?;
    Ok(projects::data_dir(app)?.join(format!("checkout-{project}.json")))
}
pub(crate) fn recover_checkout(app: &Backend, project: &str, root: &Path) -> Result<(), String> {
    let path = intent_path(app, project)?;
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let intent: Checkout =
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let repo = repository(root)?;
    let active = projects::checkout_branch(root.as_ref())?.ok_or("Missing checkout")?;
    let tip = head(&repo)?.to_string();
    if active == local_ref(&intent.name)? && tip == intent.tip {
        let mut cfg = repo.config().map_err(|e| e.to_string())?;
        let name = &intent.name;
        if let (Some(pr), Some(url)) = (intent.pr, intent.url) {
            cfg.set_str(&format!("branch.{name}.prism-url"), &url)
                .map_err(|e| e.to_string())?;
            cfg.set_str(&format!("branch.{name}.prism-pr"), &pr.to_string())
                .map_err(|e| e.to_string())?;
        }
        if let Some(remote) = intent.remote {
            cfg.set_str(&format!("branch.{name}.remote"), &remote)
                .map_err(|e| e.to_string())?;
            cfg.set_str(&format!("branch.{name}.merge"), &active)
                .map_err(|e| e.to_string())?;
        }
    } else if active != intent.before || tip != intent.before_head {
        return Err(format!(
            "Interrupted checkout: restore {} at {} or {} at {} before recovery",
            intent.before, intent.before_head, intent.name, intent.tip
        ));
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
pub(super) fn list(root: &Path) -> Result<Value, String> {
    let repo = repository(root)?;
    let active = projects::checkout_branch(root.as_ref())?.ok_or("Missing checkout")?;
    let mut branches = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| e.to_string())?
        .map(|item| {
            let (b, _) = item.map_err(|e| e.to_string())?;
            Ok(b.name()
                .map_err(|e| e.to_string())?
                .ok_or("Unsupported branch name")?
                .to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    branches.retain(|b| !b.starts_with("prism/reviews/"));
    let number = repo
        .config()
        .ok()
        .and_then(|c| {
            c.get_string(&format!(
                "branch.{}.prism-pr",
                active.trim_start_matches("refs/heads/")
            ))
            .ok()
        })
        .and_then(|n| n.parse::<u64>().ok());
    Ok(
        json!({"number":number,"active":active,"head":head(&repo)?.to_string(),"branches":branches,"connected":read_connection(root)?.is_some(),"canPublish":read_connection(root)?.is_some() && active!="HEAD" && active_connection(root)?.is_none()}),
    )
}

pub(super) async fn change(
    app: &Backend,
    project: &str,
    args: &Value,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Value, String> {
    let root = projects::get(app, project)?.root;
    projects::project_register(app.clone(), root.to_string_lossy().into())?;
    let action = args["action"].as_str().ok_or("Missing branch action")?;
    let name = args["name"].as_str().ok_or("Missing branch name")?;
    let reference = local_ref(name)?;
    let connection = read_connection(&root)?;
    let pr = args["number"].as_u64();
    let remote = match action {
        "pull" | "update" => Some(format!("refs/pull/{}/head", pr.ok_or("Missing PR number")?)),
        "remote" => Some(reference.clone()),
        "create" | "switch" | "merge" | "publish" => None,
        _ => return Err("Unknown branch action".into()),
    };
    if action == "publish" || remote.is_some() {
        validate_url(&connection.as_ref().ok_or("Connect a remote first")?.url)?;
    }
    if action == "publish" {
        let c = connection.ok_or("Connect a remote first")?;
        let old = {
            let repo = repository(&root)?;
            let active = projects::checkout_branch(root.as_ref())?.ok_or("Missing checkout")?;
            let old = head(&repo)?;
            if active != reference
                || args["active"] != active
                || args["head"] != old.to_string()
                || active_connection(&root)?.is_some()
            {
                return Err(
                    "Select an unpublished local branch and refresh before publishing".into(),
                );
            }
            old
        };
        let push = format!("{old}:{reference}");
        // A lease with an empty expected value makes creation fail if the destination exists.
        let lease = format!("--force-with-lease={reference}:");
        git(
            app,
            &root,
            &["push", &lease, &c.url, &push],
            Some(&c.url),
            cancel,
        )
        .await?;
        let mut config = repository(&root)?.config().map_err(|e| e.to_string())?;
        config
            .set_str(&format!("branch.{name}.remote"), &c.remote)
            .map_err(|e| e.to_string())?;
        config
            .set_str(&format!("branch.{name}.merge"), &reference)
            .map_err(|e| e.to_string())?;
        return Ok(json!({"changed":true}));
    }
    let fetched = if let Some(remote) = remote {
        let c = connection.as_ref().ok_or("Connect a remote first")?;
        let fetched = format!("refs/prism/fetched/{}", uuid::Uuid::new_v4());
        git(
            app,
            &root,
            &["fetch", "--no-tags", &c.url, &format!("{remote}:{fetched}")],
            Some(&c.url),
            cancel,
        )
        .await?;
        let repo = repository(&root)?;
        let id = repo.refname_to_id(&fetched).map_err(|e| e.to_string())?;
        if action == "update" {
            let source = format!(
                "refs/prism/pulls/{}/{}",
                projects::revision(c.url.as_bytes()),
                pr.ok_or("Missing PR number")?
            );
            repo.reference(&source, id, true, "Refresh pull request")
                .map_err(|e| e.to_string())?;
        }
        repo.find_reference(&fetched)
            .and_then(|mut r| r.delete())
            .map_err(|e| e.to_string())?;
        if action != "update" && args["sha"].as_str() != Some(&id.to_string()) {
            return Err("Remote revision changed. Refresh the list.".into());
        }
        Some(id)
    } else {
        None
    };
    let guard = app.inner.latex.checkout_guard(&root).await?;
    let app = app.clone();
    let project = project.to_owned();
    let args = args.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        apply_checkout(&app, &project, &root, &args, fetched, connection)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn apply_checkout(
    app: &Backend,
    project: &str,
    root: &Path,
    args: &Value,
    fetched: Option<Oid>,
    connection: Option<Connection>,
) -> Result<Value, String> {
    let action = args["action"].as_str().ok_or("Missing branch action")?;
    let name = args["name"].as_str().ok_or("Missing branch name")?;
    let reference = local_ref(name)?;
    let pr = args["number"].as_u64();
    let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let lock = workflow::mutex(&root.to_string_lossy());
    let _history = lock.lock().map_err(|e| e.to_string())?;
    let repo = repository(&root)?;
    let active = projects::checkout_branch(root.as_ref())?.ok_or("Missing checkout")?;
    let old = head(&repo)?;
    if args["active"] != active || args["head"] != old.to_string() {
        return Err("The checkout changed. Reopen the branch selector.".into());
    }
    if active == "HEAD" {
        if action != "create" {
            return Err("Create a branch at the detached commit before switching".into());
        }
        let mut options = git2::StatusOptions::new();
        options.include_untracked(false);
        if repo.state() != git2::RepositoryState::Clean
            || !repo
                .statuses(Some(&mut options))
                .map_err(|e| e.to_string())?
                .is_empty()
        {
            return Err("Checkpoint tracked edits before switching".into());
        }
    } else {
        tracked_clean(&repo)?;
    }
    if journal_path(&root).exists()
        || workflow::status(&root.to_string_lossy())?["pending"]
            .as_u64()
            .unwrap_or(0)
            > 0
        || crate::codex::review_path(app, project)?.exists()
    {
        return Err("Resolve pending history or review recovery first".into());
    }
    let pending = crate::proposals::all(app, project)?;
    if crate::proposals::all_branches(app, project)?
        .iter()
        .any(|p| matches!(p.state.as_str(), "running" | "repairing" | "applying"))
    {
        return Err("Finish or stop the active turn first".into());
    }
    let existing = repo.refname_to_id(&reference).ok();
    if action == "merge" || action == "update" {
        let reference = if action == "update" {
            let c = connection.as_ref().ok_or("Missing connection")?;
            if active != reference
                || repo
                    .config()
                    .and_then(|cfg| cfg.get_string(&format!("branch.{name}.prism-pr")))
                    .ok()
                    != pr.map(|n| n.to_string())
                || repo
                    .config()
                    .and_then(|cfg| cfg.get_string(&format!("branch.{name}.prism-url")))
                    .ok()
                    .as_ref()
                    != Some(&c.url)
            {
                return Err("This branch belongs to a different pull request".into());
            }
            format!(
                "refs/prism/pulls/{}/{}",
                projects::revision(c.url.as_bytes()),
                pr.ok_or("Missing PR number")?
            )
        } else {
            reference
        };

        if !pending.is_empty() {
            return Err("Resolve proposals on the target branch first".into());
        }
        let incoming = repo.refname_to_id(&reference).map_err(|e| e.to_string())?;
        validate_tree(&repo, incoming)?;
        if incoming == old
            || repo
                .graph_descendant_of(old, incoming)
                .map_err(|e| e.to_string())?
        {
            return Ok(json!({"changed":false}));
        }
        let target = if repo
            .graph_descendant_of(incoming, old)
            .map_err(|e| e.to_string())?
        {
            incoming
        } else {
            let ours = repo.find_commit(old).map_err(|e| e.to_string())?;
            let theirs = repo.find_commit(incoming).map_err(|e| e.to_string())?;
            let mut index = repo
                .merge_commits(&ours, &theirs, None)
                .map_err(|e| e.to_string())?;
            if index.has_conflicts() {
                return Ok(
                    json!({"resolution":crate::proposals::incoming_from(app,project,&repo,old,incoming,&index,Some(reference))?}),
                );
            }
            let tree = repo
                .find_tree(index.write_tree_to(&repo).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let sig = repo.signature().map_err(|e| e.to_string())?;
            repo.commit(
                None,
                &sig,
                &sig,
                &format!(
                    "Merge {name} into {}",
                    active.trim_start_matches("refs/heads/")
                ),
                &tree,
                &[&ours, &theirs],
            )
            .map_err(|e| e.to_string())?
        };
        if branch(&repo)? != active || repo.refname_to_id(&reference).ok() != Some(incoming) {
            return Err("A branch moved during the merge. Review the new tips.".into());
        }
        integrate(&root, old, target)?;
        return Ok(json!({"changed":true}));
    }
    let config = repo.config().map_err(|e| e.to_string())?;
    let association = format!("branch.{name}.prism-pr");
    if action == "pull"
        && existing.is_some()
        && (config.get_string(&association).ok() != pr.map(|n| n.to_string())
            || config
                .get_string(&format!("branch.{name}.prism-url"))
                .ok()
                .as_ref()
                != connection.as_ref().map(|c| &c.url))
    {
        return Err("A local branch already uses this PR branch name".into());
    }
    let create = action == "create" || (fetched.is_some() && existing.is_none());
    let target = if create {
        fetched.unwrap_or(old)
    } else {
        existing.ok_or("Missing local branch")?
    };
    validate_tree(&repo, target)?;
    std::fs::create_dir_all(projects::resolve(&root, ".prism/branch-builds")?)
        .map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.arg("-C")
        .arg(&root)
        .args(["switch", "--no-overwrite-ignore", "--no-guess"]);
    if create {
        cmd.args(["-c", name, &target.to_string()]);
    } else {
        cmd.args(["--", name]);
    }
    let intent = Checkout {
        before: active,
        before_head: old.to_string(),
        name: name.to_owned(),
        tip: target.to_string(),
        pr: if create && action == "pull" { pr } else { None },
        remote: connection
            .as_ref()
            .filter(|_| create && action == "remote")
            .map(|c| c.remote.clone()),
        url: connection.map(|c| c.url),
    };
    projects::save_json(&intent_path(app, project)?, &intent)?;
    let result = cmd.output().map_err(|e| e.to_string())?;
    if !result.status.success() {
        recover_checkout(app, project, &root)?;
        return Err(String::from_utf8_lossy(&result.stderr).into_owned());
    }
    recover_checkout(app, project, &root)?;
    Ok(json!({"changed":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_finishes_pr_metadata_after_an_interrupted_checkout() {
        let (dir, app) = crate::test_backend();
        let root = dir.path().join("checkout");
        std::fs::create_dir(&root).unwrap();
        let repo = Repository::init(&root).unwrap();
        let tree = repo
            .find_tree(repo.index().unwrap().write_tree().unwrap())
            .unwrap();
        let author = git2::Signature::now("Author", "author@example.test").unwrap();
        let oid = repo
            .commit(Some("HEAD"), &author, &author, "First", &tree, &[])
            .unwrap();
        let before = branch(&repo).unwrap();
        let project =
            projects::project_register(app.clone(), root.to_string_lossy().into()).unwrap();
        let intent = Checkout {
            before,
            before_head: oid.to_string(),
            name: "review/pr-42".into(),
            tip: oid.to_string(),
            pr: Some(42),
            remote: None,
            url: Some("git@example.test:team/paper.git".into()),
        };
        let path = intent_path(&app, &project.id).unwrap();
        projects::save_json(&path, &intent).unwrap();
        repo.branch("review/pr-42", &repo.find_commit(oid).unwrap(), false)
            .unwrap();
        repo.set_head("refs/heads/review/pr-42").unwrap();
        let registered = projects::project_register(app, root.to_string_lossy().into()).unwrap();
        assert_eq!(
            registered.checkout_branch.as_deref(),
            Some("refs/heads/review/pr-42")
        );
        assert_eq!(
            repo.config()
                .unwrap()
                .get_string("branch.review/pr-42.prism-pr")
                .unwrap(),
            "42"
        );
        assert!(!path.exists());
    }
}
