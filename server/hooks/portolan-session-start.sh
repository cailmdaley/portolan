#!/usr/bin/env bash
set -euo pipefail

readonly CITIES_JSON="${PORTOLAN_CITIES_JSON:-$HOME/.portolan/cities.json}"
readonly JQ="${JQ_BINARY:-jq}"

if ! command -v "$JQ" >/dev/null 2>&1; then
  exit 0
fi

if [ ! -f "$CITIES_JSON" ]; then
  exit 0
fi

output="$(
  "$JQ" -r '
    .cities // []
    | map(select(.name and .path))
    | sort_by(.name | ascii_downcase)
    | map(
        "• \(.name): \(.path)"
        + (if (.originId // "local") != "local"
          then " (" + ((.sshHost // .originId // "remote")) + ")"
          else ""
          end
        )
      )
    | if length == 0 then
        empty
      else
        [
          "# Portolan Cities and Directories",
          "",
          .[],
          ""
        ]
        | .[]
      end
  ' "$CITIES_JSON"
)" 2>/dev/null || exit 0

if [ -n "$output" ]; then
  printf "%s\n" "$output"
fi
