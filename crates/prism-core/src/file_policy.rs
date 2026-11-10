//! Shared classifications, with explicit policies for each document operation.
//! PDFs require context: history retains tracked/referenced figures, isolation
//! omits paired TeX output, and templates/the navigator retain PDF assets.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Rules {
    application_directories: Vec<String>,
    environment_directories: Vec<String>,
    auxiliary_suffixes: Vec<String>,
    navigator_binary_suffixes: Vec<String>,
}
fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str(include_str!("file-rules.json"))
            .unwrap_or_else(|e| panic!("Invalid embedded file classifications: {e}"))
    })
}
fn application(name: &str) -> bool {
    rules().application_directories.iter().any(|n| n == name)
}
fn environment(name: &str) -> bool {
    rules().environment_directories.iter().any(|n| n == name)
}
fn environment_file(name: &str) -> bool {
    name == ".env" || name.starts_with(".env.")
}
fn suffix(name: &str, suffixes: &[String]) -> bool {
    let lower = name.to_ascii_lowercase();
    suffixes.iter().any(|suffix| lower.ends_with(suffix))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Policy {
    LegacySnapshot,
    IsolatedSnapshot,
    Template,
    Navigator,
    History,
}
impl Policy {
    /// Names intentionally ignored before symlink checks. Do not generalize this:
    /// an isolated workspace must still reject unsupported source symlinks.
    pub(crate) fn excludes_reserved_entry(self, name: &str) -> bool {
        match self {
            Self::IsolatedSnapshot => {
                application(name) || name == ".venv" || environment_file(name)
            }
            Self::Template => application(name) || environment(name) || self.excludes_file(name),
            _ => false,
        }
    }
    pub(crate) fn excludes_directory(self, name: &str) -> bool {
        application(name)
            || environment(name)
            || (matches!(self, Self::LegacySnapshot | Self::Navigator) && name.starts_with('.'))
    }
    pub(crate) fn excludes_file(self, name: &str) -> bool {
        suffix(name, &rules().auxiliary_suffixes)
            || match self {
                Self::History => {
                    environment_file(name) || name.to_ascii_lowercase().ends_with(".pdf")
                }
                Self::IsolatedSnapshot => environment_file(name),
                Self::Navigator => suffix(name, &rules().navigator_binary_suffixes),
                Self::LegacySnapshot | Self::Template => false,
            }
    }
    /// Inputs are project-relative, but accept either separator for Windows callers.
    pub(crate) fn excludes_path(self, path: &str) -> bool {
        let parts: Vec<_> = path.split(['/', '\\']).collect();
        parts.iter().any(|p| application(p) || environment(p))
            || parts
                .iter()
                .take(parts.len().saturating_sub(1))
                .any(|p| self.excludes_directory(p))
            || parts.last().is_some_and(|name| self.excludes_file(name))
    }
}

/// Explicit file sources may be PDFs, logs or other raw data. Only reject
/// metadata/environment components; snapshot and navigator suffix rules do not
/// apply. Callers separately validate that the path stays inside the project.
pub(crate) fn data_source_reserved_path(path: &str) -> bool {
    path.split('/')
        .any(|part| application(part) || environment(part) || environment_file(part))
}

/// Preserve the hard exclusions used when reading tracked history and replaying
/// durable patches. `.venv` and `env` were not hard exclusions in older history:
/// exclude new files there, but do not silently drop existing tracked inputs.
pub(crate) fn history_protected_path(path: &str) -> bool {
    path.split(['/', '\\'])
        .any(|part| application(part) || (environment(part) && !matches!(part, ".venv" | "env")))
}

pub(crate) fn application_directories() -> impl Iterator<Item = &'static str> {
    rules()
        .application_directories
        .iter()
        .map(String::as_str)
        .filter(|n| *n != ".git")
}

/// Only for a newly initialized document repository. Never rewrite existing rules.
pub(crate) fn initial_gitignore() -> String {
    let mut lines = vec![String::new(), "# codex-prism".into()];
    lines.extend(application_directories().map(|n| format!("{n}/")));
    lines.extend(
        rules()
            .environment_directories
            .iter()
            .map(|n| format!("{n}/")),
    );
    lines.push("*.pdf".into());
    lines.extend(rules().auxiliary_suffixes.iter().map(|n| format!("*{n}")));
    // Preserve the historical broader Git patterns, without broadening snapshots.
    lines.extend(["*.synctex*".into(), ".env*".into(), String::new()]);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policies_share_auxiliaries_but_preserve_contextual_inputs() {
        for policy in [
            Policy::LegacySnapshot,
            Policy::IsolatedSnapshot,
            Policy::Template,
            Policy::Navigator,
            Policy::History,
        ] {
            for name in [
                "slides.NAV",
                "slides.snm",
                "slides.vrb",
                "main.SYNCTEX.GZ",
                "main.run.xml",
                "main.bcf",
            ] {
                assert!(policy.excludes_file(name), "{policy:?}: {name}");
            }
            for name in [
                "refs.bib",
                "custom.bst",
                "class.cls",
                "AGENTS.md",
                "data.csv",
                "figure.svg",
                "main.tex",
                "notes.log.tex",
            ] {
                assert!(!policy.excludes_file(name), "{policy:?}: {name}");
            }
            assert!(policy.excludes_path("nested\\.venv\\module.py"));
            assert!(policy.excludes_path("nested/.prism/build/main.tex"));
        }
        assert!(history_protected_path("nested\\.git\\config"));
        assert!(!history_protected_path(".venv/tracked.txt"));
        assert!(!history_protected_path("env/tracked.txt"));
        assert!(Policy::History.excludes_file("plot.pdf")); // Caller retains tracked/referenced figures.
        for policy in [
            Policy::Template,
            Policy::Navigator,
            Policy::IsolatedSnapshot,
            Policy::LegacySnapshot,
        ] {
            assert!(!policy.excludes_file("plot.pdf"));
        }
        assert!(Policy::Navigator.excludes_file("lib.so"));
        assert!(!Policy::IsolatedSnapshot.excludes_file("lib.so")); // May be a required input.
        assert!(!Policy::Template.excludes_directory(".agents"));
        assert!(!Policy::IsolatedSnapshot.excludes_directory(".agents"));
        assert!(Policy::LegacySnapshot.excludes_directory(".agents"));
        assert!(Policy::Navigator.excludes_directory(".agents"));
        assert!(Policy::IsolatedSnapshot.excludes_file(".env.local"));
        assert!(!Policy::LegacySnapshot.excludes_file(".env.local"));
        assert!(!Policy::Template.excludes_file(".env.local"));
    }
}
