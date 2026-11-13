//! Read-only discovery for project cards, including hidden compiler output.
use crate::{projects, Backend};
use serde_json::{json, Value};
use std::{fs, path::Path, time::UNIX_EPOCH};

pub(crate) fn discover(app: &Backend, project_id: &str) -> Result<Value, String> {
    let project = projects::get(app, project_id)?;
    let listing = projects::project_list(app.clone(), project_id.into())?;
    let paths: Vec<String> = listing["files"]
        .as_array()
        .ok_or("Invalid project listing")?
        .iter()
        .filter_map(|f| f["path"].as_str().map(str::to_owned))
        .collect();
    discover_paths(&project.root, paths)
}

fn discover_paths(root: &Path, mut paths: Vec<String>) -> Result<Value, String> {
    if let Ok(build) = projects::resolve(root, ".prism/build") {
        if build.is_dir() {
            for entry in fs::read_dir(build).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().map_err(|e| e.to_string())?.is_file() {
                    paths.push(format!(
                        ".prism/build/{}",
                        entry.file_name().to_string_lossy()
                    ));
                }
            }
        }
    }
    let mut tex: Vec<_> = paths
        .iter()
        .filter(|p| {
            matches!(
                Path::new(p).extension().and_then(|s| s.to_str()),
                Some("tex" | "ltx")
            )
        })
        .cloned()
        .collect();
    tex.sort_by_key(|p| {
        (
            match p.as_str() {
                "main.tex" => 0,
                "document.tex" => 1,
                _ => 2,
            },
            p.clone(),
        )
    });
    let stems: Vec<_> = tex
        .iter()
        .filter_map(|p| Path::new(p).file_stem())
        .collect();
    let mut pdfs = Vec::new();
    for path in paths
        .into_iter()
        .filter(|p| p.to_lowercase().ends_with(".pdf"))
    {
        let Ok(file) = projects::resolve(root, &path) else {
            continue;
        };
        let Ok(meta) = fs::metadata(file) else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        let modified = meta.modified().unwrap_or(UNIX_EPOCH);
        let rank = if path.starts_with(".prism/build/") {
            0
        } else if Path::new(&path)
            .file_stem()
            .is_some_and(|s| stems.contains(&s))
        {
            1
        } else if !path.contains('/') {
            2
        } else {
            3
        };
        let token = format!("{}:{modified:?}", meta.len());
        pdfs.push((rank, std::cmp::Reverse(modified), path, token));
    }
    pdfs.sort();
    let created_at = fs::metadata(root)
        .ok()
        .and_then(|m| m.created().or_else(|_| m.modified()).ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(
        json!({"createdAt":created_at,"pdfs":pdfs.into_iter().map(|(_,_,path,revision)| json!({"path":path,"revision":revision})).collect::<Vec<_>>(),"texFiles":tex}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovers_custom_names_build_outputs_and_pdf_only_projects() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".prism/build")).unwrap();
        for p in [
            "thesis.tex",
            "thesis.pdf",
            "reference.pdf",
            ".prism/build/thesis.pdf",
        ] {
            fs::write(d.path().join(p), b"content").unwrap();
        }
        let result = discover_paths(
            d.path(),
            vec![
                "thesis.tex".into(),
                "thesis.pdf".into(),
                "reference.pdf".into(),
            ],
        )
        .unwrap();
        assert_eq!(result["pdfs"][0]["path"], ".prism/build/thesis.pdf");
        assert_eq!(result["pdfs"][1]["path"], "thesis.pdf");
        assert_eq!(result["texFiles"][0], "thesis.tex");
        let token = result["pdfs"][0]["revision"].clone();
        fs::write(
            d.path().join(".prism/build/thesis.pdf"),
            b"changed contents",
        )
        .unwrap();
        assert_ne!(
            discover_paths(d.path(), vec![]).unwrap()["pdfs"][0]["revision"],
            token
        );
        fs::remove_dir_all(d.path().join(".prism")).unwrap();
        assert_eq!(
            discover_paths(d.path(), vec!["reference.pdf".into()]).unwrap()["pdfs"][0]["path"],
            "reference.pdf"
        );
    }
    #[cfg(unix)]
    #[test]
    fn ignores_symlinked_pdfs_and_build_directories() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.pdf"), b"secret").unwrap();
        fs::create_dir(d.path().join(".prism")).unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join(".prism/build")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.pdf"), d.path().join("link.pdf"))
            .unwrap();
        assert_eq!(
            discover_paths(d.path(), vec!["link.pdf".into()]).unwrap()["pdfs"],
            json!([])
        );
    }
}

