use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

const MAX_CONCURRENT: usize = 3;

/// Windows CREATE_NO_WINDOW flag to prevent console windows from flashing
/// when spawning TeX Live child processes from the GUI app.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

struct BuildInfo {
    work_dir: PathBuf,
    main_file_name: String,
}

#[derive(Clone)]
pub(crate) struct LatexCompilerState {
    last_builds: Arc<Mutex<HashMap<String, BuildInfo>>>,
    /// Per-project locks to prevent concurrent compilations on the same build directory.
    project_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    semaphore: Arc<Semaphore>,
}

impl Default for LatexCompilerState {
    fn default() -> Self {
        Self {
            last_builds: Arc::new(Mutex::new(HashMap::new())),
            project_locks: Arc::new(Mutex::new(HashMap::new())),
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT)),
        }
    }
}

#[derive(serde::Serialize)]
pub struct SynctexResult {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

// --- Helpers ---

fn extract_error_lines(log: &str) -> String {
    if log.is_empty() {
        return String::new();
    }

    let lines: Vec<&str> = log.lines().collect();

    let mut blocks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() && blocks.len() < 5 {
        let line = lines[i];
        let is_error_start =
            line.starts_with('!') || line.contains("Error:") || line.contains("error:");

        if is_error_start {
            let end = (i + 14).min(lines.len());
            blocks.push(lines[i..end].join("\n"));
            i = end;
            continue;
        }

        i += 1;
    }

    if !blocks.is_empty() {
        let mut result = blocks.join("\n\n");
        result.push_str("\n\n---- Engine output ----\n");
        let tail_start = lines.len().saturating_sub(20);
        result.push_str(&lines[tail_start..].join("\n"));
        return result;
    }

    if lines.iter().any(|l| l.contains("No pages of output")) {
        return "No pages of output. Add visible content to the document body.".to_string();
    }

    // Fallback: return tail of log
    let mut start = log.len().saturating_sub(500);
    while !log.is_char_boundary(start) {
        start += 1;
    }
    log[start..].to_string()
}

/// Keep the compiler failure primary, even when the TeX log ends successfully.
fn compilation_failure(backend: &str, result: &Result<(), String>, log: &str) -> String {
    let reason = match result {
        Err(error) if !error.trim().is_empty() => error.trim(),
        Err(_) => "Compiler process failed without diagnostic output",
        Ok(()) => "No PDF generated",
    };
    let mut message = format!("Compilation failed ({backend})\n\n{reason}");
    let details = extract_error_lines(log);
    if !details.trim().is_empty() {
        message.push_str("\n\n---- LaTeX log context ----\n");
        message.push_str(&details);
    }
    message
}

fn subprocess_failure(output: &std::process::Output) -> String {
    let mut message = format!("Compiler subprocess failed ({})", output.status);
    for (label, bytes) in [("stderr", &output.stderr), ("stdout", &output.stdout)] {
        let text = String::from_utf8_lossy(bytes);
        if !text.trim().is_empty() {
            message.push_str(&format!("\n---- {label} ----\n{}", text.trim()));
        }
    }
    message
}

/// Check if the log contains real TeX errors (! lines or Error: messages).
fn has_real_errors(log: &str) -> bool {
    log.lines()
        .any(|l| l.starts_with('!') || l.contains("Error:"))
}

#[derive(Debug, PartialEq)]
pub(crate) enum TexEngine {
    Latex,
    XeLaTeX,
    LuaLaTeX,
}

/// Detect TeX engine from `% !TEX program = <engine>` magic comment in the first 20 lines.
pub(crate) fn detect_tex_engine(content: &str) -> Option<TexEngine> {
    for line in content.lines().take(20) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('%') {
            let rest = rest.trim();
            if let Some(rest) = rest.strip_prefix("!TEX") {
                let rest = rest.trim();
                if let Some(rest) = rest.strip_prefix("program") {
                    let rest = rest.trim();
                    if let Some(rest) = rest.strip_prefix('=') {
                        let engine = rest.trim().to_lowercase();
                        return match engine.as_str() {
                            "xelatex" => Some(TexEngine::XeLaTeX),
                            "lualatex" => Some(TexEngine::LuaLaTeX),
                            "pdflatex" | "latex" => Some(TexEngine::Latex),
                            _ => None,
                        };
                    }
                }
            }
        }
    }
    None
}

#[derive(Debug, PartialEq)]
enum BibTool {
    Biber,
    BibTeX,
    None,
}

/// The first engine pass resolves packages, includes, and backend options. Its
/// Biber control file or BibTeX auxiliary commands are more reliable than source scanning.
fn generated_bib_tool(work_dir: &Path, main_stem: &str) -> Result<BibTool, String> {
    let bcf = crate::projects::resolve(work_dir, &format!("{main_stem}.bcf"))?;
    if bcf.is_file() {
        return Ok(BibTool::Biber);
    }
    let mut pending = vec![format!("{main_stem}.aux")];
    let mut visited = HashSet::new();
    while let Some(relative) = pending.pop() {
        if !visited.insert(relative.clone()) {
            continue;
        }
        let path = crate::projects::resolve(work_dir, &relative)?;
        let aux = match std::fs::read_to_string(&path) {
            Ok(aux) => aux,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("Cannot read bibliography auxiliary file: {e}")),
        };
        for line in aux.lines() {
            let line = line.trim();
            if line.starts_with("\\bibdata{") {
                return Ok(BibTool::BibTeX);
            }
            if let Some(input) = line
                .strip_prefix("\\@input{")
                .and_then(|s| s.split('}').next())
            {
                if input.ends_with(".aux") {
                    pending.push(input.into());
                }
            }
        }
    }
    Ok(BibTool::None)
}

/// Resolve a TeXLive engine binary to its full path.
/// GUI apps on macOS lack the user's shell PATH, so we check standard
/// TeXLive installation locations and fall back to a login-shell query.
#[cfg(target_os = "windows")]
fn find_texlive_binary(name: &str) -> Result<PathBuf, String> {
    crate::windows_tools::find_tex(name).ok_or_else(|| format!("{name} is unavailable in the selected LaTeX installation. Complete that installation, or select an available engine using a % !TEX program comment. Rerun the Windows installer if no compiler is installed."))
}

