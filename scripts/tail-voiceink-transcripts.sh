#!/usr/bin/env bash

set -euo pipefail

poll_seconds=1
dump_all=0
db_path=""
run_once=0

usage() {
  cat <<'EOF'
Usage: tail-voiceink-transcripts.sh [--all] [--once] [--db PATH] [--poll-seconds N]

Emit VoiceInk transcripts as JSONL by polling its local SwiftData SQLite store.

Options:
  --all             Dump all existing transcripts before following new ones.
  --once            Query once and exit instead of following.
  --db PATH         Override the VoiceInk transcript database path.
  --poll-seconds N  Poll interval in seconds. Default: 1.
  -h, --help        Show this help.
EOF
}

find_default_db() {
  local candidates=(
    "$HOME/Library/Application Support/com.prakashjoshipax.VoiceInk/default.store"
    "$HOME/Library/Application Support/com.gpl.VoiceInk/default.store"
  )
  local path
  for path in "${candidates[@]}"; do
    if [[ -f "$path" ]]; then
      printf '%s\n' "$path"
      return 0
    fi
  done
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      dump_all=1
      shift
      ;;
    --db)
      db_path="${2:-}"
      shift 2
      ;;
    --once)
      run_once=1
      shift
      ;;
    --poll-seconds)
      poll_seconds="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$db_path" ]]; then
  if ! db_path="$(find_default_db)"; then
    printf 'Could not find VoiceInk transcript store.\n' >&2
    exit 1
  fi
fi

if ! [[ -f "$db_path" ]]; then
  printf 'VoiceInk transcript store not found: %s\n' "$db_path" >&2
  exit 1
fi

if ! [[ "$poll_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  printf 'Invalid --poll-seconds value: %s\n' "$poll_seconds" >&2
  exit 1
fi

last_seen_pk=0
if [[ "$dump_all" -eq 0 ]]; then
  last_seen_pk="$(sqlite3 "$db_path" "select coalesce(max(Z_PK), 0) from ZTRANSCRIPTION;")"
fi

query_after_pk() {
  local after_pk="$1"
  sqlite3 "$db_path" "
    select
      cast(Z_PK as text) || char(9) ||
      json_object(
        'id', Z_PK,
        'timestamp_local', datetime(ZTIMESTAMP + 978307200, 'unixepoch', 'localtime'),
        'duration_s', round(coalesce(ZDURATION, 0.0), 3),
        'status', coalesce(ZTRANSCRIPTIONSTATUS, ''),
        'text', coalesce(ZTEXT, ''),
        'enhanced_text', coalesce(ZENHANCEDTEXT, ''),
        'audio_file_url', coalesce(ZAUDIOFILEURL, '')
      )
    from ZTRANSCRIPTION
    where Z_PK > ${after_pk}
    order by Z_PK asc;
  "
}

while true; do
  rows="$(query_after_pk "$last_seen_pk")"
  if [[ -n "$rows" ]]; then
    while IFS=$'\t' read -r current_pk row_json; do
      [[ -z "$current_pk" || -z "$row_json" ]] && continue
      printf '%s\n' "$row_json"
      last_seen_pk="$current_pk"
    done <<< "$rows"
  fi
  if [[ "$run_once" -eq 1 ]]; then
    break
  fi
  sleep "$poll_seconds"
done
