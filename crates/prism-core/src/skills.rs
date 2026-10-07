use crate::OperationContext;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

const TARBALL_URLS: &[&str] = &[
    "https://github.com/K-Dense-AI/scientific-agent-skills/archive/refs/heads/main.tar.gz",
    "https://codeload.github.com/K-Dense-AI/scientific-agent-skills/tar.gz/refs/heads/main",
    "https://github.com/K-Dense-AI/claude-scientific-skills/archive/refs/heads/main.tar.gz",
];
const SKILLS_DOWNLOAD_ATTEMPTS: usize = 3;
const SKILLS_DOWNLOAD_TIMEOUT_SECS: u64 = 240;
const SKILLS_CONNECT_TIMEOUT_SECS: u64 = 20;
const SKILLS_INSTALL_TIMEOUT_SECS: u64 = 420;
const SKILL_CONTENT_TIMEOUT_SECS: u64 = 45;
const RAW_SKILL_URLS: &[&str] = &[
    "https://raw.githubusercontent.com/K-Dense-AI/scientific-agent-skills/main/skills",
    "https://raw.githubusercontent.com/K-Dense-AI/claude-scientific-skills/main/scientific-skills",
];
const SKILLS_SUBFOLDERS: &[&str] = &["skills", "scientific-skills"];

// ─── Data Types ───

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub description: String,
    pub folder: String,
}

