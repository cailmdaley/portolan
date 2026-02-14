# portolan-v2

Spatial map for Claude sessions. Click to go there.

## Core Concepts

- **Cities** = project directories (derived from active sessions, persist when dormant)
- **Workers** = tmux sessions running Claude (clustered around their city hex)
- **Fibers** = open concerns per city (from felt)
- **Playgrounds** = interactive HTML tools per city (`.portolan/playgrounds/`)

Click worker → Kitty focuses that tab. Work happens in terminal, not here.

## Running

```bash
./dev.sh                    # Frontend + backend (recommended)
cd server && npm test       # ~100 tests
```

Requires Kitty with `allow_remote_control yes` and `listen_on unix:/tmp/kitty-socket`.

### Static Tapestry (GitHub Pages)

Deployed to `cailmdaley.github.io/tapestries/` from repo `cailmdaley/tapestries` (Pages serves root of `main`).

```bash
# 1. Build + export (order matters: build first, export second)
npm run build:static                        # Vite → docs/
npx tsx scripts/export-rhizome.ts pure-eb   # Data + artifacts → docs/data/

# 2. Verify locally
npx serve docs

# 3. Push docs/ to tapestries repo
cd docs && git add -A && git commit -m "Update tapestry" && git push && cd ..
```

The `docs/` directory is a separate git repo (remote: `cailmdaley/tapestries`). Build overwrites `index.html`/`assets/` but preserves `data/` (`emptyOutDir: false`). Export adds/updates `data/rhizome.json` and artifact images.

## Architecture

```
Server (Node, :4004)          Browser (Three.js, :5173)
├── SessionTracker            ├── ZoneRenderer (hex meshes)
├── CityManager               ├── Camera (sieve drag)
├── OriginManager (remote)    ├── CityHUD (fibers, search)
├── FiberReader               ├── RhizomeView (D3 DAG)
├── EvidenceReader            ├── ContextMenu
├── ConversationCache         └── main.ts
├── KittyIntegration
└── index.ts (state, WS)
```

Server polls tmux → builds state → broadcasts. Conversation flows via hooks (POST /hook/message → ConversationCache → WebSocket → UI). Browser renders → user clicks → routes to Kitty.

## Visual Language

**Porch Morning** — warm, antiquarian, cartographic.

| Element | Value |
|---------|-------|
| Background | #C8B8A8 (map), #EDE8E0 (panels) |
| Text | #2E2A26 primary, #7A7368 muted |
| Accents | #9A7B35 gold (cities), #5A7B7B teal (working) |
| Fonts | EB Garamond (body), JetBrains Mono (code) |
| Card font | `--card-font-base: 20px` on `.conversation-card`, all child sizes in `em` |
| Card size | 580×520px default |
| Workers | InstancedMesh bird sprites (bird.png), heading from velocity |

Labels use 3-slice banners (parchment for cities, leather for workers).

## Key Decisions

| Cut | Kept |
|-----|------|
| Chat rendering | Terminal handles it |
| Characters/avatars | — |
| Sound, voice | — |
| Stations | — |

This is navigation, not interaction. ~6,200 LOC vs original's 14,000.

## Hex Geometry

Pointy-top orientation. All hex angles need `-π/2` offset:
```typescript
const angle = (Math.PI / 3) * i - Math.PI / 2  // correct
```

