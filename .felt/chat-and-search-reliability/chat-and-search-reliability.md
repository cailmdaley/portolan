---
title: Chat and search reliability testing
status: closed
depends-on:
    - murmuration-workers
created-at: 2026-02-03T23:51:38.103961+01:00
closed-at: 2026-02-04T03:32:32.702395+01:00
---

(chat-and-search-reliability)=
# Spec

You are in a Ralph loop — meditative iteration toward a desired state.

## Orientation

Fresh eyes. Survey the system as it actually is. Broad authority to advance the state. Update discoverably via commits and fibers.

## Loop

1. **Survey** — Open `http://localhost:5173` in Chrome. Check git log, test functionality visually.
2. **Test** — Try the feature being tested. Observe what happens. Take screenshots if useful.
3. **Fix** — If something's broken, fix it. Commit.
4. **Repeat** — Keep testing and fixing until the acceptance criteria pass.
5. **Felt** — Before exiting: `/felt`, update CLAUDE.md if warranted
6. **Exit** — `kill $PPID`

**Visual feedback is primary.** Use Chrome to see what's happening. Don't just check logs — interact with the UI.

## Practices

- Never spawn multiple agents editing the same file
- Close sub-fibers with what happened, not that it happened

## Exit Rules

**Made contribution:** `kill $PPID`. Don't close spec.
**Nothing left:** `felt off <id> -r "..."`

---

## Desired State

Chat message sending and file search work reliably for both local and remote cities.

### Chat Message Sending

**Test procedure:**
1. Click a worker (local) → conversation card opens
2. Type a message in the chat input
3. Press Enter or click send
4. Message should appear in the worker's tmux session

**Verify with:** `tmux capture-pane -t <session> -p` to confirm message arrived

**Remote workers:**
- Same test with a remote worker (different originId)
- Message should route through the remote agent

**Success criteria:**
- Messages send without errors
- Messages appear in tmux within 2 seconds
- Works for both local and remote workers
- Error states display clearly if send fails

### File Search

**Test procedure:**
1. Click a city → city panel opens
2. Type a search query in the search box
3. Results should appear
4. Click a result → file opens in viewer

**Local cities:** Search uses local filesystem
**Remote cities:** Search proxies through remote agent

**Success criteria:**
- Search returns results within 3 seconds
- Results are clickable
- Works for both local and remote cities
- Empty/error states display clearly

### Debug Endpoints

If issues arise, use these to diagnose:
- `curl http://localhost:4004/hook/health` — conversation capture status
- `curl http://localhost:4004/debug-transcripts` — session mappings
- Browser DevTools Network tab — check request/response

## Context

### Files involved

- `src/ui/ConversationCard.ts` — Chat input and send logic
- `src/ui/CityPanel.ts` — Search input and results
- `server/src/HttpApi.ts` — `/send-message`, `/search` endpoints
- `server/src/index.ts` — WebSocket handling, remote proxying

### Patterns

- Chat send: POST to `/send-message` with sessionId, tmuxSession, message
- Search: POST to `/search` with query, cityId, originId
- Remote: Requests proxy through remote agent WebSocket

## Skills

None required — this is debugging/testing work.
