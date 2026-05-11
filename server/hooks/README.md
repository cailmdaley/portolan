# Portolan Harness Hooks

Portolan worker activity uses one canonical JSONL stream:

```json
{
  "timestamp": 1710000000000,
  "type": "post_tool_use",
  "sessionId": "harness-session-id",
  "cwd": "/project",
  "tmuxSession": "worker-tmux-session",
  "harness": "codex",
  "tool": "Read",
  "toolInput": { "file_path": "/project/file.ts" }
}
```

`EventWatcher` tails `~/.portolan/data/events.jsonl` locally, and
`server/agent.js` tails the same shape on remote hosts. File touches are
recognized from canonical `pre_tool_use` or `post_tool_use` events whose
`tool` is `Read`, `Write`, or `Edit` and whose `toolInput.file_path` is set.

## Claude Code

Install `server/hooks/portolan-hook.sh` as the Claude Code hook. It maps
Claude `PreToolUse` and `PostToolUse` payloads to the canonical JSONL schema.
`~/loom/hooks/portolan-hook.sh` is the active shared copy used by this machine.

## Codex

Install `server/hooks/portolan-codex-hook.sh` from `~/.codex/hooks.json` for
`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop` when those hooks are
enabled. Current Codex payloads report shell commands as `Bash` with
`tool_input.command`, and file edits as `apply_patch` with the patch text in
`tool_input.command`; the adapter extracts `*** Update File:` style headers into
canonical `Edit` file touches.

## Pi

Copy or symlink `server/hooks/portolan-pi-extension.ts` into
`~/.pi/agent/extensions/` or `.pi/extensions/` and run `/reload`. The extension
subscribes to `tool_call` and `tool_result` and writes the same JSONL schema
when a Pi tool payload includes a recognizable file path.

Pi's session identity surface is still thinner than Claude/Codex in local
evidence. The extension writes `sessionId` when provided and otherwise falls
back to `unknown`; Portolan's recent-file mapping primarily uses `tmuxSession`,
so the hover trail remains reliable for tmux-owned workers.
