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

Deployed to `cailmdaley.github.io/tapestries/` from repo `cailmdaley/tapestries` (branch: `live`).

**Repo structure:** `cailmdaley/tapestries` is a GitHub template repo with two branches:
- `main` — template: viewer + demo data. Cloning gives a working tapestry site.
- `live` — real data. GitHub Pages serves from here.

**Local setup:** `docs/` is a clone of `cailmdaley/tapestries`. `~/.felt/tapestries` symlinks to it. `felt tapestry export` writes to `~/.felt/tapestries/data/{city}/`, which lands in `docs/data/{city}/`.

**Export workflow** (replaces `publish-tapestry.sh`):
```bash
cd ~/Documents/projects/some-project
felt tapestry export                        # writes to ~/.felt/tapestries/data/{project}/
cd ~/Documents/projects/portolan/docs       # = the tapestries repo
git checkout live
git add -A && git commit -m "update" && git push
```

**Viewer rebuild** (rare — only when portolan frontend changes):
```bash
cd ~/Documents/projects/portolan
npm run build:static                        # rebuilds index.html + assets/ into docs/
cd docs
git checkout main && git add index.html assets/ fonts/ && git commit -m "rebuild viewer" && git push
git checkout live && git merge main && git push
```

On other machines, `~/.felt/tapestries/` is a standalone clone (not inside portolan). Same export command works everywhere.

## Architecture

```
Server (Node, :4004)          Browser (Three.js, :5173)
├── SessionTracker            ├── ZoneRenderer (hex meshes)
├── CityManager               ├── Camera (sieve drag)
├── OriginManager (remote)    ├── CityHUD (fibers, search)
├── FiberReader               ├── TapestryView (D3 DAG)
├── EvidenceReader            ├── GlobalSearchPalette (/ key)
├── RecentFileTracker         ├── RecentWorkerBar (top wire)
├── KittyIntegration          ├── ContextMenu
└── index.ts (state, WS)      └── main.ts
```

Server polls tmux → builds state → broadcasts. File touches flow via hooks (POST `/hook/file-touch` → `RecentFileTracker`). Browser renders → user clicks → routes to Kitty.

