# Contributing to codex-prism

Contributions are welcome! This guide covers the development environment, workflow, and testing.

Release packaging currently targets Ubuntu 26.04 LTS x86_64; see [the release guide](docs/releases/README.md). Other platform recipes below are retained for future work.

## Development Environment

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://rustup.rs/) (repository-pinned 1.88.0)
- Linux Tauri development libraries: see the [README](README.md).
- System TeX Live for compilation tests; no embedded compiler libraries are needed to build the app.
- macOS and Windows packaging are deferred. Historical recipes under `docs/releases/` are inactive references and still contain obsolete Tectonic steps; do not use them as current build instructions.

### Setup

```bash
git clone https://git.jolibrain.com/beniz/codex-prism.git
cd codex-prism
pnpm install
```

### Run

```bash
pnpm dev:desktop
```

### Build

```bash
pnpm build:desktop
```

## Project Structure

```
codex-prism/
├── apps/
│   └── desktop/              # Tauri desktop app
│       ├── src/              # React frontend (TypeScript)
│       └── src-tauri/        # Rust backend
│           ├── src/
│           │   ├── lib.rs           # Tauri plugin registration
│           │   ├── history.rs       # Git-based version history
│           │   ├── latex.rs         # TeX Live compilation & SyncTeX
│           │   ├── codex.rs         # Codex app-server integration & review
│           │   ├── projects.rs      # Project IDs and file operations
│           │   └── skills.rs        # Optional scientific skills management
│           └── Cargo.toml
├── .gitea/workflows/         # Linux release workflow
└── biome.json                # Linter config
```

## Testing

### Frontend (Vitest)

```bash
cd apps/desktop && pnpm test

# Watch mode
cd apps/desktop && pnpm test:watch
```

### Rust

```bash
cd apps/desktop/src-tauri && cargo test
```

Current test counts:
- **Frontend:** 89 tests (stores, components)
- **Rust:** 114 tests (65 unit + 49 integration)

### What to test

- **Unit tests:** Pure functions, parsers, data transformations
- **Integration tests:** Filesystem/git operations using `tempfile` crate for isolation
- Tests live in `#[cfg(test)] mod tests` blocks within each source file (modules are private)

### Adding Rust integration tests

Use `tempfile::TempDir` for tests that touch the filesystem or git:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_example() {
        let dir = TempDir::new().unwrap();
        // ... test with dir.path() ...
    }

    #[tokio::test]
    async fn test_async_example() {
        // For async Tauri commands that don't need the runtime
    }
}
```

## Code Style

This project uses [Biome](https://biomejs.dev/) for TypeScript/React linting and formatting.

```bash
pnpm lint          # check
pnpm lint:fix      # auto-fix
```

Rust code follows standard `rustfmt` conventions.

### Pre-commit Hook

A [Husky](https://typicode.github.io/husky/) pre-commit hook runs automatically on every commit. It checks and auto-fixes staged files via `biome check --staged --write`, so lint issues are caught before they reach the repository.

The hook is set up automatically when you run `pnpm install`.

### CI

A GitHub Actions workflow runs `biome ci` on every pull request and push to `main`. PRs that fail lint checks cannot be merged.

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run tests: `pnpm test` (frontend) and `cargo test` (Rust)
5. Commit — the pre-commit hook will auto-fix lint issues on staged files
6. Push to your fork and open a PR
7. CI will verify lint and tests pass

### Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Usage |
|--------|-------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation |
| `test:` | Adding or updating tests |
| `refactor:` | Code refactoring |
| `ci:` | CI/CD changes |
| `chore:` | Maintenance tasks |
