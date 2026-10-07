# codex-prism — local desktop development

codex-prism is a scientific writing workspace powered by the **installed Codex app-server**, with a Tauri desktop editor. It is a local, single-user application; a browser-hosted server and collaboration are not included yet.

## Run locally (Ubuntu 26.04 LTS, x86_64)

1. Install Node.js 22+, Corepack, Git, and the Linux Tauri development libraries (Ubuntu/Debian):
   ```sh
   sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev
   ```
2. Install Rust with rustup. This checkout pins Rust 1.88.0.
3. Install Codex separately and log in with `codex login`, or use **Connection → Sign in** in the application. A ChatGPT subscription uses Codex's normal login; no API key is required for that login mode. The app shares the installed CLI's account/configuration. Signing out affects that shared login.
4. From this repository:
   ```sh
   corepack pnpm install --frozen-lockfile
   corepack pnpm dev:desktop
   ```
   If a desktop launcher cannot find Codex on PATH, set its full executable path in **Connection** and restart the application.

The default launcher disables automatic native restarts and frontend hot reloads. To apply application code changes, close the app, stop the launcher with Ctrl+C if needed, and run `corepack pnpm dev:desktop` again. Editing your LaTeX documents and compiling PDFs still works normally.

For a short Linux command available from any directory, install a symlink from this checkout:

```sh
mkdir -p ~/.local/bin
ln -s "$PWD/scripts/codex-prism" ~/.local/bin/codex-prism
```

With `~/.local/bin` on your PATH, run `codex-prism`. Each launch uses the current checkout, rebuilding the native app as needed and serving the current frontend. Keep the terminal open while using the app. Use `codex-prism --watch` to enable automatic reloads. If you move the checkout, update the symlink.

To opt into automatic reloads and native rebuilds during development, use `corepack pnpm dev:desktop:watch`.

To build an installable desktop package: `corepack pnpm build:desktop`. Automatic updates from the original upstream release feed are disabled.

## Local behavior and architecture

- The Rust backend supervises one `codex app-server --listen stdio://` process. The webview receives conversation events and approval requests; credentials remain in Codex's normal credential store.
- Projects have persistent UUIDs. File operations carry `{projectId, path}` with paths relative to the project directory. The desktop adapter resolves host paths for native pickers and assets. Rename preserves the project ID; a backend relocate operation is also available for a later project-management UI.
- The agent saves dirty buffers before starting, runs with `workspace-write` and `on-request` approvals, and allows one active turn per project. Unrelated CLI sessions are not imported into its chat list.
- File editing is locked during a turn and pending review, but pending review does not block the next chat prompt. Sending a new prompt implicitly keeps pending changes once Codex confirms the new turn has started; Undo then applies only to the new turn. A failed start preserves the prior review. At completion, the app reviews the actual project source/asset changes, including command-generated changes. Keep accepts the current disk contents; Undo restores the saved bytes only if the file still matches the completed turn. Text saves likewise refuse to overwrite an external edit.
- Review baselines and session mappings persist in the application's data directory, separately from project source. Restart recovers interrupted reviews. Prompts are never automatically resubmitted after a disconnect. Generated build files, hidden/environment directories and symlinks are excluded from snapshots; changes outside that scope cannot be undone by project review.
- LaTeX/PDF and history features remain; Python and external scientific skills are optional. Existing `.claudeprism/history.git` history is deliberately retained. New project instructions use `AGENTS.md`; scientific skills use `.agents/skills`.
- `apps/desktop/src/lib/backend` is the frontend transport boundary and `desktop-host.ts` owns desktop window/dialog/open-link APIs. The implementation remains Tauri-only at this stage; a hosted transport, browser import/export, authentication and remote isolation remain future work.

## Compiler runtime

Install TeX Live separately, including for packaged `.deb` and AppImage installations:

```sh
sudo apt install texlive-latex-extra texlive-publishers texlive-fonts-recommended texlive-xetex texlive-luatex texlive-bibtex-extra biber
```