**Two file viewer modals — know which one you're editing:**
| | `FileViewerModal` | `TapestryStaticFileModal` |
|---|---|---|
| Used by | Main app (localhost:5173) | Static GitHub Pages viewer |
| Routing | `TapestryView.openFileFromLink` → `onOpenFile` → `fileViewerModal.show()` | `TapestryView.openFileFromLink` → `runtime.openStaticFile()` (only when `staticMode`) |
| Files backed by | Server API (`/project-file/`, `/raw-file/`) | Static fetch from `files/` directory |
| Styles | Inline in root `index.html` (`.file-viewer-*`) | `src/ui/tapestry-file-modal.css` (`.tapestry-file-*`) |
| Features | CodeMirror editor, annotations, save, vim mode | Read-only: PDF.js, Prism highlighting |

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
tail -f /tmp/portolan-hook-debug.log           # hook script debug output
```

## Troubleshooting: Remote Workers Missing

Requires `RemoteForward 4004 127.0.0.1:4004` in `~/.ssh/config`. Common failure: stale ControlMaster without tunnel.
**Quick fix:** `./scripts/reset-tunnel.sh <host>` — resets ControlMaster, re-establishes tunnel, restarts agent.
Manual: `ssh -O exit host && ssh -N -f host`, then restart portolan-agent tmux session.
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

One-liners. Fiber has the full story. `felt ls -s all gotcha` for more.

- **Force Touch is additive.** Suppress `click` with capture-phase flag. `main.ts:451-478`.
- **Vite HMR stacks listeners.** Add doc-level listeners in show/hide, not constructors.
- **SSH: `execFileAsync`, not shell interpolation.** Use `shellEscape()`. `gotcha-ssh-double-quote-810f6df9`
- **SSH: single-quote remote commands.** `ssh host 'kill $(pgrep ...)'` — double quotes expand locally. `gotcha-ssh-double-quote-shell-11b71ed1`
- **SSH: `--ssh-host` is always the base name.** `gotcha-agent-ssh-host-must-be-fdd3b94c`
- **SSH: parallel exhausts ControlMaster.** Batch into single call. `batch-ssh-evidence-reads-to-bf8c0096`
- **Remote: duplicate `portolan-agent` sockets race origin state.** One origin must have one live agent. `debug-pure-eb-worker-flicker-bcaf407e`
- **Codex process name is "node" on Linux.** Check `ps -o args=` fallback. `gotcha-codex-process-name-is-09e0e1b9`
- **Ralph spawns codex 3+ levels deep.** BFS up to depth 4. `bfs-descendant-search-for-cli-ae31b2f9`
- **Remote `lastActivity`: only bump when working.** `bug-remote-lastactivity-inflated-ae8ce2fb`
- **`felt depends_on` is objects.** Extract `.id`. `portolan-depends-on-mapping-6e692fcf`
- **Comma-separated felt tags.** Split on `,`. `comma-separated-tags-silently-13451ba9`
- **Evidence artifacts: `output` field only.** `evidence-artifacts-only-render-4349fadf`
- **Candide: tmux 2.7, node not in PATH.** `candide-tmux-2-7-incompatible-53b9eae6`
- **Claude native build silent fail on remote.** `claude doctor`. `gotcha-claude-code-native-build-61c642e8`
- **CSS context rules override class selectors.** Qualify selector. `css-specificity-gotcha-context-782f26f4`
- **`staticDataBase` regex over-strips.** Use `/\/tapestry$/` not `/\/[^/]+\/tapestry$/`. `fix-staticdatabase-url-d1d5bedc`
- **tmux `=` prefix breaks on 2.7.** Remote paste-buffer uses bare session name. `tmux-prefix-breaks-paste-buffer-191ccefc`
- **Two file viewer modals.** `FileViewerModal` (main app, `.file-viewer-*`) vs `TapestryStaticFileModal` (static deploy, `.tapestry-file-*`). If on localhost, you're editing the wrong one. See Architecture.
- **`show()` strips URL hash.** `hideDetail()` → `pushHash(null)` before `showCity` reads it. Capture hash first. `hash-stripped-on-tapestry-show-f7700fb8`
- **`reconnectTunnel` must kill ControlMaster first.** `ssh -fN` alone multiplexes through the stale master. `stale-controlmaster-breaks-ab430b0f`
- **Remote origin ID derived from sshHost, not hostname.** Raw hostname (e.g. `login07.leonardo.local`) doesn't match persisted `remote-cineca`. `remote-origin-id-mismatch-0994fb6f`
- **Dormant remote cities need `hasClaims` default.** No active session → agent never reports `hasClaims`. Pinned remote cities default `true`. `dormant-remote-cities-lack-37a383a9`

## Deep Dives

Core doc fibers. For more: `felt ls -s all pattern` or `felt ls -s all gotcha`.

| Topic | File |
|-------|------|
| Architecture | `.felt/portolan-architecture-server-361a92a2.md` |
| Interactions | `.felt/portolan-interactions-gesture-245370ce.md` |
| Visual Design | `.felt/portolan-visual-design-palette-49cdf63d.md` |
| Remote Agent | `.felt/portolan-remote-agent-setup-ssh-b7ce007f.md` |
| Remote Proxying | `.felt/pattern-portolan-remote-content-8180cf9d.md` |
| Worker Swarms | `.felt/murmuration-workers-68674cb9.md` |
| Tapestry DAG | `.felt/absorb-claims-dashboard-into-ed04e0e9.md` |
| Tapestry Sidebar | `.felt/tapestry-fiber-sidebar-ec45c86b.md` |
| Static Tapestry | `.felt/static-rhizome-dashboard-on-13a8fbc4.md` |
| Extraction Pattern | `.felt/extraction-pattern-1272c8d8.md` |