#[derive(Debug, Serialize)]
pub struct InstallResult {
    pub success: bool,
    pub skills_installed: usize,
    pub target_dir: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct SkillsStatus {
    pub installed: bool,
    pub skill_count: usize,
    pub location: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub folder: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SkillCategory {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub skill_count: usize,
    pub skills: Vec<SkillEntry>,
}

// ─── Skill Categories Data ───

/// Returns the known scientific skill categories with metadata.
fn skill_categories() -> Vec<SkillCategory> {
    fn s(name: &str, folder: &str) -> SkillEntry {
        SkillEntry {
            name: name.into(),
            folder: folder.into(),
        }
    }

    let mut cats = vec![
        SkillCategory {
            id: "bioinformatics".into(),
            name: "Bioinformatics & Genomics".into(),
            icon: "dna".into(),
            skill_count: 0,
            skills: vec![
                s("Scanpy (scRNA-seq)", "scanpy"),
                s("BioPython", "biopython"),
                s("PyDESeq2", "pydeseq2"),
                s("PySAM", "pysam"),
                s("gget", "gget"),
                s("scikit-bio", "scikit-bio"),
                s("DeepTools", "deeptools"),
                s("CELLxGENE Census", "cellxgene-census"),
                s("AnnData", "anndata"),
                s("GTARS", "gtars"),
                s("ETE Toolkit", "etetoolkit"),
                s("TileDB-VCF", "tiledbvcf"),
                s("FlowIO", "flowio"),
                s("GenIML", "geniml"),
                s("Ensembl Database", "ensembl-database"),
                s("Gene Database", "gene-database"),
            ],
        },
        SkillCategory {
            id: "cheminformatics".into(),
            name: "Cheminformatics & Drug Discovery".into(),
            icon: "flask-conical".into(),
            skill_count: 0,
            skills: vec![
                s("RDKit", "rdkit"),
                s("Datamol", "datamol"),
                s("MolFeat", "molfeat"),
                s("MedChem Filters", "medchem"),
                s("DeepChem", "deepchem"),
                s("PubChem Database", "pubchem-database"),
                s("ChEMBL Database", "chembl-database"),
                s("ZINC Database", "zinc-database"),
                s("TorchDrug", "torchdrug"),
                s("DiffDock", "diffdock"),
                s("Rowan", "rowan"),
            ],
        },
        SkillCategory {
            id: "clinical".into(),
            name: "Clinical Research".into(),
            icon: "heart-pulse".into(),
            skill_count: 0,
            skills: vec![
                s("ClinicalTrials.gov", "clinicaltrials-database"),
                s("ClinVar Database", "clinvar-database"),
                s("ClinPGx Database", "clinpgx-database"),
                s("Treatment Plans", "treatment-plans"),
                s("Clinical Reports", "clinical-reports"),
                s("Clinical Decision Support", "clinical-decision-support"),
                s("DrugBank Database", "drugbank-database"),
                s("FDA Database", "fda-database"),
                s("BRENDA Database", "brenda-database"),
                s("PyTDC", "pytdc"),
                s("ISO 13485 Certification", "iso-13485-certification"),
                s("COSMIC Database", "cosmic-database"),
            ],
        },
        SkillCategory {
            id: "data-analysis".into(),
            name: "Data Analysis & Visualization".into(),
            icon: "bar-chart-3".into(),
            skill_count: 0,
            skills: vec![
                s("Statistical Analysis", "statistical-analysis"),
                s("Exploratory Data Analysis", "exploratory-data-analysis"),
                s("Polars", "polars"),
                s("Dask", "dask"),
                s("Vaex", "vaex"),
                s("NetworkX", "networkx"),
                s("Seaborn", "seaborn"),
                s("Plotly", "plotly"),
                s("Matplotlib", "matplotlib"),
                s("Scientific Visualization", "scientific-visualization"),
                s("Zarr", "zarr-python"),
                s("Data Commons", "datacommons-client"),
                s("Aeon (Time Series ML)", "aeon"),
                s("TimesFM Forecasting", "timesfm-forecasting"),
            ],
        },
        SkillCategory {
            id: "ml-ai".into(),
            name: "Machine Learning & AI".into(),
            icon: "brain".into(),
            skill_count: 0,
            skills: vec![
                s("scikit-learn", "scikit-learn"),
                s("Transformers", "transformers"),
                s("PyTorch Lightning", "pytorch-lightning"),
                s("PyG (Graph Neural Nets)", "torch_geometric"),
                s("Stable Baselines3", "stable-baselines3"),
                s("PufferLib", "pufferlib"),
                s("SHAP", "shap"),
                s("UMAP", "umap-learn"),
                s("HypoGeniC", "hypogenic"),
                s("Hypothesis Generation", "hypothesis-generation"),
                s("Statsmodels", "statsmodels"),
                s("PyMC", "pymc"),
                s("PennyLane", "pennylane"),
                s("Qiskit", "qiskit"),
                s("Cirq", "cirq"),
            ],
        },
        SkillCategory {
            id: "scientific-communication".into(),
            name: "Scientific Communication".into(),
            icon: "book-open".into(),
            skill_count: 0,
            skills: vec![
                s("Scientific Writing", "scientific-writing"),
                s("Literature Review", "literature-review"),
                s("Peer Review", "peer-review"),
                s("Grant Writing", "research-grants"),
                s("Citation Management", "citation-management"),
                s("Scientific Slides", "scientific-slides"),
                s("LaTeX Posters", "latex-posters"),
                s("HTML/PPTX Posters", "pptx-posters"),
                s("Infographics", "infographics"),
                s("Scientific Schematics", "scientific-schematics"),
                s("Markdown & Mermaid", "markdown-mermaid-writing"),
                s("Scientific Brainstorming", "scientific-brainstorming"),
                s("Critical Thinking", "scientific-critical-thinking"),
                s("Scholar Evaluation", "scholar-evaluation"),
                s("Paper to Web", "paper-2-web"),
                s("Venue Templates", "venue-templates"),
                s("Market Research Reports", "market-research-reports"),
                s("Image Generation", "generate-image"),
                s("Open Notebook", "open-notebook"),
                s("MarkItDown", "markitdown"),
            ],
        },
        SkillCategory {
            id: "multi-omics".into(),
            name: "Multi-omics & Systems Biology".into(),
            icon: "microscope".into(),
            skill_count: 0,
            skills: vec![
                s("scvi-tools", "scvi-tools"),
                s("COBRApy", "cobrapy"),
                s("Bioservices", "bioservices"),
                s("Arboreto (GRN)", "arboreto"),
                s("Reactome Database", "reactome-database"),
            ],
        },
        SkillCategory {
            id: "engineering".into(),
            name: "Engineering & Simulation".into(),
            icon: "settings".into(),
            skill_count: 0,
            skills: vec![
                s("SimPy", "simpy"),
                s("pymoo", "pymoo"),
                s("FluidSim", "fluidsim"),
                s("MATLAB/Octave", "matlab"),
            ],
        },
        SkillCategory {
            id: "proteomics".into(),
            name: "Proteomics & Mass Spec".into(),
            icon: "atom".into(),
            skill_count: 0,
            skills: vec![
                s("PyOpenMS", "pyopenms"),
                s("matchms", "matchms"),
                s("ESM (Protein LM)", "esm"),
                s("PDB Database", "pdb-database"),
                s("UniProt Database", "uniprot-database"),
                s("HMDB Database", "hmdb-database"),
            ],
        },
        SkillCategory {
            id: "healthcare-ai".into(),
            name: "Healthcare AI & Clinical ML".into(),
            icon: "activity".into(),
            skill_count: 0,
            skills: vec![
                s("PyHealth", "pyhealth"),
                s("NeuroKit2", "neurokit2"),
                s("scikit-survival", "scikit-survival"),
                s("GWAS Catalog", "gwas-database"),
                s("OpenAlex Database", "openalex-database"),
                s("PubMed Database", "pubmed-database"),
                s("bioRxiv Database", "biorxiv-database"),
                s("GEO Database", "geo-database"),
            ],
        },
        SkillCategory {
            id: "medical-imaging".into(),
            name: "Medical Imaging".into(),
            icon: "scan".into(),
            skill_count: 0,
            skills: vec![
                s("pydicom", "pydicom"),
                s("HistoLab", "histolab"),
                s("PathML", "pathml"),
                s("Neuropixels Analysis", "neuropixels-analysis"),
                s("Imaging Data Commons", "imaging-data-commons"),
                s("GeoMaster", "geomaster"),
                s("GeoPandas", "geopandas"),
            ],
        },
        SkillCategory {
            id: "materials-science".into(),
            name: "Materials Science".into(),
            icon: "gem".into(),
            skill_count: 0,
            skills: vec![
                s("Pymatgen", "pymatgen"),
                s("QuTiP", "qutip"),
                s("SymPy", "sympy"),
                s("Astropy", "astropy"),
                s("Open Targets", "opentargets-database"),
            ],
        },
        SkillCategory {
            id: "physics-astronomy".into(),
            name: "Physics & Astronomy".into(),
            icon: "telescope".into(),
            skill_count: 0,
            skills: vec![
                s("Astropy", "astropy"),
                s("QuTiP", "qutip"),
                s("PennyLane", "pennylane"),
                s("SymPy", "sympy"),
            ],
        },
        SkillCategory {
            id: "lab-automation".into(),
            name: "Laboratory Automation".into(),
            icon: "pipette".into(),
            skill_count: 0,
            skills: vec![
                s("Opentrons", "opentrons-integration"),
                s("PyLabRobot", "pylabrobot"),
                s("Protocols.io", "protocolsio-integration"),
                s("LabArchive", "labarchive-integration"),
                s("Ginkgo Cloud Lab", "ginkgo-cloud-lab"),
            ],
        },
        SkillCategory {
            id: "protein-engineering".into(),
            name: "Protein Engineering".into(),
            icon: "helix".into(),
            skill_count: 0,
            skills: vec![
                s("AlphaFold Database", "alphafold-database"),
                s("ESM (Protein LM)", "esm"),
                s("DiffDock", "diffdock"),
                s("Adaptyv", "adaptyv"),
                s("STRING Database", "string-database"),
                s("LaminDB", "lamindb"),
            ],
        },
        SkillCategory {
            id: "research-methodology".into(),
            name: "Research Methodology".into(),
            icon: "lightbulb".into(),
            skill_count: 0,
            skills: vec![
                s("Hypothesis Generation", "hypothesis-generation"),
                s("Scientific Brainstorming", "scientific-brainstorming"),
                s("Critical Thinking", "scientific-critical-thinking"),
                s("Experimental Design", "hypothesis-generation"),
                s("Scholar Evaluation", "scholar-evaluation"),
                s("Peer Review", "peer-review"),
                s("Research Lookup", "research-lookup"),
                s("Denario", "denario"),
                s("bGPT Paper Search", "bgpt-paper-search"),
                s("Perplexity Search", "perplexity-search"),
            ],
        },
    ];

    for cat in &mut cats {
        cat.skill_count = cat.skills.len();
    }

    cats
}

// ─── Helpers ───

/// Resolve the target skills directory.
fn skills_dir(app: &crate::Backend, project_path: Option<&str>) -> PathBuf {
    match project_path {
        Some(p) => PathBuf::from(p).join(".agents").join("skills"),
        None => app
            .inner
            .config
            .home_dir
            .clone()
            .join(".agents")
            .join("skills"),
    }
}

fn sanitize_skill_folder_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn find_skill_md(skill_dir: &Path) -> Option<PathBuf> {
    for name in ["SKILL.md", "skill.md"] {
        let candidate = skill_dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let entries = std::fs::read_dir(skill_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
        {
            return Some(path);
        }
    }

    None
}

fn collect_skill_dirs(root: &Path, output: &mut Vec<PathBuf>) {
    if find_skill_md(root).is_some() {
        output.push(root.to_path_buf());
        return;
    }

    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        collect_skill_dirs(&entry.path(), output);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProxyKind {
    All,
    Http,
    Https,
}

struct ProxyRule {
    kind: ProxyKind,
    url: String,
    source: String,
}

fn first_env_value(names: &[&str]) -> Option<(String, String)> {
    for name in names {
        let Ok(value) = std::env::var(name) else {
            continue;
        };
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(((*name).to_string(), trimmed.to_string()));
        }
    }

    None
}

fn normalize_proxy_url(raw: &str) -> Option<String> {
    normalize_proxy_url_with_default(raw, "http")
}

fn normalize_proxy_url_with_default(raw: &str, default_scheme: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.contains("://") {
        Some(trimmed.to_string())
    } else {
        Some(format!("{}://{}", default_scheme, trimmed))
    }
}

fn explicit_env_proxy_rules() -> Vec<ProxyRule> {
    let mut rules = Vec::new();
    let mut has_https_proxy = false;
    let mut has_all_proxy = false;
    let mut http_proxy = None;

    if let Some((source, raw)) = first_env_value(&["HTTPS_PROXY", "https_proxy"]) {
        if let Some(url) = normalize_proxy_url(&raw) {
            rules.push(ProxyRule {
                kind: ProxyKind::Https,
                url,
                source,
            });
            has_https_proxy = true;
        }
    }

    if let Some((source, raw)) = first_env_value(&["HTTP_PROXY", "http_proxy"]) {
        if let Some(url) = normalize_proxy_url(&raw) {
            http_proxy = Some((source.clone(), url.clone()));
            rules.push(ProxyRule {
                kind: ProxyKind::Http,
                url,
                source,
            });
        }
    }

    if let Some((source, raw)) = first_env_value(&["ALL_PROXY", "all_proxy"]) {
        if let Some(url) = normalize_proxy_url(&raw) {
            rules.push(ProxyRule {
                kind: ProxyKind::All,
                url,
                source,
            });
            has_all_proxy = true;
        }
    }

    if !has_https_proxy && !has_all_proxy {
        if let Some((source, url)) = http_proxy {
            rules.insert(
                0,
                ProxyRule {
                    kind: ProxyKind::Https,
                    url,
                    source: format!("{} (HTTPS fallback)", source),
                },
            );
        }
    }

    rules
}

#[cfg(target_os = "windows")]
fn windows_proxy_override_to_no_proxy(raw: &str) -> Option<reqwest::NoProxy> {
    let entries = raw
        .split([';', ','])
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                return None;
            }

            if trimmed.eq_ignore_ascii_case("<local>") {
                return Some("localhost,127.0.0.1,::1".to_string());
            }

            if trimmed == "*" {
                return Some(trimmed.to_string());
            }

            if trimmed.contains('*') {
                return trimmed
                    .strip_prefix("*.")
                    .map(|domain| format!(".{}", domain.trim_start_matches('.')));
            }

            Some(trimmed.to_string())
        })
        .collect::<Vec<_>>();

