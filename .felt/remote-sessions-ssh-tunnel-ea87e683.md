---
title: '[hexarchy] Remote sessions via SSH tunnel'
status: closed
kind: spec
priority: 2
created-at: 2026-01-18T03:01:53.74679+01:00
closed-at: 2026-01-18T04:06:00.046368+01:00
close-reason: |-
    Implemented remote sessions via SSH tunnel:

    Components added:
    - OriginManager.ts: Tracks connected origins (local + remote), assigns compass positions (E, S, W, N, etc at distance 20), handles multiple agents per origin
    - agent.js: Standalone script for remote machines, discovers tmux sessions running claude, sends agent_sessions_update periodically
    - Updated CityManager: Cities keyed by (originId, path), auto-placed at origin's position
    - Updated SessionTracker: Added originId field to Session interface
    - Updated index.ts: Agent WebSocket handling (connect with ?agent=true&origin=hostname), remote focus via SSH+tmux attach

    Focus flow:
    - Local: kitty @ focus-tab or launch tab with tmux attach
    - Remote: kitty @ launch ssh -t {sshHost} tmux attach -t {session}

    Tests: 80 passing (19 new for OriginManager + updated CityManager tests)

    Usage:
    1. Local: SSH config with RemoteForward 4004 127.0.0.1:4004
    2. Remote: node agent.js connect [--ssh-host=name]
    3. Sessions appear at compass positions on hex grid
    4. Click to focus opens Kitty tab with SSH connection
---

# Ralph Spec

You are in a Ralph loop — autonomous iteration toward completion.

---

## Your Rhythm

1. **Survey** — Read previous work for orientation (`felt downstream <fiber-id>`).
   Use it for context — files touched, concepts named — but apply fresh judgment.
   Scan the spec and codebase. What's incomplete? What needs verification? What could improve?

2. **Prioritize** — Identify the single highest-value task to work on yourself.
   This is what you'll focus on in this session.

3. **Delegate** — Any routine, isolated tasks can be launched as background agents (2-3 max, different files).
   For each: create child fiber, launch with Task tool (run_in_background: true).
   Do NOT check their progress or output. They will notify you when finished.

4. **Work** — Focus on your high-value task. If agents finish while you're working, briefly note their results and continue.
   If you have nothing to work on yourself, just wait for agents to complete.

5. **Exit** — Run `kill $PPID` to end this iteration. The loop continues.

   **Close the fiber only when ALL of these are true:**
   - Everything in the design has been implemented
   - Everything has been tested and verified
   - No contributions can be made — nothing left to improve
   - No changes were made this iteration

   Then: `felt off <fiber-id> -r "summary"` and `kill $PPID`.

---

## Key Principles

- **Form your own understanding of completion.** Don't mechanically check boxes. Read the design, understand the intent, verify that the implementation matches.
- **Fresh eyes each iteration.** Previous work informs but doesn't bind. Apply fresh judgment.
- **Light parallelism.** Chunk when it helps, but don't force it. Sequential is fine.
- **Don't poll agents.** They notify you. Compulsive checking burns context.

---

## Goal

Surface Claude sessions running on remote machines via SSH tunnel, with click-to-focus support.

## Design

### Model

```
┌─────────────────┐                    ┌─────────────────┐
│  Local Machine  │                    │  Remote Machine │
│                 │     SSH tunnel     │                 │
│  hexarchy-server│◄═══════════════════│  hexarchy-agent │
│  (port 4004)    │  RemoteForward     │  → localhost:4004
│                 │                    │                 │
│  hex grid       │                    │  tmux sessions  │
│  shows both     │                    │  claude-code    │
└─────────────────┘                    └─────────────────┘
```

No custom auth. SSH handles security via reverse tunnel.

### Scope

**In:**
- Agent script (port from v1, runs on remote)
- Origin tracking (server registers remote origins at compass positions)
- Session tagging with originId
- Click-to-focus for remote sessions (Kitty opens tab → SSH → tmux attach)
- Multiple agents from same origin

**Out:**
- Visual styling differences for remote (distance is the indicator)
- Origin labels in hex grid
- Fiber reading from remote machines

### Components

#### 1. Agent (server/agent.js)

Port from v1. Runs on remote machine.

**Responsibilities:**
- Discover tmux sessions running claude (`pgrep -P {pane_pid} -f claude`)
- Connect to `localhost:4004` (tunneled) with `?agent=true&origin={hostname}`
- Poll sessions periodically, send `agent_sessions_update`
- Include session cwd for city association
- Include tmux session name for focus targeting

