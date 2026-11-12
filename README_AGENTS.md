# codex-prism: detailed reference for agents and maintainers

Start with [README.md](README.md) for installation and a product overview. Coding agents must also read [AGENTS.md](AGENTS.md), which contains repository working instructions and behavioral invariants. This file is reference material, not a replacement for those instructions or the writing `AGENTS.md` inside a user's LaTeX project.

This reference describes the current source tree. Published behavior is documented in [release notes](docs/releases/README.md); [CHANGELOG.md](CHANGELOG.md) distinguishes released changes from Unreleased work.

## Contents

- [Installation](#installation)
- [Everyday workflows](#everyday-workflows)
- [Concurrent chats and review](#concurrent-chats-and-review)
- [History, storage, and privacy](#history-storage-and-privacy)
- [LaTeX compilation](#latex-compilation)
- [Private templates](#private-templates)
- [Project data sources](#project-data-sources)
- [Referencing data sources in chat](#referencing-data-sources-in-chat)
- [SSH data sources](#ssh-data-sources)
- [Shared project instructions](#shared-project-instructions)
- [Build from source](#build-from-source)
- [Verification](#verification)
- [Architecture and change review](#architecture-and-change-review)
- [Creating releases](#creating-releases)

## Installation

Download published packages from [the latest GitHub release](https://github.com/beniz/codex-prism/releases/latest). Packages target Ubuntu 26.04 LTS x86_64, Windows 10/11 x64, and macOS Apple Silicon. Linux binaries are not guaranteed to work on older distributions; Intel/universal macOS packages are not provided.

Packaged builds do not require the application's Node.js or Rust build toolchain. Updates are manual. Each release includes `SHA256SUMS` and `release.json` with source provenance. Windows installers are unsigned; macOS apps are ad-hoc signed and not notarized.

### Linux installation

From the download directory, replace `VERSION` with the actual downloaded version. Install the Debian package:

```sh
sudo apt install ./codex-prism-VERSION-linux-x86_64.deb
```

Or make the AppImage executable and run it:

```sh
chmod +x ./codex-prism-VERSION-x86_64.AppImage
./codex-prism-VERSION-x86_64.AppImage
```

Launch the installed Debian package through the applications menu. Install TeX Live for compilation:

```sh
sudo apt install texlive-latex-extra texlive-publishers texlive-fonts-recommended \
  texlive-xetex texlive-luatex texlive-bibtex-extra biber
```

Install Codex if missing, using its [official installation instructions](https://developers.openai.com/codex/cli):

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

### macOS installation

Open the `.dmg` and drag codex-prism to Applications. Install missing tools with Homebrew:

```sh
brew install --cask codex mactex-no-gui
```

See the [Codex instructions](https://developers.openai.com/codex/cli) and [MacTeX package](https://formulae.brew.sh/cask/mactex-no-gui). Reopen the terminal and relaunch the application after installing TeX tools. After a blocked first launch, use **System Settings → Privacy & Security → Open Anyway**.

### Windows installation

Run the `-setup.exe` installer. Setup reuses existing Codex, TeX, and WebView2 installations and provisions missing prerequisites. Codex and MiKTeX installation requires Windows App Installer (`winget`) and internet access. Existing tools are never upgraded by setup.

Ghostscript is optional: complete its separate setup wizard to enable optimized PDF export. Cancelling that wizard does not prevent app installation, and silent setup skips it. Prerequisites remain installed when codex-prism is removed. See [Windows setup](docs/releases/windows.md) for discovery rules, installation logs, permissions, and enterprise deployment considerations.

### Connect Codex

Use **Connection → Sign in**, or authenticate the installed CLI:

```sh
codex --version
codex login
```

The app uses the installed CLI's account and configuration. If Codex is not found on PATH, set the full executable path in **Connection** and restart the app. On supported setups, discovery also checks Codex bundled with ChatGPT and standard Windows installations.

[Official Codex setup](https://developers.openai.com/codex/cli) also supports `npm install -g @openai/codex` when Node/npm is already available. Node is not required to run packaged codex-prism or a standalone Codex installation.

## Everyday workflows

Open an existing LaTeX project or create one from a template. Chat alongside the document, attach project files, select a model and reasoning effort, approve tool requests, and resume conversations. The latest model/effort settings persist per project. Shift+Tab toggles native Plan mode in an idle composer; completed plans offer Implement/Refine actions. Up recalls previous prompts in an empty composer; Down moves forward and returns to an empty draft.

The CodeMirror LaTeX editor supports syntax highlighting, search, multi-file projects, and auto-save. Toggle **Code** beside **Layout** to hide source while keeping chat and PDF visible. Opening a source file through the navigator reveals its panel. External editor integration and light/dark themes are available.

The MuPDF preview supports zoom and text selection. Click outline headings to navigate, including individual slides in supported presentations. Double-click LaTeX text to navigate to its position in the current PDF without changing editor focus or word selection. Mapping uses SyncTeX and can fall back to the nearest mapped line in the same file; changed or ambiguous source may require recompilation. Select PDF text and choose **Navigate to source** in its toolbar to jump back to LaTeX.

**Capture & Ask** attaches a PDF region to chat. Its current shortcut is Ctrl+Shift+X (Cmd+Shift+X on macOS); earlier releases used Ctrl/Cmd+X. Recompile builds the PDF; **Auto** enables automatic recompilation. Existing PDFs load immediately when available, even without a compiler.

In **All Projects**, use **New folder** in the sidebar to organize projects into virtual folders. The selector on each project card changes its folder without moving files on disk. Assignments are local; removing a folder returns its projects to **Unfiled**. The project library has no ten-project limit.

### PDF export

**Export PDF** offers Original PDF, High quality (300 dpi), and Compact (150 dpi). Optimized exports require [Ghostscript](https://ghostscript.com/); the high-quality mode is the default. Compact uses Ghostscript's ebook preset and can reduce figure detail. The working PDF stays unchanged. If optimization does not reduce the size, the original is exported instead.

```sh
# Ubuntu
sudo apt install ghostscript
# macOS with Homebrew
brew install ghostscript
```

Windows setup offers the optional Ghostscript wizard. Original export works without Ghostscript.

### Optional environments and skills

Python environments use [uv](https://docs.astral.sh/uv/), with optional installation and explicit project environment setup in settings. Opening a project does not create or modify an environment. Scientific skills are optional and available through settings; first launch does not require skill setup.

New projects receive writing guidance in `AGENTS.md`, including TikZ for technical drawings. Optional skills come from [K-Dense Scientific Skills](https://github.com/K-Dense-AI/claude-scientific-skills). Existing project instructions, environments, and skills are preserved.

## Concurrent chats and review

Each chat edits an application-managed project copy. Different chats run concurrently; a second prompt in a running chat steers that turn. Follow-ups refine the same pending proposal and preserve its original merge base. Starting another chat never implicitly accepts work.

**Keep** accepts a whole proposal through a three-way merge against the latest main document. Clean changes, including non-overlapping edits in one file, merge automatically. Conflicts leave main untouched and offer **Fix with agent**. Repair starts a candidate from current main, includes already cleanly merged changes, and produces another proposal for review; it never auto-applies. **Discard changes** affects only the selected proposal.

Manual editing is locked while any agent runs or proposals remain unresolved. Closing a tab does not discard pending work. The source editor stays on main; the ordinary PDF panel follows the selected chat's pending proposal and keeps a visible PDF during work. Chats with no pending proposal show main. A successful unchanged turn releases its empty proposal; startup recovers older empty completed proposals while preserving edits and repairs.

After Keep, reuse the proposal PDF only when its build inputs match the accepted main contents. Otherwise compile main, including when another chat's accepted edits change the merged result. A successful text merge can still produce a compilation error. Compilation errors remain actionable through the repair flow. Optional visual reports compare immutable base/result builds and are off by default.

Approval requests, cancellation, completion, and builds belong to the originating chat/workspace and generation. Interrupted runs retain captured edits and are not silently resubmitted. Legacy project-wide reviews must be resolved before concurrent proposals can run.

## History, storage, and privacy

Documents and compilation stay on your machine. AI requests send prompts and the content used by Codex to its configured provider for inference. Credentials are managed by the installed Codex CLI; signing out affects that shared login.

Existing project instructions, skills, Python environments and history are preserved. Document history uses the document’s normal `.git` repository (or its existing parent repository/worktree). Private `.codexprism/history` and legacy `.claudeprism/history.git` repositories migrate automatically when no normal repository exists; otherwise they remain preserved as separate archives. New project instructions use `AGENTS.md`, and scientific skills use `.agents/skills`.

History records explicit saves, checkpoints before agent turns, and accepted agent edits. **Keep** accepts the selected chat's whole proposal and records one acceptance commit; there are no per-file acceptance decisions for concurrent proposals. Older project-wide reviews retain their legacy per-file/batch controls and must be resolved before concurrent proposals can start. Autosave and compilation do not create commits. History's **Save checkpoint** and **Restore** actions provide manual recovery points; restoring preserves later commits and recompiles the document.

Acceptance commit titles use the first prompt for that proposal, shortened to a single line. Commit bodies summarize the accepted file changes, with text excerpts where available. Follow-up prompts refine the same proposal; after Keep or Discard, the next proposal starts a new commit subject. Git can therefore contain prompt-derived information even when full prompt inclusion is disabled.

**Include prompt in commits** is a per-document option in History, off by default. It applies to future turns and includes only user prompts, not attachments or tool output. Included prompts travel with remote pushes. Configure remotes and push with your usual Git tools from the document directory; codex-prism does not push automatically.

Externally staged changes, detached HEAD and ongoing merges/rebases pause automatic history recording without blocking document edits or acceptance. History displays the reason and offers Retry using captured content. Application state and generated outputs are excluded from new history commits; already tracked files remain tracked.

History also includes local images referenced by literal `\includegraphics` paths, including PDF figures excluded by `*.pdf` ignore rules. It supports `\graphicspath`, omitted image extensions, and included `.tex` sources. Accepting agent changes includes existing untracked figures referenced by the accepted source. Compiled document PDFs stay excluded. Missing, external, or symlinked figures produce a history error; copy them into the project and correct their references before creating a new checkpoint. Filenames computed by TeX macros are not resolved automatically.


The application is currently local and single-user. Browser hosting and simultaneous multi-user editing are not included. “Git-collaborative” describes working with agents through ordinary Git history.

## LaTeX compilation

The default engine is **pdfLaTeX**. For XeLaTeX or LuaLaTeX, add one of these comments within the main document's first 20 lines:

```tex
% !TEX program = xelatex
```

```tex
% !TEX program = lualatex
```

Individual documents may require additional fonts, publisher classes or language packages. The app uses your installed TeX tools. On Windows, setup enables automatic missing-package downloads only for a newly installed MiKTeX; existing distribution settings are preserved. Existing PDFs can be viewed without a compiler installed.

Bibliography processing uses the control files generated by the first LaTeX pass to select Biber or BibTeX, including when bibliography packages are loaded through a local style or class.

**Incremental** is enabled by default in the current source tree. It reuses compiler state only when inputs and outputs can be verified, skips unchanged bibliography processing when safe, and falls back to a full build when uncertain. Turn Incremental off to request full compilation every time.

## Private templates

Put each private template in its own folder under `~/.codexprism/templates`, for example:

```text
~/.codexprism/templates/lab-paper/
  paper.tex
  references.bib
  local.sty
  assets/logo.pdf
  AGENTS.md
  template.json
```

Only the LaTeX document is required. Optional `template.json` metadata controls the gallery entry:

```json
{
  "name": "Lab Paper",
  "description": "Our complete manuscript starter",
  "category": "academic",
  "tags": ["lab", "manuscript"],
  "mainFile": "paper.tex"
}
```

Every metadata field is optional. Categories are `academic`, `professional`, `creative`, or `starter` (the default). Without `mainFile`, the app selects the unique `.tex` file containing an uncommented `\documentclass`, or the only `.tex` file. Nested paths such as `document/paper.tex` are supported. Ambiguous or invalid folders show an issue in the gallery while valid templates remain available.

Open the template gallery and select **My Templates**. **Refresh** rescans the library after you edit or add folders. Private templates also appear in the main gallery, search, and category counts. No import step is needed.

Visible templates get PDF previews using the installed TeX toolchain. Builds run one at a time in isolated copies, time out after 60 seconds, and cache PDFs in the application's data directory using the template contents and compiler version. Previews do not change the library or send an AI request. A failed preview offers **Retry** and still allows project creation.

Creating a project copies the complete starter body, bibliography, classes, styles, instructions, and assets, including PDF figures. It excludes `template.json`, Git and application history, dependency environments, and LaTeX intermediate files. Symlinks are rejected. The destination must be outside the library and must not already exist. An existing `AGENTS.md` is preserved; otherwise the app adds its default instructions. The chosen main document opens immediately. An optional creation prompt asks Codex to adapt the existing starter content.

## Project data sources

Project creation and **Project settings → Data sources** offer **Add files**,
**Add directory**, and **Add SSH connection**. Sources are optional and are saved
even when you create a project without an initial writing prompt. Every chat
receives the current source manifest on its next turn.

Files are copied when you save: documents go into `attachments/`, and images use
an existing image folder or `prism-uploads/`. Selecting an existing project file
registers it without copying it again. Originals are not synchronized. Local
and SSH directories remain external. Agents consult sources on demand; adding a
source does not automatically insert content or citations into your document.

The sidebar groups file sources into **Files · N** with an availability indicator;
click it to manage individual files in settings. Removing a registration keeps
the project file. Delete files separately through the Files navigator. Adding
files is disabled while running work or pending proposals lock the document.

Existing files under `attachments/` are registered once, without following
symlinks. Removed registrations are not rediscovered. Older images elsewhere can
be registered explicitly. File-source paths stay project-relative and each chat
reads its own proposal copy.

## Referencing data sources in chat

Type `@` in the composer and press **Tab** to list registered source IDs, or
start typing an ID to filter suggestions. Select a source, then browse its
folders with Tab or Enter—for example `@attachments:/paper.pdf` or
`@research-data:/reports/results.csv`. Paths with spaces are quoted automatically.
Up/Down selects a suggestion; Escape closes the picker. Enter accepts a visible
suggestion instead of sending the message.

Completion includes only registered sources. Copied files are grouped by folder
(`attachments`, `figures`, or `project` for root-level files). Directory sources
have stable IDs shown in project settings; duplicate names receive suffixes.
Removing a source retires its ID so old references cannot silently point elsewhere.
Local and SSH directories are browsed on demand without indexing or model calls.
Use **Refresh / retry** for changed contents or an unavailable source.

References also work when typed manually and when steering a running chat. They
resolve against that chat's source configuration and proposal workspace. Invalid
references keep the draft intact. Selecting a reference does not import files;
SSH access still uses the existing research/import tools.

## SSH data sources

In **Project settings → Data sources**, choose **Add SSH connection**, enter an
SSH host alias (or `user@host`), and add one or more absolute remote directories.
Use **Test connection**, then **Save**. The sidebar shows each source's
availability; refresh checks it again. Changes apply to every chat from its next
turn, including existing conversations.

Prism uses the machine's SSH client, configuration, keys and agent. Establish
SSH trust/authentication beforehand. Remote hosts currently need Linux or macOS
and an **already running, authenticated Codex app-server**. Prism never installs,
starts or upgrades that server. If needed, connect the host through **ChatGPT
Settings → Connections** first. Prism does not read ChatGPT's private connection
registry; enter the SSH alias in Prism as well.

The default transport attaches through `codex app-server proxy`. Under
**Connection options**, provide an absolute remote Codex executable path if it
is absent from the noninteractive SSH PATH, and optionally a control-socket path.
Alternatively, select an existing WebSocket listener's remote loopback port;
Prism tunnels it through SSH. An optional remote token-file path is supported;
the token stays in memory and is never saved in project settings.

All project chats receive remote research and import tools. Research runs in a
dedicated remote thread and scratch directory; document editing, compilation,
Git history and Keep remain local. The remote agent is instructed not to modify
sources. **This is instruction-based protection, not guaranteed filesystem
read-only access.** Review remote command approval requests accordingly.

Imports require Python 3 remotely, are limited to 8 MiB per file, reject
traversal/symlink escapes and local overwrites, and write only into the owning
chat's proposal. Import needed scratch artifacts during the same turn; scratch
cleanup is best-effort when that turn ends. Work is limited to two simultaneous
remote jobs and 15 minutes per research request. Stopping a chat targets only its
remote work. If a connection is lost or Prism is forcibly terminated, remote
interruption/cleanup cannot be guaranteed; Prism never shuts down the shared
server or cancels other clients' sessions.

Developer validation and opt-in live tests are documented in
[SSH data-source testing](docs/ssh-data-sources.md).

## Shared project instructions

Click the project title to open **Project settings**, then edit the shared project prompt to save standing context for all
chats in a project. Instructions are stored locally in Prism and supplied on each
new turn, including resumed chats. Changes do not interrupt running turns.
Use registered data sources for material outside the project. Instructions alone do not upload files, register sources, or change `AGENTS.md`. Save an empty value to clear them.

## Build from source

For development or running directly from a repository checkout on Ubuntu 26.04 LTS x86_64, follow these steps. Codex and TeX Live are set up as described under [Installation](#installation).

1. Install Node.js 22+, Corepack, Git, and the Linux Tauri development libraries (Ubuntu/Debian):
   ```sh
   sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev
   ```
2. Install Rust with rustup. This checkout pins Rust 1.90.0.
3. Clone the repository and start the app:
   ```sh
   git clone https://github.com/beniz/codex-prism.git
   cd codex-prism
   corepack pnpm install --frozen-lockfile
   corepack pnpm dev:desktop
   ```

The default launcher disables automatic native restarts and frontend hot reloads. To apply application code changes, close the app, stop the launcher with Ctrl+C if needed, and run `corepack pnpm dev:desktop` again. Editing your LaTeX documents and compiling PDFs still works normally.

For a short Linux command available from any directory, install a symlink from this checkout:

```sh
mkdir -p ~/.local/bin
ln -s "$PWD/scripts/codex-prism" ~/.local/bin/codex-prism
```

With `~/.local/bin` on your PATH, run `codex-prism`. Each launch uses the current checkout, rebuilding the native app as needed and serving the current frontend. Keep the terminal open while using the app. Use `codex-prism --watch` to enable automatic reloads. If you move the checkout, update the symlink.

To opt into automatic reloads and native rebuilds during development, use `corepack pnpm dev:desktop:watch`.

To build an installable desktop package: `corepack pnpm build:desktop`.

If you also install a packaged release, the `~/.local/bin/codex-prism` launcher may take precedence over the packaged command. It continues to run the repository checkout.

## Verification

```sh
corepack pnpm --filter @codex-prism/desktop test
corepack pnpm --filter @codex-prism/desktop build
cargo test --locked --manifest-path crates/prism-core/Cargo.toml
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
corepack pnpm test:release
node scripts/verify-codex.mjs
```

The last command checks the installed server's initialization, account status and model catalogue without sending an inference prompt or printing credentials. Add `--exercise` to run one small inference turn in a disposable temporary directory and verify file editing and session resume. Codex 0.160.1 was an earlier integration baseline, not a promise that every later version is compatible. Run the verifier against the installed CLI; an incompatible app-server protocol reports an error rather than falling back to another provider.

For a hands-on acceptance check, use a disposable LaTeX project:

1. Start two chats editing different sections; verify streaming, model selection, and independent previews.
2. Keep one whole proposal, then Keep the other. Verify the final main document includes both changes and both resolved chats show the same PDF.
3. Try overlapping edits. Confirm a conflict leaves main untouched; use **Fix with agent** and review the new proposal before Keep.
4. Discard another proposal and verify only that chat's pending work is removed.
5. Test Stop, an approval request, reopening a chat, and restart with pending work. A completed question-only turn should leave no empty review or stale proposal PDF.
6. Check compilation, source/PDF navigation, and an external edit before Save/Keep to verify conflict protection.

Core tests need no Tauri or Codex account; Unix protocol fixtures use Python 3. Some TeX/Ghostscript tests and live SSH tests are opt-in. Use temporary projects, and do not treat Linux success as Windows or macOS verification. Desktop smoke harnesses live under `apps/desktop/scripts/*-smoke`.

## Architecture and change review

- `crates/prism-core` contains the headless Rust backend: projects/files, compilation, history, agent supervision/review, Python environments and scientific skills. The desktop crate supplies thin Tauri commands, event delivery and native integration.
- The Rust backend supervises one `codex app-server --listen stdio://` process. The webview receives conversation events and approval requests; credentials remain in Codex's normal credential store.
- Projects have persistent UUIDs. File operations carry `{projectId, path}` with paths relative to the project directory. The desktop adapter resolves host paths for native pickers and assets. Rename preserves the project ID; a backend relocate operation is also available for a later project-management UI.
- The agent saves dirty buffers before starting, runs with `workspace-write` and `on-request` approvals, and allows one active turn per chat. Unrelated CLI sessions are not imported into its chat list.
- Manual file editing is locked while agents run or proposals await review. Chats edit isolated copies concurrently; follow-up prompts refine their own pending proposal. Keep merges the selected chat’s proposal into the latest main document, preserving accepted changes from other chats or reporting a conflict without modifying main. Discard affects only that proposal. Text saves likewise refuse to overwrite an external edit.
- Review baselines and session mappings persist in the application's data directory, separately from project source. Restart recovers interrupted reviews. Prompts are never automatically resubmitted after a disconnect. Snapshot rules exclude generated build outputs, application/Git metadata, and dependency environments. Inputs that cannot be represented safely, including symlinks, are rejected instead of silently producing an incomplete workspace. Review covers only files represented by the workspace snapshot.
- LaTeX/PDF and history features remain; Python and external scientific skills are optional. Existing private Git history migrates to a normal document repository with commits, labels and remotes preserved. New project instructions use `AGENTS.md`; scientific skills use `.agents/skills`.
- Hosts construct a shared `prism_core::Backend` with explicit application-data, home and temporary paths, an `EventSink`, and optionally a native directory-permission hook. Construction recovers interrupted reviews; `shutdown().await` rejects new work, stops the agent and background installers, drains admitted work, and retains persisted projects/builds. The headless default never opens native permission dialogs.
- `apps/desktop/src/lib/backend` is the frontend transport boundary and `desktop-host.ts` owns desktop window/dialog/open-link APIs. The implementation remains Tauri-only at this stage; a hosted transport, browser import/export, authentication and remote isolation remain future work.

## Creating releases

GitHub Actions builds Linux x86_64, Windows x64, and macOS Apple Silicon packages and stages them together in a [draft GitHub release](https://github.com/beniz/codex-prism/releases). Linux packages target Ubuntu 26.04 LTS. Releases include checksums and source provenance and are published after verification.

See [the release guide](docs/releases/README.md) for version preparation, tagging, builds, and publication.

## Further reading

- [CONTRIBUTING.md](CONTRIBUTING.md): contribution workflow and development conventions.
- [AGENTS.md](AGENTS.md): repository instructions and invariants for coding agents.
- [CHANGELOG.md](CHANGELOG.md): authoritative release history and Unreleased changes.
- [README.md](README.md#acknowledgments): project origins and acknowledgments.
- [LICENSE](LICENSE): MIT license.

### Application updates

[Updater behaviour, signing keys, and CI upgrade testing](docs/updating.md).
Native update operations live in the Tauri host. `updater-test` is a disposable
fixture feature; never enable it in production builds. Release signing keys must
not be available to PR jobs. Source builds never self-replace.
