---
title: Hook-based conversation capture
status: open
kind: spec
priority: 2
created-at: 2026-02-03T00:22:51.273375+01:00
---

# Spec

You are in a Ralph loop — meditative iteration toward a desired state.

## Orientation

Fresh eyes. Survey the system as it actually is. Broad authority to advance the state. Update discoverably via commits and fibers.

## Loop

1. **Survey** — Explore agents, `felt downstream`, git log, tests. You decide what to check.
2. **Contribute** — Substantial, coherent work worthy of your context. Swarm subagents if needed. File a sub-fiber.
3. **Felt** — Before exiting: `/felt`, update CLAUDE.md if warranted
4. **Exit** — `kill $PPID`

## Practices

- Never spawn multiple agents editing the same file
- Close sub-fibers with what happened, not that it happened
- Comments on spec only when evidence shifts direction

## Exit Rules

**Made contribution:** `kill $PPID`. Don't close spec.
**Nothing left:** `felt off hook-based-conversation-capture-52030153 -r "..."`

---

## Desired State

Portolan receives conversation updates via Claude Code hooks instead of polling session logs.

### Architecture

**Hooks** — Single script `portolan-conversation-hook.sh` handles both events:

- `UserPromptSubmit`: POST user message (from `prompt` field in payload)
- `Stop`: POST thinking + assistant text (parsed from `transcript_path` tail)

**Server endpoint:**
```
POST /hook/message
{
  sessionId: string,
  tmuxSession: string,
  cwd: string,
  messages: [{ type: 'user' | 'thinking' | 'assistant', content: string, timestamp: string }]
}
```

**ConversationCache** — New module replacing TranscriptReader:
```typescript
class ConversationCache {
  private sessions: Map<sessionId, Message[]>  // in-memory
  private persistPath = '~/.portolan/conversations.json'  // last ~10 msgs per session

  addMessages(sessionId, messages[])
  getMessages(sessionId, limit?)
  persist()   // every 30s + graceful shutdown
  restore()   // on server start
}
```

**Data flow:**
```
Local:  Hook fires → POST /hook/message → ConversationCache → WebSocket broadcast → UI
Remote: Hook fires → POST to remote agent → WebSocket to portolan → ConversationCache → UI
```

Both local and remote use hooks. Remote agent receives hook POSTs and forwards via WebSocket.

### Behavior

- Zero polling. Zero fs.watch. Server purely reactive.
- Single session log read per turn (tail ~100 lines, at Stop time only)
- Stop fires AFTER assistant response is written (verified)
- Thinking blocks extracted from session log tail along with assistant text
- Page refresh: frontend requests `/conversation`, server returns from cache
- Debug endpoint `/hook/health` shows last event time per session

### Acceptance

**Socket-level (local):** Send message in local tmux → `/conversation` endpoint returns it → matches session log truth

**Socket-level (remote):** Send message in remote tmux → `/conversation` endpoint returns it → matches remote session log truth

**Chrome-level (local):** Click local worker → send message in terminal → appears in panel → matches tmux truth

**Chrome-level (remote):** Click remote worker → send message in terminal → appears in panel → matches remote tmux truth

**Performance:** CPU usage drops. Fan stops during sustained conversation.

**Persistence:** Page refresh restores conversation. Server restart restores conversation.

### Opportunistic

Throughout the loop, watch for and file/fix:
- UI glitches, layout issues, visual inconsistencies
- Interaction bugs
- Error handling gaps
- Anything that feels off

Small fixes bundled. Larger issues filed as fibers.

---

## Context

### Existing patterns

- `server/src/TranscriptReader.ts` — current polling approach (to be replaced for local)
- `server/src/EventWatcher.ts` — watches `~/.portolan/data/events.jsonl` for activity status
- `server/src/HttpApi.ts` — add `/hook/message` endpoint here
- `server/src/index.ts` — WebSocket broadcast patterns, `remoteConversations` map
- `src/ui/WorkerActivityPanel.ts` — frontend polling to remove, WebSocket to add
- `~/loom/hooks/portolan-hook.sh` — existing hook for activity tracking

### Hook input (verified)

**UserPromptSubmit:**
```json
{ "session_id": "...", "cwd": "...", "prompt": "user message text" }
```

**Stop:**
```json
{ "session_id": "...", "cwd": "...", "transcript_path": "/path/to/session.jsonl", "stop_hook_active": false }
```

### Session log format

Assistant messages in `~/.claude/projects/{cwd}/{session}.jsonl`:
```json
{"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "..."}, {"type": "text", "text": "..."}]}, "timestamp": "..."}
```

---

## Skills

Before substantial frontend work: `/frontend-design`
