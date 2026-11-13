# Collaboration features: initial plan

Status: evolving design for the initial implementation. See [collaboration setup](collaboration.md) for current usage and build configuration. Unreleased changes are not features of previously published packages.

Implementation decisions: repository-root projects only; manual sharing after explicit Save or Sync now; agent sharing after Keep; GitHub browser sign-in independent of SSH transport; reviewer reports and proposed edits by default; review branches remain local in the first release.

## Goal

Enable basic collaboration on a scientific-writing project through an ordinary
remote Git repository, without requiring collaborators to understand Git.
Preserve local editing, automatic history, isolated agent proposals, and PDF
review. Real-time simultaneous editing is outside the initial scope.

The recommended starting point is one shared branch and one local clone per
collaborator, with automatic synchronization at safe points. The minimum useful
feature includes offline handling, conflict resolution in the UI, and a clear
distinction between saved locally and shared with collaborators.

Bundle this initial implementation with an on-demand review agent that acts as a
collaborator: it improves documents and exercises branch review, acceptance, and
conflict resolution. The reviewer uses a dedicated branch and isolated worktree;
independent clones remain necessary for testing remote collaboration.

## Existing foundations

- [History workflow](../crates/prism-core/src/history_workflow.rs): document-scoped
  commits, durable recovery operations, preservation of unrelated changes, and
  checks against unexpected branch or HEAD changes.
- [Proposals](../crates/prism-core/src/proposals.rs): isolated workspaces and
  three-way integration against the latest main document; conflicts leave main
  untouched.
- [Visual review](../crates/prism-core/src/visual_review.rs): immutable captured
  build inputs and artifacts that can underpin revision comparison.
- [History UI state](../apps/desktop/src/stores/history-store.ts): visible history
  warnings, retry, and revision-aware asynchronous updates.

These are reusable foundations, but remote integration needs its own transaction
and recovery logic. The existing proposal merge implementation is not a complete
repository synchronization engine.

## Initial user experience

### Setup

Provide one **Connect shared project** flow, initially targeting GitHub and Gitea.
The intended experience is **paste link → sign in → connect**.

1. **Paste a repository or branch link.** Accept supported GitHub/Gitea browser
   links as well as clone URLs. Resolve the repository and optional branch;
   otherwise use the repository's default branch. Offer a branch selector when
   needed, without requiring users to know branch names beforehand.
2. **Sign in if necessary.** Reuse existing credentials where possible. Use the
   authenticated provider API to discover the contributor's name and suitable
   commit email, subject to the token's permissions.
3. **Show a compact, editable confirmation:** repository, branch, local location,
   and “Your changes will be attributed to Alice · email.” Ask for missing identity
   information only when it cannot be obtained automatically.
4. **Connect.** From the welcome screen, create a local clone and open it. From
   an existing project, connect that project after checking history compatibility.

Both contexts use the same dialog and action label. The invocation context
determines whether to clone or connect existing files; the URL alone cannot
determine that operation. Prefill an existing remote when available.

### Authentication and commit identity

For GitHub, offer **Sign in with GitHub** through browser authorization or device
flow. For Gitea, use browser authorization where an OAuth application is configured
for the instance, with an access-token fallback for arbitrary self-hosted servers.
Gitea OAuth registration is instance-specific, so universal browser sign-in must
not be assumed.

After authentication, query the GitHub or Gitea API for the user's name and email.
Prefill the commit identity and allow editing. Respect private/no-reply email
preferences rather than automatically publishing a private account email. API
access can depend on token permissions, and available profile data can be
incomplete. If no suitable identity is available, ask once and save it for this
repository. Preserve an already selected repository identity on reconnection.

Git transport credentials and commit identity remain separate: an SSH key or
credential helper may permit Git operations without supplying API profile access.
Use an existing configured Git identity as a fallback when appropriate, and keep
manual entry available. Store the selected identity in repository-local Git
configuration rather than changing the user's global configuration. The current
fallback `codex-prism <history@codex-prism.local>` must not silently become the
collaborator's identity.

### Repository setup boundaries

Recommend a dedicated repository for the writing project. Initially, an organizer
may create the remote repository and invite collaborators through the hosting
provider; Prism handles joining and subsequent synchronization.

Record the resolved remote and branch explicitly rather than assuming `origin`
or `main`; automatic discovery should avoid unnecessary selection steps.
Detect whether direct pushes are permitted. Repositories requiring pull requests
need the later review workflow; explain this limitation during setup.

Connecting an existing local history to an existing remote must not overwrite
either side. Detect unrelated histories and present a supported setup path,
such as opening a fresh clone, rather than forcing integration.

