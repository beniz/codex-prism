//! Detached, read-only review sessions. Network fetches only write into temporary repositories.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{collections::BTreeMap, fs, io::Read, sync::Arc};
use tempfile::TempDir;

pub(super) struct Preview {
    repo: TempDir,
    head: Oid,
}
fn temp(app: &Backend) -> Result<TempDir, String> {
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    builder
        .prefix("prism-remote-review-")
        .tempdir_in(&app.inner.config.temp_dir)
        .map_err(|e| e.to_string())
}
fn web_url(url: &str) -> Result<reqwest::Url, String> {
    validate_url(url)?;
    let web = if let Some(s) = url.strip_prefix("git@") {
        let (host, path) = s.split_once(':').ok_or("Invalid SSH URL")?;
        format!("https://{host}/{}", path.trim_start_matches('/'))
    } else if url.starts_with("ssh://") {
        let u = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
        format!(
            "https://{}{}",
            u.host_str().ok_or("Missing host")?,
            u.path()
        )
    } else {
        url.to_owned()
    };
    reqwest::Url::parse(web.trim_end_matches('/').trim_end_matches(".git"))
        .map_err(|e| e.to_string())
}
fn branch_ref(name: &str) -> Result<String, String> {
    let r = format!("refs/heads/{name}");
    if !git2::Reference::is_valid_name(&r) {
        return Err("Invalid branch name".into());
    }
    Ok(r)
}
fn unpack(
    repo: &Repository,
    tree: &git2::Tree,
    prefix: &str,
    dir: Option<&Path>,
    sources: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    for e in tree {
        let name = e.name().ok_or("Unsupported filename encoding")?;
        let path = format!("{prefix}{name}");
        if crate::file_policy::Policy::IsolatedSnapshot.excludes_path(&path) {
            continue;
        }
        if e.kind() == Some(git2::ObjectType::Tree) {
            let child = repo.find_tree(e.id()).map_err(|e| e.to_string())?;
            unpack(repo, &child, &format!("{path}/"), dir, sources)?;
        } else if dir.is_some() || path.to_ascii_lowercase().ends_with(".tex") {
            let blob = repo.find_blob(e.id()).map_err(|e| e.to_string())?;
            if let Some(dir) = dir {
                let dest = projects::resolve(dir, &path)?;
                fs::create_dir_all(dest.parent().ok_or("Missing parent")?)
                    .map_err(|e| e.to_string())?;
                fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(dest)
                    .and_then(|mut f| std::io::Write::write_all(&mut f, blob.content()))
                    .map_err(|e| e.to_string())?;
            } else {
                sources.insert(path, String::from_utf8_lossy(blob.content()).into_owned());
            }
        }
    }
    Ok(())
}
fn inspect(path: &Path, head: Oid) -> Result<Value, String> {
    let repo = Repository::open_bare(path).map_err(|e| e.to_string())?;
    validate_tree(&repo, head)?;
    let base = repo
        .refname_to_id("refs/review/base")
        .map_err(|e| e.to_string())?;
    let ancestor = repo
        .merge_base(base, head)
        .map_err(|_| "The branches do not share a merge base")?;
    let tree = |id| {
        repo.find_commit(id)
            .and_then(|c| c.tree())
            .map_err(|e| e.to_string())
    };
    let current = tree(head)?;
    let diff = repo
        .diff_tree_to_tree(Some(&tree(ancestor)?), Some(&current), None)
        .map_err(|e| e.to_string())?;
    let mut patch = Vec::new();
    const PATCH_LIMIT: usize = 8 * 1024 * 1024;
    let mut truncated = false;
    let printed = diff.print(git2::DiffFormat::Patch, |_, _, line| {
        if patch.len() + line.content().len() + 1 > PATCH_LIMIT {
            truncated = true;
            return false;
        }
        if matches!(line.origin(), '+' | '-' | ' ') {
            patch.push(line.origin() as u8);
        }
        patch.extend_from_slice(line.content());
        true
    });
    if truncated {
        patch.extend_from_slice(b"\n[Diff truncated at 8 MiB]\n");
    } else {
        printed.map_err(|e| e.to_string())?;
    }
    let mut sources = BTreeMap::new();
    unpack(&repo, &current, "", None, &mut sources)?;
    Ok(
        json!({"sources":sources,"diff":String::from_utf8_lossy(&patch),"sha":head.to_string(),"baseSha":base.to_string()}),
    )
}
pub(super) async fn service(
    app: &Backend,
    project: &str,
    op: &str,
    args: Value,
) -> Result<Value, String> {
    let key = (
        project.to_owned(),
        args["id"].as_str().unwrap_or("").to_owned(),
    );
    let previews = &app.inner.collaboration.previews;
    if op == "remote_work_close" {
        let closed = previews.lock().map_err(|e| e.to_string())?.remove(&key);
        tokio::task::spawn_blocking(move || drop(closed))
            .await
            .map_err(|e| e.to_string())?;
        return Ok(Value::Null);
    }
    if op == "remote_work_compile" {
        let preview = previews
            .lock()
            .map_err(|e| e.to_string())?
            .get(&key)
            .cloned()
            .ok_or("Review expired")?;
        let work = temp(app)?;
        let main = args["main"]
            .as_str()
            .ok_or("Choose a TeX document")?
            .to_owned();
        let (work, content) = tokio::task::spawn_blocking({
            let main = main.clone();
            move || -> Result<_, String> {
                let repo = Repository::open_bare(preview.repo.path()).map_err(|e| e.to_string())?;
                let tree = repo
                    .find_commit(preview.head)
                    .and_then(|c| c.tree())
                    .map_err(|e| e.to_string())?;
                unpack(&repo, &tree, "", Some(work.path()), &mut BTreeMap::new())?;
                if !main.to_ascii_lowercase().ends_with(".tex") || main.starts_with('-') {
                    return Err("Choose a TeX document".into());
                }
                let content = fs::read_to_string(projects::resolve(work.path(), &main)?)
                    .map_err(|e| e.to_string())?;
                Ok((work, content))
            }
        })
        .await
        .map_err(|e| e.to_string())??;
        let pdf = crate::latex::compile_preview(
            &app.inner.latex,
            work.path(),
            &main,
            &content,
            app.inner.cancel.subscribe(),
        )
        .await?;
        return tokio::task::spawn_blocking(move || {
            let stem = Path::new(&main)
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or("Invalid root")?;
            let mut sync = String::new();
            if let Ok(file) = fs::File::open(work.path().join(format!("{stem}.synctex.gz"))) {
                flate2::read::GzDecoder::new(file)
                    .read_to_string(&mut sync)
                    .map_err(|e| e.to_string())?;
            }
            let locations = crate::latex::forward_synctex(&sync, work.path());
            Ok(json!({"pdf": STANDARD.encode(pdf), "locations": locations}))
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let root = projects::get(app, project)?.root;
    let c = read_connection(&root)?.ok_or("Connect a repository first")?;
    validate_url(&c.url)?;
    browse(app, project, op, args, c).await
}

pub(super) async fn browse(
    app: &Backend,
    project: &str,
    op: &str,
    args: Value,
    c: Connection,
) -> Result<Value, String> {
    if matches!(op, "remote_work_branches" | "remote_work_pulls") {
        let directory = temp(app)?;
        let mut cancel = app.inner.cancel.subscribe();
        let mut command = vec!["ls-remote", "--refs", &c.url, "refs/heads/*"];
        let include_pulls = op == "remote_work_pulls";
        if include_pulls {
            command.push("refs/pull/*/head");
        }
        let output = git(app, directory.path(), &command, Some(&c.url), &mut cancel).await?;
        let mut branches = Vec::new();
        let mut pulls = BTreeMap::new();
        let web = web_url(&c.url).ok();
        for line in output.lines() {
            let (sha, reference) = line.split_once('\t').ok_or("Invalid remote reference")?;
            if let Some(name) = reference.strip_prefix("refs/heads/") {
                branches.push(json!({"name": name, "sha": sha, "base": c.branch}));
            } else if let Some(number) = reference
                .strip_prefix("refs/pull/")
                .and_then(|r| r.strip_suffix("/head"))
                .and_then(|r| r.parse::<u64>().ok())
            {
                let link = web.as_ref().map(|url| {
                    let route = if url.host_str() == Some("github.com") {
                        "pull"
                    } else {
                        "pulls"
                    };
                    format!("{url}/{route}/{number}")
                });
                pulls.insert(number, json!({"number":number, "sha":sha, "base":c.branch, "name":format!("PR #{number}"), "link":link}));
            }
        }
        if include_pulls {
            let entries: Vec<_> = pulls.into_values().rev().collect();
            return Ok(json!({"entries":entries, "branches":branches, "defaultBase":c.branch}));
        }
        return Ok(json!(branches));
    }
    if op != "remote_work_open" {
        return Err("Unknown review operation".into());
    }
    let directory = temp(app)?;
    Repository::init_bare(directory.path()).map_err(|e| e.to_string())?;
    let refresh = args["refresh"] == true;
    let mut cancel = app.inner.cancel.subscribe();
    let (reference, base) = if let Some(number) = args["number"].as_u64() {
        (
            format!("refs/pull/{number}/head"),
            args["base"].as_str().unwrap_or(&c.branch),
        )
    } else {
        (
            branch_ref(args["name"].as_str().ok_or("Missing branch")?)?,
            c.branch.as_str(),
        )
    };
    let expected = if refresh {
        None
    } else {
        Some(
            Oid::from_str(args["sha"].as_str().ok_or("Missing revision")?)
                .map_err(|e| e.to_string())?,
        )
    };
    git(
        app,
        directory.path(),
        &[
            "fetch",
            "--no-tags",
            &c.url,
            &format!("+{reference}:refs/review/head"),
            &format!("+{}:refs/review/base", branch_ref(base)?),
        ],
        Some(&c.url),
        &mut cancel,
    )
    .await?;
    let (mut result, preview) = tokio::task::spawn_blocking(move || {
        let repo = Repository::open_bare(directory.path()).map_err(|e| e.to_string())?;
        let head = repo
            .refname_to_id("refs/review/head")
            .map_err(|e| e.to_string())?;
        if expected.is_some_and(|oid| oid != head) {
            return Err("The remote revision changed. Refresh the list and open it again.".into());
        }
        inspect(directory.path(), head).map(|r| {
            (
                r,
                Preview {
                    repo: directory,
                    head,
                },
            )
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let id = uuid::Uuid::new_v4().to_string();
    app.inner
        .collaboration
        .previews
        .lock()
        .map_err(|e| e.to_string())?
        .insert((project.into(), id.clone()), Arc::new(preview));
    result["base"] = json!(base);
    result["entry"] = args;
    result["id"] = json!(id);
    Ok(result)
}
