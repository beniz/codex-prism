#!/usr/bin/env bash
# Native macOS packaging for local builds; GitHub Actions handles releases.
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
exec node scripts/build-desktop.mjs "$@"