Additional fonts, publisher classes or language packages may be needed by individual documents. The app does not download TeX packages automatically. Put an engine comment in the main document's first 20 lines when it requires XeLaTeX or LuaLaTeX. Without a comment, pdfLaTeX is used. Existing PDFs can be viewed without a compiler installed.

Python and external scientific skills are optional settings; neither is required to finish Codex setup. Existing project instructions, skills, environments and history are preserved. New project instructions describe TeX Live and optional tools.

## Verification

```sh
corepack pnpm --filter @codex-prism/desktop test
corepack pnpm --filter @codex-prism/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
node scripts/verify-codex.mjs
```

The last command checks the installed server's initialization, account status and model catalogue without sending an inference prompt or printing credentials. Add `--exercise` to run one small inference turn in a disposable temporary directory and verify file editing and session resume. Integration was checked against Codex 0.160.1; an incompatible app-server protocol reports an error rather than falling back to another provider.

For a hands-on acceptance check, open a disposable LaTeX project, ask Codex to edit a paragraph, verify streaming and model selection, then Keep one file and Undo another. Test Stop, an approval request, reopening a chat and restarting with a pending review. Check compilation/PDF navigation and externally edit a file before Save/Undo to verify conflict protection.

---

<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="codex-prism" />
</p>

## Features

- **Codex assistant** — chat alongside the document, attach project files, select models and reasoning effort, approve tool requests, and resume conversations.
- **LaTeX editor** — CodeMirror with syntax highlighting, search, multi-file projects and auto-save. Hide the source panel while keeping the chat and PDF visible.
- **PDF preview** — MuPDF rendering with SyncTeX navigation, zoom and text selection. Existing PDFs load at startup before a new compilation is needed.
- **Local compilation** — system TeX Live runs pdfLaTeX by default; `% !TEX program = xelatex` or `lualatex` selects another engine. Auto-recompile is optional.
- **History and proposed changes** — local Git snapshots, comparisons and restoration, plus Keep/Undo review of assistant edits.
- **Python environment** — optional [uv](https://docs.astral.sh/uv/) installation and explicit project environment setup in settings. Opening a project does not create or modify its environment.
- **Scientific writing instructions** — project `AGENTS.md` guidance, including TikZ for technical drawings, and optional skills from [K-Dense Scientific Skills](https://github.com/K-Dense-AI/claude-scientific-skills).
- **Templates and project wizard** — start papers, theses, presentations and other LaTeX documents.
- **Desktop tools** — external editor integration and light/dark themes.

## Data and privacy

Documents and compilation stay on your machine. AI requests send prompts and the content used by Codex to its configured provider for inference. Credentials are managed by the installed Codex CLI.

The legacy `.claudeprism/history.git` directory name is retained for compatibility with existing projects; it is not an AI connection.

## Installation

Build from this repository using the instructions above. Original upstream release binaries do not contain the codex-prism changes.

## Application releases

Linux releases target Ubuntu 26.04 LTS x86_64 and are published as drafts on [Gitea](https://git.jolibrain.com/beniz/codex-prism/releases). Local release commands work without a CI runner:

```sh
corepack pnpm release:prepare 1.3.1
# Review, commit, and tag the version changes before building.
corepack pnpm release:build
# Push the matching commit and tag; set GITEA_TOKEN before uploading.
corepack pnpm release:publish
```

See [the release guide](docs/releases/README.md) for the complete sequence, prerequisites, validation, and optional Gitea Actions setup. No version or release is created automatically by this setup.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the inherited development guidelines. The local setup and verification commands above describe this fork.

## Acknowledgments

codex-prism builds on [the original desktop project](https://github.com/delibae/claude-prism), which started from [Open Prism](https://github.com/assistant-ui/open-prism) by [assistant-ui](https://github.com/assistant-ui).

## License

[MIT](./LICENSE)
