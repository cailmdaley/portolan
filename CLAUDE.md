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
./dev.sh                    # Start/attach shared tmux session (frontend + backend + Shuttle)
./dev.sh restart            # Bounce the shared tmux session from any terminal/agent
./dev.sh kill               # Stop session and clear ports 5173, 4004, 4000
bun run tauri:dev           # Native desktop shell around the same dev stack
bun run tauri:build         # Build Portolan.app + DMG under target/release/bundle/ (legacy src-tauri/target may linger)
bun run native:backend-smoke  # App-owned native backend boundary smoke without launching GUI
./scripts/install-tunnels.sh # Install launchd-managed autossh tunnels for candide + cineca
cd server && bun test       # ~700 tests
```

This repo installs with **bun** (see `bunfig.toml`), which is the only manager
in the package-manager triad whose 7-day release-age guard
(`minimumReleaseAge = 604800`) is actually honored end-to-end. `npm install`
silently bypasses that cooldown — don't use it. The Tauri Rust dev launcher
in `src-tauri/src/lib.rs` still hardcodes `npm`; swap to `bun` when the
in-progress native-window work commits.

Requires Kitty with `allow_remote_control yes` and `listen_on unix:/tmp/kitty-socket`.
The dev stack lives in tmux session `portolan-dev`; detach with `Ctrl+B`, then `D`.

## Testing

Portolan has a strong preference for tests that exercise real seams: HTTP routes,
modal click paths, tmux/agent adapters, and end-to-end browser behavior when the
bug was user-visible. Unit tests are welcome for pure classification or parsing
rules, but a button, route, or agent workflow that failed in dogfooding should
usually leave behind coverage at the highest practical layer.

When an issue comes in as "this button doesn't work" or "this action did the
wrong thing," extend the test surface around that workflow before calling it
fixed. Prefer a regression that clicks the actual UI control or calls the real
HTTP handler with representative fixtures over a narrow helper mock that only
proves the helper still works. If a full agent launch would be expensive, stop at
the last free boundary that still proves intent, such as "the right tmux send
would happen" or "the right Shuttle request body would be sent."

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

Server polls tmux → builds state → broadcasts. File touches flow through the canonical hook JSONL stream (`~/.portolan/data/events.jsonl` → `EventWatcher`/`portolan-agent` → `RecentFileTracker`). Browser renders → user clicks → routes to Kitty.

**File viewer = vellum.** Main app opens files via `openVellumWorkspaceModal({ initialFilePath })` in `src/vellum/mount.tsx` → `WorkspaceMount` → `FiberPage`'s `FileModeView` → vellum's `FileViewerPage` + `PortolanAdapter` → server endpoints (`/project-file/`, `/raw-file/`, `/file-content`, `/fiber/:slug`, annotations). Files and fibers share one workspace shell (the standalone `openVellumFileModal()` retired 2026-04-25 — see `card-redesign/file-modal-absorbs-into-workspace`). Portolan's old `src/ui/FileViewer*` is gone; React only lives inside `src/vellum/`, everything else is vanilla TS/Three.js.

## Kanban

The kanban is a **view** over fiber state, not a state of its own. Three layers feed it, each owned differently:

| Layer | Owner | Fields | Affects dispatch? | Affects view? |
|---|---|---|---|---|
| `shuttle:` block | shuttle-ctl | `enabled`, `kind`, `schedule`, `review.state`, `agent`, `session.id` | ✓ | ✓ |
| Universal lifecycle | felt | `status`, `tempered`, `depends_on` | ✓ | ✓ |
| Tags | user (free-form) | e.g. `idea` | ✗ | only `idea` |

**Column placement is one named function**: `classifyFiber(f) → KanbanColumn` in `server/src/HttpApiKanban.ts`. The full rule (standing-role precedence over status, idea-tag precedence over enabled, status×tempered for closed lifecycle) lives there with a plain-English doc comment and pinned by tests under `describe('classifyFiber')`. Don't re-derive column placement anywhere else.

**Frontend never reclassifies.** The kanban response groups cards by column server-side; the frontend reads the bucket via `findCardColumn(response, id)`. Adding a new classification dimension = editing `classifyFiber`, no frontend change. (Two implementations of the same rule used to drift — see `gotcha-kanban-frontend-classifier-drift`.)

**Tag conventions:** `idea` is the only tag that affects column placement (routes to the speculative ideas column, regardless of `shuttle.enabled`). The `draft` tag is vestigial — many older fibers carry it, no code reads or writes it; it's pinned-as-cosmetic by a test. New tags should not be made load-bearing for classification — promote the signal into the `shuttle:` block or universal lifecycle if it needs to gate dispatch.

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

This is navigation, not interaction. ~75K source LOC today (~20K more in tests); the original "stripped-down" framing no longer applies — vellum, the kanban, the Rust crates, and the Tauri shell all live here now.

## Debugging

```bash
curl http://localhost:4004/debug-runtime       # runtime state and map sizes
curl 'http://localhost:4004/recent-files?sessionId=X'  # recent file touches for a worker
printf '%s\n' '{"hook_event_name":"PostToolUse","session_id":"test","tool_name":"Read","tool_input":{"file_path":"/tmp/test.ts"},"cwd":"/tmp"}' \
  | PORTOLAN_EVENTS_FILE=/tmp/portolan-events-smoke.jsonl server/hooks/portolan-hook.sh