#[cfg(not(target_os = "windows"))]
fn find_texlive_binary(name: &str) -> Result<PathBuf, String> {
    // 1. Try PATH (works when launched from terminal)
    if let Ok(path) = which::which(name) {
        return Ok(path);
    }

    // 2. Check standard TeXLive locations
    #[cfg(not(target_os = "windows"))]
    {
        let standard_paths = [
            format!("/Library/TeX/texbin/{}", name),
            format!("/usr/local/texlive/2025/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2024/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2025/bin/x86_64-linux/{}", name),
            format!("/usr/local/texlive/2024/bin/x86_64-linux/{}", name),
            format!("/opt/homebrew/bin/{}", name),
            format!("/usr/bin/{}", name),
        ];
        for path_str in &standard_paths {
            let p = PathBuf::from(path_str);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // 3. macOS: ask login shell for PATH
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/bin/zsh")
            .args(["-l", "-c", &format!("which {}", name)])
            .output()
        {
            if output.status.success() {
                let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let p = PathBuf::from(&resolved);
                if p.exists() {
                    return Ok(p);
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    Err(format!(
        "{} not found. Install TeX Live and add its bin directory to PATH. On Ubuntu, install texlive-latex-extra texlive-xetex texlive-luatex texlive-bibtex-extra texlive-fonts-recommended texlive-publishers biber.",
        name
    ))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            // Skip hidden directories (.git, .claudeprism, etc.)
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Sync only source files (.tex, .bib, .sty, .cls, .bst, images, .pdf figures) from project to build dir.
/// Skips build artifacts (.aux, .log, .toc, .synctex.gz, etc.) to preserve them.
/// Note: .pdf is NOT skipped — figure PDFs must be synced. The output PDF is managed by compile_latex.
fn sync_source_files(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);
        if src_path.is_dir() {
            let name = file_name.to_string_lossy();
            if name.starts_with('.') || matches!(name.as_ref(), "node_modules" | "target" | "dist")
            {
                continue;
            }
            sync_source_files(&src_path, &dst_path)?;
        } else {
            let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let is_artifact = matches!(
                ext,
                "aux"
                    | "log"
                    | "toc"
                    | "lof"
                    | "lot"
                    | "out"
                    | "nav"
                    | "snm"
                    | "vrb"
                    | "bbl"
                    | "blg"
                    | "fls"
                    | "fdb_latexmk"
                    | "synctex"
                    | "idx"
                    | "ind"
                    | "ilg"
                    | "glo"
                    | "gls"
                    | "glg"
                    | "fmt"
                    | "xdv"
            );
            let is_synctex = src_path.to_string_lossy().ends_with(".synctex.gz");
            if !is_artifact && !is_synctex {
                // Cloud storage (Dropbox/iCloud) may keep files as online-only
                // placeholders with 0 bytes. Reading the file forces a download.
                let metadata = std::fs::metadata(&src_path)?;

                if metadata.len() > 0 {
                    if let Ok(dst_meta) = std::fs::metadata(&dst_path) {
                        if metadata.len() == dst_meta.len() {
                            if let (Ok(src_m), Ok(dst_m)) =
                                (metadata.modified(), dst_meta.modified())
                            {
                                if src_m == dst_m {
                                    continue;
                                }
                            }
                        }
                    }
                }

                if metadata.len() == 0 {
                    // Attempt to materialize the file by reading it
                    let data = std::fs::read(&src_path)?;
                    if !data.is_empty() {
                        std::fs::write(&dst_path, &data)?;
                    } else {
                        std::fs::copy(&src_path, &dst_path)?;
                    }
                } else {
                    std::fs::copy(&src_path, &dst_path)?;
                }
            }
        }
    }
    Ok(())
}

/// Persistent build directory inside the project.
/// Stored in `<project>/.prism/build/` — hidden from file tree (dot-prefix is filtered).
fn persistent_build_dir(project_dir: &str) -> PathBuf {
    PathBuf::from(project_dir).join(".prism").join("build")
}

// --- Thread priority ---

/// Lower the current thread's scheduling priority so CPU-heavy compilation
/// does not starve the WebView's main thread (and thus the UI / typing).
fn lower_thread_priority() {
    #[cfg(target_os = "macos")]
    {
        // QOS_CLASS_UTILITY (0x11) — lower than default, appropriate for long-running work.
        extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        unsafe { pthread_set_qos_class_self_np(0x11, 0) };
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        extern "C" {
            fn nice(inc: i32) -> i32;
        }
        unsafe { nice(10) };
    }
}

// --- TeX Live compilation ---

fn texlive_env_path(engine: &Path) -> String {
    let texbin = engine
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let current_path = std::env::var("PATH").unwrap_or_default();
    #[cfg(target_os = "windows")]
    { format!("{};{}", texbin, current_path) }
    #[cfg(not(target_os = "windows"))]
    if current_path.contains(&texbin) {
        current_path
    } else {
        {
            format!("{}:{}", texbin, current_path)
        }
    }
}

/// Keep intermediate pass diagnostics: stale auxiliary files can fail before BibTeX
/// refreshes them. Only the final engine pass determines compilation success.
fn run_texlive_pass(
    engine: &Path,
    args: &[&str],
    main_file: &Path,
    work_dir: &Path,
) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new(engine);
    cmd.args(args)
        .arg(main_file)
        .current_dir(work_dir)
        .env("PATH", texlive_env_path(engine))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to launch {}: {}", engine.display(), e))?;

    Ok(output)
}

/// Run from the build directory with a relative job name. BibTeX rejects
/// absolute output paths under TeX Live's default openout_any=p policy.
#[cfg(test)]
fn run_bibliography_pass(
    executable: &Path,
    main_stem: &str,
    work_dir: &Path,
) -> Result<(), String> {
    let mut cmd = std::process::Command::new(executable);
    cmd.arg(main_stem)
        .current_dir(work_dir)
        .env("PATH", texlive_env_path(executable))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run {}: {}", executable.display(), e))?;
    if !output.status.success() {
        return Err(format!(
            "Bibliography tool {} failed: {}",
            executable.display(),
            subprocess_failure(&output)
        ));
    }
    Ok(())
}

fn compile_with_texlive(
    work_dir: &Path,
    main_file: &str,
    engine: Option<TexEngine>,
) -> Result<(), String> {
    compile_with_texlive_using(work_dir, main_file, engine, |program, args, dir| {
        let (main, flags) = args.split_last().ok_or("Missing compiler argument")?;
        run_texlive_pass(program, flags, Path::new(main), dir)
    })
}

fn compile_with_texlive_using(
    work_dir: &Path,
    main_file: &str,
    engine: Option<TexEngine>,
    mut run: impl FnMut(&Path, &[&str], &Path) -> Result<std::process::Output, String>,
) -> Result<(), String> {
    let engine_name = match engine {
        Some(TexEngine::XeLaTeX) => "xelatex",
        Some(TexEngine::Latex) | None => "pdflatex",
        Some(TexEngine::LuaLaTeX) => "lualatex",
    };

    let engine_path = find_texlive_binary(engine_name)?;
    eprintln!(
        "[texlive] backend: {} ({})",
        engine_name,
        engine_path.display()
    );
    let main_stem = Path::new(main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    // A persistent build may still contain a Biber control file from an earlier
    // bibliography configuration. Only a freshly generated file may select Biber.
    let bcf = crate::projects::resolve(work_dir, &format!("{main_stem}.bcf"))?;
    match std::fs::remove_file(bcf) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Cannot remove stale Biber control file: {e}")),
    }

    // Use "." as output-directory since current_dir is already work_dir.
    // Absolute paths break when they contain ~ (e.g. iCloud's com~apple~CloudDocs)
    // because TeX interprets ~ as a home directory shortcut.
    let output_dir_arg = "-output-directory=.".to_string();
    // Intermediate passes may need to recover from stale bibliography/auxiliary files.
    let common_args: Vec<&str> = vec![
        "-synctex=1",
        "-interaction=nonstopmode",
        &output_dir_arg,
        main_file,
    ];

    // Pass 1
    run(&engine_path, &common_args, work_dir)?;

    // Bib pass (if needed)
    let bib_tool = generated_bib_tool(work_dir, main_stem)?;
    let bibliography_program = match bib_tool {
        BibTool::Biber => Some("biber"),
        BibTool::BibTeX => Some("bibtex"),
        BibTool::None => None,
    };
    if let Some(program) = bibliography_program {
        let executable = find_texlive_binary(program)?;
        let output = run(&executable, &[main_stem], work_dir)?;
        if !output.status.success() {
            return Err(format!(
                "Bibliography tool {} failed: {}",
                executable.display(),
                subprocess_failure(&output)
            ));
        }
    }

    // Pass 2: resolve references / TOC
    let mut final_output = run(&engine_path, &common_args, work_dir)?;

    // Pass 3: stabilize citations (only if bib was used)
    if !matches!(bib_tool, BibTool::None) {
        final_output = run(&engine_path, &common_args, work_dir)?;
    }

    if !final_output.status.success() {
        return Err(subprocess_failure(&final_output));
    }
    let log =
        std::fs::read_to_string(work_dir.join(format!("{}.log", main_stem))).unwrap_or_default();
    if has_real_errors(&log) {
        return Err(extract_error_lines(&log));
    }
    Ok(())
}

async fn preview_cancelled(cancel: &mut tokio::sync::watch::Receiver<bool>) {
    if !*cancel.borrow() {
        let _ = cancel.changed().await;
    }
}

/// Owned preview subprocesses: timeout/cancellation kills and reaps the compiler.
pub(crate) async fn run_preview_program(
    program: &Path,
    args: &[&str],
    dir: &Path,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    deadline: tokio::time::Instant,
) -> Result<std::process::Output, String> {
    use tokio::io::AsyncReadExt;
    if *cancel.borrow() {
        return Err("Backend is shutting down".into());
    }
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(dir)
        .env("PATH", texlive_env_path(program))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Cannot start {}: {e}", program.display()))?;
    let mut stdout = child.stdout.take().ok_or("Missing compiler stdout")?;
    let mut stderr = child.stderr.take().ok_or("Missing compiler stderr")?;
    let mut out = tokio::spawn(async move {
        let mut bytes = vec![];
        stdout.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let mut err = tokio::spawn(async move {
        let mut bytes = vec![];
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let result = tokio::select! {
        status = child.wait() => status.map_err(|e| e.to_string()),
        _ = tokio::time::sleep_until(deadline) => Err("Preview compilation timed out (60 seconds)".into()),
        _ = preview_cancelled(&mut cancel) => Err("Backend is shutting down".into()),
    };
    let status = match result {
        Ok(status) => status,
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            out.abort();
            err.abort();
            return Err(error);
        }
    };
    let output = tokio::select! {
        output = async {
            let stdout = (&mut out).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            let stderr = (&mut err).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            Ok(std::process::Output { status, stdout, stderr })
        } => output,
        _ = tokio::time::sleep_until(deadline) => Err("Preview compilation timed out (60 seconds)".into()),
        _ = preview_cancelled(&mut cancel) => Err("Backend is shutting down".into()),
    };
    if output.is_err() {
        out.abort();
        err.abort();
    }
    output
}

pub(crate) async fn preview_toolchain(
    content: &str,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let content = content.to_owned();
    let programs = tokio::task::spawn_blocking(move || {
        let engine = match detect_tex_engine(&content) {
            Some(TexEngine::XeLaTeX) => "xelatex",
            Some(TexEngine::LuaLaTeX) => "lualatex",
            _ => "pdflatex",
        };
        // The bibliography backend is resolved after the first engine pass, so
        // include both installed tools in cache identity without requiring either
        // until compilation actually needs it.
        let programs = vec![
            (engine, Some(find_texlive_binary(engine)?)),
            ("bibtex", find_texlive_binary("bibtex").ok()),
            ("biber", find_texlive_binary("biber").ok()),
        ];
        Ok::<_, String>(programs)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut identity = String::new();
    for (name, program) in programs {
        let Some(program) = program else {
            identity.push_str(&format!("{name}:unavailable;"));
            continue;
        };
        let output = run_preview_program(
            &program,
            &["--version"],
            &std::env::temp_dir(),
            cancel.clone(),
            tokio::time::Instant::now() + std::time::Duration::from_secs(5),
        )
        .await?;
        identity.push_str(&format!(
            "{}:{};",
            program.display(),
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or_default()
        ));
    }
    Ok(identity)
}

pub(crate) async fn compile_preview(
    state: &LatexCompilerState,
    work: &Path,
    main: &str,
    content: &str,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<Vec<u8>, String> {
    let _permit = tokio::select! {
        permit = state.semaphore.clone().acquire_owned() => permit.map_err(|e| e.to_string())?,
        _ = preview_cancelled(&mut cancel) => return Err("Backend is shutting down".into()),
    };
    let work = work.to_path_buf();
    let main = main.to_owned();
    let content = content.to_owned();
    let runtime = tokio::runtime::Handle::current();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    tokio::task::spawn_blocking(move || {
        lower_thread_priority();
        let stem = Path::new(&main)
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("Invalid main document")?;
        let pdf = work.join(format!("{stem}.pdf"));
        // Source PDFs are preserved as assets, but cannot masquerade as successful output.
        if pdf.exists() {
            std::fs::remove_file(&pdf).map_err(|e| e.to_string())?;
        }
        compile_with_texlive_using(
            &work,
            &main,
            detect_tex_engine(&content),
            |program, args, dir| {
                runtime.block_on(run_preview_program(
                    program,
                    args,
                    dir,
                    cancel.clone(),
                    deadline,
                ))
            },
        )?;
        let bytes = std::fs::read(pdf).map_err(|e| format!("No preview PDF generated: {e}"))?;
        if !bytes.starts_with(b"%PDF-") {
            return Err("Compiler generated an invalid preview PDF".into());
        }
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- SyncTeX Native Parser ---

struct SynctexNode {
    tag: u32,
    line: u32,
    h: f64, // PDF points
    v: f64, // PDF points
}

/// Parse synctex data and find the source location closest to (target_x, target_y) on target_page.
fn parse_synctex_data(
    data: &str,
    target_page: u32,
    target_x: f64,
    target_y: f64,
) -> Option<(String, u32, u32)> {
    let mut inputs: HashMap<u32, String> = HashMap::new();
    let mut magnification: f64 = 1000.0;
    let mut unit: f64 = 1.0;
    let mut x_offset: f64 = 0.0;
    let mut y_offset: f64 = 0.0;

    let mut in_content = false;
    let mut on_target_page = false;
    let mut nodes: Vec<SynctexNode> = Vec::new();

    for raw_line in data.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if !in_content {
            if let Some(rest) = line.strip_prefix("Input:") {
                if let Some(colon_pos) = rest.find(':') {
                    if let Ok(tag) = rest[..colon_pos].parse::<u32>() {
                        inputs.insert(tag, rest[colon_pos + 1..].to_string());
                    }
                }
            } else if let Some(rest) = line.strip_prefix("Magnification:") {
                magnification = rest.trim().parse().unwrap_or(1000.0);
            } else if let Some(rest) = line.strip_prefix("Unit:") {
                unit = rest.trim().parse().unwrap_or(1.0);
            } else if let Some(rest) = line.strip_prefix("X Offset:") {
                x_offset = rest.trim().parse().unwrap_or(0.0);
            } else if let Some(rest) = line.strip_prefix("Y Offset:") {
                y_offset = rest.trim().parse().unwrap_or(0.0);
            } else if line == "Content:" {
                in_content = true;
            }
            continue;
        }

        // Content section
        if line.starts_with("Postamble:") {
            break;
        }

        let first_byte = match line.as_bytes().first() {
            Some(b) => *b,
            None => continue,
        };
        match first_byte {
            b'{' => {
                let page: u32 = line.get(1..).and_then(|s| s.parse().ok()).unwrap_or(0);
                on_target_page = page == target_page;
            }
            b'}' => {
                on_target_page = false;
            }
            // Box/node records: [, (, h, v, k, x, g, $
            b'[' | b'(' | b'h' | b'v' | b'k' | b'x' | b'g' | b'$' if on_target_page => {
                // Convert synctex internal units to PDF points (bp)
                // 1 TeX pt = 65536 sp; 1 inch = 72.27 TeX pt = 72 PDF bp
                let factor = unit * magnification / (1000.0 * 65536.0) * 72.0 / 72.27;
                if let Some(node) = line
                    .get(1..)
                    .and_then(|s| parse_synctex_node(s, factor, x_offset, y_offset))
                {
                    nodes.push(node);
                }
            }
            _ => {}
        }
    }

    if nodes.is_empty() {
        return None;
    }

    // Find closest node to (target_x, target_y)
    let mut best_idx = 0;
    let mut best_dist = f64::MAX;
    for (i, node) in nodes.iter().enumerate() {
        let dx = node.h - target_x;
        let dy = node.v - target_y;
        let dist = dx * dx + dy * dy;
        if dist < best_dist {
            best_dist = dist;
            best_idx = i;
        }
    }

    let best = nodes.get(best_idx)?;
    let filename = inputs.get(&best.tag)?.clone();
    Some((filename, best.line, 0))
}

/// Parse a synctex node record (after stripping the type character).
/// Format: `<tag>,<line>,<column>:<h>,<v>[:<W>,<H>,<D>]`
fn parse_synctex_node(s: &str, factor: f64, x_offset: f64, y_offset: f64) -> Option<SynctexNode> {
    let colon_parts: Vec<&str> = s.splitn(4, ':').collect();
    if colon_parts.len() < 2 {
        return None;
    }

    // Parse tag and line (ignore column)
    let first_part = colon_parts.first()?;
    let tlc: Vec<&str> = first_part.splitn(3, ',').collect();
    if tlc.len() < 2 {
        return None;
    }
    let tag: u32 = tlc.first()?.parse().ok()?;
    let line: u32 = tlc.get(1)?.parse().ok()?;

    // Parse h, v coordinates
    let second_part = colon_parts.get(1)?;
    let hv: Vec<&str> = second_part.splitn(2, ',').collect();
    if hv.len() < 2 {
        return None;
    }
    let h_raw: i64 = hv.first()?.parse().ok()?;
    let v_raw: i64 = hv.get(1)?.parse().ok()?;

    let h = h_raw as f64 * factor + x_offset;
    let v = v_raw as f64 * factor + y_offset;

    Some(SynctexNode { tag, line, h, v })
}

// --- Services ---

#[derive(serde::Serialize)]
pub struct TexliveStatus {
    pub available: bool,
    pub engines: Vec<String>,
    pub version: Option<String>,
}

pub(crate) fn detect_texlive() -> TexliveStatus {
    let engines_to_check = ["pdflatex", "xelatex", "lualatex"];
    let mut found_engines = Vec::new();

    for name in &engines_to_check {
        if find_texlive_binary(name).is_ok() {
            found_engines.push(name.to_string());
        }
    }

    let version = find_texlive_binary("pdflatex").ok().and_then(|path| {
        let mut cmd = std::process::Command::new(&path);
        cmd.arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output().ok().and_then(|o| {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.lines().next().map(|l| l.to_string())
        })
    });

    TexliveStatus {
        available: !found_engines.is_empty(),
        engines: found_engines,
        version,
    }
}

/// Load the most recent PDF for this TeX root without invoking a compiler.
pub(crate) async fn load_existing_pdf(
    state: &LatexCompilerState,
    project_dir: String,
    main_file: String,
) -> Result<Option<Vec<u8>>, String> {
    let root = PathBuf::from(&project_dir);
    let found = tokio::task::spawn_blocking(move || find_existing_pdf(&root, &main_file))
        .await
        .map_err(|e| e.to_string())??;
    if let Some((path, bytes)) = found {
        if let (Some(parent), Some(stem)) =
            (path.parent(), path.file_stem().and_then(|s| s.to_str()))
        {
            state.last_builds.lock().await.insert(
                project_dir,
                BuildInfo {
                    work_dir: parent.to_path_buf(),
                    main_file_name: stem.to_string(),
                },
            );
        }
        return Ok(Some(bytes));
    }
    Ok(None)
}

fn find_existing_pdf(root: &Path, main_file: &str) -> Result<Option<(PathBuf, Vec<u8>)>, String> {
    crate::projects::resolve(root, main_file)?;
    let main = Path::new(main_file);
    let stem = main
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid TeX filename")?;
    let beside_source = main.with_extension("pdf").to_string_lossy().to_string();
    let mut candidates = Vec::new();
    for relative in [format!(".prism/build/{stem}.pdf"), beside_source] {
        let path = crate::projects::resolve(root, &relative)?;
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => candidates.push((
                meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                path,
            )),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in candidates {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        // Ignore empty/obviously invalid artifacts from interrupted builds.
        if bytes.starts_with(b"%PDF-") {
            return Ok(Some((path, bytes)));
        }
    }
    Ok(None)
}

pub(crate) async fn compile_latex(
    state: &LatexCompilerState,
    project_dir: String,
    main_file: String,
) -> Result<Vec<u8>, String> {
    // Acquire semaphore permit (non-blocking)
    let _permit = state
        .semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Server busy, too many concurrent compilations".to_string())?;

    // Acquire per-project lock to prevent concurrent compilations on the same build dir.
    let project_lock = {
        let mut locks = state.project_locks.lock().await;
        locks
            .entry(project_dir.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _project_guard = project_lock.lock().await;

    let t0 = std::time::Instant::now();

    let main_file_name = Path::new(&main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();

    // Set up build directory (offload blocking I/O to avoid starving the async runtime)
    let work_dir = persistent_build_dir(&project_dir);
    let is_reuse = work_dir.exists();

    {
        let work_dir = work_dir.clone();
        let project_dir = project_dir.clone();
        tokio::task::spawn_blocking(move || {
            if is_reuse {
                sync_source_files(Path::new(&project_dir), &work_dir)
                    .map_err(|e| format!("Failed to sync project: {}", e))
            } else {
                std::fs::create_dir_all(&work_dir)
                    .map_err(|e| format!("Failed to create build dir: {}", e))?;
                copy_dir_recursive(Path::new(&project_dir), &work_dir)
                    .map_err(|e| format!("Failed to copy project: {}", e))
            }
        })
        .await
        .map_err(|e| format!("File sync task panicked: {}", e))??;
    }

    eprintln!(
        "[latex] +{:.0}ms {} ({}, backend={})",
        t0.elapsed().as_millis(),
        if is_reuse {
            "sync source files"
        } else {
            "full copy"
        },
        if is_reuse { "reuse" } else { "first build" },
        "texlive"
    );

    // Remove stale PDF so a failed compile doesn't return the previous result.
    let pdf_path = work_dir.join(format!("{}.pdf", main_file_name));
    let _ = std::fs::remove_file(&pdf_path);

    // Verify the main TeX file exists before attempting compilation
    let main_tex_path = work_dir.join(&main_file);
    if !main_tex_path.exists() {
        return Err(format!(
            "Compilation failed\n\nNo .tex file found: \"{}\". Create a document.tex or main.tex file to compile.",
            main_file
        ));
    }

    // Detect TeX engine from magic comment
    let main_tex_content = std::fs::read_to_string(&main_tex_path).unwrap_or_default();
    let engine = detect_tex_engine(&main_tex_content);

    // Save engine name before `engine` is moved into the spawn_blocking closure
    let engine_name_for_label = match &engine {
        Some(TexEngine::XeLaTeX) => "xelatex",
        Some(TexEngine::Latex) | None => "pdflatex",
        Some(TexEngine::LuaLaTeX) => "lualatex",
    };
    let backend_label = format!("TeX Live/{}", engine_name_for_label);
    let work_dir_clone = work_dir.clone();
    let main_file_clone = main_file.clone();
    let compile_result = tokio::task::spawn_blocking(move || {
        lower_thread_priority();
        compile_with_texlive(&work_dir_clone, &main_file_clone, engine)
    })
    .await
    .map_err(|e| format!("Compilation task panicked: {}", e))?;
    let log_path = work_dir.join(format!("{}.log", main_file_name));

    // Store build info
    {
        let mut builds = state.last_builds.lock().await;
        builds.insert(
            project_dir.clone(),
            BuildInfo {
                work_dir: work_dir.clone(),
                main_file_name: main_file_name.clone(),
            },
        );
    }

    if compile_result.is_ok() && pdf_path.exists() {
        let pdf_path_clone = pdf_path.clone();
        let pdf_bytes = tokio::task::spawn_blocking(move || std::fs::read(&pdf_path_clone))
            .await
            .map_err(|e| format!("PDF read task panicked: {}", e))?
            .map_err(|e| format!("Failed to read PDF: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms total (reuse={}, backend={}) pdf_size={}KB",
            t0.elapsed().as_millis(),
            is_reuse,
            backend_label,
            pdf_bytes.len() / 1024
        );
        Ok(pdf_bytes)
    } else {
        // Do not let startup PDF loading pick up a partial failed output.
        let _ = std::fs::remove_file(&pdf_path);
        let log_content = std::fs::read_to_string(&log_path).unwrap_or_default();
        Err(compilation_failure(
            &backend_label,
            &compile_result,
            &log_content,
        ))
    }
}

/// Resolve an outline link only against the PDF currently displayed by the client.
pub(crate) fn synctex_view(
    project_dir: &str,
    main_file: &str,
    file: &str,
    line: u32,
    source_line: &str,
    pdf_revision: &str,
) -> Result<Option<SourceBox>, String> {
    let root = Path::new(project_dir);
    let Some((pdf, bytes)) = find_existing_pdf(root, main_file)? else {
        return Ok(None);
    };
    if crate::projects::revision(&bytes) != pdf_revision {
        return Ok(None);
    }
    let work = pdf.parent().ok_or("Invalid PDF directory")?;
    let gz = pdf.with_extension("synctex.gz");
    let plain = pdf.with_extension("synctex");
    let data = if gz.exists() {
        let compressed = std::fs::read(gz).map_err(|e| e.to_string())?;
        let mut data = String::new();
        flate2::read::GzDecoder::new(&compressed[..])
            .read_to_string(&mut data)
            .map_err(|e| e.to_string())?;
        data
    } else if plain.exists() {
        std::fs::read_to_string(plain).map_err(|e| e.to_string())?
    } else {
        return Ok(None);
    };
    // Builds use a copied source tree. Check the requested heading against it
    // so unsaved line insertions cannot send the PDF to unrelated text.
    let source_root = if work.starts_with(root.join(".prism/build")) {
        work
    } else {
        root
    };
    let source = crate::projects::resolve(source_root, file)?;
    let Ok(text) = std::fs::read_to_string(source) else {
        return Ok(None);
    };
    if text
        .lines()
        .nth(line.saturating_sub(1) as usize)
        .map(str::trim)
        != Some(source_line.trim())
    {
        return Ok(None);
    }
    let mut boxes = forward_synctex(&data, work);
    // PDFs built beside their source can record project-relative absolute inputs.
    if work != root {
        boxes.extend(forward_synctex(&data, root));
    }
    Ok(boxes
        .into_iter()
        .filter(|b| b.file == file && b.line >= line && b.line <= line.saturating_add(2))
        .min_by(|a, b| {
            a.line
                .abs_diff(line)
                .cmp(&b.line.abs_diff(line))
                .then(a.page.cmp(&b.page))
                .then(a.y.total_cmp(&b.y))
        }))
}

pub(crate) async fn synctex_edit(
    state: &LatexCompilerState,
    project_dir: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SynctexResult, String> {
    let builds = state.last_builds.lock().await;
    let build = builds
        .get(&project_dir)
        .ok_or("No build found for this project")?;

    let synctex_gz = build
        .work_dir
        .join(format!("{}.synctex.gz", build.main_file_name));
    let synctex_plain = build
        .work_dir
        .join(format!("{}.synctex", build.main_file_name));

    let work_dir = build.work_dir.clone();
    drop(builds); // Release lock before I/O

    // Read, decompress, and parse synctex data (blocking I/O + CPU work → offload)
    let (mut file, line, column) = tokio::task::spawn_blocking(move || {
        let synctex_data = if synctex_gz.exists() {
            let compressed = std::fs::read(&synctex_gz)
                .map_err(|e| format!("Failed to read synctex.gz: {}", e))?;
            let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
            let mut data = String::new();
            decoder
                .read_to_string(&mut data)
                .map_err(|e| format!("Failed to decompress synctex: {}", e))?;
            Ok::<_, String>(data)
        } else if synctex_plain.exists() {
            std::fs::read_to_string(&synctex_plain)
                .map_err(|e| format!("Failed to read synctex: {}", e))
        } else {
            Err("No synctex data found. Recompile with synctex enabled.".to_string())
        }?;

        parse_synctex_data(&synctex_data, page, x, y)
            .ok_or_else(|| "Could not resolve source location".to_string())
    })
    .await
    .map_err(|e| format!("Synctex task panicked: {}", e))??;

    // Normalize: strip work_dir prefix and "./" or ".\\" prefix
    let work_dir_str = work_dir.to_string_lossy().to_string();
    if let Some(rest) = file.strip_prefix(&format!("{}/", work_dir_str)) {
        file = rest.to_string();
    } else if let Some(rest) = file.strip_prefix(&format!("{}\\", work_dir_str)) {
        file = rest.to_string();
    }
    if let Some(rest) = file.strip_prefix("./") {
        file = rest.to_string();
    } else if let Some(rest) = file.strip_prefix(".\\") {
        file = rest.to_string();
    }

    Ok(SynctexResult { file, line, column })
}

/// Clear in-memory build state on app exit.
/// Persistent build directories are intentionally kept for fast restart.
pub(crate) async fn cleanup_all_builds(state: &LatexCompilerState) {
    let mut builds = state.last_builds.lock().await;
    builds.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn bibliography_pass_uses_relative_job_and_build_directory() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("bibtex-test");
        std::fs::write(
            &executable,
            "#!/bin/sh\n[ \"$1\" = paper ] && [ -f paper.aux ]\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.path().join("paper.aux"), "").unwrap();
        run_bibliography_pass(&executable, "paper", dir.path()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bibliography_pass_reports_failure_instead_of_reusing_stale_output() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("bibtex-test");
        std::fs::write(
            &executable,
            "#!/bin/sh\necho 'missing bibliography database'\necho 'write denied' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.path().join("paper.bbl"), "stale bibliography").unwrap();
        let error = run_bibliography_pass(&executable, "paper", dir.path()).unwrap_err();
        assert!(error.contains("Bibliography tool"));
        assert!(error.contains("exit status: 1"));
        assert!(error.contains("missing bibliography database"));
        assert!(error.contains("write denied"));
    }

    #[test]
    #[ignore = "requires system TeX Live engines and BibTeX"]
    fn texlive_integration_engines_errors_and_bibliography() {
        let dir = tempfile::tempdir().unwrap();
        let simple = "\\documentclass{article}\n\\begin{document}Test\\end{document}\n";
        for engine in [None, Some(TexEngine::XeLaTeX), Some(TexEngine::LuaLaTeX)] {
            std::fs::write(dir.path().join("main.tex"), simple).unwrap();
            compile_with_texlive(dir.path(), "main.tex", engine).unwrap();
            assert!(std::fs::read(dir.path().join("main.pdf"))
                .unwrap()
                .starts_with(b"%PDF-"));
        }
        let invalid =
            "\\documentclass{article}\n\\begin{document}\\undefinedPrismCommand\\end{document}";
        std::fs::write(dir.path().join("main.tex"), invalid).unwrap();
        let error = compile_with_texlive(dir.path(), "main.tex", None).unwrap_err();
        assert!(error.contains("Undefined control sequence"));
        // A stale bibliography must be replaced before the final engine pass.
        let bib = "\\documentclass{article}\n\\begin{document}\\cite{known}\\bibliographystyle{plain}\\bibliography{refs}\\end{document}";
        std::fs::write(dir.path().join("main.tex"), bib).unwrap();
        std::fs::write(dir.path().join("main.bbl"), "\\obsoleteBibliographyCommand").unwrap();
        std::fs::write(dir.path().join("refs.bib"), "@article{known,author={A. Writer},title={Verified Entry},journal={Journal},year={2026}}").unwrap();
        compile_with_texlive(dir.path(), "main.tex", None).unwrap();
        let log = std::fs::read_to_string(dir.path().join("main.log")).unwrap();
        assert!(!log.contains("undefined"));
        assert!(std::fs::read_to_string(dir.path().join("main.bbl"))
            .unwrap()
            .contains("Verified"));
        std::fs::remove_file(dir.path().join("refs.bib")).unwrap();
        assert!(compile_with_texlive(dir.path(), "main.tex", None)
            .unwrap_err()
            .contains("Bibliography tool"));
    }

    #[tokio::test]
    #[ignore = "requires system pdfLaTeX"]
    async fn texlive_integration_failed_pdf_is_not_reused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let state = LatexCompilerState::default();
        std::fs::write(
            dir.path().join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\\undefinedPrismCommand\\end{document}",
        )
        .unwrap();
        assert!(compile_latex(&state, root.clone(), "main.tex".into())
            .await
            .is_err());
        assert!(load_existing_pdf(&state, root.clone(), "main.tex".into())
            .await
            .unwrap()
            .is_none());
        std::fs::write(
            dir.path().join("main.tex"),
            "\\documentclass{article}\n\\begin{document}Recovered\\end{document}",
        )
        .unwrap();
        let pdf = compile_latex(&state, root, "main.tex".into())
            .await
            .unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
    }

    #[test]
    fn missing_texlive_tool_names_the_tool_and_installation_action() {
        let error = find_texlive_binary("prism-nonexistent-tex-tool").unwrap_err();
        assert!(error.contains("prism-nonexistent-tex-tool"));
        #[cfg(not(target_os = "windows"))]
        assert!(error.contains("Install TeX Live"));
        #[cfg(target_os = "windows")]
        assert!(error.contains("Rerun the Windows installer"));
    }

    #[tokio::test]
    #[ignore = "requires PRISM_TEST_PROJECT, compiles only a temporary copy"]
    async fn texlive_integration_project_copy() {
        let project = std::env::var("PRISM_TEST_PROJECT").unwrap();
        let main = std::env::var("PRISM_TEST_MAIN").unwrap();
        let output = std::env::var("PRISM_TEST_OUTPUT").unwrap();
        let dir = tempfile::tempdir().unwrap();
        copy_dir_recursive(Path::new(&project), dir.path()).unwrap();
        let content = std::fs::read_to_string(dir.path().join(&main)).unwrap();
        compile_with_texlive(dir.path(), &main, detect_tex_engine(&content)).unwrap();
        // Exercise the isolated-preview runner as well as normal project compilation.
        let (_send, cancel) = tokio::sync::watch::channel(false);
        preview_toolchain(&content, cancel.clone()).await.unwrap();
        let bytes = compile_preview(
            &LatexCompilerState::default(),
            dir.path(),
            &main,
            &content,
            cancel,
        )
        .await
        .unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        std::fs::write(output, bytes).unwrap();
    }

    #[test]
    fn generated_biber_control_file_takes_precedence_over_auxiliary_commands() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("slides.bcf"), "<bcf:controlfile/>").unwrap();
        std::fs::write(dir.path().join("slides.aux"), "\\bibdata{refs}").unwrap();
        assert_eq!(
            generated_bib_tool(dir.path(), "slides").unwrap(),
            BibTool::Biber
        );
    }

    #[test]
    fn generated_bibtex_commands_can_come_from_nested_auxiliary_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sections")).unwrap();
        std::fs::write(
            dir.path().join("paper.aux"),
            "\\@input{sections/references.aux}",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("sections/references.aux"),
            "\\@input{paper.aux}\n\\bibdata{refs}\n\\bibstyle{plain}",
        )
        .unwrap();
        assert_eq!(
            generated_bib_tool(dir.path(), "paper").unwrap(),
            BibTool::BibTeX
        );
    }

    #[test]
    fn generated_auxiliary_files_without_bibliography_data_do_not_run_bibtex() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            generated_bib_tool(dir.path(), "slides").unwrap(),
            BibTool::None
        );
        std::fs::write(dir.path().join("slides.aux"), "% \\bibdata{commented}\n\\relax\n\\@input{missing.aux}\n\\@input{slides.aux}\n\\citation{example}").unwrap();
        assert_eq!(
            generated_bib_tool(dir.path(), "slides").unwrap(),
            BibTool::None
        );
    }

    #[test]
    fn generated_auxiliary_inputs_cannot_escape_the_build_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("paper.aux"), "\\@input{../outside.aux}").unwrap();
        assert!(generated_bib_tool(dir.path(), "paper").is_err());
    }

    #[test]
    #[ignore = "requires system pdfLaTeX, Biber, BibTeX and biblatex"]
    fn texlive_integration_hidden_biblatex_backend_and_backend_changes() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("localbib.sty");
        let main = dir.path().join("slides.tex");
        std::fs::write(
            &package,
            "\\RequirePackage[backend=biber,style=numeric]{biblatex}",
        )
        .unwrap();
        std::fs::write(dir.path().join("refs.bib"), "@article{known,author={A. Writer},title={Verified Entry},journal={Journal},year={2026}}").unwrap();
        // Empty starters are valid; biblatex is loaded indirectly, as in custom themes.
        let preamble =
            "\\documentclass{article}\n\\usepackage{localbib}\n\\addbibresource{refs.bib}\n";
        std::fs::write(
            &main,
            format!("{preamble}\\begin{{document}}Empty starter\\end{{document}}"),
        )
        .unwrap();
        compile_with_texlive(dir.path(), "slides.tex", None).unwrap();
        assert!(dir.path().join("slides.bcf").is_file());
        assert!(std::fs::read_to_string(dir.path().join("slides.blg"))
            .unwrap()
            .contains("Biber"));

        std::fs::write(
            &main,
            format!(
                "{preamble}\\begin{{document}}\\cite{{known}}\\printbibliography\\end{{document}}"
            ),
        )
        .unwrap();
        compile_with_texlive(dir.path(), "slides.tex", None).unwrap();
        assert!(std::fs::read_to_string(dir.path().join("slides.bbl"))
            .unwrap()
            .contains("Verified"));
        let log = std::fs::read_to_string(dir.path().join("slides.log")).unwrap();
        assert!(!log.contains("Citation 'known'"));

        // A stale .bcf must not override biblatex's explicit BibTeX backend.
        std::fs::write(
            &package,
            "\\RequirePackage[backend=bibtex,style=numeric]{biblatex}",
        )
        .unwrap();
        compile_with_texlive(dir.path(), "slides.tex", None).unwrap();
        assert!(!dir.path().join("slides.bcf").exists());
        assert!(std::fs::read_to_string(dir.path().join("slides.blg"))
            .unwrap()
            .contains("BibTeX"));
        assert!(std::fs::read_to_string(dir.path().join("slides.bbl"))
            .unwrap()
            .contains("Verified"));

        std::fs::write(
            &main,
            "\\documentclass{article}\n\\begin{document}No bibliography\\end{document}",
        )
        .unwrap();
        compile_with_texlive(dir.path(), "slides.tex", None).unwrap();
        assert_eq!(
            generated_bib_tool(dir.path(), "slides").unwrap(),
            BibTool::None
        );
    }

    // --- extract_error_lines ---

    #[test]
    fn test_compilation_failure_preserves_pdf_conversion_error() {
        let result = Err("xdvipdfmx: failed to load image".to_string());
        let log = "Output written on main.xdv (6 pages, 54328 bytes).";
        let message = compilation_failure("TeX Live/xelatex", &result, log);
        assert!(message.starts_with(
            "Compilation failed (TeX Live/xelatex)\n\nxdvipdfmx: failed to load image"
        ));
        assert!(message.contains("---- LaTeX log context ----\nOutput written"));
    }

    #[test]
    fn test_compilation_failure_missing_pdf_and_empty_diagnostics() {
        assert!(compilation_failure("TeX Live/xelatex", &Ok(()), "").ends_with("No PDF generated"));
        assert!(
            compilation_failure("TeX Live/xelatex", &Err(String::new()), "")
                .ends_with("Compiler process failed without diagnostic output")
        );
        let message = compilation_failure(
            "TeX Live/xelatex",
            &Err("engine failed".into()),
            "! Undefined control sequence.",
        );
        assert!(message.contains("engine failed"));
        assert!(message.contains("! Undefined control sequence."));
    }

    #[cfg(unix)]
    #[test]
    fn test_subprocess_failure_reports_status_and_both_streams() {
        use std::os::unix::process::ExitStatusExt;
        let mut output = std::process::Output {
            status: std::process::ExitStatus::from_raw(1 << 8),
            stdout: b"converter detail".to_vec(),
            stderr: b"font error".to_vec(),
        };
        let message = subprocess_failure(&output);
        assert!(message.contains("exit status: 1"));
        assert!(message.contains("font error"));
        assert!(message.contains("converter detail"));
        output.status = std::process::ExitStatus::from_raw(6);
        output.stdout.clear();
        output.stderr.clear();
        assert!(subprocess_failure(&output).contains("signal: 6"));
    }

    #[test]
    fn test_extract_error_lines_unicode_tail() {
        let log = format!("a{}", "界".repeat(200));
        let result = extract_error_lines(&log);
        assert!(log.ends_with(&result));
        assert!(result.len() <= 500);
        assert!(!result.is_empty());
    }

    #[test]
    fn test_extract_error_lines_empty_log() {
        assert_eq!(extract_error_lines(""), "");
    }

    #[test]
    fn test_extract_error_lines_no_pages() {
        let log = "Some preamble\nNo pages of output.\nSome trailing";
        let result = extract_error_lines(log);
        assert_eq!(
            result,
            "No pages of output. Add visible content to the document body."
        );
    }

    #[test]
    fn test_extract_error_lines_with_errors() {
        let log = "line 1\n! Undefined control sequence.\nline 3\n! Missing $ inserted.\nline 5";
        let result = extract_error_lines(log);
        assert!(result.contains("Undefined control sequence"));
        assert!(result.contains("Missing $ inserted"));
    }

    #[test]
    fn test_extract_error_lines_error_colon() {
        let log = "stuff\nLatex Error: Bad math environment\nmore stuff";
        let result = extract_error_lines(log);
        assert!(result.contains("Error:"));
    }

    #[test]
    fn test_extract_error_lines_no_errors_returns_tail() {
        let log = "a".repeat(1000);
        let result = extract_error_lines(&log);
        // Should return last 500 chars
        assert_eq!(result.len(), 500);
    }

    #[test]
    fn test_extract_error_lines_limits_to_10() {
        let mut log = String::new();
        for i in 0..20 {
            log.push_str(&format!("! Error number {}\n", i));
        }
        let result = extract_error_lines(&log);
        assert!(result.contains("---- Engine output ----"));
        let count = result.lines().count();
        assert!(count <= 120);
    }

    // --- persistent_build_dir ---

    #[test]
    fn test_persistent_build_dir() {
        let dir = persistent_build_dir("/Users/dev/my-project");
        assert_eq!(dir, PathBuf::from("/Users/dev/my-project/.prism/build"));
    }

    // --- parse_synctex_node ---

    #[test]
    fn test_parse_synctex_node_basic() {
        // Format: tag,line,column:h,v
        let node = parse_synctex_node("1,42,0:1000,2000", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let node = node.unwrap();
        assert_eq!(node.tag, 1);
        assert_eq!(node.line, 42);
        assert_eq!(node.h, 1000.0);
        assert_eq!(node.v, 2000.0);
    }

    #[test]
    fn test_parse_synctex_node_with_dimensions() {
        // Format: tag,line,column:h,v:W,H,D
        let node = parse_synctex_node("3,10,0:500,600:100,20,5", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let node = node.unwrap();
        assert_eq!(node.tag, 3);
        assert_eq!(node.line, 10);
    }

    #[test]
    fn test_parse_synctex_node_with_offset() {
        let node = parse_synctex_node("1,1,0:0,0", 1.0, 10.0, 20.0);
        let node = node.unwrap();
        assert_eq!(node.h, 10.0); // 0 * 1.0 + 10.0
        assert_eq!(node.v, 20.0); // 0 * 1.0 + 20.0
    }

    #[test]
    fn test_parse_synctex_node_invalid_missing_colon() {
        assert!(parse_synctex_node("1,1,0", 1.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn test_parse_synctex_node_invalid_missing_comma() {
        assert!(parse_synctex_node("1:100,200", 1.0, 0.0, 0.0).is_none());
    }

    // --- parse_synctex_data ---

    #[test]
    fn test_parse_synctex_data_basic() {
        let data = "\
SyncTeX Version:1
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000:500,100,0
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 50.0, 50.0);
        assert!(result.is_some());
        let (file, line, _col) = result.unwrap();
        assert_eq!(file, "./main.tex");
        assert_eq!(line, 5);
    }

    #[test]
    fn test_parse_synctex_data_wrong_page() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000
}1
Postamble:
";
        // Looking for page 2 but data only has page 1
        let result = parse_synctex_data(data, 2, 50.0, 50.0);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_synctex_data_closest_node() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,10,0:0,0
h1,20,0:100000000,100000000
}1
Postamble:
";
        // (0, 0) is closer to the first node
        let result = parse_synctex_data(data, 1, 0.0, 0.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 10);
    }

    #[test]
    fn test_parse_synctex_data_empty() {
        let result = parse_synctex_data("", 1, 0.0, 0.0);
        assert!(result.is_none());
    }

    // --- extract_error_lines additional edge cases ---

    #[test]
    fn test_extract_error_lines_mixed_error_formats() {
        let log = "preamble\n! LaTeX Error: File not found.\nl.42 \\input{missing}\nerror: compilation stopped";
        let result = extract_error_lines(log);
        assert!(result.contains("LaTeX Error"));
        assert!(result.contains("error: compilation stopped"));
    }

    #[test]
    fn test_extract_error_lines_short_log_no_errors() {
        let log = "This is a short log without errors";
        let result = extract_error_lines(log);
        // Short log (< 500 chars) returned as tail
        assert_eq!(result, log);
    }

    // --- parse_synctex_node additional edge cases ---

    #[test]
    fn test_parse_synctex_node_negative_coordinates() {
        let node = parse_synctex_node("1,1,0:-500,300", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let n = node.unwrap();
        assert_eq!(n.h, -500.0);
        assert_eq!(n.v, 300.0);
    }

    #[test]
    fn test_parse_synctex_node_factor_scaling() {
        // factor=2.0 should double the coordinates
        let node = parse_synctex_node("1,1,0:100,200", 2.0, 0.0, 0.0);
        let n = node.unwrap();
        assert_eq!(n.h, 200.0);
        assert_eq!(n.v, 400.0);
    }

    #[test]
    fn test_parse_synctex_node_zero_tag_and_line() {
        let node = parse_synctex_node("0,0,0:0,0", 1.0, 0.0, 0.0);
        let n = node.unwrap();
        assert_eq!(n.tag, 0);
        assert_eq!(n.line, 0);
    }

    // --- parse_synctex_data additional edge cases ---

    #[test]
    fn test_parse_synctex_data_multiple_inputs() {
        let data = "\
Input:1:./main.tex
Input:2:./chapter1.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h2,15,0:500,500
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 0.0, 0.0);
        assert!(result.is_some());
        let (file, line, _) = result.unwrap();
        assert_eq!(file, "./chapter1.tex");
        assert_eq!(line, 15);
    }

    #[test]
    fn test_parse_synctex_data_multiple_pages() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:100,100
}1
{2
h1,25,0:200,200
}2
Postamble:
";
        let result = parse_synctex_data(data, 2, 200.0, 200.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 25);
    }

    // --- extract_error_lines: real errors take priority over "No pages of output" ---

    #[test]
    fn test_extract_error_lines_real_errors_over_no_pages() {
        let log = "Some preamble\n! LaTeX Error: File `missing.sty' not found.\nNo pages of output.\nMore stuff";
        let result = extract_error_lines(log);
        assert!(
            result.contains("LaTeX Error"),
            "real error should be shown, got: {}",
            result
        );
        assert!(
            !result.contains("Add visible content"),
            "No pages fallback should NOT appear"
        );
    }

    // --- has_real_errors ---

    #[test]
    fn test_has_real_errors_with_bang() {
        assert!(has_real_errors("ok\n! Undefined control sequence.\nmore"));
    }

    #[test]
    fn test_has_real_errors_with_error_colon() {
        assert!(has_real_errors("LaTeX Error: Bad math\nstuff"));
    }

    #[test]
    fn test_has_real_errors_none() {
        assert!(!has_real_errors("This is pdfTeX\nNo pages of output.\n"));
    }

    // --- detect_tex_engine ---

    #[test]
    fn test_detect_tex_engine_xelatex() {
        let content = "% !TEX program = xelatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_pdflatex() {
        let content = "% !TEX program = pdflatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::Latex));
    }

    #[test]
    fn test_detect_tex_engine_lualatex() {
        let content = "% !TEX program = lualatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::LuaLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_none() {
        let content = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n";
        assert_eq!(detect_tex_engine(content), None);
    }

    #[test]
    fn test_detect_tex_engine_case_insensitive() {
        let content = "% !TEX program = XeLaTeX\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_no_spaces() {
        let content = "%!TEX program=xelatex\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    // --- persistent_build_dir edge case ---

    #[test]
    fn test_persistent_build_dir_trailing_slash() {
        let dir = persistent_build_dir("/project/");
        assert_eq!(dir, PathBuf::from("/project/.prism/build"));
    }

    // --- copy_dir_recursive integration tests ---

    #[test]
    fn test_copy_dir_recursive_nested() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Create nested structure
        std::fs::create_dir_all(src.path().join("sub").join("deep")).unwrap();
        std::fs::write(src.path().join("top.tex"), "top").unwrap();
        std::fs::write(src.path().join("sub").join("mid.tex"), "mid").unwrap();
        std::fs::write(
            src.path().join("sub").join("deep").join("bottom.tex"),
            "bottom",
        )
        .unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("top.tex")).unwrap(),
            "top"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("mid.tex")).unwrap(),
            "mid"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("deep").join("bottom.tex"))
                .unwrap(),
            "bottom"
        );
    }

    #[test]
    fn test_copy_dir_recursive_skips_hidden_dirs() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join(".git")).unwrap();
        std::fs::write(src.path().join(".git").join("config"), "secret").unwrap();
        std::fs::write(src.path().join("main.tex"), "doc").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert!(!dst.path().join(".git").exists(), ".git should be skipped");
    }

    #[test]
    fn test_copy_dir_recursive_empty_subdir() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("empty_sub")).unwrap();
        std::fs::write(src.path().join("a.tex"), "a").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("empty_sub").exists());
        assert!(dst.path().join("empty_sub").is_dir());
    }

    // --- sync_source_files integration tests ---

    #[test]
    fn test_sync_source_files_copies_sources() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("refs.bib"), "bib").unwrap();
        std::fs::write(src.path().join("style.sty"), "sty").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("main.tex")).unwrap(),
            "doc"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("refs.bib")).unwrap(),
            "bib"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("style.sty")).unwrap(),
            "sty"
        );
    }

    #[test]
    fn test_sync_source_files_skips_artifacts() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("main.aux"), "aux").unwrap();
        std::fs::write(src.path().join("main.log"), "log").unwrap();
        std::fs::write(src.path().join("main.synctex.gz"), "sync").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert!(!dst.path().join("main.aux").exists());
        assert!(!dst.path().join("main.log").exists());
        assert!(!dst.path().join("main.synctex.gz").exists());
    }

    #[test]
    fn test_sync_source_files_recursive_and_skips_hidden() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("chapters")).unwrap();
        std::fs::create_dir_all(src.path().join(".claudeprism")).unwrap();
        std::fs::write(src.path().join("chapters").join("ch1.tex"), "ch1").unwrap();
        std::fs::write(src.path().join("chapters").join("ch1.aux"), "aux").unwrap();
        std::fs::write(src.path().join(".claudeprism").join("data"), "data").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("chapters").join("ch1.tex")).unwrap(),
            "ch1"
        );
        assert!(!dst.path().join("chapters").join("ch1.aux").exists());
        assert!(!dst.path().join(".claudeprism").exists());
    }

    // --- sync_source_files copies figure PDFs ---

    #[test]
    fn test_sync_source_files_copies_figure_pdfs() {
        // .pdf files (e.g. figures) must be synced — they are NOT artifacts.
        // The output PDF is managed by compile_latex (explicit remove_file).
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("figures")).unwrap();
        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("figures").join("chart.pdf"), "pdf figure").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert_eq!(
            std::fs::read_to_string(dst.path().join("figures").join("chart.pdf")).unwrap(),
            "pdf figure"
        );
    }

    #[test]
    fn test_sync_source_files_overwrites_changed_tex_content() {
        // Regression: when a user empties a file, sync must overwrite
        // the old content in the build dir with the empty content.
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Old content in build dir
        std::fs::write(dst.path().join("main.tex"), "old content").unwrap();
        // User emptied the file
        std::fs::write(src.path().join("main.tex"), "").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("main.tex")).unwrap(),
            ""
        );
    }

    // --- persistent_build_dir ---

    #[test]
    fn test_stale_pdf_removal_pattern() {
        // Simulates the pattern used in compile_latex: remove stale PDF
        // before compilation so a failed compile doesn't return old results.
        let build_dir = tempfile::tempdir().unwrap();
        let pdf_path = build_dir.path().join("document.pdf");

        // Simulate previous successful build left a PDF
        std::fs::write(&pdf_path, "old pdf data").unwrap();
        assert!(pdf_path.exists());

        // This is what compile_latex does before running the compiler
        let _ = std::fs::remove_file(&pdf_path);
        assert!(!pdf_path.exists());

        // If compilation fails, pdf_path.exists() is false → error returned
    }

    #[test]
    fn test_stale_pdf_removal_no_existing_file() {
        // remove_file on a non-existent path should not panic (we use let _ =)
        let build_dir = tempfile::tempdir().unwrap();
        let pdf_path = build_dir.path().join("document.pdf");

        assert!(!pdf_path.exists());
        let result = std::fs::remove_file(&pdf_path);
        // It's an error but we ignore it with let _ =
        assert!(result.is_err());
    }
}