### Everyday interface

Expose a status indicator, **Sync now**, and **View changes**. Keep routine Git
commands and branch terminology out of the primary writing flow.

| State | Suggested UI |
| --- | --- |
| Local and last observed remote revision agree | Up to date · checked just now |
| Local checkpoints await upload | Saved locally · waiting to share |
| Offline | Offline · changes saved on this computer |
| Incoming changes cannot yet be applied | Updates available · finish reviewing your changes |
| Conflicting edits | Changes need your review |
| Authentication or permissions failure | Sharing paused · reconnect |

“Up to date” refers to the last successful remote check, not a guarantee that
nobody has pushed since then. Local history errors must remain distinguishable
from network sharing errors.

## Synchronization behavior

Separate fetching remote history from applying it to the live project.

1. Save and checkpoint eligible local edits. Agent changes become eligible only
   after Keep. Manual checkpoints occur on explicit Save or Sync now; autosave
   stays local. Opening/focusing a project never checkpoints unsaved work.
2. Fetch the configured branch.
3. Prepare integration in isolation: fast-forward where possible, otherwise
   perform a three-way merge and create an ordinary merge commit.
4. Before applying, recheck the branch, source revision, editor buffers, pending
   history operations, and proposal state. Preserve unrelated staged and working
   changes; defer integration when it cannot safely preserve them.
5. Apply through a recoverable transaction, then push the committed revision to
   the explicit destination branch.
6. If another collaborator pushed meanwhile, fetch and retry a bounded number of
   times. Preserve progress and show a useful status if retries are exhausted.

Do not automatically rebase or force-push. Stable commit identities support
reviews, comments, and recovery. Detect remote history rewrites or branch deletion
and pause for an explicit recovery choice rather than automatically resurrecting
or overwriting history.

Trigger synchronization after a successful checkpoint, on project opening, on
returning to the application with a cooldown, and through Sync now. Avoid
continuous polling initially. If needed later, offer a bounded refresh interval
for the active project. Network operations must be cancellable and bounded, with
backoff after failures.

### Interaction with agents and previews

For the first version, fetch while agents or unresolved proposals are active,
but defer applying incoming changes until they are resolved. Already committed
changes may still be pushed. Do not publish unaccepted proposal workspaces.

Preserve manual-edit locks and route asynchronous operations by their owning
project, workspace, and generation. An incoming update must not implicitly accept
another chat's changes.

Keep the visible PDF until updated source has a matching successful build. A
failed build must expose the error without presenting an old PDF as current or
substituting another chat's artifact.

## Agent conflict resolution is part of the minimum scope

Use the agent to resolve conflicts, then present the result as a regular proposal:
**Prism prepared a combined version — review it like any other agent change.**
Users should not need a terminal or a dedicated three-pane merge editor.

1. Detect conflicts and create an isolated resolution workspace, leaving the live
   manuscript untouched.
2. Populate the workspace with cleanly merged changes. Give the agent the common
   ancestor, local version, incoming version, and conflict diagnostics, preserving
   exact original files, including binary assets.
3. Have the agent propose resolved files that preserve both collaborators' intent.
   It must leave the result for review and cannot apply it or push it itself.
4. Present the ordinary source diffs, PDF preview, and follow-up chat. Users can
   ask for refinements through the same proposal workflow they already use.
5. **Keep** accepts the reviewed result, records a merge commit with both local
   and incoming parent revisions, and resumes synchronization.

The default diff compares the local document before integration with the proposed
merged document. It must show everything Keep will change, including incoming
edits that merged cleanly. Highlight files or passages resolved by the agent.
Retain access to the incoming version and common ancestor: a local-to-result diff
alone cannot reveal incoming content the agent omitted.

When scientific claims or results cannot be reconciled confidently, the agent
asks the user through chat. Binary figures and delete-versus-edit conflicts may
also require an explicit choice. Never silently drop an unresolved file or treat
successful compilation as proof that the scientific resolution is correct.

**Discard** discards only the proposed resolution and leaves synchronization
pending; it must not discard collaborators' work or mark the incoming revision as
integrated. Deferral, agent failure, or unavailable agent access likewise preserves
both versions and allows resolution to resume later.

Do not write conflict markers into the active manuscript. Revalidate local and
remote revisions before applying or publishing. If subsequent changes require
modifying the reviewed result, prepare an updated proposal for review rather than
silently accepting a different result. Keep the current PDF visible while the
resolution is prepared and built.

