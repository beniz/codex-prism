# codex-prism releases

New releases are built and staged on **GitHub**. `.github/workflows/release.yml` runs when a `v<version>` tag is pushed, or when an existing tag is selected through **Actions → Release → Run workflow**.

The workflow validates the tag against the package, Cargo and Tauri versions, then calls three platform build workflows:

| Platform | Packages | Build environment |
| --- | --- | --- |
| Linux x86_64 | `.deb` and `.AppImage` | Ubuntu 26.04 container on a GitHub-hosted Linux runner |
| Windows 10/11 x64 | `-setup.exe` | GitHub `windows-2022` runner |
| macOS Apple Silicon | `.dmg` | GitHub `macos-15` runner |

After all builds and tests pass, one publishing job creates a **draft GitHub release** containing all four packages, `SHA256SUMS`, `RELEASE_NOTES.md`, and `release.json` with the source commit and artifact hashes. It uses the workflow's built-in `GITHUB_TOKEN`; no separate publishing token or signing secrets are required. Build jobs have read-only repository permissions; only the publishing job can write releases.

Windows packages are unsigned. macOS packages are ad-hoc signed, not Apple-notarized. Linux packages target Ubuntu 26.04 and are not promised to work on older distributions. Automatic application updates are not enabled.

## Prepare a release

Start from a clean, committed checkout. Merge workflow changes before creating the release tag. Replace `1.6.2` below with the chosen version.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm release:prepare 1.6.2
# Add release notes in docs/releases/1.6.2.md and review the version changes.
corepack pnpm test:release
git add package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock docs/releases/1.6.2.md
git commit -m "chore: release 1.6.2"
git tag -a v1.6.2 -m "codex-prism 1.6.2"
git push github main
git push github v1.6.2
```

Watch **Actions → Release** on GitHub. Version-specific notes in `docs/releases/<version>.md` become the release body; if absent, the workflow supplies platform and prerequisite information.

Expected assets for this example:

- `codex-prism-1.6.2-linux-x86_64.deb`
- `codex-prism-1.6.2-x86_64.AppImage`
- `codex-prism-1.6.2-windows-x86_64-setup.exe`
- `codex-prism-1.6.2-macos-arm64.dmg`
- `SHA256SUMS`, `RELEASE_NOTES.md`, and `release.json`

Smoke-test the actual packages before publishing the draft: launch, connect Codex, open a project, compile a PDF, and exercise chat plus Keep/Undo. Windows setup provisions missing prerequisites; Linux and macOS require Codex and TeX installed separately. Python environments and external scientific skills remain optional. Packaged applications do not require Node.js or Rust at runtime.

Open the draft on the [GitHub releases page](https://github.com/beniz/codex-prism/releases), review its notes and assets, and publish it after verification. Creating the tag never publishes a public release automatically.

## Retry and test builds

Use **Re-run failed jobs** after a transient failure to preserve successful build artifacts. Alternatively, dispatch **Release** with the existing tag to rebuild all platforms. Builds check out that tag, not the latest main branch. An unchanged draft asset is reused; a different or unverifiable existing asset blocks upload without overwriting it. Review and remove conflicting draft assets before retrying. Already published releases are never modified.

Each **Build Linux**, **Build Windows**, and **Build macOS** workflow can also be run manually on a branch. Those runs only upload workflow artifacts, retained for 14 days, and never create a release. Windows also runs on main pushes and relevant pull requests. The Windows workflow tests prerequisite decisions under 32-bit and 64-bit PowerShell and smoke-tests packaged silent install/uninstall with dependency fixtures; real dependency provisioning and GUI behavior still need physical-machine verification.

```sh
gh workflow run build-linux.yml --repo beniz/codex-prism --ref main
gh workflow run build-windows.yml --repo beniz/codex-prism --ref main
gh workflow run build-macos.yml --repo beniz/codex-prism --ref main
```

Manual macOS artifacts are named `codex-prism-macos-arm64`; Windows artifacts are `codex-prism-windows-x64`; Linux artifacts are `codex-prism-linux-x64`. macOS may require an explicit Gatekeeper override. Intel/universal macOS packaging and signing/notarization remain future work.

## Local Linux packaging

Build on Ubuntu 26.04 x86_64. Install the [development dependencies](../../README_AGENTS.md#build-from-source) plus `patchelf`, `librsvg2-bin`, `file`, `curl`, `wget`, `xdg-utils`, `libpng-dev`, `zlib1g-dev`, and `squashfs-tools`. Install Node 22 with Corepack and Rust 1.88.0.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm release:build
```

Artifacts go to `dist/releases/v<version>/`. Packaging embeds a portable PNG `.DirIcon` and validates the AppImage after extraction into a separate directory, before generating checksums. AppImage filenames omit `linux` to follow catalog conventions. Signing, if added, must happen after this normalization.

Local `release:build` can build an uncommitted checkout for testing. The `codex-prism` symlink in `~/.local/bin` continues launching the repository checkout; remove or rename it if an installed package should take precedence.
