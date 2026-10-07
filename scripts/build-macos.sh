#!/usr/bin/env bash
# Native macOS packaging remains available locally; release publishing is deferred.
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
exec node scripts/build-desktop.mjs "$@"