    if entries.is_empty() {
        None
    } else {
        reqwest::NoProxy::from_string(&entries.join(","))
    }
}

#[cfg(target_os = "windows")]
fn windows_system_no_proxy() -> Option<reqwest::NoProxy> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let raw = settings.get_value::<String, _>("ProxyOverride").ok()?;
    windows_proxy_override_to_no_proxy(&raw)
}

#[cfg(target_os = "windows")]
fn parse_windows_proxy_server(raw: &str) -> Vec<ProxyRule> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    if !trimmed.contains('=') {
        return normalize_proxy_url(trimmed)
            .map(|url| {
                vec![ProxyRule {
                    kind: ProxyKind::All,
                    url,
                    source: "Windows system proxy".to_string(),
                }]
            })
            .unwrap_or_default();
    }

    let mut rules = Vec::new();
    for entry in trimmed.split(';') {
        let Some((scheme, value)) = entry.split_once('=') else {
            continue;
        };
        let scheme = scheme.trim();
        let (kind, default_proxy_scheme) = match scheme.to_ascii_lowercase().as_str() {
            "http" => (ProxyKind::Http, "http"),
            "https" => (ProxyKind::Https, "http"),
            "socks" | "socks5" => (ProxyKind::All, "socks5"),
            "socks4" => (ProxyKind::All, "socks4"),
            _ => continue,
        };
        let Some(url) = normalize_proxy_url_with_default(value, default_proxy_scheme) else {
            continue;
        };

        rules.push(ProxyRule {
            kind,
            url,
            source: format!("Windows system proxy ({})", scheme.trim()),
        });
    }

    rules
}