curl 'http://localhost:4004/fiber-graph?cityId=X'  # Vellum graph: fibers + links
curl 'http://localhost:4004/project-file/local/path/to/file.html'  # serve project file (also: /project-file/{originId}/path)
# The ASTRA paper-view routes are extension stubs now; Portolan core returns 501 for them.
tail -f /tmp/portolan-hook-debug.log           # hook script debug output
```

## Troubleshooting: Remote Workers Missing

Remote portolan-agent reaches the local backend through launchd-managed autossh jobs:
`com.cailmdaley.portolan-tunnel-candide` and `com.cailmdaley.portolan-tunnel-cineca`.
Install/update them with `./scripts/install-tunnels.sh`; logs land in
`~/.local/state/portolan/tunnel-<host>.log`.

When a remote agent WebSocket disconnects, Portolan now self-recovers: it kickstarts
the launchd tunnel, verifies the remote can reach local `/debug-runtime`, and restarts
only the remote `portolan-agent` tmux session. Check `/debug-runtime` under
`runtime.remoteAgentRecovery` and the backend log lines prefixed `[RemoteAgent]` to
distinguish tunnel-unreachable from tunnel-reachable-agent-restarted.

**Quick fix:** `./scripts/reset-tunnel.sh <host>` — `launchctl kickstart -k` for the tunnel, then restarts the default Rust agent.
Manual fallback: `./scripts/reset-tunnel.sh --manual <host>` runs a one-shot reverse tunnel.
Port still held? `ssh <host> "fuser -k 4004/tcp"`. See fibers `gotcha-ssh-remoteforward-port`
and `gotchas/gotcha-candide-reverse-tunnel-backoff`.

For Rust agent smoke tests, use a separate runtime session so Node stays as fallback:

- Build a Linux Rust agent binary from macOS: `bun run native:agent:linux`
- Install remote hooks and artifacts:
  - `./scripts/install-remote.sh <host> --agent-binary crates/portolan-agent/target/x86_64-unknown-linux-gnu/release/portolan-agent-rust`
  - Optional session knobs:
    - `--origin <origin>` (defaults to `<host>`)
    - `--plannotator-port <port>` (pass this through to Rust with `--plannotator-port=<port>`)
    - `--once` (exit after one disconnect)
- Start or restart the Rust runtime:
  - `./scripts/reset-tunnel.sh <host>` (or `./scripts/reset-tunnel.sh --agent-runtime rust <host>` when being explicit)
  - `./scripts/reset-tunnel.sh --agent-runtime rust --origin <origin> --plannotator-port <port> --once <host>`
- Both commands print the resolved runtime command and a short session log tail so you can confirm the Rust agent attached and which runtime/socket flags were applied during remote smokes.

Node fallback remains explicit and unchanged:
- Node runtime is still in session `portolan-agent`.
- Rust agent runtime is still in session `portolan-agent-rust`.
- Normal restarts stop the opposite runtime session so only one socket per origin is active at a time; with `--once`, Rust agent runs side-by-side and exits cleanly.
- Default Rust installs do not refresh `~/.local/bin/portolan-agent.js`; pass `--install-node-fallback` with a Rust install only when you deliberately want rollback staged.
- Install/start the Node fallback with `./scripts/install-remote.sh --agent-runtime node <host>` when rollback is intentional.
- Resume Node fallback with `./scripts/reset-tunnel.sh --agent-runtime node <host>` (or let normal self-recovery bring Node back when needed).

Candide-specific model: SSH is ping-gated and seems to impose a short backoff after failed opens.
Do not hammer it. First check whether candide can see the local backend:
`ssh candide "curl -sS --max-time 4 http://localhost:4004/debug-runtime"`.
If that hangs or refuses, debug the reverse tunnel before blaming tmux or the agent.
`ss -ltnp | grep :4004` on candide shows whether a stale remote listener is blocking autossh.
If Portolan is healthy locally but candide cannot reach `localhost:4004`, clear the remote listener,
wait out the backoff, then start a command-mode tunnel (`ssh -R 4004:localhost:4004 candide 'sleep 3600'`);
bare `ssh -N -R ...` is brittle on candide.

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
- **Touching SSH?** `execFileAsync` + `shellEscape()`; single-quote remote commands (double-quotes expand locally); `--ssh-host` is the base name; one origin = one live agent (duplicate sockets race); `reconnectTunnel` must kick the launchd tunnel first and only use one-shot SSH as fallback.
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
| Graph Export (/fiber-graph) | `absorb-claims-dashboard-into` |
| Extraction Pattern | `extraction-pattern` |
| Voice Ingress | `constitution-portolan-voice-ingress`; Parakeet live mic daemon at `server/voice-ingress/parakeet_daemon.py` / `server/src/ParakeetTranscriptSource.ts`; VibeVoice-ASR file/batch daemon at `server/voice-ingress/vibevoice_asr_daemon.py` / `server/src/VibeVoiceTranscriptSource.ts` |
