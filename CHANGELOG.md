# codex-prism changelog

User-visible changes to codex-prism. Version-specific installation instructions
and detailed release notes are in [docs/releases](docs/releases/README.md).

## Unreleased

- Add persistent project instructions shared by all chats and applied to each new turn.

## 1.6.5

- Prevent Windows prerequisite setup from upgrading existing Codex or MiKTeX installations through WinGet.

[Release notes](docs/releases/1.6.5.md)

## 1.6.4

- Default PDF export to High quality (300 dpi), with Compact (150 dpi) and Original alternatives.
- List Beamer frames in the outline, including frame titles, untitled slides, and editor/PDF navigation. Custom commands that generate frames are not expanded.
- Reveal the source panel when opening a file from the Files navigator.
- Navigate newly compiled agent PDFs to the earliest page mapped to changed source; retain the current page when no location can be mapped.
- Mark chat tabs with an amber dot when their changes await review.

[Release notes](docs/releases/1.6.4.md)

## 1.6.3

- Add native Codex Plan mode, toggled with Shift+Tab in the idle composer, with per-chat persistence and inline Implement/Refine actions.
- Release empty planning workspaces while preserving pending document edits.
- Reuse reviewed PDFs when accepted build inputs match, preserving captured sources and SyncTeX navigation; rebuild when inputs differ or artifacts are unavailable.
- Fix accepted-build SyncTeX paths on Windows.
- Show landscape previews without cropping in project lists, folders, and My Templates.
- Collapse command executions in chat while retaining expandable commands, status, and exit codes.
- Improve release handling for Windows line endings and GitHub draft creation delays.

[Release notes](docs/releases/1.6.3.md)

## 1.6.2

- Add Windows installation, prerequisite discovery and setup, and GitHub release builds for Windows, Linux, and macOS.
- Improve outline/PDF navigation after source shifts and failed builds, including Windows path normalization.
- Include locally referenced figures in document-history commits, including PDF figures, while excluding compiled document output.
- Fix AppImage icons and validate packages after extraction.

[Release notes](docs/releases/1.6.2.md)

## 1.6.1

- Restore project chat tabs, conversations, and unsent drafts after restart.
- Refresh PDF rendering after display-density changes and foreground restoration.
- Add Copy link address to chat links.
- Hide Keep for proposals without changed files.
- Make scientific skills available through Settings without automatic onboarding.

[Release notes](docs/releases/1.6.1.md)

## 1.6.0

- Run chats concurrently in isolated project copies with per-chat Keep and Discard.
- Merge non-overlapping edits into the latest main document; report conflicts atomically and offer Fix with agent.
- Keep PDF previews visible during agent work and select each chat's PDF when switching tabs.
- Use shortened requests as acceptance commit subjects, with optional full prompts.
- Organize projects into virtual folders and preview existing PDFs without compilation.
- Continue Markdown lists with Shift+Enter and correct template-preview resizing.

[Release notes](docs/releases/1.6.0.md)

## 1.5.1

- Store document history in ordinary Git repositories with descriptive acceptance commits.
- Add Keep all and numbered outline navigation to PDF locations.
- Improve typing, scrolling, zoom responsiveness, and automatic compilation scheduling.
- Add optimized PDF export through Ghostscript while retaining original-quality export.

[Release notes](docs/releases/1.5.1.md)

## 1.5.0

- Add private local templates, previews, and creation from complete starter documents and assets.
- Add optional visual change reports with before/after excerpts and navigation.
- Add resizable chat input and persistent editor font sizes.
- Import uploaded images into project image folders and improve PDF export naming.

[Release notes](docs/releases/1.5.0.md)

## 1.4.2

- Reduce review overhead with on-demand content loading and background diff computation.
- Refresh project files incrementally, batch chat rendering, and avoid redundant recompilation.
- Fix initialization of empty legacy history repositories.

[Release notes](docs/releases/1.4.2.md)

## 1.4.1

- Fix a PDF resize-observer loop that kept the frontend busy while idle.
- Improve legacy history migration, macOS Codex discovery, and project-path handling.
- Add LaTeX environment guidance in Settings.
- Extract the shared headless Rust backend from the desktop host.

[Release notes](docs/releases/1.4.1.md)

## 1.4.0

- Establish codex-prism's Codex-powered scientific-writing workflow with project conversations, attachments, change review, and PDF preview.
- Add optional automatic recompilation, load existing PDFs, and improve bibliography processing and diagnostics.
- Standardize on system TeX Live and remove embedded Tectonic and unused integrations.
- Make Python environments and scientific skills optional.

[Release notes](docs/releases/1.4.0.md)

## Upstream history

codex-prism was forked from [Claude Prism](https://github.com/delibae/claude-prism).
Earlier upstream releases and tags are not codex-prism releases. Historical
package logs are retained in [the desktop archive](apps/desktop/CHANGELOG.md)
and [the native-host archive](apps/desktop/src-tauri/CHANGELOG.md); Git history
preserves the full upstream development record.
