use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::{Path, PathBuf};

struct ExportDirectory(PathBuf);
impl Drop for ExportDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn ghostscript() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    for name in ["gswin64c", "gswin32c", "gs"] {
        if let Some(path) = crate::windows_tools::find(name) {
            return Ok(path);
        }
    }
    for name in [
        "gs",
        "gswin64c",
        "gswin32c",
        "/opt/homebrew/bin/gs",
        "/usr/local/bin/gs",
        "/usr/bin/gs",
    ] {
        if let Ok(path) = which::which(name) {
            return Ok(path);
        }
    }
    Err("Ghostscript is not installed. Install Ghostscript (on Windows, rerun setup interactively), or choose Original PDF.".into())
}

pub(crate) async fn optimize(
    app: &crate::Backend,
    encoded: String,
) -> Result<serde_json::Value, String> {
    // Bound IPC decoding; do not accept filenames or user-supplied gs options.
    if encoded.len() > 140_000_000 {
        return Err(
            "PDF is too large for optimized export (100 MB limit). Choose Original PDF.".into(),
        );
    }
    let input = STANDARD.decode(encoded).map_err(|_| "Invalid PDF data")?;
    if input.len() > 100_000_000 {
        return Err(
            "PDF is too large for optimized export (100 MB limit). Choose Original PDF.".into(),
        );
    }
    if !input.starts_with(b"%PDF-") {
        return Err("Invalid PDF data".into());
    }
    let program = ghostscript()?;
    let work = ExportDirectory(
        app.inner
            .config
            .temp_dir
            .join(format!("pdf-export-{}", uuid::Uuid::new_v4())),
    );
    tokio::fs::create_dir(&work.0)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::write(work.0.join("input.pdf"), &input)
        .await
        .map_err(|e| e.to_string())?;
    run(&program, &work.0, app.inner.cancel.subscribe()).await?;
    let output = tokio::fs::read(work.0.join("output.pdf"))
        .await
        .map_err(|e| format!("Cannot read optimized PDF: {e}"))?;
    if !output.starts_with(b"%PDF-") {
        return Err(
            "Ghostscript did not produce a valid PDF. Choose Original PDF or retry.".into(),
        );
    }
    let reduced = output.len() < input.len();
    let bytes = if reduced { &output } else { &input };
    Ok(
        serde_json::json!({"pdfBase64": STANDARD.encode(bytes), "originalBytes": input.len(), "exportBytes": bytes.len(), "reduced": reduced}),
    )
}
async fn run(
    program: &Path,
    work: &Path,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    let output = crate::latex::run_preview_program(
        program,
        &[
            "-dSAFER",
            "-dBATCH",
            "-dNOPAUSE",
            "-dQUIET",
            "-sDEVICE=pdfwrite",
            "-dPDFSETTINGS=/ebook",
            "-dCompatibilityLevel=1.5",
            "-dAutoRotatePages=/None",
            "-sOutputFile=output.pdf",
            "input.pdf",
        ],
        work,
        cancel,
        tokio::time::Instant::now() + std::time::Duration::from_secs(60),
    )
    .await
    .map_err(|e| e.replace("Preview compilation", "PDF optimization"))?;
    if !output.status.success() {
        return Err("Ghostscript could not optimize this PDF. Choose Original PDF or check that the PDF opens correctly.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires Ghostscript and TeX Live"]
    async fn optimizes_real_pdf_without_changing_input_and_cleans_up() {
        let temp = tempfile::tempdir().unwrap();
        let backend = crate::Backend::new(
            crate::BackendConfig {
                data_dir: temp.path().join("data"),
                home_dir: temp.path().join("home"),
                temp_dir: temp.path().join("tmp"),
            },
            std::sync::Arc::new(crate::NoopEventSink),
        )
        .unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(
            project.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}Readable text. $E=mc^2$.\\end{document}",
        )
        .unwrap();
        let input = crate::latex::compile_latex(
            &crate::latex::LatexCompilerState::default(),
            project.to_str().unwrap().into(),
            "main.tex".into(),
        )
        .await
        .unwrap();
        let result = optimize(&backend, STANDARD.encode(&input)).await.unwrap();
        let output = STANDARD
            .decode(result["pdfBase64"].as_str().unwrap())
            .unwrap();
        assert!(output.starts_with(b"%PDF-"));
        assert!(output.len() <= input.len());
        assert_eq!(
            input,
            std::fs::read(project.join(".prism/build/main.pdf")).unwrap()
        );
        assert_eq!(
            std::fs::read_dir(temp.path().join("tmp")).unwrap().count(),
            0
        );
        assert!(optimize(&backend, STANDARD.encode(b"not pdf"))
            .await
            .is_err());
        backend.shutdown().await;
    }
}