#[cfg(target_os = "windows")]
fn windows_system_proxy_rules() -> Vec<ProxyRule> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Ok(settings) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    else {
        return Vec::new();
    };

    let proxy_enabled = settings.get_value::<u32, _>("ProxyEnable").unwrap_or(0) != 0;
    if !proxy_enabled {
        return Vec::new();
    }

    settings
        .get_value::<String, _>("ProxyServer")
        .map(|raw| parse_windows_proxy_server(&raw))
        .unwrap_or_default()
}

#[cfg(not(target_os = "windows"))]
fn windows_system_proxy_rules() -> Vec<ProxyRule> {
    Vec::new()
}

#[cfg(not(target_os = "windows"))]
fn windows_system_no_proxy() -> Option<reqwest::NoProxy> {
    None
}

fn redacted_proxy_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return "<invalid proxy URL>".to_string();
    };

    if !parsed.username().is_empty() {
        let _ = parsed.set_username("***");
        if parsed.password().is_some() {
            let _ = parsed.set_password(Some("***"));
        }
    }

    parsed.to_string()
}

fn add_proxy_rule(
    builder: reqwest::ClientBuilder,
    rule: &ProxyRule,
    no_proxy: Option<reqwest::NoProxy>,
) -> Result<reqwest::ClientBuilder, String> {
    let proxy = match rule.kind {
        ProxyKind::All => reqwest::Proxy::all(&rule.url),
        ProxyKind::Http => reqwest::Proxy::http(&rule.url),
        ProxyKind::Https => reqwest::Proxy::https(&rule.url),
    }
    .map_err(|e| {
        format!(
            "Invalid proxy from {} ({}): {}",
            rule.source,
            redacted_proxy_url(&rule.url),
            e
        )
    })?;

    let proxy = proxy.no_proxy(no_proxy);
    Ok(builder.proxy(proxy))
}

fn configure_proxy_for_client(
    mut builder: reqwest::ClientBuilder,
    context: Option<&OperationContext>,
) -> Result<reqwest::ClientBuilder, String> {
    let mut rules = explicit_env_proxy_rules();
    let mut no_proxy = reqwest::NoProxy::from_env();

    if rules.is_empty() {
        let windows_rules = windows_system_proxy_rules();
        if !windows_rules.is_empty() {
            rules = windows_rules;
            no_proxy = windows_system_no_proxy();
        }
    }

    if rules.is_empty() {
        if let Some(context) = context {
            emit_log(context, "Using system proxy settings when available");
        }
        return Ok(builder);
    }

    if let Some(context) = context {
        for rule in &rules {
            emit_log(
                context,
                &format!(
                    "Using proxy from {}: {}",
                    rule.source,
                    redacted_proxy_url(&rule.url)
                ),
            );
        }
    }

    for rule in &rules {
        builder = add_proxy_rule(builder, rule, no_proxy.clone())?;
    }

    Ok(builder)
}

fn build_skills_http_client(
    timeout_secs: u64,
    context: Option<&OperationContext>,
) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(SKILLS_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(timeout_secs));

    configure_proxy_for_client(builder, context)?
        .build()
        .map_err(|e| format!("Failed to create download client: {}", e))
}

fn tarball_source_label(url: &str) -> &'static str {
    if url.contains("codeload.github.com") {
        "GitHub codeload"
    } else if url.contains("claude-scientific-skills") {
        "legacy GitHub archive"
    } else {
        "GitHub archive"
    }
}

fn reset_download_workspace(tmp_dir: &Path) {
    let _ = std::fs::remove_dir_all(tmp_dir.join("repo"));
    let _ = std::fs::remove_dir_all(tmp_dir.join("repo-raw"));
}

fn find_extracted_repo_dir(raw_dir: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    let entries = std::fs::read_dir(raw_dir).ok()?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            candidates.push(path);
        }
    }
    candidates.sort();

    for candidate in &candidates {
        if find_skills_source(candidate).is_some() {
            return Some(candidate.clone());
        }
    }

    candidates.into_iter().next()
}

fn unpack_tarball(bytes: &[u8], tmp_dir: &Path) -> Result<(), String> {
    reset_download_workspace(tmp_dir);

    let raw_dir = tmp_dir.join("repo-raw");
    std::fs::create_dir_all(&raw_dir)
        .map_err(|e| format!("Failed to create extraction dir: {}", e))?;

    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);

    archive
        .unpack(&raw_dir)
        .map_err(|e| format!("Failed to extract tarball: {}", e))?;

    let repo_source = find_extracted_repo_dir(&raw_dir)
        .ok_or_else(|| "Downloaded tarball did not contain a repository directory".to_string())?;

    std::fs::rename(&repo_source, tmp_dir.join("repo"))
        .map_err(|e| format!("Failed to prepare extracted repo: {}", e))?;

    let _ = std::fs::remove_dir_all(&raw_dir);
    Ok(())
}