**Keep as JS** — runs standalone, easy deployment, no build step needed.

Agent does NOT handle focus. Just reports state.

#### 2. Origin Tracking (server)

```typescript
interface Origin {
  id: string           // 'local' | 'remote-{hostname}'
  name: string         // hostname
  type: 'local' | 'remote'
  sshHost: string      // SSH config host (e.g., "amundsen", "user@server.com")
  position: { q: number; r: number }  // hex offset (compass direction)
  connectedAt: number
  agentSockets: Set<WebSocket>  // all agent connections for this origin
}
```

**Compass positions** — remotes placed at cardinal/intercardinal directions:
```
        N
   NW   │   NE
     \  │  /
  W ───LOCAL─── E
     /  │  \
   SW   │   SE
        S
```

Distance: ~15-20 hex radii from center (enough to be visually distinct).

**Multiple agents from same origin:** Share the origin, add socket to `agentSockets`. Sessions merged from all agents.

#### 3. Session Handling (server)

Sessions from agents tagged with `originId`:
```typescript
interface ManagedSession {
  // existing fields...
  originId: string       // 'local' | 'remote-{hostname}'
  tmuxSession: string    // tmux session name (for focus)
}
```

**Stale detection:** When agent sends update, reconcile. With multiple agents, session exists if ANY agent reports it.

#### 4. Cities

All cities are ephemeral — derived from session cwds.
- Created when first session appears in that cwd
- Deleted when last session leaves
- No persistence (cities.json removed)
- Positions assigned dynamically, cached for server lifetime

Remote and local cities are structurally identical. Same interface, same rendering, same worker clustering.

#### 5. Click-to-Focus (Remote)

When user clicks a remote session hex:

1. Server looks up session's `originId` → gets `sshHost`
2. Server queries Kitty for existing tab: `kitty @ ls`
3. Look for tab with matching title (e.g., `claude@{hostname}:{project}`)
4. **If found:** `kitty @ focus-tab --match title:{pattern}`
5. **If not found:** `kitty @ launch --type=tab --title={title} ssh -t {sshHost} tmux attach -t {tmuxSession}`

Focus is orchestrated entirely by the local server via Kitty. Agent is not involved.

#### 6. Client Rendering

Remote sessions/cities appear at their origin's compass offset. Distance provides visual distinction. No special styling needed.

### Message Types

#### Agent → Server

```typescript
// Full session list (periodic)
{ type: 'agent_sessions_update', payload: { sessions: ManagedSession[] } }
```

#### Server → Client

```typescript
// Origin connected
{ type: 'origin_connect', payload: Origin }

// Origin disconnected
{ type: 'origin_disconnect', payload: { id: string } }

// Sessions update (existing, now includes originId)
{ type: 'sessions', payload: ManagedSession[] }

// Cities update (existing, now includes ephemeral remote cities)
{ type: 'cities', payload: City[] }
```

#### Server → Agent

```typescript
// Connection confirmed
{ type: 'connected', payload: { originId: string } }
```

### Setup

#### SSH Config (local)

```
Host amundsen
  RemoteForward 4004 127.0.0.1:4004
```

#### Agent Start (remote)

```bash
node agent.js
```

## Context

@/Users/cd280747/Documents/projects/hexarchy/server/agent.js — port this, session discovery via tmux + pgrep
@/Users/cd280747/Documents/projects/hexarchy/server/index.js — origin registration (lines 670-706), agent message handling (lines 1617-1727)
@server/SessionTracker.ts — where to add originId tagging
@server/FocusManager.ts — extend for remote focus (SSH + tmux attach)

## Completion

**Verify by doing, not by checking boxes:**
- Run the tests. Do they pass?
- Try interacting with what you built. Does it work as intended?
- Look for edge cases not covered by tests. Handle them.
- Check that behavior is documented where appropriate.
- Read through the changes with fresh eyes. Anything feel off?

**Done when:**
- Agent connects via tunnel, server tracks origin with compass position
- Sessions from agent appear on hex grid at origin's offset
- Click-to-focus opens Kitty tab + SSH + tmux attach (or focuses existing tab)
- Multiple agents from same origin merge sessions correctly
- Cities derived from remote session cwds appear/disappear with sessions

## Notes

**Test host:** `candide` — `ssh candide` works (already configured in SSH config with RemoteForward). Use this for end-to-end testing.

**Node on candide:** Installed via nvm, requires login shell. Use `bash -l -c "node ..."` or interactive shell. Path: `~/.nvm/versions/node/v24.11.1/bin/node`
