//! Bibliography reuse is opt-in evidence: any unsupported control or resolution
//! failure returns None and leaves the ordinary bibliography invocation intact.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Signature {
    version: u32,
    tool: String,
    controls: BTreeMap<String, String>,
    inputs: BTreeMap<String, String>,
    output: Option<String>,
}
impl Signature {
    pub(super) fn reusable(&self) -> bool {
        self.output.is_some()
    }
    pub(super) fn same_inputs(&self, other: &Self) -> bool {
        self.version == other.version
            && self.tool == other.tool
            && self.controls == other.controls
            && self.inputs == other.inputs
    }
}
fn hash(p: &Path) -> Option<String> {
    Some(crate::projects::revision(&fs::read(p).ok()?))
}
pub(super) fn take(work: &Path, stem: &str) -> Option<Signature> {
    let path = work.join(format!(".prism-bibliography-{stem}.json"));
    let bytes = fs::read(&path).ok();
    let _ = fs::remove_file(path);
    serde_json::from_slice(&bytes?).ok()
}
pub(super) fn save(work: &Path, stem: &str, signature: &Signature) {
    if let Ok(bytes) = serde_json::to_vec(signature) {
        let _ = fs::write(work.join(format!(".prism-bibliography-{stem}.json")), bytes);
    }
}
pub(super) fn capture(
    work: &Path,
    stem: &str,
    tool: &Path,
    biber: bool,
    mut resolve: impl FnMut(&str) -> Option<std::path::PathBuf>,
) -> Option<Signature> {
    let mut controls = BTreeMap::new();
    let mut names = BTreeSet::new();
    if biber {
        // Custom configuration can add dependencies not declared in the BCF.
        for base in [
            Some(work.to_path_buf()),
            std::env::var_os("HOME").map(Into::into),
            std::env::var_os("XDG_CONFIG_HOME").map(Into::into),
            std::env::var_os("APPDATA").map(Into::into),
        ]
        .into_iter()
        .flatten()
        {
            for name in [
                "biber.conf",
                ".biber.conf",
                "biber/biber.conf",
                ".config/biber/biber.conf",
                "Library/biber/biber.conf",
            ] {
                if base.join(name).exists() {
                    return None;
                }
            }
        }
        if resolve("biber.conf").is_some() {
            return None;
        }
        let path = work.join(format!("{stem}.bcf"));
        let content = fs::read_to_string(&path).ok()?;
        controls.insert(format!("{stem}.bcf"), hash(&path)?);
        // Accept only the ordinary local BibTeX datasource form. XML entities,
        // globs, URLs, other formats and unfamiliar syntax conservatively miss.
        for line in content.lines().filter(|l| l.contains("<bcf:datasource")) {
            let line = line.trim();
            let name = line
                .strip_prefix("<bcf:datasource type=\"file\" datatype=\"bibtex\" glob=\"false\">")?
                .strip_suffix("</bcf:datasource>")?;
            if name.contains(['&', '<', '>', ':', '*', '?']) || name.is_empty() {
                return None;
            }
            names.insert(name.to_owned());
        }
    } else {
        let mut pending = vec![format!("{stem}.aux")];
        while let Some(name) = pending.pop() {
            if controls.contains_key(&name) {
                continue;
            }
            let path = crate::projects::resolve(work, &name).ok()?;
            let text = fs::read_to_string(&path).ok()?;
            controls.insert(name, hash(&path)?);
            for line in text.lines() {
                let line = line.trim();
                for (prefix, extension) in [
                    ("\\bibdata{", "bib"),
                    ("\\bibstyle{", "bst"),
                    ("\\@input{", "aux"),
                ] {
                    if let Some(value) = line.strip_prefix(prefix) {
                        let value = value.strip_suffix('}')?;
                        for item in value.split(',') {
                            if item.is_empty() || item.contains(['{', '}', '\\']) {
                                return None;
                            }
                            let item = if item.ends_with(&format!(".{extension}")) {
                                item.to_owned()
                            } else {
                                format!("{item}.{extension}")
                            };
                            if extension == "aux" {
                                pending.push(item);
                            } else {
                                names.insert(item);
                            }
                        }
                    }
                }
            }
        }
    }
    if names.is_empty() {
        return None;
    }
    let mut inputs = BTreeMap::new();
    for name in names {
        if name.starts_with('-') {
            return None;
        }
        let path = fs::canonicalize(resolve(&name)?).ok()?;
        inputs.insert(path.to_string_lossy().into_owned(), hash(&path)?);
    }
    Some(Signature {
        version: 1,
        tool: format!("{}:{}", tool.display(), hash(tool)?),
        controls,
        inputs,
        output: hash(&work.join(format!("{stem}.bbl"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_citations_style_database_and_output_are_all_part_of_identity() {
        let dir = tempfile::tempdir().unwrap();
        let w = dir.path();
        for (name, value) in [
            ("tool", "binary"),
            ("main.aux", "\\@input{part.aux}"),
            (
                "part.aux",
                "\\citation{one}\n\\bibdata{refs}\n\\bibstyle{plain}",
            ),
            ("refs.bib", "database"),
            ("plain.bst", "style"),
            ("main.bbl", "output"),
        ] {
            fs::write(w.join(name), value).unwrap();
        }
        let capture_now =
            || capture(w, "main", &w.join("tool"), false, |name| Some(w.join(name))).unwrap();
        let baseline = capture_now();
        for name in ["part.aux", "refs.bib", "plain.bst", "main.bbl", "tool"] {
            let old = fs::read(w.join(name)).unwrap();
            let mut changed = old.clone();
            changed.extend_from_slice(b"\nchanged");
            fs::write(w.join(name), changed).unwrap();
            assert_ne!(baseline, capture_now(), "{name}");
            fs::write(w.join(name), old).unwrap();
        }
        save(w, "main", &baseline);
        assert_eq!(take(w, "main"), Some(baseline));
        assert!(take(w, "main").is_none());
        fs::remove_file(w.join("refs.bib")).unwrap();
        assert!(capture(w, "main", &w.join("tool"), false, |n| Some(w.join(n))).is_none());
    }
    #[test]
    fn unknown_biber_sources_and_configuration_disable_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let w = dir.path();
        fs::write(w.join("main.bcf"), "<bcf:datasource type=\"file\" datatype=\"bibtex\" glob=\"true\">*.bib</bcf:datasource>").unwrap();
        assert!(capture(w, "main", &w.join("tool"), true, |_| None).is_none());
        fs::write(w.join("biber.conf"), "custom").unwrap();
        assert!(capture(w, "main", &w.join("tool"), true, |_| None).is_none());
    }
}