async fn download_tarball_once(
    client: &reqwest::Client,
    context: &OperationContext,
    tmp_dir: &Path,
    url: &str,
) -> Result<(), String> {
    reset_download_workspace(tmp_dir);

    let source_label = tarball_source_label(url);
    emit_log(context, &format!("Downloading from {}...", source_label));

    let mut response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "codex-prism skills installer")
        .send()
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let total_size = response.content_length();
    let mut bytes =
        Vec::with_capacity(total_size.unwrap_or_default().min(64 * 1024 * 1024) as usize);
    let mut downloaded = 0_u64;
    let mut last_emitted_percent = 0_u64;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to read download bytes: {}", e))?
    {
        downloaded += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);

        if let Some(total) = total_size {
            if total > 0 {
                let percent = ((downloaded.saturating_mul(100)) / total).min(100);
                if percent >= last_emitted_percent + 5 || percent == 100 {
                    emit_log(context, &format!("Download progress {}%", percent));
                    last_emitted_percent = percent;
                }
            }
        } else if downloaded / (1024 * 1024) > last_emitted_percent {
            last_emitted_percent = downloaded / (1024 * 1024);
            emit_log(context, &format!("Downloaded {} MiB", last_emitted_percent));
        }
    }

    unpack_tarball(&bytes, tmp_dir)
}

/// Download and extract tarball.
async fn download_tarball(context: &OperationContext, tmp_dir: &Path) -> Result<(), String> {
    let client = build_skills_http_client(SKILLS_DOWNLOAD_TIMEOUT_SECS, Some(context))?;

    let mut last_error = None;
    for attempt in 1..=SKILLS_DOWNLOAD_ATTEMPTS {
        for url in TARBALL_URLS {
            let label = tarball_source_label(url);
            emit_log(
                context,
                &format!(
                    "Download attempt {}/{} ({})",
                    attempt, SKILLS_DOWNLOAD_ATTEMPTS, label
                ),
            );

            match download_tarball_once(&client, context, tmp_dir, url).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let message = format!("{} failed: {}", label, e);
                    emit_log(context, &message);
                    last_error = Some(message);
                    reset_download_workspace(tmp_dir);
                }
            }
        }

        if attempt < SKILLS_DOWNLOAD_ATTEMPTS {
            let delay_secs = attempt as u64 * 2;
            emit_log(context, &format!("Retrying in {} seconds...", delay_secs));
            tokio::time::sleep(Duration::from_secs(delay_secs)).await;
        }
    }

    Err(format!(
        "Failed to download skills after {} attempts. Last error: {}",
        SKILLS_DOWNLOAD_ATTEMPTS,
        last_error.unwrap_or_else(|| "unknown download error".to_string())
    ))
}

fn contains_skill_dirs(path: &Path) -> bool {
    let mut dirs = Vec::new();
    collect_skill_dirs(path, &mut dirs);
    !dirs.is_empty()
}

fn find_skills_source(repo_dir: &Path) -> Option<PathBuf> {
    for subfolder in SKILLS_SUBFOLDERS {
        let candidate = repo_dir.join(subfolder);
        if contains_skill_dirs(&candidate) {
            return Some(candidate);
        }
    }

    if contains_skill_dirs(repo_dir) {
        return Some(repo_dir.to_path_buf());
    }

    let entries = std::fs::read_dir(repo_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if candidate.is_dir() && contains_skill_dirs(&candidate) {
            return Some(candidate);
        }
    }

    None
}

fn skills_staging_dir(target_dir: &Path) -> PathBuf {
    let parent = target_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let target_name = target_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skills");

    parent.join(format!(
        ".{}-installing-{}",
        target_name,
        uuid::Uuid::new_v4().simple()
    ))
}

fn hidden_sibling_path(path: &Path, label: &str) -> PathBuf {
    let parent = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill");

    parent.join(format!(
        ".{}-{}-{}",
        name,
        label,
        uuid::Uuid::new_v4().simple()
    ))
}

fn replace_dir_from_staging(staged: &Path, target: &Path) -> Result<(), String> {
    let backup = hidden_sibling_path(target, "backup");
    let had_existing = target.exists();

    if had_existing {
        std::fs::rename(target, &backup).map_err(|e| {
            format!(
                "Failed to prepare replacement for {}: {}",
                target.display(),
                e
            )
        })?;
    }

    match std::fs::rename(staged, target) {
        Ok(()) => {
            if had_existing {
                let _ = std::fs::remove_dir_all(&backup);
            }
            Ok(())
        }
        Err(e) => {
            let restore_error = if had_existing {
                std::fs::rename(&backup, target)
                    .err()
                    .map(|restore| format!(" Restore also failed: {}", restore))
            } else {
                None
            };

            Err(format!(
                "Failed to install {}: {}{}",
                target.display(),
                e,
                restore_error.unwrap_or_default()
            ))
        }
    }
}

