# Windows x64 setup

The Windows 10/11 x64 package is an NSIS `-setup.exe` installer. It installs
codex-prism for the current user and creates Start menu/uninstall entries.
Node.js and Rust are build dependencies only; users do not need them.

## Prerequisites installed by setup

Setup reuses existing tools. When absent it downloads and installs:

- Microsoft WebView2 through Tauri's bootstrapper (PDF preview is bundled MuPDF).
- MiKTeX through Windows Package Manager (`winget`), only when no usable pdfLaTeX,
  XeLaTeX or LuaLaTeX compiler is detected, including Biber and common scientific
  packages. Newly installed MiKTeX enables downloading additional missing TeX
  packages during compilation. Existing MiKTeX/TeX Live settings are preserved.
- Codex CLI through Windows Package Manager. Sign in from Connection after setup.
- Ghostscript 10.08.0 from the official Artifex release for optimized PDF export,
  with a pinned SHA-256 check before running its installer. Its system-wide setup
  opens its license/setup wizard and requests administrator approval. Complete
  that wizard to enable optimized export; canceling it or a download failure
  does not prevent installing the app. Original PDF export remains available.
  Artifex disables silent installation in this release. Existing 32-bit or
  64-bit Ghostscript installations are reused.

An Internet connection and Windows App Installer (`winget`) are needed when
MiKTeX or Codex is missing. Setup accepts the package/source agreements for these
prerequisites. Vendor licenses apply; prerequisites are separate installations
and remain installed when codex-prism is uninstalled.

Setup detects tools rather than requiring a particular TeX distribution. It
searches the current and saved Windows PATH, standard MiKTeX locations and
`C:\texlive\*\bin\windows`, and checks compiler availability with `--version`.
For a custom installation elsewhere, add its binary directory to PATH before
running setup. An installed PDF reader alone does not provide a LaTeX compiler.
Setup and the app search current PATH, saved user PATH, saved machine PATH and
standard locations in that order. They select the first directory containing a
usable supported compiler and keep its compiler/bibliography tools together,
so tools from multiple TeX installations are not mixed.

If any supported compiler works, setup reuses it and warns about missing engines
or bibliography tools without blocking installation or adding another TeX
distribution. Install those components in your existing distribution when a
document needs them. Documents use pdfLaTeX by default; if only XeLaTeX or LuaLaTeX
is available, select it with a `% !TEX program = xelatex` or `lualatex` comment
within the main document's first 20 lines. Passing `--version` verifies that a
compiler starts; individual documents can still need additional TeX packages.
Required prerequisite failures abort installation and are logged at
`%LOCALAPPDATA%\codex-prism\installer.log`. Rerunning setup reuses successful
prerequisite installations. No inference requests are sent during installation.

Unattended installation (`codex-prism_1.6.0_x64-setup.exe /S`) skips the optional
Ghostscript wizard when Ghostscript is missing. Rerun setup interactively later,
or use the **Get Ghostscript** button after a missing-Ghostscript export error.
Unattended setup still provisions missing MiKTeX/Codex through WinGet and requires
Internet access. No administrator prompt is needed for those per-user packages;
WebView2's bootstrapper may have its own requirements.

## Build

Install Node.js 22 with Corepack, Git, the Visual Studio C++ desktop build tools
and Windows SDK, and Rust (the checkout pins 1.88.0). WebView2 is required to run.
From PowerShell in the checkout:

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build:desktop
```

The installer is written to
`apps/desktop/src-tauri/target/release/bundle/nsis/`. The Windows override and
prerequisite hook are selected automatically by `build:desktop`.

The **Build Windows** GitHub workflow tests and builds the same installer and
uploads it with SHA-256 checksums. Builds are unsigned unless a Windows signing
certificate is configured separately; Windows may show an unknown-publisher warning.
CI also runs a packaged silent install/uninstall smoke test on its disposable
runner, using executable dependency fixtures. This verifies the NSIS package and
optional-tool behavior; it does not claim to install real TeX/Codex packages or
complete Ghostscript's interactive wizard. Real provisioning and PDF rendering
were separately verified on a physical Windows PC.

## Verify locally

```powershell
powershell -NoProfile -File scripts/windows-prerequisites.test.ps1
corepack pnpm --filter @codex-prism/desktop test
cargo test --locked --manifest-path crates/prism-core/Cargo.toml
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
```

After installing, check tools without downloading anything:

```powershell
powershell -NoProfile -File apps/desktop/src-tauri/windows/prerequisites.ps1 -CheckOnly
```

Run the real LaTeX/PDF acceptance tests when prerequisites are installed:

```powershell
cargo test --locked --manifest-path crates/prism-core/Cargo.toml texlive_integration_engines_errors_and_bibliography -- --ignored
cargo test --locked --manifest-path crates/prism-core/Cargo.toml texlive_integration_failed_pdf_is_not_reused -- --ignored
cargo test --locked --manifest-path crates/prism-core/Cargo.toml texlive_integration_hidden_biblatex_backend_and_backend_changes -- --ignored
cargo test --locked --manifest-path crates/prism-core/Cargo.toml optimizes_real_pdf_without_changing_input_and_cleans_up -- --ignored
cargo test --locked --manifest-path crates/prism-core/Cargo.toml windows_installed_codex -- --ignored
```

Launch the installed app, open a disposable project, compile and inspect the PDF,
check Connection and the model list, and export Original and Ebook PDFs. Verify
missing-dependency setup by uninstalling the dependencies on a test PC, confirming
their tools are absent, then running setup and repeating the compilation/export
checks. Also verify that setup reuses existing tools; decision tests use mocks
and complement these real installation checks.
