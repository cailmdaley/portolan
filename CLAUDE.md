(portolan)=
# portolan-v2

Spatial map for Claude sessions. Click to go there. **This repo is local-only (no git remote).**

## Core Concepts

- **Cities** = project directories (derived from active sessions, persist when dormant)
- **Workers** = tmux sessions running Claude (clustered around their city hex)
- **Fibers** = open concerns per city (from felt)
- **Playgrounds** = interactive HTML tools per city (`.portolan/playgrounds/`)

Click worker → Kitty focuses that tab. Work happens in terminal, not here.

## Running

```bash
./dev.sh                    # Frontend + backend (recommended)
cd server && npm test       # ~282 tests
```

Requires Kitty with `allow_remote_control yes` and `listen_on unix:/tmp/kitty-socket`.

## Architecture

```
Server (Node, :4004)          Browser (Three.js, :5173)
├── SessionTracker            ├── ZoneRenderer (hex meshes)
├── CityManager               ├── Camera (sieve drag)
├── OriginManager (remote)    ├── MapChromeBar (vellum + workers)
├── FiberReader               ├── Vellum workspace (`v`/`k`/`/`)
├── EvidenceReader            ├── Find dashboard (fibers/files/git)
├── RecentFileTracker         ├── WorkerPicker / NewWorkerDialog
├── KittyIntegration          ├── ContextMenu / PlaygroundViewer
└── index.ts (state, WS)      └── main.ts
```

Server polls tmux → builds state → broadcasts. File touches flow via hooks (POST `/hook/file-touch` → `RecentFileTracker`). Browser renders → user clicks → routes to Kitty.

**File viewer = vellum.** Main app opens files via `openVellumWorkspaceModal({ initialFilePath })` in `src/vellum/mount.tsx` → `WorkspaceMount` → `FiberPage`'s `FileModeView` → vellum's `FileViewerPage` + `PortolanAdapter` → server endpoints (`/project-file/`, `/raw-file/`, `/file-content`, `/fiber/:slug`, annotations). Files and fibers share one workspace shell (the standalone `openVellumFileModal()` retired 2026-04-25 — see `card-redesign/file-modal-absorbs-into-workspace`). Portolan's old `src/ui/FileViewer*` is gone; React only lives inside `src/vellum/`, everything else is vanilla TS/Three.js.

## Visual Language

**Porch Morning** — warm, antiquarian, cartographic.

| Element | Value |
|---------|-------|
| Background | #C8B8A8 (map), #EDE8E0 (panels) |
| Text | #2E2A26 primary, #7A7368 muted |
| Accents | #9A7B35 gold (cities), #5A7B7B teal (working) |
| Fonts | EB Garamond (body), JetBrains Mono (code) |
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

## Debugging

```bash
curl http://localhost:4004/debug-runtime       # runtime state and map sizes
curl 'http://localhost:4004/recent-files?sessionId=X'  # recent file touches for a worker
curl -s localhost:4004/hook/file-touch -X POST -H 'Content-Type: application/json' \
  -d '{"session_id":"test","tool_name":"Read","tool_input":{"file_path":"/tmp/test.ts"}}'
curl 'http://localhost:4004/tapestry?cityId=X'  # full DAG: fibers, evidence, staleness
curl 'http://localhost:4004/project-file/local/path/to/file.html'  # serve project file (also: /project-file/{originId}/path)
curl 'http://localhost:4004/astra-paper-view/local/abs/path/to/astra.yaml'  # render astra.yaml as lightcone paper view (local only)
curl 'http://localhost:4004/astra-bundle/local/abs/path/to/astra.yaml'      # JSON Bundle + csvs (vellum-native astra renderer feeds off this; response also carries mtime token)
curl 'http://localhost:4004/astra-mtime/local/abs/path/to/astra.yaml'       # cheap stat token (no buildBundle); vellum's focus-staleness probe
curl 'http://localhost:4004/astra/asset/vellum.css'                         # paper-view CSS/JS sidecars (paper-viewer.js, vellum.css)
tail -f /tmp/portolan-hook-debug.log           # hook script debug output
```

## Troubleshooting: Remote Workers Missing