#[cfg(test)]
mod existing_pdf_tests {
    use super::*;
    #[test]
    fn loads_persistent_build_without_compiling() {
        let d = tempfile::tempdir().unwrap();
        let build = d.path().join(".prism/build");
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("main.pdf"), b"%PDF-1.7 cached").unwrap();
        let (_, bytes) = find_existing_pdf(d.path(), "main.tex").unwrap().unwrap();
        assert_eq!(bytes, b"%PDF-1.7 cached");
    }
    #[test]
    fn loads_pdf_beside_nested_source_and_ignores_unrelated_pdfs() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("paper")).unwrap();
        std::fs::write(d.path().join("paper/article.pdf"), b"%PDF-1.7 external").unwrap();
        assert!(find_existing_pdf(d.path(), "main.tex").unwrap().is_none());
        assert!(find_existing_pdf(d.path(), "paper/article.tex")
            .unwrap()
            .is_some());
    }
    #[test]
    fn prefers_the_newer_matching_pdf() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".prism/build")).unwrap();
        let cached = d.path().join(".prism/build/main.pdf");
        std::fs::write(&cached, b"%PDF-1.7 older").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&cached)
            .unwrap()
            .set_modified(std::time::SystemTime::UNIX_EPOCH)
            .unwrap();
        std::fs::write(d.path().join("main.pdf"), b"%PDF-1.7 newer").unwrap();
        assert_eq!(
            find_existing_pdf(d.path(), "main.tex").unwrap().unwrap().1,
            b"%PDF-1.7 newer"
        );
    }
    #[test]
    fn skips_invalid_cached_pdf_and_falls_back_to_project_pdf() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".prism/build")).unwrap();
        std::fs::write(d.path().join(".prism/build/main.pdf"), b"").unwrap();
        assert!(find_existing_pdf(d.path(), "main.tex").unwrap().is_none());
        std::fs::write(d.path().join("main.pdf"), b"%PDF-1.7 valid").unwrap();
        assert!(find_existing_pdf(d.path(), "main.tex").unwrap().is_some());
    }
}