Reuse the existing proposal-repair pattern, which creates an isolated candidate
with preserved original inputs. Remote integration additionally needs durable
tracking of both parent commits and merge-aware acceptance; an ordinary
single-parent proposal commit is insufficient to record the integration.

A clean textual merge still does not guarantee scientific consistency. Show a
concise incoming-change notification with access to the diff even when Git merges
without needing the agent.

## Branch strategy

| Model | Benefit | Cost |
| --- | --- | --- |
| Shared branch | Everyone converges on the same manuscript automatically | Overlapping changes sometimes require resolution |
| Permanent branch per user | Work remains separate until explicitly integrated | Users must understand which version they see and when others receive changes |
| Branch per proposed change | Natural foundation for review and approval | Requires submission, review status, and integration workflows |

Start with a shared branch. Permanent user branches move the integration problem
rather than remove it.

The initial reviewer brings forward a narrow use of short-lived branches, managed
by Prism without a branch-management UI. Human collaboration still defaults to the
shared branch.

Later generalize this into **Create a draft → Request review → Accept changes**
for human collaborators, with approvals and optional provider pull requests. This
fits writing tasks and Prism's proposal model better than permanent personal
branches.

## Review agent in the initial implementation

### Purpose and scope

Provide **Request review**, with optional instructions such as “Review the
argument and identify unsupported claims.” Run the reviewer locally through the
installed Codex while Prism is open. It can assess clarity, structure, consistency,
and supporting evidence, returning findings and optionally proposed manuscript
edits. External verification depends on the sources and tools actually available;
the reviewer must distinguish missing evidence from established errors.

Start with explicit requests rather than reviewing every save or push. Bound work
and avoid loops in which review-report commits trigger further reviews. Always-on
remote reviewers and CI deployment are outside the initial scope.

### Branch and worktree flow

1. Capture a specific committed manuscript revision and create a dedicated branch,
   for example `prism/reviews/<review-id>`, with its own application-managed worktree.
   A separate repository clone is not required for the reviewer.
2. Run the reviewer in that worktree without switching the user's active branch or
   modifying the main checkout. Supply the source and, where available, a PDF
   tied to the same captured inputs.
3. Produce a revision-linked report and optional manuscript edits. Prism validates
   the output and records it on the review branch with clear agent attribution;
   the agent does not control main-branch acceptance or remote publication.
4. Present the report, ordinary source diffs, PDF preview, and follow-up chat.
   Preserve the exact reviewed base and proposal revision through refinements.
5. **Keep** integrates the approved result into the shared branch and resumes
   normal synchronization. If main has advanced, prepare the integration against
   the latest revision; use agent conflict resolution where needed, and renew
   review when the proposed result changes.
6. Keep review branches local in the initial release. Accepted reports and edits
   travel through ordinary shared-branch synchronization. Publishing unaccepted
   review branches and provider pull-request UI are deferred.

Keep both reports and unaccepted manuscript edits on the review branch initially.
Prism can display reports directly from that branch. Accepted review records can
travel with the integration commit; report-only reviews should not create a
manuscript-edit lock solely because metadata exists. Publishing a report without
accepting accompanying edits is a separate operation, not an implicit merge of
the whole branch.

**Discard** leaves the shared manuscript unchanged. Pending or interrupted work
remains recoverable until explicitly discarded. Do not remove active or pending
review worktrees during cleanup, and do not delete published review branches
implicitly.

### Minimal review records

Bring a small part of the shared-review storage design into the initial release:
store a versioned record under `.prism-collab/reviews/<review-id>/` containing the
review ID, reviewed commit, reviewer identity, scope, summary, and findings with
source references and quoted context. Include artifact identity when findings
refer to a PDF. Review identity must remain stable across follow-up turns.

Full comment threads, collaborative resolution events, and formal approvals can
follow later. Review metadata must not trigger TeX recompilation or become
ordinary manuscript content. Give the reviewer a narrow output path for its own
report rather than general authority to rewrite collaboration records.

### Isolation and reuse

Reuse agent sessions, proposal review, repair, and immutable PDF builds. Existing
proposal snapshots are not Git worktrees, so branch-backed reviews require an
explicit bridge between those lifecycles and durable ownership of branch, base
commit, worktree, proposal, and generation.

A worktree shares Git administration and most refs with its repository; it is not
an independent security boundary. Prism must own Git mutations, credentials,
acceptance, and publication, while the model edits only its allowed worktree
content. Preserve the existing restrictions against writes to main or another
chat's workspace, and coordinate shared repository operations.

Keep reviewer and conflict-resolver jobs distinct even if they use the same agent
infrastructure. The reviewer assesses the manuscript; the resolver reconciles
specific versions and must not turn integration into an unsolicited rewrite.

