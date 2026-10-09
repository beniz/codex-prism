//! Compact, backwards-compatible review persistence. Publish blobs before the
//! manifest so a crash always leaves the previous manifest readable.
use crate::{codex::Review, projects};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredReview {
    format_version: u8,
    project_id: String,
    active: bool,
    before: BTreeMap<String, String>,
    after: BTreeMap<String, String>,
    previous: Option<Box<StoredReview>>,
}

fn encode(review: &Review, dir: &Path) -> Result<StoredReview, String> {
    let store = |files: &BTreeMap<String, Vec<u8>>| -> Result<BTreeMap<String, String>, String> {
        files
            .iter()
            .map(|(name, bytes)| {
                let hash = projects::revision(bytes);
                let dest = dir.join(&hash);
                if !dest.exists() {
                    let temp = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
                    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
                    fs::rename(temp, dest).map_err(|e| e.to_string())?;
                }
                Ok((name.clone(), hash))
            })
            .collect()
    };
    Ok(StoredReview {
        format_version: 1,
        project_id: review.project_id.clone(),
        active: review.active,
        before: store(&review.before)?,
        after: store(&review.after)?,
        previous: review
            .previous
            .as_ref()
            .map(|r| encode(r, dir).map(Box::new))
            .transpose()?,
    })
}

fn decode(review: StoredReview, dir: &Path) -> Result<Review, String> {
    if review.format_version != 1 {
        return Err("Unsupported review format".into());
    }
    let read = |files: BTreeMap<String, String>| -> Result<BTreeMap<String, Vec<u8>>, String> {
        files
            .into_iter()
            .map(|(name, hash)| {
                if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("Invalid review blob identifier".into());
                }
                let bytes = fs::read(dir.join(&hash))
                    .map_err(|e| format!("Cannot read review blob: {e}"))?;
                if projects::revision(&bytes) != hash {
                    return Err("Corrupt review blob".into());
                }
                Ok((name, bytes))
            })
            .collect()
    };
    Ok(Review {
        project_id: review.project_id,
        active: review.active,
        before: read(review.before)?,
        after: read(review.after)?,
        previous: review
            .previous
            .map(|r| decode(*r, dir).map(Box::new))
            .transpose()?,
    })
}

pub(crate) fn load(path: &Path) -> Result<Review, String> {
    load_inner(path, false)
}

pub(crate) fn display(path: &Path) -> Result<Review, String> {
    load_inner(path, true)
}

fn load_inner(path: &Path, display: bool) -> Result<Review, String> {
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if display && value.get("active").and_then(|v| v.as_bool()) == Some(true) {
        return Ok(Review {
            active: true,
            ..Default::default()
        });
    }
    if value.get("formatVersion").is_some() {
        decode(
            serde_json::from_value(value).map_err(|e| e.to_string())?,
            &path.with_extension("blobs"),
        )
    } else {
        serde_json::from_value(value).map_err(|e| e.to_string())
    }
}

pub(crate) fn save(path: &Path, review: &Review) -> Result<(), String> {
    let dir = path.with_extension("blobs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stored = encode(review, &dir)?;
    projects::save_json(path, &stored)?;
    fn collect(review: &StoredReview, used: &mut std::collections::HashSet<String>) {
        used.extend(review.before.values().chain(review.after.values()).cloned());
        if let Some(previous) = &review.previous {
            collect(previous, used);
        }
    }
    let mut used = std::collections::HashSet::new();
    collect(&stored, &mut used);
    // Callers serialize readers and writers with the project lock. Prune only
    // after the new manifest is published, including references from rollback.
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if !used.contains(&entry.file_name().to_string_lossy().to_string()) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

pub(crate) fn confirm_start(path: &Path) -> Result<(), String> {
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if value["active"] == true && value.get("previous").is_some_and(|v| !v.is_null()) {
        value["previous"] = serde_json::Value::Null;
        projects::save_json(path, &value)?;
    }
    Ok(())
}

pub(crate) fn remove(path: &Path) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| e.to_string())?;
    // The manifest owns the lock. Orphan blobs are harmless and may remain if
    // cleanup fails; never let cleanup failure resurrect an accepted review.
    let _ = fs::remove_dir_all(path.with_extension("blobs"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_snapshots_are_deduplicated_and_roundtrip_without_json_expansion() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("review.json");
        let bytes = vec![255; 1024 * 1024];
        let review = Review {
            before: BTreeMap::from([("figure.png".into(), bytes.clone())]),
            after: BTreeMap::from([("figure.png".into(), bytes.clone())]),
            ..Default::default()
        };
        save(&path, &review).unwrap();
        assert!(fs::metadata(&path).unwrap().len() < 1024);
        assert_eq!(
            fs::read_dir(path.with_extension("blobs")).unwrap().count(),
            1
        );
        let loaded = load(&path).unwrap();
        assert_eq!(loaded.before, review.before);
        assert_eq!(loaded.after, review.after);
        remove(&path).unwrap();
        assert!(!path.with_extension("blobs").exists());
    }

    #[test]
    fn legacy_review_and_rollback_survive_conversion_and_pruning() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("review.json");
        let previous = Review {
            before: BTreeMap::from([("a.tex".into(), b"original".to_vec())]),
            ..Default::default()
        };
        let mut review = Review {
            active: true,
            before: BTreeMap::from([("a.tex".into(), b"edited".to_vec())]),
            previous: Some(Box::new(previous)),
            ..Default::default()
        };
        projects::save_json(&path, &review).unwrap();
        let legacy = load(&path).unwrap();
        save(&path, &legacy).unwrap();
        assert_eq!(
            load(&path).unwrap().previous.unwrap().before["a.tex"],
            b"original"
        );
        assert!(display(&path).unwrap().before.is_empty());
        assert!(display(&path).unwrap().active);
        review.previous = None;
        save(&path, &review).unwrap();
        assert_eq!(
            fs::read_dir(path.with_extension("blobs")).unwrap().count(),
            1
        );
        fs::write(
            path.with_extension("blobs")
                .join(projects::revision(b"edited")),
            b"corrupt",
        )
        .unwrap();
        assert!(load(&path).is_err());
        assert!(path.exists()); // Failure must keep the project locked.
    }
}
