#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-candide}"
PORTOLAN_URL="${PORTOLAN_URL:-http://localhost:4004}"
CITIES_FILE="${PORTOLAN_CITIES_FILE:-$HOME/.portolan/cities.json}"

if ! command -v node >/dev/null 2>&1; then
  echo "[portolan] remote-agent-default-rust-smoke requires node on PATH" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "[portolan] remote-agent-default-rust-smoke requires curl on PATH" >&2
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "[portolan] remote-agent-default-rust-smoke requires ssh on PATH" >&2
  exit 1
fi

CITY_ID="$(
  HOST="$HOST" CITIES_FILE="$CITIES_FILE" node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

const host = process.env.HOST;
const citiesFile = process.env.CITIES_FILE;
const data = JSON.parse(readFileSync(citiesFile, 'utf8'));
const city = data.cities.find((candidate) => candidate.sshHost === host);

if (!city) {
  console.error(`[portolan] no persisted city found for sshHost=${host} in ${citiesFile}`);
  process.exit(2);
}

process.stdout.write(city.id);
NODE
)"

echo "[portolan] Checking remote-agent default runtime diagnostics at $PORTOLAN_URL"
DEBUG_JSON="$(curl -fsS --max-time 5 "$PORTOLAN_URL/debug-runtime")"
DEBUG_JSON="$DEBUG_JSON" node --input-type=module <<'NODE'
const debug = JSON.parse(process.env.DEBUG_JSON);
const prefs = debug.runtime?.remoteAgentRuntimePreferences;

if (prefs?.defaultRuntime !== 'rust') {
  console.error(`[portolan] expected defaultRuntime=rust, got ${prefs?.defaultRuntime ?? '<missing>'}`);
  process.exit(1);
}
NODE

echo "[portolan] Activating $HOST city $CITY_ID without an agentRuntime override"
RESPONSE_JSON="$(
  curl -fsS \
    -X POST \
    -H 'Content-Type: application/json' \
    -d '{}' \
    "$PORTOLAN_URL/activate-city?cityId=$CITY_ID"
)"
printf '%s\n' "$RESPONSE_JSON"

RESPONSE_JSON="$RESPONSE_JSON" node --input-type=module <<'NODE'
const response = JSON.parse(process.env.RESPONSE_JSON);
const okStatus = response.status === 'started' || response.status === 'already_running';

if (!okStatus) {
  console.error(`[portolan] unexpected activation status: ${response.status ?? '<missing>'}`);
  process.exit(1);
}

if (response.preferredRuntime !== 'rust') {
  console.error(`[portolan] expected preferredRuntime=rust, got ${response.preferredRuntime ?? '<missing>'}`);
  process.exit(1);
}

if (!String(response.message ?? '').includes('rust')) {
  console.error(`[portolan] activation message did not identify Rust runtime: ${response.message ?? '<missing>'}`);
  process.exit(1);
}
NODE

echo "[portolan] Verifying remote tmux session portolan-agent-rust-preview on $HOST"
ssh -T "$HOST" "tmux has-session -t '=portolan-agent-rust-preview'"

echo "[portolan] Default Rust remote-agent activation smoke passed for $HOST"