### Collaboration testing

The local reviewer exercises branch isolation, review records, diffs, acceptance,
and merging. It does not by itself validate remote synchronization.

Use independent clones and a temporary bare remote for deterministic tests of
fetch/push races, offline edits, rejection/retry, and recovery. Script reviewer
outputs for repeatable success and failure cases; use live reviewer runs as
additional end-to-end checks of usefulness and UX, not as the only test harness.

When testing optional review publication, results must pass through actual push
and fetch operations rather than being injected directly into another client's
state. Add GitHub/Gitea integration checks with separate identities to cover
authentication and permissions that same-account local tests cannot establish.

## Design decisions to reserve now

### Shared metadata versus local application state

Keep credentials, recovery journals, chat workspaces, machine paths, and caches
local. Reserve a versioned, tracked namespace for collaboration records, for
example:

```text
.prism-collab/project.json
.prism-collab/reviews/<review-id>/...
.prism-collab/comments/<thread-id>/<event-id>.json
```

The namespace is provisional. The important requirement is an explicit file
policy: `.codexprism` and `.prism` are currently excluded by
[file-rules.json](../crates/prism-core/src/file-rules.json).

Shared metadata should travel through Git but stay out of TeX build inputs,
ordinary agent-edit scopes, and document-only restore operations. Metadata-only
updates should not trigger compilation. Define schema versions and compatibility
behavior before introducing these records.

### Stable review and comment identities

Use UUIDs for shared projects, reviews, threads, and events, independent of commit
IDs and machine-local project registration. Link reviews to specific base and
target commits. Approval applies to the exact reviewed revision; subsequent edits
make that approval outdated.

Prefer independently named records over one shared `comments.json`. Immutable
reply, edit, resolve, and reopen events reduce simultaneous-write conflicts.
Define concurrent event semantics explicitly; timestamps alone must not silently
decide between conflicting actions. Persist author attribution and preserve
unknown compatible fields when updating records.

### Robust annotation anchors

Store source path, reviewed revision, selected text with surrounding context, and
an approximate source range. PDF annotations additionally record the exact
artifact identity, page, and rectangle.

Page coordinates drift after reflow; line numbers drift after source edits. Use
the W3C annotation model's text-quote and position selectors as design references,
without requiring adoption of the entire standard. If relocation is ambiguous,
show **Location changed** instead of attaching the comment to unrelated text.

### Revision comparison independent of chats

Extend visual review toward comparing any two immutable source revisions. Reuse
this for incoming changes, historical comparison, and eventual branch review.

Record compiler/toolchain information alongside source and asset hashes. The
existing manifest captures engine and options, but different TeX installations
can produce different pagination. Exact cross-machine PDF review may eventually
require sharing the reviewed artifact. Do not commit every generated PDF by
default; artifact distribution and retention remain a later design decision.

### Separate saving, publishing, and approval

Auto-sharing may be the first policy, but retain separate internal operations.
Future private drafts and review requests need checkpoints that do not immediately
become shared manuscript content.

Distinguish restoring an old manuscript from undoing one contribution. A full
restore can remove collaborators' later work even when recorded as a new commit.
Shared history must remain intact; undo should not rewrite published history.

### Repository scope and sharing disclosure

Prism supports documents inside larger parent repositories. Document-scoped
commits do not make pushes document-scoped: a push publishes reachable repository
history, including other files and earlier commits.

Recommend dedicated repositories and explain the actual sharing scope during
setup. Existing commit titles and bodies may contain prompt-derived information
even when full prompt inclusion is disabled. Ignore rules do not remove already
tracked content or historical content.

Decide separately whether history labels/tags are shared. Do not automatically
push all refs, tags, or internal recovery refs as part of ordinary synchronization.

## Implementation direction

Add a repository-scoped collaboration service in `prism-core`, exposed through
the existing typed frontend backend boundary. Keep desktop-specific authentication
and native integration in host adapters.

Coordinate synchronization with history, proposal acceptance, restores, and editor
saves. Use durable operation records and revision checks, and handle Git changes
made outside Prism. Shared repositories and linked worktrees require coordination
beyond a single document ID. Avoid holding mutation locks across network waits;
revalidate before local publication.

Initially favor the installed Git executable for network transport, preserving
SSH and credential-helper behavior, while retaining current library-based local
operations. This choice needs platform validation. Authentication must have an
application-visible flow; background commands must not wait indefinitely for a
terminal prompt. Keep secrets out of repository metadata and logs.

Extend history presentation with author attribution and enough merge information
to explain incoming changes. Keep networking errors separate from failures to
save local history.

