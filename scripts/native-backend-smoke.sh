#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[portolan] native-backend-smoke requires node on PATH" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "[portolan] native-backend-smoke requires cargo on PATH" >&2
  exit 1
fi

cd "$REPO_DIR"

echo "[portolan] Running app-owned native backend boundary smoke (no GUI launch)"
cargo test --manifest-path src-tauri/Cargo.toml native_backend_smoke_starts_resource_bound_backend_without_gui -- --ignored --nocapture