#[cfg(all(test, unix))]
mod preview_process_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn sleeper(dir: &Path) -> PathBuf {
        let program = dir.join("compiler");
        std::fs::write(
            &program,
            "#!/bin/sh\necho $$ > compiler.pid\nexec sleep 30\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        program
    }
    fn assert_reaped(dir: &Path) {
        let pid = std::fs::read_to_string(dir.join("compiler.pid")).unwrap();
        assert!(!std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success());
    }
    #[tokio::test]
    async fn preview_timeout_kills_and_reaps_the_compiler() {
        let dir = tempfile::tempdir().unwrap();
        let program = sleeper(dir.path());
        let (_send, cancel) = tokio::sync::watch::channel(false);
        let result = run_preview_program(
            &program,
            &[],
            dir.path(),
            cancel,
            tokio::time::Instant::now() + std::time::Duration::from_millis(100),
        )
        .await;
        assert!(result.unwrap_err().contains("timed out"));
        assert_reaped(dir.path());
    }
    #[tokio::test]
    async fn preview_shutdown_kills_and_reaps_the_compiler() {
        let dir = tempfile::tempdir().unwrap();
        let program = sleeper(dir.path());
        let (send, cancel) = tokio::sync::watch::channel(false);
        let path = dir.path().to_path_buf();
        let task = tokio::spawn(async move {
            run_preview_program(
                &program,
                &[],
                &path,
                cancel,
                tokio::time::Instant::now() + std::time::Duration::from_secs(60),
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !dir.path().join("compiler.pid").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        send.send_replace(true);
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().contains("shutting down"));
        assert_reaped(dir.path());
    }
}

/// Forward source index, in PDF points. Only horizontal boxes are candidates:
/// enclosing vertical/page boxes would misleadingly highlight entire pages.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct SourceBox {
    pub file: String,
    pub line: u32,
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
pub(crate) fn forward_synctex(data: &str, root: &Path) -> Vec<SourceBox> {
    let mut inputs = HashMap::new();
    let (mut mag, mut unit, mut xo, mut yo) = (1000.0, 1.0, 0.0, 0.0);
    let mut page = 0;
    let mut boxes = Vec::new();
    let mut horizontal: Vec<Option<SourceBox>> = Vec::new();
    for line in data.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("Input:") {
            if let Some((tag, path)) = rest.split_once(':') {
                let path = Path::new(path);
                let absolute = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    root.join(path)
                };
                // Canonicalize while the immutable build directory still exists.
                if let (Ok(absolute), Ok(root)) = (absolute.canonicalize(), root.canonicalize()) {
                    if let Ok(relative) = absolute.strip_prefix(root) {
                        if let Ok(tag) = tag.parse::<u32>() {
                            inputs.insert(tag, relative.to_string_lossy().replace('\\', "/"));
                        }
                    }
                }
            }
        } else if let Some(v) = line.strip_prefix("Magnification:") {
            mag = v.trim().parse().unwrap_or(1000.0);
        } else if let Some(v) = line.strip_prefix("Unit:") {
            unit = v.trim().parse().unwrap_or(1.0);
        } else if let Some(v) = line.strip_prefix("X Offset:") {
            xo = v.trim().parse().unwrap_or(0.0);
        } else if let Some(v) = line.strip_prefix("Y Offset:") {
            yo = v.trim().parse().unwrap_or(0.0);
        } else if let Some(v) = line.strip_prefix('{') {
            page = v.parse().unwrap_or(0);
        } else if line.starts_with('}') || line.starts_with("Postamble:") {
            page = 0;
        } else if line.starts_with(')') {
            horizontal.pop();
        } else if page > 0 && line.starts_with(['x', 'g', 'k', '$']) {
            let factor = unit * mag / (1000.0 * 65536.0) * 72.0 / 72.27;
            if let Some(n) = parse_synctex_node(&line[1..], factor, xo * factor, yo * factor) {
                if let (Some(file), Some(Some(parent))) = (inputs.get(&n.tag), horizontal.last()) {
                    let mut region = parent.clone();
                    region.file = file.clone();
                    region.line = n.line;
                    if !boxes.iter().any(|b: &SourceBox| {
                        b.file == region.file
                            && b.line == region.line
                            && b.page == region.page
                            && b.x == region.x
                            && b.y == region.y
                    }) {
                        boxes.push(region);
                    }
                }
            }
        } else if page > 0 && (line.starts_with('(') || line.starts_with('h')) {
            if line.starts_with('(') {
                horizontal.push(None);
            }
            let factor = unit * mag / (1000.0 * 65536.0) * 72.0 / 72.27;
            if let Some(n) = parse_synctex_node(&line[1..], factor, xo * factor, yo * factor) {
                let dimensions: Vec<f64> = line
                    .split(':')
                    .nth(2)
                    .unwrap_or("")
                    .split(',')
                    .filter_map(|v| v.parse::<f64>().ok())
                    .map(|v| v * factor)
                    .collect();
                if let (Some(file), [w, h, d]) = (inputs.get(&n.tag), dimensions.as_slice()) {
                    if *w > 0.0 && h + d > 0.0 {
                        let region = SourceBox {
                            file: file.clone(),
                            line: n.line,
                            page,
                            x: n.h,
                            y: n.v - h,
                            w: *w,
                            h: h + d,
                        };
                        if line.starts_with('(') {
                            if let Some(parent) = horizontal.last_mut() {
                                *parent = Some(region.clone());
                            }
                        }
                        boxes.push(region);
                    }
                }
            }
        }
    }
    boxes
}

