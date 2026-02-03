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

## Architecture

```
Server (Node, :4004)          Browser (Three.js, :5173)
├── SessionTracker            ├── ZoneRenderer (hex meshes)
├── CityManager               ├── Camera (sieve drag)
├── OriginManager (remote)    ├── CityPanel (fibers, search)
├── FiberReader               ├── ContextMenu
├── KittyIntegration          └── main.ts
└── index.ts (state, WS)
```

Server polls tmux → builds state → broadcasts. Browser renders → user clicks → routes to Kitty.

## Visual Language

**Porch Morning** — warm, antiquarian, cartographic.

| Element | Value |
|---------|-------|
| Background | #C8B8A8 (map), #EDE8E0 (panels) |
| Text | #2E2A26 primary, #7A7368 muted |
| Accents | #9A7B35 gold (cities), #5A7B7B teal (working) |
| Fonts | EB Garamond (body), JetBrains Mono (code) |

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
```

Session-transcript correlation uses `lsof` to detect which transcript file each Claude process has open (via `~/.claude/tasks/{uuid}/`). Mappings persist to `~/.portolan/transcript-mappings.json`.

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

## Gotchas

**Force Touch events are additive.** `webkitmouseforcedown` fires *in addition to* normal mouse events — the `click` still fires on release. Suppress with capture-phase listener + flag. See `main.ts:451-478`.

**Vite HMR stacks constructor listeners.** Document-level listeners added in constructors accumulate across hot reloads. Add listeners dynamically (in show/hide) with stored references for cleanup.

**Event handler order matters.** `stopImmediatePropagation` only blocks handlers registered *after* yours. Earlier handlers still fire. See fiber `pattern-event-handler-d26b6bae`.

**`kill $PPID` doesn't trigger Claude Code Stop hook.** Ralph loops exit via SIGTERM, which bypasses the Stop hook entirely. The conversation hook works around this by scanning recent transcripts on UserPromptSubmit to capture any missed assistant content.

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
| Remote Proxying | `.felt/pattern-portolan-remote-content-8180cf9d.md` |

Search patterns/gotchas: `felt find pattern` or `felt find gotcha`