/// Copy the skills directory from the downloaded repo to the target.
fn copy_skills(repo_dir: &Path, target_dir: &Path) -> Result<usize, String> {
    let src = find_skills_source(repo_dir).ok_or_else(|| {
        format!(
            "skills directory not found in downloaded repo at {}",
            repo_dir.display()
        )
    })?;

    // Create target directory
    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create target dir: {}", e))?;

    let mut skill_dirs = Vec::new();
    collect_skill_dirs(&src, &mut skill_dirs);
    skill_dirs.sort();

    if skill_dirs.is_empty() {
        return Err("No skills found in downloaded repository".into());
    }

    let staging_dir = skills_staging_dir(target_dir);
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create staging dir: {}", e))?;

    let mut staged_names = Vec::new();
    let stage_result = (|| -> Result<(), String> {
        for entry_path in &skill_dirs {
            let Some(skill_name) = entry_path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };

            let staged_skill = staging_dir.join(skill_name);
            copy_dir_recursive(entry_path, &staged_skill)?;
            staged_names.push(skill_name.to_string());
        }

        Ok(())
    })();

    if let Err(e) = stage_result {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(e);
    }

    let replace_result = (|| -> Result<usize, String> {
        let mut count = 0;
        for skill_name in staged_names {
            let staged_skill = staging_dir.join(&skill_name);
            let target_skill = target_dir.join(&skill_name);

            replace_dir_from_staging(&staged_skill, &target_skill).map_err(|e| {
                format!(
                    "Failed to replace {} with staged skill {}: {}",
                    target_skill.display(),
                    skill_name,
                    e
                )
            })?;
            count += 1;
        }

        Ok(count)
    })();

    let _ = std::fs::remove_dir_all(&staging_dir);
    replace_result
}

/// Recursively copy a directory.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create dir {}: {}", dst.display(), e))?;

    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read dir {}: {}", src.display(), e))?;

    for entry in entries.flatten() {
        let entry_path = entry.path();
        let target = dst.join(entry.file_name());

        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &target)?;
        } else {
            std::fs::copy(&entry_path, &target)
                .map_err(|e| format!("Failed to copy {}: {}", entry_path.display(), e))?;
        }
    }

    Ok(())
}

/// Parse a SKILL.md file to extract skill info.
fn parse_skill_md(skill_dir: &Path) -> Option<SkillInfo> {
    let skill_md = find_skill_md(skill_dir)?;

    let content = std::fs::read_to_string(&skill_md).ok()?;
    let folder = skill_dir.file_name()?.to_string_lossy().to_string();

    // Extract title from first # heading
    let name = content
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l.trim_start_matches("# ").trim().to_string())
        .unwrap_or_else(|| folder.clone());

    // Extract description from first paragraph after heading
    let description = content
        .lines()
        .skip_while(|l| !l.starts_with("# "))
        .skip(1)
        .skip_while(|l| l.trim().is_empty())
        .take_while(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect::<String>();

    // Infer domain from folder name prefix (e.g., "bioinformatics-rna-seq" → "bioinformatics")
    let domain = folder.split('-').next().unwrap_or("general").to_string();

    Some(SkillInfo {
        id: folder.clone(),
        name,
        domain,
        description,
        folder,
    })
}

// ─── Services ───

pub(crate) async fn install_scientific_skills_global(
    context: OperationContext,
) -> Result<InstallResult, String> {
    let app = &context.backend;
    let target = skills_dir(&app, None);
    install_skills_with_timeout(&context, &target, None).await
}

pub(crate) async fn import_skill_from_folder(
    app: crate::Backend,
    source_path: String,
) -> Result<Vec<SkillInfo>, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_dir() {
        return Err("Selected path is not a folder".into());
    }

    let mut skill_dirs = Vec::new();
    collect_skill_dirs(&source, &mut skill_dirs);
    skill_dirs.sort();

    if skill_dirs.is_empty() {
        return Err(
            "Selected folder does not contain any agent skills. A skill must contain SKILL.md."
                .into(),
        );
    }

    let target_root = skills_dir(&app, None);
    std::fs::create_dir_all(&target_root).map_err(|e| {
        format!(
            "Failed to create skills dir {}: {}",
            target_root.display(),
            e
        )
    })?;

    let mut imported = Vec::new();
    for skill_dir in skill_dirs {
        let raw_folder_name = skill_dir
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Selected skill folder has an invalid name".to_string())?;
        let folder_name = sanitize_skill_folder_name(raw_folder_name);
        if folder_name.is_empty() {
            return Err("Selected skill folder has an invalid name".into());
        }

        let target = target_root.join(folder_name);
        let source_canon = skill_dir
            .canonicalize()
            .map_err(|e| format!("Failed to resolve selected skill folder: {}", e))?;

        if target.exists() {
            let target_canon = target
                .canonicalize()
                .map_err(|e| format!("Failed to resolve existing skill folder: {}", e))?;
            if target_canon == source_canon {
                let info = parse_skill_md(&target).ok_or_else(|| {
                    "Selected skill folder has an unreadable SKILL.md".to_string()
                })?;
                imported.push(info);
                continue;
            }

            std::fs::remove_dir_all(&target).map_err(|e| {
                format!(
                    "Failed to replace existing skill {}: {}",
                    target.display(),
                    e
                )
            })?;
        }

        copy_dir_recursive(&skill_dir, &target)?;
        let info = parse_skill_md(&target)
            .ok_or_else(|| "Imported skill has an unreadable SKILL.md".to_string())?;
        imported.push(info);
    }

    Ok(imported)
}

/// Ensure the target directory is creatable and writable.
/// Delegate permission repair to the host after ordinary creation fails.
fn ensure_target_writable(app: &crate::Backend, target: &Path) -> Result<(), String> {
    app.prepare_directory(target, &app.inner.config.home_dir.join(".agents"))
}

/// Emit a progress log event to the frontend + stderr for terminal debugging.
fn emit_log(context: &OperationContext, msg: &str) {
    eprintln!("[skills] {}", msg);
    context
        .events
        .emit(crate::BackendEvent::SkillsInstallLog(msg.to_string()));
}

