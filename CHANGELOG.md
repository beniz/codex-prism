# codex-prism changelog

User-visible changes to codex-prism. Version-specific installation instructions
and detailed release notes are in [docs/releases](docs/releases/README.md).

## Unreleased

- Avoid false LaTeX warnings from syntax trees awaiting publication; fix missing-document warnings in included files and show the full document outline across literal `\input`/`\include` files, with continuous slide numbering and navigation to each source. Resolve included files to their owning document before unrelated standalone figures.

- Cancel obsolete PDF preview requests and analyze changed pages in a background worker, keeping the visible PDF usable and preserving the automatic jump to the first change.

- Reduce chat typing latency by avoiding unrelated PDF and review redraws and batching draft autosaves, while retaining immediate text updates and flushing drafts on navigation or close.

- Highlight Plan mode and show agent questions in the chat composer, with explicit selected-answer colours, a separate submit action, and selections preserved when switching chats.

- Fix PDF-to-LaTeX navigation for included files and cached PDFs. Remove ambiguous word-based jumps and verify source lines against the displayed build.

- Open project settings by clicking the Data sources heading in the sidebar.

- Check for new releases every 12 hours and show an update indicator beside the version. Official AppImage, macOS, and Windows packages support signed downloads and a guarded restart; Debian installations detect externally installed upgrades, and source builds show update instructions.

- Distinguish agent commands, file/image access, research, progress, approvals, and outcomes with small coloured icons and labels. Expanded commands use shell syntax highlighting.

- Use a restrained light/dark syntax palette in the LaTeX and BibTeX editor, with matching language-aware highlighting for chat code blocks. Streamed text remains immediately visible.

- Build completed chats’ PDFs in the background with up to three concurrent compilations. Switching tabs reuses each chat’s saved PDF without rebuilding, including with Incremental disabled.

- Show matching sources' files and directories directly in `@` completion, below whole-source choices, without an extra Browse files step.

- Clear submitted chat text immediately, before data-source validation or agent startup. Restore failed prompts without overwriting newer drafts.

- Reference entire data sources with `@source:` or `@source:/`, and select directories through completion. Imported-file groups include only registered files; local and SSH sources are explored on demand.

- Clear the chat composer as soon as Codex accepts a prompt, including data-source references, without waiting for review refresh. Failed submissions and newer drafts retain their text.

- Correct new-project writing instructions to describe ordinary Git history and acceptance through Keep. Existing project instructions are preserved.

- Share file-exclusion classifications across workspaces, templates, history, and the file navigator; consistently omit Beamer auxiliary and compound build outputs while retaining PDF assets and tracked history inputs.

- Share project creation across blank, built-in, and private templates; retries preserve existing source and avoid duplicate file imports and chats after a failed open.

## 1.7.0

- Unify copied reference files, local directories and SSH directories as project data sources, available during creation and in project settings. Existing attachments are registered once; file sources share a single sidebar availability row.
- Configure local read-only data-source directories in project settings, view their availability in the sidebar, and share their paths with all project chats from the next turn.
- Add per-project SSH data sources backed by existing remote Codex servers, with connection tests, availability indicators, remote research/computation, and bounded imports into the owning chat’s proposal. Remote source protection is instruction-based.
- Add `@source-id:/path` completion in chat for registered files and local/SSH directories, with on-demand browsing, stable source IDs, quoted paths, and reference validation for prompts and steering.
- Add a persisted Incremental compilation toggle next to Auto and Changes. Disabling it forces full main-document and proposal build requests while preserving Keep PDF reuse.
- Shorten repeated main-document compilation to one LaTeX pass when recorded dependencies and unchanged auxiliary state prove it safe; uncertain and bibliography builds retain the full pass sequence.
- Skip unchanged BibTeX/Biber processing during incremental compilation when generated controls, resolved databases/styles, tool identity, and bibliography output are verified. Unsupported Biber sources/configuration retain full processing.
- Return chats with completed, unchanged turns to the latest main-document PDF instead of retaining an empty proposal with an older preview. Recover existing empty proposals on restart while preserving pending edits and repairs.
- Move Capture & Ask to Ctrl+Shift+X (Cmd+Shift+X on macOS), restoring the standard cut shortcut in the chat composer and other text fields.
- Simplify the README's platform quickstart and highlight parallel writing, Git history, private templates, and data sources; move detailed setup and operational documentation into `README_AGENTS.md`.

[Release notes](docs/releases/1.7.0.md)

## 1.6.6

- Double-click LaTeX text to show its matching PDF position, falling back to the nearest mapped line in the same file, while retaining word selection.
- Discover existing Windows Codex installations in WinGet package and machine link directories, and continue discovery when WinGet reports Codex is already installed.
- Recall sent prompts with Up in an empty chat composer; use Down to return through history to an empty draft.
- Open project settings from the project title to rename the project and edit its shared prompt.
- Remember the last chat model and reasoning effort separately for each project.
- Add persistent project instructions shared by all chats and applied to each new turn.

[Release notes](docs/releases/1.6.6.md)

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
