#!/usr/bin/env bash
set -euo pipefail

HOST="candide"
PORTOLAN_URL="${PORTOLAN_URL:-http://localhost:4004}"
CITIES_FILE="${PORTOLAN_CITIES_FILE:-$HOME/.portolan/cities.json}"
CITY_ID_OVERRIDE=""
REQUIRE_STARTED=false
STOP_OPPOSITE=false

usage() {
  cat <<'EOF'
Usage: scripts/remote-agent-default-rust-smoke.sh [--require-started] [--stop-opposite] [--city-id ID] [host]

Verifies that /activate-city without an agentRuntime override uses the Rust
remote-agent runtime. By default, an already-running Rust agent is accepted.
When --require-started races Portolan's remote-agent auto-recovery, an
already-running Rust response is accepted if the Node fallback session is not
running after activation.

Options:
  --city-id ID       Use an explicit persisted Portolan city id instead of
                     looking one up by sshHost in ~/.portolan/cities.json.
  --require-started  Stop the Rust runtime session first and require status=started
                     unless auto-recovery self-heals it first.
  --stop-opposite    Also stop the Node fallback session before activation.
  -h, --help         Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --require-started)
      REQUIRE_STARTED=true
      shift
      ;;
    --stop-opposite)
      STOP_OPPOSITE=true
      shift
      ;;
    --city-id)
      if [ "$#" -lt 2 ]; then
        echo "[portolan] --city-id requires a value" >&2
        exit 2
      fi
      CITY_ID_OVERRIDE="$2"
      shift 2
      ;;
    --city-id=*)
      CITY_ID_OVERRIDE="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "[portolan] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      HOST="$1"
      shift
      ;;
  esac
done

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

require_ssh_connection() {
  local host="$1"
  local output

  if output="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" "echo ok" 2>&1)"; then
    return 0
  fi

  echo "[portolan] SSH preflight failed for $host before activation smoke" >&2
  if echo "$output" | grep -Fq "no such identity:"; then
    echo "[portolan] missing SSH identity file in local ssh config:" >&2
    echo "$output" | grep -F "no such identity:" >&2
  fi
  echo "$output" >&2
  return 1
}

if [ -n "$CITY_ID_OVERRIDE" ]; then
  CITY_ID="$CITY_ID_OVERRIDE"
else
  CITY_ID="$(
    HOST="$HOST" CITIES_FILE="$CITIES_FILE" node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

const host = process.env.HOST;
const citiesFile = process.env.CITIES_FILE;
const data = JSON.parse(readFileSync(citiesFile, 'utf8'));
const baseHost = (value) => String(value ?? '').replace(/-login\d+$/, '');
const city = data.cities.find((candidate) =>
  candidate.sshHost === host || baseHost(candidate.sshHost) === baseHost(host)
);

if (!city) {
  const remoteHosts = data.cities
    .filter((candidate) => candidate.originId !== 'local')
    .map((candidate) => `${candidate.sshHost ?? '<no-ssh-host>'}:${candidate.id}`)
    .sort();
  console.error(`[portolan] no persisted city found for sshHost=${host} in ${citiesFile}`);
  console.error(`[portolan] available remote city hosts: ${remoteHosts.length ? remoteHosts.join(', ') : '<none>'}`);
  console.error('[portolan] pass --city-id <id> when the city is known but keyed by another host alias');
  process.exit(2);
}

process.stdout.write(city.id);
NODE
  )"
fi

require_ssh_connection "$HOST"

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

if [ "$REQUIRE_STARTED" = true ]; then
  echo "[portolan] Stopping remote Rust runtime session before activation on $HOST"
  ssh -T "$HOST" "tmux kill-session -t '=portolan-agent-rust' 2>/dev/null || true"
  ssh -T "$HOST" "tmux kill-session -t '=portolan-agent-rust-preview' 2>/dev/null || true"
  if [ "$STOP_OPPOSITE" = true ]; then
    echo "[portolan] Stopping remote Node fallback session before activation on $HOST"
    ssh -T "$HOST" "tmux kill-session -t '=portolan-agent' 2>/dev/null || true"
  fi
fi

echo "[portolan] Activating $HOST city $CITY_ID without an agentRuntime override"
RESPONSE_JSON="$(
  curl -fsS \
    -X POST \
    -H 'Content-Type: application/json' \
    -d '{}' \
    "$PORTOLAN_URL/activate-city?cityId=$CITY_ID"
)"
printf '%s\n' "$RESPONSE_JSON"

RESPONSE_JSON="$RESPONSE_JSON" REQUIRE_STARTED="$REQUIRE_STARTED" node --input-type=module <<'NODE'
const response = JSON.parse(process.env.RESPONSE_JSON);
const requireStarted = process.env.REQUIRE_STARTED === 'true';
const okStatus = requireStarted
  ? response.status === 'started' || response.status === 'already_running'
  : response.status === 'started' || response.status === 'already_running';

if (!okStatus) {
  console.error(`[portolan] unexpected activation status: ${response.status ?? '<missing>'}${requireStarted ? ' (expected started or auto-recovered already_running)' : ''}`);
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

echo "[portolan] Verifying remote tmux session portolan-agent-rust on $HOST"
ssh -T "$HOST" "tmux has-session -t '=portolan-agent-rust'"

if [ "$REQUIRE_STARTED" = true ] && [ "$STOP_OPPOSITE" = true ]; then
  echo "[portolan] Verifying remote Node fallback session stayed stopped on $HOST"
  ssh -T "$HOST" "! tmux has-session -t '=portolan-agent' 2>/dev/null"
fi

echo "[portolan] Default Rust remote-agent activation smoke passed for $HOST"
