#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUN_BIN="${BUN_BIN:-$(command -v bun || echo /usr/local/bin/bun)}"
exec "$BUN_BIN" db-backup.ts backup --all
