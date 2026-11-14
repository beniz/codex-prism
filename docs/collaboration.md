# Git collaboration and manuscript review

These features are under Unreleased. They are not part of previously published
packages.

## Connect a project

Install Git, then choose **Connect shared project** from the project picker or
workspace. Paste a GitHub/Gitea repository URL, branch link, or SSH clone URL.
Check the repository, confirm the branch and contributor identity, and connect.
From the picker, choose a new local folder; from an open project, Prism connects
the existing repository. Projects must be at the repository root. Unrelated
histories must be opened in separate folders.

Create repositories and invite collaborators through your hosting provider.
Direct shared-branch pushes must be allowed. Rejected pushes remain local and
appear in collaboration status; Prism never bypasses branch protection or force
pushes. Submodules, LFS-managed inputs, and source symlinks are not supported in
this first collaboration workflow.

GitHub browser sign-in retrieves your name and email through its API. Gitea can
use an instance-configured OAuth application or a personal access token. The
confirmation fields remain editable. GitHub's private/no-reply email is offered
when available. Commit identity is repository-local and distinct from the account
that authenticates the push.

Credentials can be remembered in the system credential store. If native storage
is unavailable, sign-in remains valid for the application session. SSH transport
uses existing keys, SSH configuration, and the SSH agent independently of API
sign-in. Configure SSH trust/key access beforehand, or use HTTPS. Select SSH in
the dialog or paste an SSH clone URL; Prism does not change a supplied SSH URL
to HTTPS.

## Save, sync, and resolve

- **Autosave** writes local files without creating a sharing checkpoint.
- **Save** creates the normal Git checkpoint and schedules synchronization.
- **Keep** accepts agent changes, records them, and schedules synchronization.
- **Sync now** saves eligible files, checkpoints them, and synchronizes.
- Opening or focusing a connected project checks for updates, with a cooldown.
  There is no periodic background polling.

Prism fetches before integrating. Uncheckpointed edits, staged external work,
running agents, and pending manuscript proposals defer incoming changes. The
editor is briefly locked during integration, after checking for unsaved buffers.
Your current PDF remains visible while the updated manuscript is built.

Conflicts create an isolated agent proposal. Review its ordinary diffs, PDF
preview, and chat explanation, then choose Keep or request refinements. The
original versions remain available to the resolver. If newer collaborator changes
arrive, refresh the resolution before accepting. Discard leaves synchronization
pending; it does not erase remote work. Use **Review pending resolution** to
return to a proposal after closing its chat or restarting.

**View changes** opens document history. Connection status distinguishes pending
sharing, uncheckpointed edits, incoming changes, authentication failures, and
history errors. **Disconnect** stops Prism synchronization without deleting the
repository, remotes, or local history.

Pushes share reachable repository history, including earlier commits and files.
Prompt-derived commit titles and optional full prompts travel with that history.

## Request a review

Save the manuscript, then select **Request review**. Enter an optional focus such
as argument quality, structure, clarity, or supporting evidence.

The reviewer runs through the installed Codex while Prism is open. It uses its own
local `prism/reviews/<id>` branch and worktree, without switching your active
branch. Findings and proposed improvements are reviewed through the normal chat,
diffs, PDF preview, and Keep controls. Report-only results do not keep the editor
locked after the turn completes.

Review branches remain local. Findings are always retained locally and remain
listed directly under **Collaboration → Reviews**, including after **Discard
suggested changes**. Click a review to open its findings tab. Local-only findings
are labeled **Local**; pending and saved reviews are labeled separately. The list
refreshes when reviews finish or are saved, and the section refresh icon reloads
it manually.

- **Save review** records only this review's report and metadata on the manuscript
  branch for normal synchronization. Suggested document edits remain pending, and
  manual editing is unlocked once the agent is idle.
- **Keep selected** accepts only the checked tracked document files, and saves the
  review records if needed. Unselected edits remain pending in the reviewer chat.
  Save any manual manuscript edits before accepting reviewer changes.
- **Discard suggested changes** dismisses the pending edits without removing the
  retained findings or previously accepted files.

After independent edits, acceptance merges selected files against the current
manuscript. A changed merge result requires renewed review; conflicting files
remain unapplied and can be repaired with the agent. Reviewer follow-ups keep
pending edits and the original reviewed revision. New or untracked context files
are not included in document acceptance. Record saving and selective acceptance
use ordinary commits containing only the chosen output, never a merge of the
entire reviewer branch and its unaccepted history. Existing staged or unsaved
on-disk changes cause acceptance to pause without changing them.

Report-only reviews do not trigger source reload or main-PDF compilation. No
automatic reviews, pull requests, or review-branch publication are performed.

Versioned review metadata lives in `.prism-collab/reviews/<id>/`. It is excluded
from TeX inputs and ordinary source snapshots/restores. Runtime state, credentials,
and recovery journals remain local. The versioned record retains the review ID,
reviewed commit, reviewer, requested scope, source-context digest, and report path; source anchors and
quoted context are included in the Markdown report. Findings refer to the reviewed revision and
must not be interpreted as independent verification of claims without evidence.

## Authentication configuration for builds

### GitHub

Register a Prism-owned GitHub OAuth app and enable device flow. Provide its public
client ID as `PRISM_GITHUB_CLIENT_ID` when compiling the core/desktop. The platform
build workflows read the repository variable of the same name. No client secret
is embedded. Without a configured ID, access-token authentication remains
available and the browser sign-in action explains the missing configuration.

The device flow requests repository access and profile/email access. Organization
policies may require authorizing the application or token for private repositories.
API credentials do not replace SSH transport credentials.

### Gitea

Register an OAuth application as a **public client** on the instance, with
`http://127.0.0.1/` as the loopback redirect. Enter its client ID and the HTTPS
server address in the connection dialog. Prism uses PKCE with S256, an ephemeral
loopback port, and a one-time state value. A personal access token is the fallback
when instance OAuth is unavailable. Refresh tokens renew Gitea browser sign-in;
revoked credentials require reconnecting. Grant the profile/email and repository access
needed by your chosen transport and server version.

### Native storage and validation

The desktop uses Keychain on macOS, Windows Credential Manager on Windows, and
Secret Service on Linux. Linux builds require `libdbus-1-dev` in addition to the
existing Tauri dependencies. Headless backends default to session-only credentials
and can inject a credential-store adapter. Hosts using token-based Git operations
must also register a `set_git_askpass` executable that handles `PRISM_GIT_ASKPASS`
before normal startup, as the desktop entry point does.

Core collaboration tests use independent temporary clones and a bare remote.
Reviewer tests use local worktrees and deterministic output. Live GitHub/Gitea,
native credential stores, and live Codex reviews require separate smoke checks;
local tests do not establish those external integrations or other platforms.

The WebKit fixture under `apps/desktop/scripts/collaboration-smoke` exercises the
real connection and review components with a mocked host. Start Vite on port 1445
and run its `webkit.py` with system PyGObject/WebKit on a display.

Provider protocol references: [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
and [Gitea OAuth provider configuration](https://docs.gitea.com/development/oauth2-provider/).