async fn install_skills_with_timeout(
    context: &OperationContext,
    target: &Path,
    project_path: Option<&str>,
) -> Result<InstallResult, String> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(SKILLS_INSTALL_TIMEOUT_SECS),
        install_skills_to(context, target, project_path),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            let message = format!(
                "Skills installation timed out after {} seconds. Check your network or try again later.",
                SKILLS_INSTALL_TIMEOUT_SECS
            );
            emit_log(context, &message);
            Err(message)
        }
    }
}

/// Core installation logic.
async fn install_skills_to(
    context: &OperationContext,
    target: &Path,
    _project_path: Option<&str>,
) -> Result<InstallResult, String> {
    emit_log(context, &format!("Target directory: {}", target.display()));

    // Ensure target directory is writable before proceeding
    emit_log(context, "Checking directory permissions...");
    ensure_target_writable(&context.backend, target).map_err(|e| {
        emit_log(context, &format!("Permission error: {}", e));
        e
    })?;
    emit_log(context, "Directory permissions OK");

    // Create a temporary directory for the clone/download
    let tmp_dir = context.backend.inner.config.temp_dir.join(format!(
        "scientific-agent-skills-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| {
        let msg = format!("Failed to create temp dir: {}", e);
        emit_log(context, &msg);
        msg
    })?;

    struct TempCleanup(PathBuf);
    impl Drop for TempCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = TempCleanup(tmp_dir.clone());
    let result = async {
        // Download via tarball (faster, no git/git-lfs dependency)
        emit_log(context, "Downloading skills...");
        download_tarball(context, &tmp_dir).await.map_err(|e| {
            emit_log(context, &format!("Download failed: {}", e));
            e
        })?;
        emit_log(context, "Download complete");

        let repo_dir = tmp_dir.join("repo");

        // Copy skills to target directory
        emit_log(context, "Copying skills...");
        let count = copy_skills(&repo_dir, target).map_err(|e| {
            emit_log(context, &format!("Copy failed: {}", e));
            e
        })?;
        emit_log(context, &format!("Copied {} skills", count));

        let target_str = target.to_string_lossy().to_string();

        Ok(InstallResult {
            success: true,
            skills_installed: count,
            target_dir: target_str.clone(),
            message: format!("Successfully installed {} skills to {}", count, target_str),
        })
    }
    .await;

    match std::fs::remove_dir_all(&tmp_dir) {
        Ok(_) => emit_log(context, "Cleanup complete"),
        Err(e) if tmp_dir.exists() => emit_log(context, &format!("Cleanup failed: {}", e)),
        Err(_) => {}
    }

    result
}

pub(crate) async fn check_skills_installed(
    app: crate::Backend,
    project_path: Option<String>,
) -> Result<SkillsStatus, String> {
    let target = skills_dir(&app, project_path.as_deref());

    if !target.exists() {
        return Ok(SkillsStatus {
            installed: false,
            skill_count: 0,
            location: target.to_string_lossy().to_string(),
        });
    }

    let mut skill_dirs = Vec::new();
    collect_skill_dirs(&target, &mut skill_dirs);
    let count = skill_dirs.len();

    Ok(SkillsStatus {
        installed: count > 0,
        skill_count: count,
        location: target.to_string_lossy().to_string(),
    })
}

pub(crate) async fn list_installed_skills(
    app: crate::Backend,
    project_path: Option<String>,
) -> Result<Vec<SkillInfo>, String> {
    let target = skills_dir(&app, project_path.as_deref());

    if !target.exists() {
        return Ok(Vec::new());
    }

    let mut skills = Vec::new();
    let mut skill_dirs = Vec::new();
    collect_skill_dirs(&target, &mut skill_dirs);
    skill_dirs.sort();

    for skill_dir in skill_dirs {
        if let Some(info) = parse_skill_md(&skill_dir) {
            skills.push(info);
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

pub(crate) async fn delete_installed_skill(
    app: crate::Backend,
    skill_folder: String,
) -> Result<(), String> {
    if skill_folder.trim().is_empty() {
        return Err("Skill folder cannot be empty".into());
    }

    let target = skills_dir(&app, None);
    if !target.exists() {
        return Err("No global skills directory found".into());
    }

    let target_canon = target
        .canonicalize()
        .map_err(|e| format!("Failed to resolve global skills directory: {}", e))?;

    let mut skill_dirs = Vec::new();
    collect_skill_dirs(&target, &mut skill_dirs);
    let skill_dir = skill_dirs
        .into_iter()
        .find(|dir| {
            dir.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == skill_folder)
        })
        .ok_or_else(|| format!("Skill '{}' is not installed", skill_folder))?;

    let skill_canon = skill_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve skill folder: {}", e))?;
    if !skill_canon.starts_with(&target_canon) {
        return Err("Refusing to delete a skill outside ~/.agents/skills".into());
    }

    std::fs::remove_dir_all(&skill_canon)
        .map_err(|e| format!("Failed to delete skill {}: {}", skill_folder, e))?;

    Ok(())
}

pub(crate) async fn uninstall_scientific_skills(
    app: crate::Backend,
    project_path: Option<String>,
) -> Result<(), String> {
    let target = skills_dir(&app, project_path.as_deref());

    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("Failed to remove skills: {}", e))?;
    }

    Ok(())
}

pub(crate) fn get_skill_categories() -> Vec<SkillCategory> {
    skill_categories()
}

