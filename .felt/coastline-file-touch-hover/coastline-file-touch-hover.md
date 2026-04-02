---
title: 'Coastline: file-touch hover'
status: closed
tags:
    - portolan
    - spec
depends-on:
    - descope-conversation-cards
created-at: 2026-03-02T03:12:43.809145+01:00
closed-at: 2026-03-02T04:32:24.234391+01:00
outcome: Completed coastline migration from conversation cards + shell pipeline to file-touch hover + native HTTP hooks. Active runtime now serves /hook/file-touch + /recent-files with in-memory RecentFileTracker, frontend bird hover fetches and renders basename trails with click-through to FileViewerModal, and worker click remains Kitty focus. Conversation runtime/components/endpoints are removed from active code paths, remote forwarding verified over SSH RemoteForward (debug-runtime PID match + remote file-touch POST probe), and ~/.claude/settings.json uses PostToolUse HTTP hook for Read|Write|Edit. Final hardening in this iteration fixed tooltip dismissal edge cases by resetting hover state on programmatic hide and auto-hiding when target workers disappear; build/tests pass.
---

(coastline-file-touch-hover)=
Replace conversation cards with a lightweight file-touch hover tooltip on worker birds. Switch from the shell-script hook pipeline to native HTTP hooks.

## Desired State

**Workers show their file trail on hover.** 300ms hover on a bird sprite shows a small tooltip: the last ~5 file paths this worker touched (Read/Write/Edit). Basenames only, full path on inner hover. Click a path → FileViewerModal opens. Click the bird still focuses Kitty. Tooltip dismisses on mouseout. No conversation text, no chat input, no card dragging, no z-ordering.

**One HTTP hook replaces the conversation shell script.** `~/.claude/settings.json` has:

```json
"PostToolUse": [{
  "matcher": "Read|Write|Edit",
  "hooks": [{ "type": "http", "url": "http://localhost:4004/hook/file-touch" }]
}]
```

Claude Code POSTs `{ session_id, tool_name, tool_input: { file_path }, cwd }` directly. No shell script, no jq, no transcript scanning, no tmux PID walking. Server resolves session → worker using SessionTracker.

**The conversation pipeline is gone.** Specifically deleted:

- `src/ui/ConversationCard.ts` (962 lines)
- `server/src/ConversationCache.ts` (352 lines)
- All conversation card machinery in `ZoneRenderer.ts` (~350 lines across 15+ methods: `openConversationCard`, `closeConversationCard`, `bringCardToFront`, `reapplyCardZIndexes`, `handleConversationMessage`, card state persistence methods, etc.)
- Conversation WS broadcast in `server/src/index.ts`
- `/hook/message`, `/hook/health`, `GET /conversation`, `POST /send-message` endpoints in `HttpApi.ts`
- Card state persistence endpoints (`/card-states`, `/card-state/:workerId`)
- `portolan-conversation-hook.sh` hook script
- Conversation hook entries in `~/.claude/settings.json`
- Related CSS (`.conversation-card`, `.conversation-card-wrapper`, card font variables)

**What stays:**

- `FileViewerModal` — independently valuable, now triggered from hover tooltip
- `portolan-hook.sh` — handles session lifecycle, unrelated to conversations
- CSS2DRenderer — used by worker labels
- Bird click → Kitty focus (unchanged)

## Context

### Server

- `server/src/HttpApi.ts` (~2187 lines) — add `POST /hook/file-touch`, remove 4 conversation endpoints
- `server/src/index.ts` — remove ConversationCache setup + WS broadcast
- New: a minimal per-session file ring buffer (last 10 paths + timestamps). In-memory only, no persistence. Exposed via `GET /recent-files?sessionId=X` or included in existing state broadcast.
- SessionTracker already maps `session_id` → tmux session → worker. The `/hook/file-touch` endpoint uses this.

### Frontend

- `src/render/ZoneRenderer.ts` (1571 lines) — gut card methods, add hover tooltip on bird meshes. Tooltip is plain DOM positioned via bird's screen coordinates.
- `src/main.ts` — remove card WS handling, rewire file-click from card to tooltip
- `src/ui/ConversationCard.ts` — delete entirely

### HTTP hook JSON (from Claude Code docs)

```json
{
  "hook_event_name": "PostToolUse",
  "session_id": "abc-123",
  "tool_name": "Read",
  "tool_input": { "file_path": "/path/to/file.ts" },
  "tool_response": "...",
  "cwd": "/Users/cail/projects/foo"
}
```

We only need `session_id`, `tool_name`, and `tool_input.file_path`.

### Remote workers

HTTP hooks POST to `localhost:4004`, which RemoteForward tunnels to the portolan server. Same mechanism as the current curl — should work without changes.

## Evidence

- `grep -r 'ConversationCard' src/` returns zero
- `grep -r 'ConversationCache' server/src/` returns zero
- `grep -r 'portolan-conversation-hook' ~/ .` returns zero
- `grep -r '/hook/message' server/src/` returns zero
- `curl -s localhost:4004/hook/file-touch -X POST -H 'Content-Type: application/json' -d '{"session_id":"test","tool_name":"Read","tool_input":{"file_path":"/tmp/test.ts"}}'` succeeds
- Hovering a bird shows tooltip with recent file paths
- Clicking a path in tooltip opens FileViewerModal
- Bird click still focuses Kitty
- No `portolan-conversation-hook.sh` references remain in settings.json

## Decisions

- **Tooltip positioning**: Anchor to hover-start position. No per-frame tracking.
- **Data flow**: Fetch on hover (`GET /recent-files?sessionId=X`). Fresh data, small latency acceptable.

## Open Questions

- **Remote HTTP hook verification**: Need to confirm HTTP hooks work over SSH RemoteForward tunnel. If not, keep a minimal shell script fallback for remote.
