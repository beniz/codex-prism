//! Review records and selected document edits have independent acceptance.
use super::*;

pub(super) fn record_prefix(p: &Proposal) -> Result<String, String> {
    let g = p.git.as_ref().ok_or("Not a reviewer proposal")?;
    let id = g
        .branch
        .as_deref()
        .and_then(|b| b.rsplit('/').next())
        .unwrap_or(&p.id);
    uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
    Ok(format!(".prism-collab/reviews/{id}/"))
}
fn records(p: &Proposal, r: &Review) -> Result<Files, String> {
    let prefix = record_prefix(p)?;
    Ok(["report.md", "review.json"]
        .into_iter()
        .filter_map(|name| {
            let path = format!("{prefix}{name}");
            r.after.get(&path).map(|bytes| (path, bytes.clone()))
        })
        .collect())
}
pub(super) fn document_paths(
    app: &Backend,
    p: &Proposal,
    r: &Review,
) -> Result<BTreeSet<String>, String> {
    let main = projects::get(app, &p.project_id)?;
    let repo = git2::Repository::open(main.root).map_err(|e| e.to_string())?;
    let g = p.git.as_ref().ok_or("Not a reviewer proposal")?;
    let tree = repo
        .find_commit(
            git2::Oid::from_str(g.reviewed_commit.as_ref().unwrap_or(&g.base))
                .map_err(|e| e.to_string())?,
        )
        .and_then(|c| c.tree())
        .map_err(|e| e.to_string())?;
    Ok(r.before
        .keys()
        .chain(r.after.keys())
        .filter(|name| {
            !name.starts_with(".prism-collab/")
                && r.before.get(*name) != r.after.get(*name)
                && tree.get_path(Path::new(name)).is_ok()
        })
        .cloned()
        .collect())
}

