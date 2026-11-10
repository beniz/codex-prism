# SSH data-source validation

Normal frontend and core suites use temporary projects and fixtures, with no
machine-specific SSH targets. The bridge checks proposal ownership and generation,
uses a per-turn loopback capability, and is revoked on turn completion/cancellation.
The desktop executable dispatches `--prism-source-mcp` before starting Tauri;
headless hosts that use these tools must dispatch that mode to
`prism_core::source_mcp::run_stdio()` too.

Run the ordinary suites listed in `AGENTS.md`. Core capability tests require
permission to bind loopback sockets. A real WebKit UI smoke test uses a mocked
native boundary (it never connects to SSH):

```sh
corepack pnpm --filter @codex-prism/desktop exec vite --port 1438
/usr/bin/python3 apps/desktop/scripts/data-sources-smoke/webkit.py
```

For explicit live validation, set `PRISM_TEST_SSH_PROFILE` outside the repository
to a JSON object with `id` (UUID), `name`, `host`, and optional `executable`,
`socket`, `port`, `tokenFile`. Set `PRISM_TEST_SOURCE_PATH` to a readable directory
for the attach-only probe. Never commit real host names, paths or credentials.

```sh
cargo test --locked --manifest-path crates/prism-core/Cargo.toml live_existing_server -- --ignored --nocapture
cargo test --locked --manifest-path crates/prism-core/Cargo.toml live_research_and_import -- --ignored --nocapture
```

The second test creates temporary remote input data, asks the existing remote
agent to compute a result, imports it into an isolated local proposal, verifies
that the input and main document were not changed, and removes its temporary
remote files. It uses the remote server's existing account and may consume model
usage. Never run it against a host without authorization.

To verify local MCP startup, refresh on resume, and removal without using an
account, build the desktop binary and set `PRISM_TEST_MCP_EXE` to its absolute
path. This test launches an isolated local app-server with a temporary Codex home
and immediately interrupts its unauthenticated test turn.

```sh
cargo test --locked --manifest-path crates/prism-core/Cargo.toml live_local_mcp_start_and_resume -- --ignored --nocapture
```

Linux validation does not verify Windows SSH/executable handling or macOS remote
behavior. WebSocket port/token transport also needs an explicitly configured
existing listener for live validation; tests must not start remote servers.
