//! Reclaim only caches positively identified as belonging to terminal proposals.
use super::*;
use std::sync::{mpsc::Receiver, Arc};

pub(crate) fn start(app: &Backend, jobs: Receiver<String>) {
    let weak = Arc::downgrade(&app.inner);
    let result = std::thread::Builder::new()
        .name("proposal-cache-cleanup".into())
        .spawn(move || {
            let mut selected = None; // First pass also picks up old caches and interrupted deletions.
            loop {
                let Some(inner) = weak.upgrade() else { break };
                if let Err(e) = sweep(&Backend { inner }, selected.as_ref()) {
                    eprintln!("Proposal cache cleanup deferred: {e}");
                }
                let Ok(first) = jobs.recv() else { break };
                selected = Some(std::iter::once(first).chain(jobs.try_iter()).collect());
            }
        });
    if let Err(e) = result {
        eprintln!("Cannot schedule proposal cache cleanup: {e}");
    }
}

fn terminal(p: &Proposal) -> bool {
    matches!(p.state.as_str(), "applied" | "discarded" | "superseded")
}

fn sweep(app: &Backend, selected: Option<&BTreeSet<String>>) -> Result<(), String> {
    let base = projects::data_dir(app)?.join("visual-reviews");
    if !base.symlink_metadata().is_ok_and(|m| m.is_dir()) {
        return Ok(());
    }
    if selected.is_some_and(|ids| {
        !ids.iter()
            .any(|id| uuid::Uuid::parse_str(id).is_ok() && base.join(id).is_dir())
    }) {
        return Ok(());
    }
    let trash = base.join(".resolved-cache");
    if trash.try_exists().map_err(|e| e.to_string())? {
        if !trash
            .symlink_metadata()
            .map_err(|e| e.to_string())?
            .is_dir()
        {
            return Ok(());
        }
        if selected.is_none() {
            for entry in fs::read_dir(&trash).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok()
                    && entry.file_type().map_err(|e| e.to_string())?.is_dir()
                {
                    fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    let mut candidates = Vec::new();
    let mut protected = BTreeSet::new();
    // A repair can only acquire a parent while that parent is unresolved.
    // Read atomically published state off-lock; recheck before detaching.
    {
        protected.extend(projects::registry(app)?.into_iter().map(|p| p.id));
        for entry in fs::read_dir(directory(app)?).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if uuid::Uuid::parse_str(&id).is_err() {
                continue;
            }
            if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                continue;
            }
            if !entry
                .path()
                .join("state.json")
                .try_exists()
                .map_err(|e| e.to_string())?
            {
                continue;
            }
            let Ok(p) = load(app, &id) else {
                protected.insert(id);
                if let Ok(bytes) = fs::read(entry.path().join("state.json")) {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(parent) = value["parent"].as_str() {
                            protected.insert(parent.to_owned());
                        }
                    }
                }
                continue;
            };
            if p.id != id {
                protected.insert(id);
                protected.extend(p.parent);
                continue;
            }
            if !terminal(&p) || has_journal(&entry.path())? {
                protected.insert(id);
                protected.extend(p.parent);
            } else if selected.is_none_or(|ids| ids.contains(&id)) {
                candidates.push(id);
            }
        }
    }
    for id in candidates {
        if protected.contains(&id) {
            continue;
        }
        let dest = trash.join(uuid::Uuid::new_v4().to_string());
        {
            let _lock = app.inner.projects.0.lock().map_err(|e| e.to_string())?;
            let source = base.join(&id);
            if !source.symlink_metadata().is_ok_and(|m| m.is_dir())
                || !terminal(&load(app, &id)?)
                || has_journal(&dir(app, &id)?)?
                || crate::codex::review_path(app, &id)?
                    .try_exists()
                    .map_err(|e| e.to_string())?
            {
                continue;
            }
            fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
            if !crate::visual_review::detach_cache(app, &source, &dest)
                .map_err(|e| e.to_string())?
            {
                continue;
            }
        }
        fs::remove_dir_all(dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn has_journal(dir: &Path) -> Result<bool, String> {
    for name in ["application.json", "review-decision.json"] {
        if dir.join(name).try_exists().map_err(|e| e.to_string())? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweep_preserves_live_and_unknown_owners_and_retries_pinned_caches() {
        let (_temp, app) = crate::test_backend();
        let caches = projects::data_dir(&app).unwrap().join("visual-reviews");
        let mut owners = Vec::new();
        let project = uuid::Uuid::new_v4().to_string();
        for state in [
            "applied",
            "discarded",
            "superseded",
            "ready",
            "repairing",
            "applied",
            "broken",
        ] {
            let id = uuid::Uuid::new_v4().to_string();
            let proposal = dir(&app, &id).unwrap();
            fs::create_dir_all(&proposal).unwrap();
            let value = json!({
                "id":id, "projectId":project, "state":state, "generation":1,
                "conflicts":[], "parent": if state == "repairing" { owners.get(2) } else { None }
            });
            projects::save_json(&proposal.join("state.json"), &value).unwrap();
            if state == "broken" {
                fs::write(proposal.join("state.json"), b"{").unwrap();
            }
            if owners.len() == 5 {
                fs::write(proposal.join("application.json"), b"{}").unwrap();
            }
            owners.push(id);
        }
        owners.push(project);
        let pin = crate::visual_review::pin_workspace(&app, &owners[1]).unwrap();
        for id in &owners {
            fs::create_dir_all(caches.join(id)).unwrap();
        }
        let interrupted = caches
            .join(".resolved-cache")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&interrupted).unwrap();
        sweep(&app, None).unwrap();
        assert!(!interrupted.exists());
        assert!(!caches.join(&owners[0]).exists());
        for id in &owners[1..] {
            assert!(caches.join(id).exists());
        }
        drop(pin);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while caches.join(&owners[1]).exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!caches.join(&owners[1]).exists());
        sweep(&app, None).unwrap();
        for id in &owners[2..] {
            assert!(caches.join(id).exists());
        }
    }
}
