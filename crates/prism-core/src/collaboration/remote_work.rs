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
async fn pulls(app: &Backend, url: &str, page: u64, number: Option<u64>) -> Result<Value, String> {
    let web = web_url(url)?;
    let github = web.host_str() == Some("github.com");
    let (prefix, repo) = web.path().rsplit_once('/').ok_or("Missing repository")?;
    let (base, owner) = prefix.rsplit_once('/').ok_or("Missing repository owner")?;
    let server = web.origin().ascii_serialization();
    let api = if github {
        format!("https://api.github.com/repos/{owner}/{repo}/pulls")
    } else {
        format!("{server}{base}/api/v1/repos/{owner}/{repo}/pulls")
    };
    let mut request = if let Some(n) = number {
        http()?.get(format!("{api}/{n}"))
    } else {
        http()?.get(api).query(&[
            ("state", "open"),
            (if github { "per_page" } else { "limit" }, "50"),
            ("page", &page.to_string()),
        ])
    };
    if let Some(c) = credential(app, &server).await? {
        request = request.bearer_auth(c.token);
    }
    let body = request.send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| format!("Could not read pull requests. Check repository API access in Connection settings. {e}"))?
        .text().await.map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let entry = |r: &Value| -> Result<Value, String> {
        let n = r["number"].as_u64().ok_or("Invalid pull request number")?;
        let sha = r["head"]["sha"]
            .as_str()
            .ok_or("Missing pull request revision")?;
        let base = r["base"]["ref"]
            .as_str()
            .ok_or("Missing pull request target")?;
        let route = if github { "pull" } else { "pulls" };
        Ok(
            json!({"number":n,"name":r["title"],"author":r["user"]["login"],"draft":r["draft"],"base":base,"sha":sha,"link":format!("{web}/{route}/{n}")}),
        )
    };
    if number.is_some() {
        if data["state"] != "open" {
            return Err("This pull request is closed".into());
        }
        return entry(&data);
    }
    let entries = data
        .as_array()
        .ok_or("Invalid pull request list")?
        .iter()
        .map(entry)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!(entries))
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
    if op == "remote_work_pulls" {
        return pulls(app, &c.url, args["page"].as_u64().unwrap_or(1), None).await;
    }
    if op == "remote_work_branches" {
        let directory = temp(app)?;
        let mut cancel = app.inner.cancel.subscribe();
        let output = git(
            app,
            directory.path(),
            &["ls-remote", "--heads", &c.url],
            Some(&c.url),
            &mut cancel,
        )
        .await?;
        let mut branches = Vec::new();
        for line in output.lines() {
            let (sha, reference) = line.split_once('\t').ok_or("Invalid remote reference")?;
            if let Some(name) = reference.strip_prefix("refs/heads/") {
                branches.push(json!({"name": name, "sha": sha, "base": c.branch}));
            }
        }
        return Ok(json!(branches));
    }
    if op != "remote_work_open" {
        return Err("Unknown review operation".into());
    }
    let pr = if let Some(number) = args["number"].as_u64() {
        Some(pulls(app, &c.url, 1, Some(number)).await?)
    } else {
        None
    };
    open_revision(app, project, args, &c, pr).await
}

pub(super) async fn open_revision(
    app: &Backend,
    project: &str,
    args: Value,
    c: &Connection,
    pr: Option<Value>,
) -> Result<Value, String> {
    let directory = temp(app)?;
    Repository::init_bare(directory.path()).map_err(|e| e.to_string())?;
    let refresh = args["refresh"] == true;
    let mut cancel = app.inner.cancel.subscribe();
    let (reference, base) = if let Some(meta) = &pr {
        (
            format!("refs/pull/{}/head", meta["number"]),
            meta["base"].as_str().ok_or("Missing PR target")?,
        )
    } else {
        (
            branch_ref(args["name"].as_str().ok_or("Missing branch")?)?,
            c.branch.as_str(),
        )
    };
    let expected = if refresh && pr.is_none() {
        None
    } else {
        let data = if refresh {
            pr.as_ref().unwrap_or(&args)
        } else {
            &args
        };
        Some(
            Oid::from_str(data["sha"].as_str().ok_or("Missing revision")?)
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
    result["entry"] = pr.unwrap_or(args);
    result["id"] = json!(id);
    Ok(result)
}
