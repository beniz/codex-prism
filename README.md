<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="codex-prism logo" />
</p>

<h1 align="center">codex-prism</h1>

<p align="center">Scientific writing with Codex, LaTeX, and PDF preview in one workspace.</p>

codex-prism is a local, single-user desktop application powered by your installed Codex CLI. Write and revise papers with an AI assistant, edit LaTeX when you need to, and review the compiled document alongside your conversation.

![codex-prism workspace with project files, LaTeX source, Codex chat, and a compiled PDF preview](docs/images/codex-prism-workspace.png)

[Quickstart](#quickstart) · [Features](#features) · [Build from source](#build-from-source) · [Releases](https://git.jolibrain.com/beniz/codex-prism/releases)

## Quickstart

Packaged releases currently target **Ubuntu 26.04 LTS, x86_64**.

**Windows 10/11 x64:** Download the `-setup.exe` installer from the
[Windows downloads](https://github.com/beniz/codex-prism/actions/workflows/build-windows.yml),
run it, and follow the setup wizard. Setup installs missing Codex, LaTeX (MiKTeX)
and WebView2 dependencies automatically, reusing existing installations. It also
offers Ghostscript for optimized PDF export; complete its setup wizard to enable
that feature. Then open codex-prism and use **Connection → Sign in** to start
working. You do not need to build the app or install Node.js or Rust.

### 1. Install the application

The following installation commands are for Ubuntu. Windows users can run the
installer above and continue to **3. Open a project and start writing** after
signing in.

Download the `.deb` or `.AppImage` from [the releases page](https://git.jolibrain.com/beniz/codex-prism/releases). For version 1.4.0, install the Debian package from your download directory:

```sh
sudo apt install ./codex-prism-1.4.0-linux-x86_64.deb
```

Or run the AppImage:

```sh
chmod +x codex-prism-1.4.0-linux-x86_64.AppImage
./codex-prism-1.4.0-linux-x86_64.AppImage
```

Launch the installed Debian package from your applications menu. Packaged builds do not require the application's Node.js or Rust build toolchain. Updates are installed manually; download checksums are included in each release.

### 2. Set up Codex and LaTeX

Install the Codex CLI separately and authenticate with `codex login`, or use **Connection → Sign in** in the app. The app uses the installed CLI's account and configuration. If Codex is not found on PATH, set its full executable path in **Connection** and restart the app.

Install system TeX Live to compile documents:

```sh
sudo apt install texlive-latex-extra texlive-publishers texlive-fonts-recommended texlive-xetex texlive-luatex texlive-bibtex-extra biber
```

Python environments and external scientific skills are optional and can be configured later in settings.

### 3. Open a project and start writing

Open an existing LaTeX project or create one from a template. Ask Codex to help draft or revise your document, and review edits with **Keep** or **Undo**. Sending another chat prompt implicitly keeps pending changes once the new turn starts successfully.

In **All Projects**, use **New folder** in the sidebar to organize projects into virtual folders. The selector on each project card changes its folder without moving files on disk. Folder assignments are saved locally; removing a folder returns its projects to **Unfiled**. The project library has no ten-project limit.

Use **Recompile** to build the PDF, or enable **Auto** for automatic recompilation. Existing PDFs load immediately when available. Toggle **Code** beside **Layout** to hide the LaTeX source while keeping the chat and PDF visible.

Use **Export PDF** to choose the original PDF or an optimized ebook copy. Ebook export requires [Ghostscript](https://ghostscript.com/) (`gs`) and can reduce image detail for screen reading. The working PDF stays unchanged; if optimization does not reduce the size, the original is exported instead.

## Features

- **Codex assistant** — chat alongside the document, attach project files, select models and reasoning effort, approve tool requests, and resume conversations.
- **LaTeX editor** — CodeMirror with syntax highlighting, search, multi-file projects and auto-save. Hide the source panel while keeping the chat and PDF visible.
- **PDF preview** — MuPDF rendering with SyncTeX navigation, zoom and text selection. Existing PDFs load at startup before a new compilation is needed.
- **Local compilation** — your installed TeX tools (TeX Live, or MiKTeX on Windows) run pdfLaTeX by default; `% !TEX program = xelatex` or `lualatex` selects another engine. Auto-recompile is optional.
- **History and proposed changes** — ordinary document Git commits, a compact history list and restoration, plus Keep/Undo review of assistant edits.
- **Python environment** — optional [uv](https://docs.astral.sh/uv/) installation and explicit project environment setup in settings. Opening a project does not create or modify its environment.
- **Scientific writing instructions** — project `AGENTS.md` guidance, including TikZ for technical drawings, and optional skills from [K-Dense Scientific Skills](https://github.com/K-Dense-AI/claude-scientific-skills).
- **Templates and project wizard** — start papers, theses, presentations and other LaTeX documents, including private local templates.
- **Desktop tools** — external editor integration and light/dark themes.

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

Visible templates get PDF previews using system TeX Live. Builds run one at a time in isolated copies, time out after 60 seconds, and cache PDFs in the application's data directory using the template contents and compiler version. Previews do not change the library or send an AI request. A failed preview offers **Retry** and still allows project creation.

Creating a project copies the complete starter body, bibliography, classes, styles, instructions, and assets, including PDF figures. It excludes `template.json`, Git and application history, dependency environments, and LaTeX intermediate files. Symlinks are rejected. The destination must be outside the library and must not already exist. An existing `AGENTS.md` is preserved; otherwise the app adds its default instructions. The chosen main document opens immediately. An optional creation prompt asks Codex to adapt the existing starter content.

## Data and privacy

Documents and compilation stay on your machine. AI requests send prompts and the content used by Codex to its configured provider for inference. Credentials are managed by the installed Codex CLI; signing out affects that shared login.

Existing project instructions, skills, Python environments and history are preserved. Document history uses the document’s normal `.git` repository (or its existing parent repository/worktree). Private `.codexprism/history` and legacy `.claudeprism/history.git` repositories migrate automatically when no normal repository exists; otherwise they remain preserved as separate archives. New project instructions use `AGENTS.md`, and scientific skills use `.agents/skills`.

History records explicit saves, checkpoints before agent turns, and accepted agent edits. **Keep** records the selected file; **Keep all** records one commit for the batch, including acceptance from visual review. Autosave and compilation do not create commits. History’s **Save checkpoint** and **Restore** actions provide manual recovery points; restoring preserves later commits and recompiles the document.

**Include prompt in commits** is a per-document option in History, off by default. It applies to future turns and includes only user prompts, not attachments or tool output. Included prompts travel with remote pushes. Configure remotes and push with your usual Git tools from the document directory; codex-prism does not push automatically.

Externally staged changes, detached HEAD and ongoing merges/rebases pause automatic history recording without blocking document edits or acceptance. History displays the reason and offers Retry using captured content. Application state and generated outputs are excluded from new history commits; already tracked files remain tracked.


The application is currently local and single-user. Browser hosting and project collaboration are not included yet.

## Build from source

For development or running directly from a repository checkout on Ubuntu 26.04 LTS x86_64, follow these steps. Codex and TeX Live are set up as described in the [quickstart](#quickstart).

1. Install Node.js 22+, Corepack, Git, and the Linux Tauri development libraries (Ubuntu/Debian):
   ```sh
   sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev
   ```
2. Install Rust with rustup. This checkout pins Rust 1.88.0.
3. Clone the repository and start the app:
   ```sh
   git clone https://git.jolibrain.com/beniz/codex-prism.git
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

### Verification

```sh
corepack pnpm --filter @codex-prism/desktop test
corepack pnpm --filter @codex-prism/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
node scripts/verify-codex.mjs
```

The last command checks the installed server's initialization, account status and model catalogue without sending an inference prompt or printing credentials. Add `--exercise` to run one small inference turn in a disposable temporary directory and verify file editing and session resume. Integration was checked against Codex 0.160.1; an incompatible app-server protocol reports an error rather than falling back to another provider.

For a hands-on acceptance check, open a disposable LaTeX project, ask Codex to edit a paragraph, verify streaming and model selection, then Keep one file and Undo another. Test Stop, an approval request, reopening a chat and restarting with a pending review. Check compilation/PDF navigation and externally edit a file before Save/Undo to verify conflict protection.

### Architecture and change review

- `crates/prism-core` contains the headless Rust backend: projects/files, compilation, history, agent supervision/review, Python environments and scientific skills. The desktop crate supplies thin Tauri commands, event delivery and native integration.
- The Rust backend supervises one `codex app-server --listen stdio://` process. The webview receives conversation events and approval requests; credentials remain in Codex's normal credential store.
- Projects have persistent UUIDs. File operations carry `{projectId, path}` with paths relative to the project directory. The desktop adapter resolves host paths for native pickers and assets. Rename preserves the project ID; a backend relocate operation is also available for a later project-management UI.
- The agent saves dirty buffers before starting, runs with `workspace-write` and `on-request` approvals, and allows one active turn per project. Unrelated CLI sessions are not imported into its chat list.
- File editing is locked during a turn and pending review, but pending review does not block the next chat prompt. Sending a new prompt implicitly keeps pending changes once Codex confirms the new turn has started; Undo then applies only to the new turn. A failed start preserves the prior review. At completion, the app reviews the actual project source/asset changes, including command-generated changes. Keep accepts the current disk contents; Undo restores the saved bytes only if the file still matches the completed turn. Text saves likewise refuse to overwrite an external edit.
- Review baselines and session mappings persist in the application's data directory, separately from project source. Restart recovers interrupted reviews. Prompts are never automatically resubmitted after a disconnect. Generated build files, hidden/environment directories and symlinks are excluded from snapshots; changes outside that scope cannot be undone by project review.
- LaTeX/PDF and history features remain; Python and external scientific skills are optional. Existing private Git history migrates to a normal document repository with commits, labels and remotes preserved. New project instructions use `AGENTS.md`; scientific skills use `.agents/skills`.
- Hosts construct a shared `prism_core::Backend` with explicit application-data, home and temporary paths, an `EventSink`, and optionally a native directory-permission hook. Construction recovers interrupted reviews; `shutdown().await` rejects new work, stops the agent and background installers, drains admitted work, and retains persisted projects/builds. The headless default never opens native permission dialogs.
- `apps/desktop/src/lib/backend` is the frontend transport boundary and `desktop-host.ts` owns desktop window/dialog/open-link APIs. The implementation remains Tauri-only at this stage; a hosted transport, browser import/export, authentication and remote isolation remain future work.

### Creating releases

Linux releases target Ubuntu 26.04 LTS x86_64 and are hosted on [Gitea](https://git.jolibrain.com/beniz/codex-prism/releases). The release tooling supports local builds without a CI runner, checks version consistency, and collects packages with checksums. Uploads create a draft for review before publication.

See [the release guide](docs/releases/README.md) for version preparation, tagging, building, uploading, and optional Gitea Actions setup.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the inherited development guidelines. The build and verification commands above describe this fork.

## License

[MIT](./LICENSE)

## Acknowledgments

This project is a fork of [ClaudePrism](https://github.com/delibae/claude-prism) by delibae, adapted to use Codex as its AI backend. ClaudePrism started from [Open Prism](https://github.com/assistant-ui/open-prism) by [assistant-ui](https://github.com/assistant-ui).
