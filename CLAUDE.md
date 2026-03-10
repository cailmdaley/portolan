# portolan-v2

Spatial map for Claude sessions. Click to go there. **This repo is local-only (no git remote).** The `docs/` subdirectory is a separate repo (`cailmdaley/tapestries`) — that's the only thing that pushes.

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
./scripts/publish-tapestry.sh cmbx pure_eb   # build, export, commit, push
./scripts/publish-tapestry.sh                 # all cities in manifest
./scripts/publish-tapestry.sh cmbx --force    # re-download all artifacts
npx serve docs                                # verify locally before pushing
```

The `docs/` directory is a separate git repo (remote: `cailmdaley/tapestries`). Build overwrites `index.html`/`assets/` but preserves `data/` (`emptyOutDir: false`). Export adds/updates `data/tapestry.json` and artifact images. Shareable URLs: clicking a node sets `#fiber-id` in the URL; opening that URL auto-selects the node.

## Architecture

```
Server (Node, :4004)          Browser (Three.js, :5173)
├── SessionTracker            ├── ZoneRenderer (hex meshes)
├── CityManager               ├── Camera (sieve drag)
├── OriginManager (remote)    ├── CityHUD (fibers, search)
├── FiberReader               ├── TapestryView (D3 DAG)
├── EvidenceReader            ├── ContextMenu
├── RecentFileTracker         └── main.ts
├── KittyIntegration
└── index.ts (state, WS)
```

Server polls tmux → builds state → broadcasts. File touches flow via hooks (POST `/hook/file-touch` → `RecentFileTracker`). Browser renders → user clicks → routes to Kitty.

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
tail -f /tmp/portolan-hook-debug.log           # hook script debug output
```

## Troubleshooting: Remote Workers Missing

Requires `RemoteForward 4004 127.0.0.1:4004` in `~/.ssh/config`. Common failure: stale ControlMaster without tunnel.
Diagnose: `ssh -T remote-host "curl -s http://localhost:4004/"`. Fix: `ssh -O exit remote-host && ssh remote-host`.
Port still held? `ssh remote-host "fuser -k 4004/tcp"`. See fiber `gotcha-ssh-remoteforward-port-3c440457`.

## Remote File-Touch Hooks

Remote workers should post `PostToolUse` events directly to portolan over the existing SSH `RemoteForward`:

```json
"PostToolUse": [{
  "matcher": "Read|Write|Edit",
  "hooks": [{ "type": "http", "url": "http://localhost:4004/hook/file-touch" }]
}]
```

No agent-side hook proxy or transcript fallback is required.

## Gotchas

**Claude native build breaks silently on remote.** Silent exit 0 ~2s after launch. Fix: `claude doctor`. See fiber `gotcha-claude-code-native-build-61c642e8`.

**CSS context rules override class selectors.** `.tapestry-detail-body code` beats bare `.config-resolved`. Fix: qualify selector. See fiber `css-specificity-gotcha-context-782f26f4`.

**Force Touch is additive.** `webkitmouseforcedown` + `click` both fire. Suppress with capture-phase flag. See `main.ts:451-478`.

**Vite HMR stacks constructor listeners.** Add doc-level listeners in show/hide, not constructors.

**Event handler order.** `stopImmediatePropagation` only blocks later-registered handlers. See fiber `pattern-event-handler-d26b6bae`.

**SSH: use `execFileAsync` not shell interpolation.** String wrapping is injection-vulnerable. Use `shellEscape()` for remote args. See fiber `gotcha-ssh-double-quote-810f6df9`.

**Codex process name is "node" on Linux.** Check `ps -o args=` fallback. macOS is `codex`. See fiber `gotcha-codex-process-name-is-09e0e1b9`.

**Ralph launches codex 3+ levels deep.** `bash→python3→MainThread→codex` — single-level `pgrep -P` misses it. BFS up to depth 4 in `agent.js` and `SessionTracker.ts`. See fiber `bfs-descendant-search-for-cli-ae31b2f9`.

**Candide: node not in PATH for non-interactive SSH.** Use full path `/home/cdaley/.nvm/versions/node/v24.13.1/bin/node` when running via nohup/SSH. Candide tmux is 2.7 — `allow-passthrough` and `terminal-features` require 3.3+, wrapped in `if-shell` guards. See fiber `candide-tmux-2-7-incompatible-53b9eae6`.

**SSH remote shell expansion.** `ssh host "kill $(pgrep ...)"` expands `$()` locally — sends local PIDs to the remote. Always use single quotes: `ssh host 'kill $(pgrep ...)'`. See fiber `gotcha-ssh-double-quote-shell-11b71ed1`.

**felt `depends_on` is objects.** `[{id: "..."}]` not strings. Extract `.id`. See fiber `portolan-depends-on-mapping-6e692fcf`.

**Comma-separated felt tags break matching.** Split on `,` in FiberReader + HttpApi. See fiber `comma-separated-tags-silently-13451ba9`.

**Evidence artifacts: `output` field only.** No dir scan, no legacy fields. See fiber `evidence-artifacts-only-render-4349fadf`.

**Agent `--ssh-host`: always the base name.** `buildSpecificSshHost` appends login node; doubled if already specific. See fiber `gotcha-agent-ssh-host-must-be-fdd3b94c`.

**Parallel SSH exhausts ControlMaster.** Batch into single SSH call with delimited output. See `readEvidenceBatch()`. See fiber `batch-ssh-evidence-reads-to-bf8c0096`.

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
| Tapestry Endpoint | `.felt/tapestry-endpoint-returns-full-2a1e18b5.md` |
| Tapestry tags | `.felt/rule-tag-replaces-spec-tag-for-b03b4699.md` |
| Tapestry DAG spec | `.felt/absorb-claims-dashboard-into-ed04e0e9.md` |
| Config Interpolation | `.felt/config-value-interpolation-in-e3a39852.md` |
| SSH Batch Evidence | `.felt/batch-ssh-evidence-reads-to-bf8c0096.md` |
| Comma Tag Bug | `.felt/comma-separated-tags-silently-13451ba9.md` |
| Artifact Array Crash | `.felt/array-artifact-values-crash-ad036e78.md` |
| SSH Stability | `.felt/ssh-stability-controlmaster-5e3ed591.md` |
| Static Tapestry | `.felt/static-rhizome-dashboard-on-13a8fbc4.md` |
| Fiber Sidebar | `.felt/tapestry-fiber-sidebar-ec45c86b.md` |
| Rendered Markdown | `.felt/rendered-markdown-by-default-6cb4d4f3.md` |

Search patterns/gotchas: `felt find pattern` or `felt find gotcha`
