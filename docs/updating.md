# Application updates

codex-prism checks the latest public stable GitHub release every 12 hours. A blue
Download icon beside the version opens release information. Settings → Environment
→ Application updates provides a manual check and the automatic-check preference.
Checks do not download or install anything automatically.

AppImage, Windows setup and macOS application installations can download a signed
update, then **Restart and update**. Wait for agents, builds and saves to finish.
Pending proposals do not need to be kept or discarded. Dirty files and chat drafts
are saved first; a save failure prevents restart. Save and close other application
windows before restarting so their unsaved editor state is not lost.

For `.deb` installations, download the package and install it yourself:

```sh
sudo apt install ./codex-prism-VERSION-linux-x86_64.deb
# Alternatively:
sudo dpkg -i ./codex-prism-VERSION-linux-x86_64.deb
```

Prism does not configure an APT repository. If your administrator provides one,
use its update instructions. Return to the app after installation: it detects the
new installed version on focus or when opening the update panel, then offers a
restart. Prism never asks for sudo credentials or invokes apt/dpkg installation.

Source builds show release notes and source build instructions. Save/commit your
local work before updating your checkout; rebuild and relaunch using
[the source guide](../README_AGENTS.md#build-from-source). Prism does not modify
source installations. Local packaged builds without the official build marker
also remain notification-only.

The first updater-enabled release must be installed manually. Older versions do
not gain an updater retroactively. Failed checks stay quiet until you open the
update panel; manual retry is always available. Missing platform assets never
trigger a substitute platform download.

## Release signing setup

Generate a dedicated updater key once, on a trusted machine:

```sh
corepack pnpm --filter @codex-prism/desktop tauri signer generate -w /secure/path/prism-updater.key
```

Back up the private key and password outside the repository. Configure these
GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the private key file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password (empty if deliberately unencrypted).
- `PRISM_UPDATE_PUBLIC_KEY`: contents of the corresponding `.pub` file.

Release jobs require these keys and embed only the public key. They sign final
payload bytes, including AppImages after icon normalization. Release assembly
verifies payload signatures and writes `latest.json`, signatures, checksums, and
source provenance before creating a draft. Publish only after the updater matrix
and existing platform checks pass. No production secrets enter PR upgrade tests.

Updater signing is separate from Apple notarization/Developer ID and Windows
Authenticode. Current platform signing limitations still apply. Losing the key
requires a manual reinstall unless a transition release signed with the old key
has already shipped the new public key. Do not rotate the key independently of
that transition, change published assets, or move published tags.

## Upgrade tests

The `Test updater` Actions workflow builds two fixture packages on Windows,
Linux, and Apple Silicon macOS. Each uses a fresh disposable key and loopback feed,
rejects a tampered payload, then upgrades A→B through the native updater and checks
the restarted executable's version. Linux additionally checks an external dpkg
upgrade and local restart detection. Windows verifies the actual NSIS handoff
and installer-driven relaunch using a non-elevated token for the same user. This matches the per-user installer and
avoids requiring an Explorer shell in an elevated, headless runner session. A
launcher self-test checks privileges, environment inheritance, and paths with
spaces in a separate Windows job before any platform starts package builds. The
disposable runner grants its own user access to the window station and desktop
so removing administrator privileges does not prevent DLL initialization. Failure artifacts include the installed
version, process names, prerequisite log, and installer handoff marker.
The fixture `updater-test` feature is never enabled in production release jobs.

The harness writes only into the runner's temporary test directories, except for
the Debian install on the disposable Linux runner. Do not run the Debian scenario
on a workstation. It uses no Codex account or production data. Failed assertions
fail the job; diagnostic JSON and logs are uploaded without keys or packages.

These tests establish package replacement/relaunch behaviour. They cannot certify
all enterprise policies, Windows security products, or macOS Gatekeeper prompts.

For a quick local preflight (PowerShell 7 is available on Linux and macOS):

```sh
pwsh -NoProfile -File scripts/check-updater-scripts.ps1
corepack pnpm test:release
node --check scripts/updater-smoke.mjs
```

This parses the Windows scripts and compiles the embedded launcher C#, without
calling Windows APIs or running an installer. Native token permissions, NSIS
replacement, and automatic relaunch still require the Windows Actions jobs.
Failed package tests retain Rust dependency caches to shorten retries.