#[cfg(test)]
mod outline_navigation_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires local TeX Live"]
    async fn real_compiled_section_in_included_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("main.tex"), "\\documentclass{article}\n\\begin{document}\n\\section{First}\nFirst page.\n\\newpage\n\\input{chapter}\n\\end{document}\n").unwrap();
        std::fs::write(
            root.join("chapter.tex"),
            "\\section{Results}\nSecond page.\n",
        )
        .unwrap();
        let bytes = compile_latex(
            &LatexCompilerState::default(),
            root.to_str().unwrap().into(),
            "main.tex".into(),
        )
        .await
        .unwrap();
        let found = synctex_view(
            root.to_str().unwrap(),
            "main.tex",
            "chapter.tex",
            1,
            "\\section{Results}",
            &crate::projects::revision(&bytes),
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.page, 2);
        assert!(found.y > 0.0 && found.y < 400.0);
    }
    #[test]
    fn locates_included_heading_and_rejects_stale_pdf_or_source() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let work = root.join(".prism/build");
        std::fs::create_dir_all(work.join("chapters")).unwrap();
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(root.join("main.tex"), "\\input{chapters/results}").unwrap();
        for path in [
            root.join("chapters/results.tex"),
            work.join("chapters/results.tex"),
        ] {
            std::fs::write(path, "\\section{Results}\nContent").unwrap();
        }
        let bytes = b"%PDF-test";
        std::fs::write(work.join("main.pdf"), bytes).unwrap();
        std::fs::write(work.join("main.synctex"), "Input:1:./chapters/results.tex\nMagnification:1000\nUnit:65536\nContent:\n{3\n(1,1:50,120:100,12,0\n)\n}3\n").unwrap();
        let revision = crate::projects::revision(bytes);
        let locate = |heading: &str, hash: &str| {
            synctex_view(
                root.to_str().unwrap(),
                "main.tex",
                "chapters/results.tex",
                1,
                heading,
                hash,
            )
            .unwrap()
        };
        let found = locate("\\section{Results}", &revision).unwrap();
        assert_eq!(found.page, 3);
        assert!(found.y > 100.0);
        assert!(locate("\\section{Other}", &revision).is_none());
        assert!(locate("\\section{Results}", "old-pdf").is_none());
        std::fs::remove_file(work.join("main.synctex")).unwrap();
        assert!(locate("\\section{Results}", &revision).is_none());
    }
}
