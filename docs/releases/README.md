# codex-prism releases

The initial release target is **Ubuntu 26.04 LTS, x86_64**. Build on Ubuntu 26.04; the release packages are not promised to work on older distributions. Both a `.deb` installer and an AppImage are produced. Other platforms remain available through the general desktop build script, but are not part of the release workflow yet.

## Local release (no runner needed)

Install the dependencies listed in the root README, plus `patchelf`, `librsvg2-bin`, `file`, `curl`, `wget`, `xdg-utils`, `libpng-dev`, and `zlib1g-dev`. Install Node 22 with Corepack and Rust via rustup (the repository pins Rust 1.88.0).

Start from a clean, committed checkout. Replace `1.3.1` below with your chosen version; `1.3.0` is currently inherited from upstream.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm release:prepare 1.3.1
# Review the version changes; this updates all package/Cargo/Tauri versions.
corepack pnpm test:release
corepack pnpm --filter @codex-prism/desktop test
CXXFLAGS=-std=c++17 cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
git add package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "chore: release 1.3.1"
git tag -a v1.3.1 -m "codex-prism 1.3.1"
corepack pnpm release:build
```

Artifacts go to `dist/releases/v1.3.1/`:

- `codex-prism-1.3.1-linux-x86_64.deb`
- `codex-prism-1.3.1-linux-x86_64.AppImage`
- `SHA256SUMS`, `RELEASE_NOTES.md`, and `release.json` (source commit and artifact hashes)

Smoke-test the actual packages before publishing: launch, connect Codex, open a project, compile a PDF, and try chat plus Keep/Undo. Users must install and authenticate the Codex CLI separately. The installed release contains a built frontend; it does not need Node or Rust at runtime. The `codex-prism` symlink in `~/.local/bin` continues launching your repository checkout; remove or rename that symlink if you want an installed package's executable to take precedence.

Push the commit and tag, then upload:

```sh
git push origin main
git push origin v1.3.1
# Set GITEA_TOKEN securely in your shell to a token with repository write access.
corepack pnpm release:publish
```

The publisher targets `https://git.jolibrain.com/beniz/codex-prism`, requires the remote tag to match the built commit, verifies checksums, and creates a **draft release**. Open its printed URL to review and publish. It never creates tags, overwrites differing assets, or modifies an already published release. Retrying an interrupted upload skips identical assets. If a draft contains a conflicting artifact, remove that asset through Gitea before retrying.

`release:build` can also build an uncommitted checkout for local testing, but `release:publish` refuses artifacts marked dirty. The publisher never prints the token. Signing and in-app automatic updates remain disabled for this initial release setup.

## Gitea Actions (later)

The tag-triggered workflow is `.gitea/workflows/release-linux.yml`. No runner is required for the local commands above. To enable automation:

1. Enable Actions on the repository and register an x86_64 runner labelled `ubuntu-26.04`, with Ubuntu 26.04 userspace, Node-capable Actions execution, and permission to install build dependencies. A container runner needs an Ubuntu 26.04 image with Node and Git available for checkout.
2. Allow its built-in `GITEA_TOKEN` to write repository releases. If your server does not grant this, add a repository Actions secret named `RELEASE_TOKEN` with that permission.
3. Push a matching `v<version>` tag. The workflow tests, builds, and uploads a draft release using the same scripts as the local process.

Do not run a local upload and CI upload for the same tag simultaneously. The current server's API returned HTTP 403 to an unauthenticated version request, so server permissions and runner execution must be verified after setup.

## Deferred platforms

`deferred-platforms.yml.disabled` and `deferred-macos.sh.disabled` retain the old platform dependency, signing, and packaging recipes as inactive references. Their old GitHub publishing portions are not active and must be replaced before reuse. `scripts/build-macos.sh` now performs local packaging only; the generic `build:desktop` script retains Windows support.

References: [Gitea release API](https://docs.gitea.com/api/1.24/operations/repo-create-release/), [release attachments](https://docs.gitea.com/api/1.25/operations/repo-create-release-attachment/), [Actions token permissions](https://docs.gitea.com/usage/actions/token-permissions/), [Tauri Linux compatibility](https://v2.tauri.app/distribute/appimage/).