Requires `RemoteForward 4004 127.0.0.1:4004` in `~/.ssh/config`. Common failure: stale ControlMaster without tunnel.
**Quick fix:** `./scripts/reset-tunnel.sh <host>` — resets ControlMaster, re-establishes tunnel, restarts agent.
Manual: `ssh -O exit host && ssh -N -f host`, then restart portolan-agent tmux session.
Port still held? `ssh remote-host "fuser -k 4004/tcp"`. See fiber `gotcha-ssh-remoteforward-port`.

## Activity Pipeline

One hook script on every host (`~/loom/hooks/portolan-hook.sh`) writes tool events to `~/.portolan/data/events.jsonl`. Two tailers converge on the same sinks:

- **Local**: `EventWatcher` tails `events.jsonl` → `onActivity` callback in `index.ts` → `recordTouch` + `broadcastActivity`.
- **Remote**: `portolan-agent` (`server/agent.js`) tails the remote `events.jsonl`, pushes `agent_activity` messages over the SSH `RemoteForward` WebSocket → `RemoteAgentCoordinator.handleAgentActivity` → same sinks.

Same hook, same event stream, same sinks — the tailer just runs in a different process depending on where the worker lives. No Claude Code HTTP hooks are used for file-touch tracking.

## Invariants

When adding new code, these are the rules new code will violate if you don't know:

- **New modal?** Default to `AppDialog` from `src/ui/AppDialog.tsx` (Radix-backed; focus trap + escape + portal + scroll lock for free). Only fall back to the legacy `lockModalBackground()` from `src/ui/modalBackgroundLock.ts` when growing an existing imperative modal class such as `NewWorkerDialog` or `PlaygroundViewer`. For the legacy path: call `lockModalBackground()` on show, return value on hide. `aria-modal="true"` alone doesn't hide siblings — AT and the agent-browser snapshot still see the map through any full-viewport modal. Stacked modals also need window-capture Escape + body-sibling inert.
- **New scrollable overlay?** Add it to Camera's `closest()` exemption list, or window-wheel preventDefault eats overlay scroll and zooms the map instead.
- **Popovers near vellum?** z-index ≥ 10000. `.vellum-modal-scrim` is 9999.
- **Touching SSH?** `execFileAsync` + `shellEscape()`; single-quote remote commands (double-quotes expand locally); `--ssh-host` is the base name; one origin = one live agent (duplicate sockets race); `reconnectTunnel` must `ssh -O exit` first.
- **Touching felt?** Fibers use `name`, never `title`. `felt add <slug> <name>` (two args). Tags are comma-separated. `depends_on` is objects, extract `.id`.
- **Mounting `<PretextProse>`?** Sibling `<TextAnnotationLayer>` for selection-to-comment / margin notes; measure `proseRef`'s `contentBoxSize.inlineSize` for `contentWidth`, not the wrapper's `clientWidth` — `.vellum-prose` has 3.5rem horizontal padding the wrapper doesn't account for.
- **Type/picker that mounts in differently-sized containers?** Container queries (`container-type: inline-size`), not media queries — viewport doesn't change when the component shrinks inside a modal/embed.

## Trap fibers

Past surprises live in fibers — `felt ls -s all gotcha` is the live index. High-density areas: vellum modal a11y, SSH/remote-agent lifecycle, container-query sized typography. Search by area: `felt ls -s all gotcha vellum`, `felt ls -s all gotcha ssh`, `felt ls -s all gotcha astra`.

## Deep Dives

Core doc fibers. For more: `felt ls -s all pattern` or `felt ls -s all gotcha`.

| Topic | Fiber |
|-------|-------|
| Architecture | `hexarchy-architecture-server` |
| Activity Pipeline | `activity-pipeline` |
| Interactions | `hexarchy-interactions-gesture` |
| Visual Design | `hexarchy-visual-design-palette` |
| Remote Agent | `hexarchy-remote-agent-setup-ssh` |
| Remote Proxying | `pattern-hexarchy-remote-content` |
| Worker Swarms | `murmuration-workers` |
| Tapestry → Vellum | `tapestry-dissolves` |
| DAG Export (/tapestry) | `absorb-claims-dashboard-into` |
| Extraction Pattern | `extraction-pattern` |
| Voice Ingress | `constitution-portolan-voice-ingress`; Parakeet live mic daemon at `server/voice-ingress/parakeet_daemon.py` / `server/src/ParakeetTranscriptSource.ts`; VibeVoice-ASR file/batch daemon at `server/voice-ingress/vibevoice_asr_daemon.py` / `server/src/VibeVoiceTranscriptSource.ts` |
