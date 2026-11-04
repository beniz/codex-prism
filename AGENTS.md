# Working on codex-prism

## Product and architecture

codex-prism is a local, single-user scientific-writing editor built around an
installed Codex CLI, LaTeX source, and PDF previews. Keep it focused on authoring
and review; a standalone presentation player or HTML playback environment is
not part of the current product.

- `apps/desktop/src`: React 19, TypeScript, Vite, Zustand stores, CodeMirror editor, and MuPDF rendering through a worker. Tests live under `src/__tests__` and alongside some libraries.
- `apps/desktop/src/lib/backend`: typed frontend boundary for native operations. Keep desktop-only calls in the host adapters rather than spreading Tauri dependencies into product state.
- `crates/prism-core`: shared, headless Rust backend. `api.rs` exposes operations; `services.rs` routes project services; `events.rs` defines host events.
- Core modules: `codex.rs` handles app-server sessions; `proposals.rs` handles isolated workspaces and merges; `history_workflow.rs` handles Git acceptance/recovery; `latex.rs` handles compilation/SyncTeX; `visual_review.rs` handles immutable builds; `templates.rs` handles private templates.
- `apps/desktop/src-tauri`: Tauri 2 host, native adapters, platform configuration, and Windows installer hooks. Business logic belongs in the core when it does not need Tauri.
- There is no root Cargo workspace. The core and desktop have separate manifests and lockfiles.

This file guides development of the application. The `AGENTS.md` generated in a
user's LaTeX project is a different document containing writing instructions;
shared writing guidance lives in `crates/prism-core/src/writing-guidance.txt`.

## Development commands

Run from the repository root unless noted. Use Node 22+, the pinned pnpm version
from `package.json`, and the Rust toolchain in `rust-toolchain.toml`. Linux desktop
builds require Tauri/WebKit/GTK libraries listed in the README.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev:desktop          # No automatic reloads/restarts; relaunch after edits
corepack pnpm dev:desktop:watch    # Opt-in reloads/restarts
corepack pnpm build:desktop       # Native desktop build

corepack pnpm --filter @codex-prism/desktop test
corepack pnpm --filter @codex-prism/desktop exec tsc -b
corepack pnpm --filter @codex-prism/desktop build  # Frontend typecheck and Vite build
cargo test --locked --manifest-path crates/prism-core/Cargo.toml
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
corepack pnpm test:release
```

Use focused tests while iterating. Run broader checks when the affected behavior
warrants them; report skipped/platform-specific checks. Core tests do not need
Tauri or a Codex account; Unix protocol fixtures use Python 3. Some TeX and
Ghostscript integration tests are explicitly ignored unless their tools are
available. Desktop smoke harnesses are under `apps/desktop/scripts/*-smoke`.
Do not treat Linux success as verification of Windows or macOS behavior.

Use temporary projects for filesystem/Git tests and compiler experiments.
Inspect user projects read-only unless the task explicitly includes editing them.
Avoid sweeping formatting changes and preserve unrelated working-tree files.

## Behavior to preserve

- Each chat edits its own application-managed copy. Keep accepts that chat's whole proposal through a three-way merge against the latest main document. Conflicts leave main untouched. Follow-ups refine pending proposals; they do not implicitly accept another chat's work.
- Route turns, approvals, cancellation, build results, and recovery by their owning chat/workspace and generation. Do not grant isolated agents write access to main or another chat's workspace.
- Manual source editing remains locked while agents run or proposals remain unresolved. Closing a tab must not discard pending work. Chats without pending work show main; pending chats show their own PDF through the ordinary preview panel.
- Preserve the visible PDF while agents work. Keep source mappings, errors, and PDFs tied to the same build. Reuse accepted PDFs only when build inputs match, including assets; otherwise compile. Never substitute another chat's build after a failure.
- Document acceptance records ordinary Git history and must preserve unrelated working-tree/staged changes. Retain durable application journals and visible history warning/retry behavior.
- Native Plan mode uses app-server collaboration modes. Shift+Tab toggles it only in the idle composer. Empty planning workspaces must not leave Keep controls or locks; existing changes remain recoverable.
- Compilation uses external TeX Live, or MiKTeX on Windows, with pdfLaTeX/XeLaTeX/LuaLaTeX and bibliography tools. Do not reintroduce embedded Tectonic. Keep compilation bounded and cancellable.
- Private templates live under the configured home's `.codexprism/templates`. Preview builds use isolated copies; never modify the template library when previewing or creating a project.
- Skills and Python environments are optional. Do not start skill setup automatically on installation or project opening.
- Keep idle work bounded: avoid polling, render loops, repeated source scans, and redundant compilation. Check ownership/revision before applying async results.
- Windows paths may contain spaces, mixed separators, or canonical `\\?\` prefixes. Use path-aware operations and platform-independent assertions; test executable discovery and file permissions explicitly.

## Changes and releases

`CHANGELOG.md` is the authoritative project changelog. Add user-visible changes
under Unreleased. The two package changelogs are upstream archives. For a release,
move the appropriate changes into its version section and add
`docs/releases/<version>.md`; do not present unpublished changes as released.

Follow `docs/releases/README.md` for release preparation and platform validation.
New releases are built/published on GitHub (`beniz/codex-prism`).
Check remotes rather than assuming `origin` is GitHub.
In this checkout, the GitHub remote is named `github`.

- Prepare synchronized versions with `corepack pnpm release:prepare <version>` in a clean checkout. Use an isolated checkout if unrelated local files prevent preparation; never delete them to make the tree clean.
- Review release notes and version changes, run release tests/checks, commit, then create and push the annotated `v<version>` tag when releasing is requested.
- `.github/workflows/release.yml` builds Linux x86_64 `.deb`/AppImage, Windows x64 setup, and macOS Apple Silicon DMG packages from the same tag. It stages a draft, not a public release.
- Verify platform jobs, package checks, notes, asset set, checksums, and source provenance before publishing. Do not move a published tag or overwrite published assets.
- Commit, push, merge, and release within the user's requested scope. A request to commit alone does not imply pushing or publishing.

See `README.md`, `CONTRIBUTING.md`, and `docs/releases/windows.md` for setup and
platform details. Historical release notes describe behavior at that release;
current code and the invariants above govern new changes.