## Delivery sequence

1. **Connection and state:** one Connect shared project flow for GitHub/Gitea,
   repository/branch link resolution, authentication, API-based identity discovery
   with editable fallback, repository-scope disclosure, and sync status.
2. **Safe synchronization:** fetch, isolated integration, ordinary push, offline
   retry, coordination with local editing/proposals, and durable recovery.
3. **Complete the minimum collaboration experience:** agent conflict resolution
   through ordinary proposal diffs, PDF preview, follow-up chat, and Keep;
   incoming-change inspection and platform validation. Do not call the feature
   complete while routine conflicts require terminal Git knowledge.
4. **Initial reviewer bundle:** on-demand review on a dedicated branch/worktree,
   minimal revision-linked reports, optional edits, ordinary proposal acceptance,
   with review branches kept local. Validate remote behavior separately
   with independent clones. Steps 1–4 form the initial feature bundle.
5. **Extended shared review records:** comments, replies, resolution state,
   richer anchors, and comparison of arbitrary revisions.
6. **General review workflows:** human draft branches, review requests, approvals,
   and optional hosting-provider pull-request integration.

Repository creation and invitations inside Prism, permanent personal branches,
real-time presence/editing, and large-file/artifact hosting are outside the initial
scope. Detect unsupported repository features rather than silently corrupting or
partially synchronizing them.

## Validation criteria

Use temporary repositories with two independent clones and a bare remote. Cover:

- The unified setup flow in both welcome-screen and existing-project contexts.
- GitHub/Gitea repository and branch links, default-branch discovery, and branch
  names containing slashes; do not infer a branch solely by splitting a URL.
- API identity discovery, missing permissions/profile fields, private/no-reply
  email choices, manual fallback, and preservation of repository-local identity.
- GitHub authorization and Gitea instance-specific OAuth/token authentication.
- Sequential edits and concurrent pushes, including bounded retry behavior.
- Divergent clean merges and text, binary, rename, and delete-versus-edit conflicts.
- Agent resolution isolation, preservation of both original versions, complete
  local-to-result diffs, and merge commits retaining both parent revisions.
- Resolution follow-ups, Discard/deferral, agent failure, and recovery without
  losing incoming work or marking an unresolved merge as synchronized.
- Local or remote changes during resolution review, requiring renewed review
  whenever the proposed result changes.
- Reviewer branch/worktree isolation, unchanged active branch, report attribution,
  follow-up turns, and reports tied to the exact reviewed revision.
- Report-only completion without spurious manuscript locks or compilation;
  proposed edits remain unaccepted until Keep.
- Review job cancellation/restart and cleanup preserving pending work; optional
  branch publication round trips through independent clones.
- Offline edits followed by reconnection; authentication and permission failures.
- Dirty editor buffers, unrelated staged/working changes, and untracked collisions.
- Active agents, unresolved proposals, pending history retries, and concurrent Keep.
- Restart or cancellation during integration and after a push with an uncertain
  network result, without duplicated or lost changes.
- Remote branch deletion, history rewrites, and external Git operations.
- Failed compilation after incoming changes, preserving correct PDF ownership.
- Parent repositories and linked worktrees.
- Windows paths, executable discovery, SSH/HTTPS authentication, and native
  behavior on each supported platform; Linux tests do not establish Windows or
  macOS correctness.

## Questions for the next iteration

- Is host-side repository creation/invitation acceptable for the first release?
- How should Gitea instance administrators configure OAuth, and what guided
  access-token fallback should Prism provide when OAuth is unavailable?
- Is fetch-on-open/focus/checkpoint sufficient, or is timed refresh required?
- How much incoming-change visual comparison belongs in the initial release?
- Which repository features require immediate support versus a clear unsupported
  state, particularly LFS, submodules, and protected branches?
- Should shared comments follow document branches initially, and how should they
  later propagate between drafts and the shared manuscript?
- Which review presets and finding fields belong in the initial reviewer UI?
- In a later release, should review-branch publication be enabled per request or
  as a project setting?

## References

- [Git fetch](https://git-scm.com/docs/git-fetch): downloading remote history.
- [Git pull](https://git-scm.com/docs/git-pull): fetching and integrating changes.
- [Git push](https://git-scm.com/docs/git-push): destination refs and rejection of
  unsafe updates.
- [Git credentials](https://git-scm.com/docs/gitcredentials): credential helpers
  and askpass integration.
- [Git worktree](https://git-scm.com/docs/git-worktree): isolated working trees
  with shared repository administration and refs.
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/):
  annotation identities, targets, and selectors.