// Disposable, versioned card images; never stored inside a writing project.
pub(crate) fn cache(
    app: &Backend,
    project: &str,
    operation: &str,
    args: Value,
) -> Result<Value, String> {
    let directory = app.inner.config.data_dir.join("project-thumbnails");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let root = args["root"].as_str().ok_or("Missing project path")?;
    let key = projects::revision(format!("thumbnail-v1-420:{root}").as_bytes());
    let file = directory.join(format!("{key}.json"));
    if operation == "thumbnail_cache_get" {
        return Ok(fs::metadata(&file)
            .ok()
            .filter(|m| m.len() <= 24 * 1024 * 1024)
            .and_then(|_| fs::read(&file).ok())
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .filter(|v| {
                v["version"] == 1
                    && v["bytes"].as_array().is_some_and(|a| {
                        a.iter()
                            .take(8)
                            .filter_map(Value::as_u64)
                            .collect::<Vec<_>>()
                            == vec![137, 80, 78, 71, 13, 10, 26, 10]
                    })
            })
            .unwrap_or(Value::Null));
    }
    if operation == "thumbnail_cache_delete" {
        let _ = fs::remove_file(file);
        return Ok(Value::Null);
    }
    if operation != "thumbnail_cache_put" {
        return Err("Unknown thumbnail operation".into());
    }
    let manifest = discover(app, project)?;
    if manifest["pdfs"] != args["candidates"] {
        return Err("Preview selection changed".into());
    }
    let candidate = args["pdf"].as_str().ok_or("Missing PDF")?;
    let revision = args["revision"].as_str().ok_or("Missing revision")?;
    if !manifest["pdfs"].as_array().is_some_and(|pdfs| {
        pdfs.iter()
            .any(|p| p["path"] == candidate && p["revision"] == revision)
    }) {
        return Err("PDF changed while rendering preview".into());
    }
    let bytes = args["bytes"].as_array().ok_or("Missing PNG")?;
    if bytes.len() > 16 * 1024 * 1024
        || bytes
            .iter()
            .take(8)
            .filter_map(Value::as_u64)
            .collect::<Vec<_>>()
            != vec![137, 80, 78, 71, 13, 10, 26, 10]
    {
        return Err("Invalid thumbnail".into());
    }
    let entry = json!({"version":1,"projectId":project,"pdf":candidate,"revision":revision,"bytes":bytes,"createdAt":manifest["createdAt"]});
    let encoded = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
    if encoded.len() > 24 * 1024 * 1024 {
        return Err("Thumbnail exceeds cache entry limit".into());
    }
    projects::atomic_bytes(&file, &encoded)?;
    let mut entries: Vec<_> = fs::read_dir(&directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|e| e == "json"))
        .filter_map(|e| {
            e.metadata()
                .ok()
                .map(|m| (m.modified().unwrap_or(UNIX_EPOCH), m.len(), e.path()))
        })
        .collect();
    entries.sort();
    let mut size: u64 = entries.iter().map(|e| e.1).sum();
    let mut count = entries.len();
    for (_, bytes, path) in entries {
        if size <= 128 * 1024 * 1024 && count <= 1000 {
            break;
        }
        if fs::remove_file(path).is_ok() {
            size -= bytes;
            count -= 1;
        }
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    #[test]
    fn cache_survives_restart_and_rejects_changed_source() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::BackendConfig {
            data_dir: temp.path().join("data"),
            home_dir: temp.path().join("home"),
            temp_dir: temp.path().join("tmp"),
        };
        let root = temp.path().join("paper with spaces");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main.pdf"), b"pdf").unwrap();
        let app = Backend::new(config.clone(), std::sync::Arc::new(crate::NoopEventSink)).unwrap();
        let p = projects::project_register(app.clone(), root.to_string_lossy().into()).unwrap();
        let m = discover(&app, &p.id).unwrap();
        let args = json!({"root":root,"pdf":"main.pdf","revision":m["pdfs"][0]["revision"],"candidates":m["pdfs"],"bytes":[137,80,78,71,13,10,26,10]});
        cache(&app, &p.id, "thumbnail_cache_put", args.clone()).unwrap();
        let reopened = Backend::new(config, std::sync::Arc::new(crate::NoopEventSink)).unwrap();
        assert_eq!(
            cache(&reopened, "", "thumbnail_cache_get", json!({"root":root})).unwrap()["pdf"],
            "main.pdf"
        );
        fs::write(root.join("main.pdf"), b"changed pdf").unwrap();
        assert!(cache(&reopened, &p.id, "thumbnail_cache_put", args).is_err());
        cache(
            &reopened,
            "",
            "thumbnail_cache_delete",
            json!({"root":root}),
        )
        .unwrap();
        assert!(
            cache(&reopened, "", "thumbnail_cache_get", json!({"root":root}))
                .unwrap()
                .is_null()
        );
    }
}