#[derive(Serialize, Deserialize)]
struct Decision {
    before: String,
    after: String,
    branch: String,
    proposal: Proposal,
    review: Review,
    workspace_before: Files,
    workspace_after: Files,
}
fn decision_path(app: &Backend, p: &Proposal) -> Result<PathBuf, String> {
    Ok(dir(app, &p.id)?.join("review-decision.json"))
}
pub(super) fn pending(app: &Backend, p: &Proposal) -> bool {
    decision_path(app, p).is_ok_and(|path| path.exists())
}
fn complete(app: &Backend, decision: &Decision) -> Result<(), String> {
    let p = &decision.proposal;
    // Only update files explicitly accepted. The rest of the proposal stays pending.
    let workspace = root(app, p)?;
    for name in decision
        .workspace_before
        .keys()
        .chain(decision.workspace_after.keys())
    {
        let bytes = fs::read(projects::resolve(&workspace, name)?).ok();
        if bytes.as_ref() != decision.workspace_before.get(name)
            && bytes.as_ref() != decision.workspace_after.get(name)
        {
            return Err(format!(
                "Reviewer workspace changed during acceptance: {name}"
            ));
        }
    }
    write_files(
        &workspace,
        &decision.workspace_before,
        &decision.workspace_after,
    )?;
    review_storage::save(&snapshot_path(app, p)?, &decision.review)?;
    save(app, p)?;
    if let Some(parent) = &p.parent {
        let mut old = load(app, parent)?;
        old.state = "superseded".into();
        save(app, &old)?;
        cleanup_resolved(app, &old);
    }
    fs::remove_file(decision_path(app, p)?).map_err(|e| e.to_string())?;
    app.inner.events.emit(crate::BackendEvent::HistoryChanged {
        project_id: p.project_id.clone(),
        warning: None,
    });
    cleanup_resolved(app, p);
    app.emit_review(json!({"projectId":p.project_id}))
}
pub(super) fn recover(app: &Backend, p: &Proposal) -> Result<(), String> {
    let decision: Decision =
        serde_json::from_slice(&fs::read(decision_path(app, p)?).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let main = projects::get(app, &p.project_id)?;
    let lock = workflow::mutex(&main.root.to_string_lossy());
    let _history = lock.lock().map_err(|e| e.to_string())?;
    crate::collaboration::recover(&main.root)?;
    let repo = git2::Repository::open(&main.root).map_err(|e| e.to_string())?;
    let head = repo.head().map_err(|e| e.to_string())?;
    if head.name() != Some(decision.branch.as_str()) {
        return Err("Return to the original branch to finish saving this review".into());
    }
    let tip = head.peel_to_commit().map_err(|e| e.to_string())?.id();
    let after = git2::Oid::from_str(&decision.after).map_err(|e| e.to_string())?;
    if tip == git2::Oid::from_str(&decision.before).map_err(|e| e.to_string())? {
        crate::collaboration::integrate(&main.root, tip, after)?;
    } else if tip != after
        && !repo
            .graph_descendant_of(tip, after)
            .map_err(|e| e.to_string())?
    {
        return Err("Document history changed during review acceptance; retained recovery needs the original branch".into());
    }
    complete(app, &decision)
}

pub(super) fn decide(
    app: &Backend,
    project: &str,
    id: &str,
    generation: u64,
    save_only: bool,
    args: &Value,
) -> Result<Value, String> {
    let _files = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
    let mut p = checked(app, project, id, generation)?;
    if let Some(error) = &p.error {
        return Err(error.clone());
    }
    let mut r = snapshot(app, &p)?;
    let main = projects::get(app, project)?;
    let lock = workflow::mutex(&main.root.to_string_lossy());
    let _history = lock.lock().map_err(|e| e.to_string())?;
    let repo = git2::Repository::open(&main.root).map_err(|e| e.to_string())?;
    workflow::safe(&repo)?;
    crate::collaboration::tracked_clean(&repo)?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch = head.name().ok_or("Missing branch")?.to_string();
    let tip = head.peel_to_commit().map_err(|e| e.to_string())?;
    let eligible = document_paths(app, &p, &r)?;
    let selected: BTreeSet<String> = if save_only {
        BTreeSet::new()
    } else if let Some(paths) = args.get("paths") {
        serde_json::from_value(paths.clone()).map_err(|_| "Invalid selected document files")?
    } else {
        eligible.clone()
    };
    if !selected.is_subset(&eligible) {
        return Err("Select only pending tracked document files".into());
    }
    if !save_only && selected.is_empty() {
        return Err("Select at least one document file".into());
    }
    let current = projects::isolated_snapshot(&main.root)?;
    let base: Files = r
        .before
        .iter()
        .filter(|(n, _)| selected.contains(*n))
        .map(|(n, b)| (n.clone(), b.clone()))
        .collect();
    let proposed: Files = r
        .after
        .iter()
        .filter(|(n, _)| selected.contains(*n))
        .map(|(n, b)| (n.clone(), b.clone()))
        .collect();
    let (merged, conflicts) = merge(&merge_repo(app, &p)?, &base, &proposed, &current)?;
    if !conflicts.is_empty() {
        p.state = "conflicts".into();
        p.conflicts = conflicts;
        save(app, &p)?;
        return Ok(json!({"conflicts":p.conflicts}));
    }
    // A changed base must be shown again before any document acceptance.
    if selected
        .iter()
        .any(|n| current.get(n) != r.before.get(n) && merged.get(n) != r.after.get(n))
    {
        let mut updated = r.after.clone();
        for name in &selected {
            copy_entry(&mut r.before, name, &current);
            copy_entry(&mut updated, name, &merged);
        }
        write_files(&root(app, &p)?, &r.after, &updated)?;
        r.after = updated;
        p.generation += 1;
        p.conflicts.retain(|name| !selected.contains(name));
        p.state = if p.conflicts.is_empty() {
            "ready"
        } else {
            "conflicts"
        }
        .into();
        review_storage::save(&snapshot_path(app, &p)?, &r)?;
        save(app, &p)?;
        return Ok(json!({"reviewAgain":true,"conflicts":[]}));
    }
    let records = records(&p, &r)?;
    if save_only && !records.keys().any(|n| n.ends_with("/report.md")) {
        return Err("The reviewer has not written findings yet".into());
    }
    let mut before = Files::new();
    let mut after = records.clone();
    let tree = tip.tree().map_err(|e| e.to_string())?;
    let record_base = repo
        .find_commit(git2::Oid::from_str(&p.git.as_ref().unwrap().base).map_err(|e| e.to_string())?)
        .and_then(|commit| commit.tree())
        .map_err(|e| e.to_string())?;
    // Compare records explicitly: ordinary source snapshots intentionally omit them.
    for name in records.keys() {
        let path = projects::resolve(&main.root, name)?;
        if let Ok(entry) = tree.get_path(Path::new(name)) {
            let bytes = repo
                .find_blob(entry.id())
                .map_err(|e| e.to_string())?
                .content()
                .to_vec();
            let expected = record_base
                .get_path(Path::new(name))
                .ok()
                .map(|entry| {
                    repo.find_blob(entry.id())
                        .map(|blob| blob.content().to_vec())
                })
                .transpose()
                .map_err(|e| e.to_string())?;
            if expected.as_ref() != Some(&bytes) && records.get(name) != Some(&bytes) {
                return Err(format!(
                    "Shared review record changed; inspect it before replacing it: {name}"
                ));
            }
            if fs::read(&path).ok().as_ref() != Some(&bytes) {
                return Err(format!("Review record has local edits: {name}"));
            }
            before.insert(name.clone(), bytes);
        } else if record_base.get_path(Path::new(name)).is_ok() {
            return Err(format!(
                "Shared review record was removed; inspect it before restoring it: {name}"
            ));
        } else if path.exists() && fs::read(&path).ok().as_ref() != records.get(name) {
            return Err(format!("A local review record already exists: {name}"));
        }
    }
    let mut workspace_before = Files::new();
    let mut workspace_after = Files::new();
    for name in &selected {
        copy_entry(&mut before, name, &current);
        copy_entry(&mut after, name, &merged);
        copy_entry(&mut workspace_before, name, &r.after);
        copy_entry(&mut workspace_after, name, &merged);
        copy_entry(&mut r.before, name, &merged);
        copy_entry(&mut r.after, name, &merged);
    }
    let source_changed = selected.iter().any(|n| before.get(n) != after.get(n));
    let result_tree = proposal_tree(&repo, &tip, &before, &after)?;
    let signature = repo.signature().map_err(|e| e.to_string())?;
    // Never merge the reviewer branch: its ancestors contain unaccepted edits.
    let oid = if result_tree.id() == tree.id() {
        tip.id()
    } else {
        repo.commit(
            None,
            &signature,
            &signature,
            &format!(
                "{}\n\nPrism-Review-Decision: {}:{}",
                if save_only {
                    "Save manuscript review"
                } else {
                    "Accept selected reviewer edits"
                },
                p.id,
                p.generation
            ),
            &result_tree,
            &[&tip],
        )
        .map_err(|e| e.to_string())?
    };
    p.review_saved = true;
    p.review_deferred = true;
    p.generation += 1;
    p.conflicts.retain(|name| !selected.contains(name));
    p.state = if p.conflicts.is_empty() {
        "ready"
    } else {
        "conflicts"
    }
    .into();
    p.error = None;
    p.git.as_mut().unwrap().base = oid.to_string();
    if document_paths(app, &p, &r)?.is_empty() {
        p.state = "applied".into();
    }
    let decision = Decision {
        before: tip.id().to_string(),
        after: oid.to_string(),
        branch,
        proposal: p.clone(),
        review: r,
        workspace_before,
        workspace_after,
    };
    projects::save_json(&decision_path(app, &p)?, &decision)?;
    let mut applying = load(app, id)?;
    applying.state = "applying".into();
    save(app, &applying)?;
    if let Err(error) = crate::collaboration::integrate(&main.root, tip.id(), oid) {
        applying.error = Some(error.clone());
        save(app, &applying)?;
        return Err(error);
    }
    complete(app, &decision)?;
    Ok(json!({"conflicts":[],"sourceChanged":source_changed,"reusedBuilds":[]}))
}
fn copy_entry(dest: &mut Files, name: &str, source: &Files) {
    if let Some(bytes) = source.get(name) {
        dest.insert(name.into(), bytes.clone());
    } else {
        dest.remove(name);
    }
}

/// Snapshots and local review branches outlive Discard; expose their reports too.
pub(crate) fn local_reviews(app: &Backend, project: &str) -> Result<Vec<Value>, String> {
    let main = projects::get(app, project)?;
    let mut result = vec![];
    for entry in fs::read_dir(directory(app)?)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let Ok(p) = load(app, &entry.file_name().to_string_lossy()) else {
            continue;
        };
        if p.project_id != project
            || p.git.as_ref().is_none_or(|g| g.kind != "reviewer")
            || ["original", "superseded"].contains(&p.state.as_str())
        {
            continue;
        }
        let r = snapshot(app, &p)?;
        let prefix = record_prefix(&p)?;
        let Some(report) = r.after.get(&format!("{prefix}report.md")) else {
            continue;
        };
        let record = records(&p, &r)?;
        if record
            .iter()
            .all(|(name, bytes)| fs::read(main.root.join(name)).ok().as_ref() == Some(bytes))
        {
            continue;
        }
        let g = p.git.as_ref().unwrap();
        result.push(json!({"id":p.id,"proposalId":p.id,"scope":g.scope,"reviewedCommit":g.reviewed_commit.as_ref().unwrap_or(&g.base),"schemaVersion":1,"local":true,"hasReport":!report.is_empty()}));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Backend, projects::Project, Proposal) {
        let (dir, app) = crate::test_backend();
        let path = dir.path().join("paper");
        fs::create_dir(&path).unwrap();
        fs::write(
            path.join("main.tex"),
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
        )
        .unwrap();
        fs::write(path.join("section.tex"), "original section\n").unwrap();
        let project =
            projects::project_register(app.clone(), path.to_string_lossy().into()).unwrap();
        workflow::initialize(&path.to_string_lossy(), None).unwrap();
        let repo = git2::Repository::open(&path).unwrap();
        repo.config()
            .unwrap()
            .set_str("user.name", "Author")
            .unwrap();
        repo.config()
            .unwrap()
            .set_str("user.email", "author@example.test")
            .unwrap();
        fs::write(path.join("scratch.md"), "private context").unwrap();
        let prepared = prepare_reviewer(&app, &project.id, "review", "Clarity").unwrap();
        let p = begin_for_chat(&app, &project.id, None, None, Some("review".into())).unwrap();
        let workspace = root(&app, &p).unwrap();
        fs::write(
            workspace.join("main.tex"),
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
        )
        .unwrap();
        fs::write(workspace.join("section.tex"), "suggested section\n").unwrap();
        fs::write(workspace.join("scratch.md"), "unaccepted private context").unwrap();
        let report = workspace.join(format!("{}report.md", record_prefix(&p).unwrap()));
        fs::create_dir_all(report.parent().unwrap()).unwrap();
        fs::write(report, "# Findings\nClarify the argument.").unwrap();
        finish(&app, prepared["proposalId"].as_str().unwrap(), false).unwrap();
        let p = load(&app, &p.id).unwrap();
        (dir, app, project, p)
    }
    fn act(
        app: &Backend,
        p: &Proposal,
        operation: &str,
        paths: Option<Vec<&str>>,
    ) -> Result<Value, String> {
        let latest = load(app, &p.id)?;
        let mut args = json!({"proposalId":p.id,"generation":latest.generation});
        if let Some(paths) = paths {
            args["paths"] = json!(paths);
        }
        service(app, &p.project_id, operation, args)
    }
    fn head(repo: &git2::Repository) -> git2::Commit<'_> {
        repo.head().unwrap().peel_to_commit().unwrap()
    }
    fn manual_edit(project: &projects::Project, file: &str, value: &str) {
        fs::write(project.root.join(file), value).unwrap();
        workflow::checkpoint(&project.root.to_string_lossy(), "Independent edit", None).unwrap();
    }
    #[test]
    fn save_then_selectively_accept_and_discard_preserves_findings_and_unselected_files() {
        let (_dir, app, project, p) = fixture();
        let repo = git2::Repository::open(&project.root).unwrap();
        let original = head(&repo).id();
        let incoming = git2::Oid::from_str(&p.git.as_ref().unwrap().incoming).unwrap();
        let result = act(&app, &p, "proposal_save_review", None).unwrap();
        assert_eq!(result["sourceChanged"], false);
        assert_eq!(head(&repo).parent_ids().collect::<Vec<_>>(), vec![original]);
        assert!(!repo
            .graph_descendant_of(head(&repo).id(), incoming)
            .unwrap());
        assert!(project
            .root
            .join(format!("{}report.md", record_prefix(&p).unwrap()))
            .exists());
        assert!(fs::read_to_string(project.root.join("main.tex"))
            .unwrap()
            .starts_with("one"));
        assert!(!locked(&app, &project.id).unwrap());
        let list = service(&app, &project.id, "proposal_list", json!({})).unwrap();
        assert_eq!(list[0]["changes"].as_array().unwrap().len(), 2);
        assert_eq!(list[0]["reviewSaved"], true);
        act(&app, &p, "proposal_apply", Some(vec!["main.tex"])).unwrap();
        assert!(fs::read_to_string(project.root.join("main.tex"))
            .unwrap()
            .starts_with("ONE"));
        assert_eq!(
            fs::read_to_string(project.root.join("section.tex")).unwrap(),
            "original section\n"
        );
        assert_eq!(
            document_paths(
                &app,
                &load(&app, &p.id).unwrap(),
                &snapshot(&app, &load(&app, &p.id).unwrap()).unwrap()
            )
            .unwrap(),
            BTreeSet::from(["section.tex".into()])
        );
        assert_eq!(
            fs::read_to_string(project.root.join("scratch.md")).unwrap(),
            "private context"
        );
        assert!(head(&repo)
            .tree()
            .unwrap()
            .get_path(Path::new("scratch.md"))
            .is_err());
        act(&app, &p, "proposal_discard", None).unwrap();
        assert!(project
            .root
            .join(format!("{}report.md", record_prefix(&p).unwrap()))
            .exists());
        assert!(!root(&app, &p).unwrap().exists());
        assert_eq!(
            report(&app, &project.id, &p.id).unwrap()["report"],
            "# Findings\nClarify the argument."
        );
    }
    #[test]
    fn discarded_unsaved_review_remains_locally_discoverable() {
        let (_dir, app, project, p) = fixture();
        let repo = git2::Repository::open(&project.root).unwrap();
        let original = head(&repo).id();
        act(&app, &p, "proposal_discard", None).unwrap();
        assert_eq!(head(&repo).id(), original);
        let local = local_reviews(&app, &project.id).unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0]["proposalId"], p.id);
        assert_eq!(local[0]["local"], true);
        assert!(!root(&app, &p).unwrap().exists());
        assert!(report(&app, &project.id, &p.id).unwrap()["report"]
            .as_str()
            .unwrap()
            .contains("Findings"));
    }
    #[test]
    fn later_acceptance_requires_review_of_a_clean_merge_and_keeps_independent_edits() {
        let (_dir, app, project, p) = fixture();
        act(&app, &p, "proposal_save_review", None).unwrap();
        manual_edit(
            &project,
            "main.tex",
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n",
        );
        let first = act(&app, &p, "proposal_apply", Some(vec!["main.tex"])).unwrap();
        assert_eq!(first["reviewAgain"], true);
        assert!(fs::read_to_string(project.root.join("main.tex"))
            .unwrap()
            .starts_with("one"));
        let next = act(&app, &p, "proposal_apply", Some(vec!["main.tex"])).unwrap();
        assert_eq!(next["sourceChanged"], true);
        let text = fs::read_to_string(project.root.join("main.tex")).unwrap();
        assert!(text.starts_with("ONE"));
        assert!(text.ends_with("TEN\n"));
    }
    #[test]
    fn conflicts_only_block_selected_files_and_new_or_metadata_paths_are_rejected() {
        let (_dir, app, project, p) = fixture();
        act(&app, &p, "proposal_save_review", None).unwrap();
        manual_edit(&project, "section.tex", "independent section\n");
        let result = act(&app, &p, "proposal_apply", Some(vec!["section.tex"])).unwrap();
        assert_eq!(result["conflicts"], json!(["section.tex"]));
        assert_eq!(
            fs::read_to_string(project.root.join("section.tex")).unwrap(),
            "independent section\n"
        );
        act(&app, &p, "proposal_apply", Some(vec!["main.tex"])).unwrap();
        assert!(act(&app, &p, "proposal_apply", Some(vec!["scratch.md"])).is_err());
        assert!(act(
            &app,
            &p,
            "proposal_apply",
            Some(vec![".prism-collab/reviews/other/report.md"])
        )
        .is_err());
        assert!(act(&app, &p, "proposal_apply", Some(vec![])).is_err());
    }
    #[test]
    fn unrelated_staged_or_unsaved_files_are_never_overwritten() {
        let (_dir, app, project, p) = fixture();
        let repo = git2::Repository::open(&project.root).unwrap();
        let original = head(&repo).id();
        fs::write(project.root.join("section.tex"), "manual draft").unwrap();
        assert!(act(&app, &p, "proposal_save_review", None)
            .unwrap_err()
            .contains("Save"));
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("section.tex")).unwrap();
        index.write().unwrap();
        let index_bytes = fs::read(repo.path().join("index")).unwrap();
        assert!(act(&app, &p, "proposal_save_review", None)
            .unwrap_err()
            .contains("staged"));
        assert_eq!(fs::read(repo.path().join("index")).unwrap(), index_bytes);
        assert_eq!(
            fs::read_to_string(project.root.join("section.tex")).unwrap(),
            "manual draft"
        );
        assert_eq!(head(&repo).id(), original);
        assert!(!pending(&app, &p));
        assert_eq!(load(&app, &p.id).unwrap().state, "ready");
    }
    #[test]
    fn accepted_files_stay_accepted_across_reviewer_followups_and_deletions() {
        let (_dir, app, project, p) = fixture();
        act(&app, &p, "proposal_apply", Some(vec!["main.tex"])).unwrap();
        let running = begin_for_chat(&app, &project.id, None, None, Some("review".into())).unwrap();
        fs::remove_file(root(&app, &running).unwrap().join("section.tex")).unwrap();
        finish(&app, &p.id, false).unwrap();
        let next = load(&app, &p.id).unwrap();
        assert!(!next.review_saved);
        assert_eq!(
            document_paths(&app, &next, &snapshot(&app, &next).unwrap()).unwrap(),
            BTreeSet::from(["section.tex".into()])
        );
        act(&app, &p, "proposal_apply", Some(vec!["section.tex"])).unwrap();
        assert!(!project.root.join("section.tex").exists());
        assert!(fs::read_to_string(project.root.join("main.tex"))
            .unwrap()
            .starts_with("ONE"));
    }
    #[test]
    fn recovery_finishes_record_only_commit_without_accepting_document_edits() {
        let (_dir, app, project, mut p) = fixture();
        let repo = git2::Repository::open(&project.root).unwrap();
        let tip = head(&repo);
        let r = snapshot(&app, &p).unwrap();
        let tree = proposal_tree(&repo, &tip, &Files::new(), &records(&p, &r).unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let oid = repo
            .commit(None, &sig, &sig, "Save review", &tree, &[&tip])
            .unwrap();
        p.generation += 1;
        p.review_saved = true;
        p.review_deferred = true;
        p.git.as_mut().unwrap().base = oid.to_string();
        let decision = Decision {
            before: tip.id().to_string(),
            after: oid.to_string(),
            branch: repo.head().unwrap().name().unwrap().into(),
            proposal: p.clone(),
            review: r,
            workspace_before: Files::new(),
            workspace_after: Files::new(),
        };
        projects::save_json(&decision_path(&app, &p).unwrap(), &decision).unwrap();
        let mut applying = load(&app, &p.id).unwrap();
        applying.state = "applying".into();
        save(&app, &applying).unwrap();
        // Simulate a crash after Git integration, before proposal state publication.
        crate::collaboration::integrate(&project.root, tip.id(), oid).unwrap();
        recover_applications(&app);
        assert_eq!(head(&repo).id(), oid);
        assert!(!pending(&app, &p));
        assert!(load(&app, &p.id).unwrap().review_saved);
        assert_eq!(
            document_paths(&app, &p, &snapshot(&app, &p).unwrap())
                .unwrap()
                .len(),
            2
        );
        assert!(fs::read_to_string(project.root.join("main.tex"))
            .unwrap()
            .starts_with("one"));
        assert!(!locked(&app, &project.id).unwrap());
    }
    #[test]
    fn collaborator_edits_to_saved_findings_are_not_overwritten_by_document_acceptance() {
        let (_dir, app, project, p) = fixture();
        act(&app, &p, "proposal_save_review", None).unwrap();
        let repo = git2::Repository::open(&project.root).unwrap();
        let tip = head(&repo);
        let name = format!("{}report.md", record_prefix(&p).unwrap());
        fs::write(
            project.root.join(&name),
            "Collaborator's additional finding",
        )
        .unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(&name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, "Discuss findings", &tree, &[&tip])
            .unwrap();
        assert!(act(&app, &p, "proposal_apply", Some(vec!["main.tex"]))
            .unwrap_err()
            .contains("Shared review record changed"));
        assert_eq!(head(&repo).id(), oid);
        assert_eq!(
            fs::read_to_string(project.root.join(name)).unwrap(),
            "Collaborator's additional finding"
        );
        assert!(fs::read_to_string(project.root.join("main.tex"))
            .unwrap()
            .starts_with("one"));
    }
}