/// Read the raw SKILL.md content for a specific skill folder.
/// Tries local install first, then fetches from GitHub.
pub(crate) async fn get_skill_content(
    app: crate::Backend,
    skill_folder: String,
    project_path: Option<String>,
) -> Result<String, String> {
    // Try local (project-level first, then global)
    let locations: Vec<PathBuf> = match project_path.as_deref() {
        Some(pp) => vec![skills_dir(&app, Some(pp)), skills_dir(&app, None)],
        None => vec![skills_dir(&app, None)],
    };

    for base in &locations {
        let skill_dir = base.join(&skill_folder);
        if let Some(skill_md) = find_skill_md(&skill_dir) {
            return std::fs::read_to_string(&skill_md)
                .map_err(|e| format!("Failed to read SKILL.md: {}", e));
        }

        let mut skill_dirs = Vec::new();
        collect_skill_dirs(base, &mut skill_dirs);
        for skill_dir in skill_dirs {
            if skill_dir
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == skill_folder)
            {
                if let Some(skill_md) = find_skill_md(&skill_dir) {
                    return std::fs::read_to_string(&skill_md)
                        .map_err(|e| format!("Failed to read SKILL.md: {}", e));
                }
            }
        }
    }

    // Fallback: fetch from GitHub. The upstream project moved from
    // claude-scientific-skills/scientific-skills to scientific-agent-skills/skills.
    let client = build_skills_http_client(SKILL_CONTENT_TIMEOUT_SECS, None)
        .map_err(|e| format!("Failed to create GitHub client: {}", e))?;

    let mut last_error = None;
    for base_url in RAW_SKILL_URLS {
        for skill_file in ["SKILL.md", "skill.md"] {
            let url = format!("{}/{}/{}", base_url, skill_folder, skill_file);
            let response = match client
                .get(&url)
                .header(reqwest::header::USER_AGENT, "codex-prism skills viewer")
                .send()
                .await
            {
                Ok(response) => response,
                Err(e) => {
                    last_error = Some(format!("{}: {}", url, e));
                    continue;
                }
            };

            if response.status().is_success() {
                match response.text().await {
                    Ok(text) => return Ok(text),
                    Err(e) => {
                        last_error = Some(format!("{}: failed to read response: {}", url, e));
                        continue;
                    }
                }
            }

            last_error = Some(format!("{}: HTTP {}", url, response.status()));
        }
    }

    Err(format!(
        "Skill '{}' not found. Last error: {}",
        skill_folder,
        last_error.unwrap_or_else(|| "unknown".to_string())
    ))
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_skills_dir_global() {
        let (_tmp, app) = crate::test_backend();
        let dir = skills_dir(&app, None);
        assert!(dir.to_string_lossy().contains(".agents"));
        assert!(dir.to_string_lossy().ends_with("skills"));
    }

    #[test]
    fn test_skills_dir_project() {
        let (_tmp, app) = crate::test_backend();
        let dir = skills_dir(&app, Some("/tmp/my-project"));
        assert_eq!(dir, PathBuf::from("/tmp/my-project/.agents/skills"));
    }

    #[test]
    fn test_sanitize_skill_folder_name() {
        assert_eq!(
            sanitize_skill_folder_name("My Local Skill!"),
            "my-local-skill"
        );
        assert_eq!(
            sanitize_skill_folder_name("__Data_Skill-01__"),
            "__data_skill-01__"
        );
    }

    #[test]
    fn test_normalize_proxy_url_defaults_to_http() {
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_proxy_url("socks5://127.0.0.1:7891"),
            Some("socks5://127.0.0.1:7891".to_string())
        );
        assert_eq!(normalize_proxy_url("   "), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_windows_proxy_server_single_proxy() {
        let rules = parse_windows_proxy_server("127.0.0.1:7890");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].kind, ProxyKind::All);
        assert_eq!(rules[0].url, "http://127.0.0.1:7890");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_windows_proxy_server_per_scheme_proxy() {
        let rules = parse_windows_proxy_server(
            "http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891",
        );
        assert_eq!(rules.len(), 3);
        assert_eq!(rules[0].kind, ProxyKind::Http);
        assert_eq!(rules[0].url, "http://127.0.0.1:7890");
        assert_eq!(rules[1].kind, ProxyKind::Https);
        assert_eq!(rules[1].url, "http://127.0.0.1:7890");
        assert_eq!(rules[2].kind, ProxyKind::All);
        assert_eq!(rules[2].url, "socks5://127.0.0.1:7891");
    }

    #[test]
    fn test_skill_categories_count() {
        let cats = skill_categories();
        assert_eq!(cats.len(), 16);
        // Verify skill_count matches actual skills vec length
        for cat in &cats {
            assert_eq!(cat.skill_count, cat.skills.len(), "Mismatch in {}", cat.id);
        }
        let total: usize = cats.iter().map(|c| c.skill_count).sum();
        assert!(total >= 100);
    }

    #[test]
    fn test_find_skills_source_new_repo_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join("skills").join("exploratory-data-analysis");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "# Exploratory Data Analysis").unwrap();

        let src = find_skills_source(tmp.path()).unwrap();
        assert_eq!(
            src.file_name().and_then(|name| name.to_str()),
            Some("skills")
        );
    }

    #[test]
    fn test_find_skills_source_legacy_repo_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp
            .path()
            .join("scientific-skills")
            .join("exploratory-data-analysis");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "# Exploratory Data Analysis").unwrap();

        let src = find_skills_source(tmp.path()).unwrap();
        assert_eq!(
            src.file_name().and_then(|name| name.to_str()),
            Some("scientific-skills")
        );
    }

    #[test]
    fn test_parse_skill_md() {
        let tmp = std::env::temp_dir().join("test-skill-parse");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let skill_content = "# RNA-seq Analysis\n\nComprehensive RNA-seq data analysis pipeline.\n\n## Usage\nUse this skill for RNA sequencing workflows.\n";
        std::fs::write(tmp.join("SKILL.md"), skill_content).unwrap();

        let info = parse_skill_md(&tmp).unwrap();
        assert_eq!(info.name, "RNA-seq Analysis");
        assert!(info.description.contains("RNA-seq"));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