Reference: [Red Blob Games](https://www.redblobgames.com/grids/hexagons/)

## Debugging

```bash
curl http://localhost:4004/debug-transcripts   # session→transcript mappings
curl http://localhost:4004/hook/health         # conversation hook status per session
curl 'http://localhost:4004/rhizome?cityId=X'  # full DAG: fibers, evidence, staleness
tail -f /tmp/portolan-hook-debug.log           # hook script debug output
```

Session-transcript correlation uses `lsof` to detect which transcript file each Claude process has open (via `~/.claude/tasks/{uuid}/`). Mappings persist to `~/.portolan/transcript-mappings.json`.

Conversation capture: hooks POST to `/hook/message`, ConversationCache stores by sessionId and aggregates by tmuxSession. Persistence to `~/.portolan/conversations.json` (50 sessions, 10 msgs each).

## Troubleshooting: Remote Workers Missing

Remote workers require an SSH tunnel (`RemoteForward 4004 127.0.0.1:4004` in `~/.ssh/config`).

**Common failure:** SSH ControlMaster keeps a tunnel-less master alive. The tunnel is only established by the *master* connection — if it was created before the config had RemoteForward, or if the tunnel died, new SSH connections reuse the broken master.

**Diagnose:**
```bash
ssh -T remote-host "curl -s http://localhost:4004/"   # should print "Portolan server running"
```

**Fix:**
```bash
ssh -O exit remote-host                               # kill stale master
ssh remote-host                                       # fresh connection with tunnel
ssh -T remote-host "tmux kill-session -t portolan-agent; tmux new-session -d -s portolan-agent 'node ~/bin/portolan-agent.js connect --ssh-host=remote-host'"
```

If tunnel still fails after ControlMaster reset (`remote forward failure for: listen 4004`), the old sshd child is still holding the port on the remote. Fix: `ssh remote-host "fuser -k 4004/tcp"`, then reconnect. See fiber `gotcha-ssh-remoteforward-port-3c440457`.

## Remote Conversation Hooks

For real-time conversation updates on remote workers, install the hook script and configure it to POST to the agent's local hook server (port 4005).

**Setup on remote machine:**
1. Copy hook script: `scp ~/loom/hooks/portolan-conversation-hook.sh remote:~/bin/`
2. Add to shell profile: `export PORTOLAN_URL=http://127.0.0.1:4005`
3. Configure Claude Code hooks in `~/.claude/settings.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": ["~/bin/portolan-conversation-hook.sh"],
    "PostToolUse": ["~/bin/portolan-conversation-hook.sh"],
    "Stop": ["~/bin/portolan-conversation-hook.sh"]
  }
}
```

The agent receives hook POSTs on port 4005 and forwards them via WebSocket to the portolan server. Without hooks, the agent falls back to polling transcripts.

## Gotchas

**Claude native build breaks silently on remote machines.** Claude exits cleanly (exit 0) ~2s after startup — no error message. Debug log (`--debug-file`) shows normal init through OAuth check, then `Released PID lock` and exit. Existing interactive sessions keep working; only new launches fail. Fix: `claude doctor` or `claude install` on the remote. Recurs after auto-updates. See fiber `gotcha-claude-code-native-build-61c642e8`.

**Force Touch events are additive.** `webkitmouseforcedown` fires *in addition to* normal mouse events — the `click` still fires on release. Suppress with capture-phase listener + flag. See `main.ts:451-478`.

**Vite HMR stacks constructor listeners.** Document-level listeners added in constructors accumulate across hot reloads. Add listeners dynamically (in show/hide) with stored references for cleanup.

**Event handler order matters.** `stopImmediatePropagation` only blocks handlers registered *after* yours. Earlier handlers still fire. See fiber `pattern-event-handler-d26b6bae`.

**`kill $PPID` doesn't trigger Claude Code Stop hook.** Ralph loops exit via SIGTERM, which bypasses the Stop hook entirely. The conversation hook works around this by scanning recent transcripts on UserPromptSubmit to capture any missed assistant content.

**tmuxSession prefix for remote conversations.** ConversationCache and WebSocket broadcasts use `originId/tmuxSession` (e.g., `remote-c02/test`). But Session objects from state have unprefixed `tmuxSession` (`test`). Client code must build the prefixed key when matching. See `ConversationCard.prefixedTmuxSession`. Server-side: `handleHookMessage` auto-detects remote hooks (via SSH tunnel) and prefixes tmuxSession before storing — no `PORTOLAN_URL` config needed on remotes.

**Don't normalize conversation timestamps.** Millisecond precision distinguishes content blocks within the same second (thinking at .389Z vs text at .545Z). Stripping ms causes silent message loss. Use exact timestamps for dedup; toolUseId handles cross-source overlap. See fiber `gotcha-ms-precision-timestamps-9b21c263`.

**Conversation lookup: sessionId only, no tmux aggregation.** `resolveConversationMessages` uses `getMessages(sessionId)` exclusively — tmux aggregation removed because it caused cross-contamination between sessions after disconnects. `ConversationCard.handleMessage()` matches by sessionId only (no tmux fallback). On WebSocket reconnect, all open cards re-fetch from server to recover missed messages. See fibers `conversation-session-isolation-dbb8aa40`, `conversationcard-tmux-match-f7c8fc8f`.

**Mid-turn text needs PostToolUse transcript scan.** Stop fires once at END of turn. PostToolUse fires per tool call but only sends tool_use + tool_result. Assistant text between tool uses has no delivery path unless PostToolUse also scans the transcript tail. The hook filters transcript to text/thinking only (tool_use comes from payload). See fiber `mid-turn-assistant-text-needs-3ab050e3`.

**ConversationCache dedup must check within batch.** `addMessages()` deduplicates against existing cache but also needs to track seen items within the incoming batch itself, or transcript-extracted and payload messages in the same POST create duplicates. See fiber `gotcha-conversationcache-dedup-94a66c7c`.

**Card header drag blocks bringToFront.** `startDrag` on the card header calls `stopPropagation()`, which prevents the card-level mousedown listener from firing `onBringToFront`. Fix: call `onBringToFront()` directly in startDrag. See fiber `gotcha-card-header-drag-28ae4165`.

**SSH commands: never double-quote-wrap user content.** `execAsync(\`ssh host "cmd '${userArg}'"\`)` is vulnerable — double quotes in `userArg` break out of wrapping. Use `execFileAsync('ssh', [host, cmd])` to bypass local shell entirely, and `shellEscape()` (from KittyIntegration) for quoting within the remote command string. All SSH handlers now follow this pattern. See fiber `gotcha-ssh-double-quote-810f6df9`.

**felt depends_on is objects, not strings.** `felt ls --json` emits `depends_on: [{id: "..."}]` (Dependency objects with optional label), not bare string arrays. `getAllCityFibers` must extract `.id` from each entry. See fiber `portolan-depends-on-mapping-6e692fcf`.

**Stop hook fires before transcript flush.** The Stop hook and the final assistant text write happen in the same sub-second. The hook's `tail|jq` reads a stale transcript missing the last entry. Fix: `sleep 0.3` at the top of the Stop handler. While the hook sleeps, Claude Code's event loop flushes the pending write. See fiber `gotcha-stop-hook-transcript-c50e76c0`.

**Subagent transcripts bleed into parent conversation.** Task tool subagents write to `.../subagents/agent-<id>.jsonl`. The UserPromptSubmit scan (`find *.jsonl`) recurses into this directory, and subagent Stop hooks fire with the subagent's transcript_path but the parent's session_id. Fix: `-not -path "*/subagents/*"` in find, and `case */subagents/*` skip in Stop handler. See fiber `gotcha-subagent-transcripts-8975ca25`.

**Parallel SSH calls exhaust ControlMaster connections.** 20+ concurrent `execFileAsync('ssh', ...)` calls cause silent failures — half return errors, caught and swallowed as null. Fix: batch into a single SSH command with delimited output. See `readEvidenceBatch()` in EvidenceReader.ts. See fiber `batch-ssh-evidence-reads-to-bf8c0096`.

## Deep Dives

Fibers in `.felt/` provide detail beyond this overview.

| Topic | File |
|-------|------|
| Interactions | `.felt/portolan-interactions-gesture-245370ce.md` |
| Persistence | `.felt/portolan-persistence-5335c979.md` |
| Architecture | `.felt/portolan-architecture-server-361a92a2.md` |
| Visual Design | `.felt/portolan-visual-design-palette-49cdf63d.md` |
| Remote Agent | `.felt/portolan-remote-agent-setup-ssh-b7ce007f.md` |
| Asset Generation | `.felt/portolan-assets-nano-banana-aec3aef3.md` |
| City Sprites | `.felt/document-nano-banana-prompting-15652206.md` |
| Worker Swarms | `.felt/murmuration-workers-68674cb9.md` |
| Remote Proxying | `.felt/pattern-portolan-remote-content-8180cf9d.md` |
| Claims Annotation | `.felt/claims-annotation-inline-bba0fc30.md` |
| Claims Side Panel | `.felt/claims-annotation-side-panel-f290eeb2.md` |
| Rhizome Endpoint | `.felt/rhizome-endpoint-returns-full-2a1e18b5.md` |
| Rhizome rule: tags | `.felt/rule-tag-replaces-spec-tag-for-b03b4699.md` |
| Rhizome DAG spec | `.felt/absorb-claims-dashboard-into-ed04e0e9.md` |
| Config Interpolation | `.felt/config-value-interpolation-in-e3a39852.md` |
| SSH Batch Evidence | `.felt/batch-ssh-evidence-reads-to-bf8c0096.md` |
| Static Tapestry | `.felt/static-rhizome-dashboard-on-13a8fbc4.md` |
| Fiber Sidebar | `.felt/tapestry-fiber-sidebar-ec45c86b.md` |
| Rendered Markdown | `.felt/rendered-markdown-by-default-6cb4d4f3.md` |

Search patterns/gotchas: `felt find pattern` or `felt find gotcha`
