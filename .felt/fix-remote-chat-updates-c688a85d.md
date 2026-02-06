---
title: Fix remote chat updates
status: closed
kind: spec
priority: 2
created-at: 2026-02-04T13:52:42.543039+01:00
closed-at: 2026-02-05T15:04:39.938436+01:00
close-reason: 'Fixed across 3 iterations: (1) sessionId extraction in agent + tmuxSession prefix for remote lookups, (2) timestamp deduplication — different precision from hooks vs polling caused duplicates, fixed with normalizeTimestamp(), (3) WebSocket routing — added prefixedTmuxSession getter so remote conversation broadcasts match correctly. 114 tests pass.'
---

## Desired State

Remote worker conversations update in real-time via hook proxy. When a remote worker sends/receives messages, the conversation cache reflects this within 2-3 seconds.

## Architecture: Hook Proxy

```
Remote Machine                          Local Machine
─────────────────                       ─────────────
Claude Code                             Portolan Server (:4004)
    │                                        ▲
    ▼ (hooks fire)                           │
portolan-conversation-hook.sh                │
    │                                        │
    ▼ POST to :4005                          │
Agent Hook Server (:4005)  ──WebSocket──────▶│
```

**Why hook proxy over polling:**
- Real-time updates (~1s vs 5s polling)
- Hooks already exist for local workers
- Same hook script works everywhere (just change PORTOLAN_URL)

## Test Loop (CLI/WebSocket)

Each iteration:

1. **Check baseline** — `curl localhost:4004/conversation?sessionId=remote-remote-c02-test | jq '.messages | length'`
2. **Send message to remote** — `curl -X POST localhost:4004/send-message -d '{"sessionId":"remote-remote-c02-test","message":"test from portolan"}'`
3. **Verify in tmux** — `ssh candide "tmux capture-pane -t test -p | tail -5"` shows message
4. **Trigger response** — Remote worker responds (or manually type in tmux)
5. **Verify hook fired** — Check agent logs: `ssh candide "tmux capture-pane -t portolan-agent -p | tail -10"`
6. **Verify in cache** — Conversation endpoint shows new message count

## Setup Checklist

### Remote Agent (candide)
- [x] Agent deployed with hook server (`server/agent.js` → `~/bin/portolan-agent.js`)
- [x] Agent running with login shell for node
- [x] Hook server listening on :4005

### Remote Hooks
- [x] Hook script copied: `~/bin/portolan-conversation-hook.sh`
- [x] PORTOLAN_URL set in bashrc: `http://127.0.0.1:4005`
- [x] `~/.claude/settings.json` updated with conversation hook

### Server Fix
- [x] HttpApi.ts: Prefix tmuxSession with originId for remote lookups
- [x] ConversationCard.ts: prefixedTmuxSession getter for WebSocket routing

## Debug Commands

```bash
# Agent status
ssh -T candide "tmux capture-pane -t portolan-agent -p | tail -20"

# Hook server health (on remote)
ssh -T candide "curl -s http://localhost:4005/hook/health"

# Server conversation cache
curl -s http://localhost:4004/hook/health | jq 'to_entries | map(select(.value.tmuxSession | contains("c02"))) | from_entries'

# Fetch conversation for remote session
curl -s "http://localhost:4004/conversation?sessionId=remote-remote-c02-test" | jq '.messages | length'

# Test worker tmux
ssh -T candide "tmux capture-pane -t test -p | tail -20"

# Send message to remote worker
curl -X POST http://localhost:4004/send-message \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"remote-remote-c02-test","message":"hello from portolan"}'
```

## Acceptance Criteria

1. Send message via /send-message → appears in remote tmux within 2s
2. Remote worker responds → hook fires → agent forwards → cache updated within 3s
3. `/conversation` endpoint returns new messages
4. `/hook/health` shows recent activity timestamps
5. No message duplication

## Constraints

**DO NOT add viewport clamping to ConversationCard.applyTransform().** Cards must stay pinned to map coordinates (their swarm position). The transform must remain `translateY(-50%) scale(${this.currentScale})` — no wrapper rect calculations, no cardTop checks. Cards that pan off-screen should pan off-screen.

## Files

- `server/agent.js` — Remote agent with hook server
- `server/src/index.ts` — WebSocket handling, agent_conversation routing
- `server/src/HttpApi.ts` — Conversation endpoint with remote prefix fix
- `server/src/ConversationCache.ts` — Message storage and deduplication
- `~/loom/hooks/portolan-conversation-hook.sh` — Hook script (deployed to remote)

## Comments
**2026-02-04 16:20** — Iteration 1: Fixed sessionId extraction in agent, tmuxSession prefix in HttpApi for remote lookups, changed polling to 30s fallback. Remote and local conversation paths now equivalent. Tool uses propagate correctly.
**2026-02-04 16:26** — Iteration 2: Fixed conversation deduplication. Timestamps from different sources (hooks vs polling) had different precision (.077Z vs .Z), causing duplicates. Added normalizeTimestamp() that truncates to seconds before comparing. All acceptance criteria verified working.
**2026-02-04 16:33** — Iteration 3: Fixed WebSocket routing for remote cards. Conversation cache broadcasts with prefixed tmuxSession (originId/tmuxSession) but Session objects have unprefixed names. Added prefixedTmuxSession getter to ConversationCard for correct matching. All 114 tests pass.
