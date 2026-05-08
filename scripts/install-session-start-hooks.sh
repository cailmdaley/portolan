#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

SOURCE_HOOK="$REPO_DIR/server/hooks/portolan-session-start.sh"
TARGET_HOOK_DIR="$HOME/.portolan/hooks"
TARGET_HOOK="$TARGET_HOOK_DIR/portolan-session-start.sh"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CODEX_SETTINGS="$HOME/.codex/hooks.json"

if ! command -v jq >/dev/null 2>&1; then
  echo "[portolan] jq is required to patch settings.json files" >&2
  exit 1
fi

if [ ! -f "$SOURCE_HOOK" ]; then
  echo "[portolan] missing hook source at $SOURCE_HOOK" >&2
  exit 1
fi

mkdir -p "$TARGET_HOOK_DIR"
cp "$SOURCE_HOOK" "$TARGET_HOOK"
chmod +x "$TARGET_HOOK"

patch_claude_settings() {
  local settings_file="$1"
  local hook_path="$2"

  if [ ! -f "$settings_file" ]; then
    echo '{}' > "$settings_file"
  fi

  local existing
  existing="$(cat "$settings_file")"

  local patched
  patched="$(
    echo "$existing" | jq --arg path "$hook_path" '
      . // {}
      | .hooks //= {}
      | .hooks.SessionStart = (
          (.hooks.SessionStart // []) as $existing_hooks
          | if ([ $existing_hooks[]? | .hooks[]? | select((.command // "") == $path) ] | length) > 0 then
              $existing_hooks
            else
              $existing_hooks + [{ hooks: [ { type: "command", command: $path } ] }]
            end
        )
    '
  )"

  echo "$patched" > "$settings_file"
}

patch_codex_settings() {
  local settings_file="$1"
  local hook_path="$2"

  if [ ! -f "$settings_file" ]; then
    echo '{"hooks":{}}' > "$settings_file"
  fi

  local existing
  existing="$(cat "$settings_file")"

  local patched
  patched="$(
    echo "$existing" | jq --arg path "$hook_path" '
      . // {}
      | .hooks //= {}
      | .hooks.SessionStart = (
          (.hooks.SessionStart // []) as $existing_hooks
          | if ([ $existing_hooks[]? | .hooks[]? | select((.command | gsub("^\"|\"$";"")) == $path) ] | length) > 0 then
              $existing_hooks
            else
              $existing_hooks + [{ hooks: [ { type: "command", command: $path } ] }]
            end
        )
    '
  )"

  echo "$patched" > "$settings_file"
}

patch_claude_settings "$CLAUDE_SETTINGS" "$TARGET_HOOK"
patch_codex_settings "$CODEX_SETTINGS" "$TARGET_HOOK"

echo "[portolan] Installed session-start hook:"
echo "  - Hook script: $TARGET_HOOK"
echo "  - Claude settings: $CLAUDE_SETTINGS"
echo "  - Codex hooks: $CODEX_SETTINGS"

