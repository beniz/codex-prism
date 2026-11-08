//! Conservative pass elision. Missing evidence always means a normal full build.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct Record {
    version: u32,
    main: String,
    engine: String,
    sources: BTreeMap<String, String>,
    dependencies: BTreeMap<String, String>,
    state: BTreeMap<String, String>,
}
fn hash(path: &Path) -> Option<String> {
    Some(crate::projects::revision(&fs::read(path).ok()?))
}
fn sources(work: &Path) -> Option<BTreeMap<String, String>> {
    Some(
        crate::projects::isolated_snapshot(work)
            .ok()?
            .into_iter()
            .map(|(p, b)| (p, crate::projects::revision(&b)))
            .collect(),
    )
}
fn state(work: &Path, stem: &str) -> Option<BTreeMap<String, String>> {
    let recorder = fs::read_to_string(work.join(format!("{stem}.fls"))).ok()?;
    let mut result = BTreeMap::new();
    for output in recorder.lines().filter_map(|l| l.strip_prefix("OUTPUT ")) {
        let path = Path::new(output);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            work.join(path)
        };
        let relative = path.strip_prefix(work).ok()?.to_string_lossy().into_owned();
        let ext = path.extension()?.to_str()?;
        if matches!(ext, "pdf" | "log" | "fls") || relative.ends_with(".synctex.gz") {
            continue;
        }
        if !matches!(
            ext,
            "aux" | "toc" | "lof" | "lot" | "out" | "nav" | "snm" | "vrb" | "bcf"
        ) && !relative.ends_with(".run.xml")
        {
            return None;
        }
        result.insert(relative, hash(&path)?);
    }
    if !result.keys().any(|p| p.ends_with(".aux")) {
        return None;
    }
    // Bibliography output is not necessarily listed as an engine output.
    let bbl = work.join(format!("{stem}.bbl"));
    if bbl.exists() {
        result.insert(format!("{stem}.bbl"), hash(&bbl)?);
    }
    Some(result)
}
fn dependencies(work: &Path, stem: &str) -> Option<BTreeMap<String, String>> {
    let recorder = fs::read_to_string(work.join(format!("{stem}.fls"))).ok()?;
    let mut result = BTreeMap::new();
    for input in recorder.lines().filter_map(|l| l.strip_prefix("INPUT ")) {
        let path = Path::new(input);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            work.join(path)
        };
        let path = fs::canonicalize(path).ok()?;
        result.insert(path.to_string_lossy().into_owned(), hash(&path)?);
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}
pub(super) fn settled(work: &Path, stem: &str) -> bool {
    let Ok(log) = fs::read_to_string(work.join(format!("{stem}.log"))) else {
        return false;
    };
    let lower = log.to_lowercase();
    ![
        "rerun to",
        "please rerun",
        "please re-run",
        "undefined",
        "please (re)run",
        "shell escape",
        "runsystem(",
    ]
    .iter()
    .any(|s| lower.contains(s))
}
fn record_path(work: &Path) -> PathBuf {
    work.join(".prism-incremental.json")
}

pub(super) struct Candidate {
    previous: Record,
}
pub(super) fn begin(work: &Path, main: &str, engine: &Path) -> Option<Candidate> {
    let path = record_path(work);
    let bytes = fs::read(&path).ok();
    // A failed or interrupted attempt must not leave reusable metadata.
    let _ = fs::remove_file(path);
    let previous: Record = serde_json::from_slice(&bytes?).ok()?;
    if previous.version != 2 || previous.main != main || previous.engine != hash(engine)? {
        return None;
    }
    let now = sources(work)?;
    if now.keys().ne(previous.sources.keys()) {
        return None;
    }
    for (p, h) in &now {
        if previous.sources.get(p) != Some(h) && !p.ends_with(".tex") {
            return None;
        }
    }
    for (p, h) in &previous.dependencies {
        let path = Path::new(p);
        if hash(path).as_ref() != Some(h) {
            let relative = path.strip_prefix(fs::canonicalize(work).ok()?).ok()?;
            if relative.extension()?.to_str()? != "tex" {
                return None;
            }
        }
    }
    Some(Candidate { previous })
}
impl Candidate {
    pub(super) fn can_finish(&self, work: &Path, stem: &str) -> bool {
        settled(work, stem) && state(work, stem).as_ref() == Some(&self.previous.state)
    }
}
pub(super) fn save(work: &Path, main: &str, stem: &str, engine: &Path) -> Option<()> {
    if !settled(work, stem) {
        return None;
    }
    let record = Record {
        version: 2,
        main: main.into(),
        engine: hash(engine)?,
        sources: sources(work)?,
        dependencies: dependencies(work, stem)?,
        state: state(work, stem)?,
    };
    fs::write(record_path(work), serde_json::to_vec(&record).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_evidence_never_shortens_build() {
        let dir = tempfile::tempdir().unwrap();
        assert!(begin(dir.path(), "main.tex", Path::new("missing-engine")).is_none());
        assert!(state(dir.path(), "main").is_none());
        assert!(!settled(dir.path(), "main"));
    }
    #[test]
    fn wording_edit_can_finish_but_auxiliary_changes_cannot() {
        let dir = tempfile::tempdir().unwrap();
        let work = fs::canonicalize(dir.path()).unwrap();
        let engine = work.join("engine");
        fs::write(&engine, "test-engine").unwrap();
        fs::write(work.join("main.tex"), "Old wording").unwrap();
        fs::write(work.join("main.aux"), "stable references").unwrap();
        fs::write(work.join("main.log"), "Output written").unwrap();
        fs::write(
            work.join("main.fls"),
            "INPUT main.tex\nINPUT main.aux\nOUTPUT main.aux\nOUTPUT main.log\nOUTPUT main.pdf\n",
        )
        .unwrap();
        assert!(save(&work, "main.tex", "main", &engine).is_some());
        fs::write(work.join("main.tex"), "New wording").unwrap();
        let candidate = begin(&work, "main.tex", &engine).unwrap();
        assert!(candidate.can_finish(&work, "main"));
        assert!(!record_path(&work).exists());
        fs::write(work.join("main.aux"), "changed references").unwrap();
        assert!(!candidate.can_finish(&work, "main"));
    }
    #[test]
    fn incomplete_bibliography_build_cannot_seed_incremental_state() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.log"), "Output written").unwrap();
        fs::write(dir.path().join("main.bbl"), "bibliography").unwrap();
        assert!(save(dir.path(), "main.tex", "main", Path::new("engine")).is_none());
    }
    #[test]
    fn warnings_and_unknown_outputs_block_reuse() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.log"), "Please rerun LaTeX").unwrap();
        assert!(!settled(dir.path(), "main"));
        fs::write(dir.path().join("main.fls"), "OUTPUT custom.xyz\n").unwrap();
        assert!(state(dir.path(), "main").is_none());
    }
}
