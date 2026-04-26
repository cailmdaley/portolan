(portolan)=
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
cd server && npm test       # ~282 tests
```

Requires Kitty with `allow_remote_control yes` and `listen_on unix:/tmp/kitty-socket`.

### Static Tapestry (GitHub Pages)

Deployed to `cailmdaley.github.io/tapestries/` from repo `cailmdaley/tapestries` (branch: `live`).

**Repo structure:** `cailmdaley/tapestries` is a GitHub template repo with two branches:
- `main` — template: viewer + demo data. Cloning gives a working tapestry site.
- `live` — real data. GitHub Pages serves from here.

**Local setup:** `docs/` is a clone of `cailmdaley/tapestries`. `~/.felt/tapestries` symlinks to it. `felt export --format tapestry` writes to `~/.felt/tapestries/data/{city}/`, which lands in `docs/data/{city}/`.

**Export workflow** (replaces `publish-tapestry.sh`):
```bash
cd ~/Documents/projects/some-project
felt export --format tapestry                        # writes to ~/.felt/tapestries/data/{project}/
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
├── FiberReader               ├── VellumWorkspace (reader, on `t`)
├── EvidenceReader            ├── GlobalSearchPalette (/ key)
├── RecentFileTracker         ├── RecentWorkerBar (top wire)
├── KittyIntegration          ├── ContextMenu
└── index.ts (state, WS)      └── main.ts
```

Server polls tmux → builds state → broadcasts. File touches flow via hooks (POST `/hook/file-touch` → `RecentFileTracker`). Browser renders → user clicks → routes to Kitty.

**File viewer = vellum.** Main app opens files via `openVellumFileModal()` in `src/vellum/mount.tsx` → vellum's `FileViewerModal` + `PortolanAdapter` → server endpoints (`/project-file/`, `/raw-file/`, `/file-content`, `/fiber/:slug`, annotations). Portolan's old `src/ui/FileViewer*` is gone; React only lives inside `src/vellum/`, everything else is vanilla TS/Three.js. The static GitHub Pages viewer uses `openVellumStaticFileModal()` with `createPortolanStaticAdapter` — same vellum modal, read-only adapter that resolves flat files under `${staticDataBase}/files/`.

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
curl 'http://localhost:4004/astra-bundle/local/abs/path/to/astra.yaml'      # JSON Bundle + csvs (vellum-native astra renderer feeds off this)
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

## Gotchas

One-liners. Fiber has the full story. `felt ls -s all gotcha` for more.

- **Force Touch is additive.** Suppress `click` with capture-phase flag. `main.ts:451-478`.
- **Vite HMR stacks listeners.** Add doc-level listeners in show/hide, not constructors.
- **Window wheel preventDefaults over everything.** New overlays must be added to Camera's exemption `closest()` list or the map zooms instead of the overlay scrolling. `gotcha-modal-scroll-window-wheel`
- **Modal a11y needs background `inert`.** `aria-modal="true"` alone doesn't hide siblings — screen readers and the agent-browser snapshot still see the map, pinned cards, and recent-worker bar through any full-viewport modal. New modals must call `lockModalBackground()` from `src/ui/modalBackgroundLock.ts` on show and the returned unlock fn on hide.
- **Fibers use `name`, never `title`.** Felt switched to ASTRA vocabulary; backward-compat shims are gone end-to-end. `fiber-rename-title-to-name`
- **`felt add` requires `<slug> <name>`.** Two positional args, not one. `gotcha-file-as-fiber-slug`
- **Body-appended popovers inside vellum modals need z-index > 9999.** `.vellum-modal-scrim` is 9999; put popovers at 10000+. `gotcha-picker-below-vellum-scrim`
- **SSH: `execFileAsync`, not shell interpolation.** Use `shellEscape()`. `gotcha-ssh-double-quote`
- **SSH: single-quote remote commands.** `ssh host 'kill $(pgrep ...)'` — double quotes expand locally. `gotcha-ssh-double-quote-shell`
- **SSH: `--ssh-host` is always the base name.** `gotcha-agent-ssh-host-must-be`
- **SSH: parallel exhausts ControlMaster.** Batch into single call. `batch-ssh-evidence-reads-to`
- **Remote: duplicate `portolan-agent` sockets race origin state.** One origin must have one live agent. `debug-pure-eb-worker-flicker`
- **Codex process name is "node" on Linux.** Check `ps -o args=` fallback. `gotcha-codex-process-name-is`
- **Ralph spawns codex 3+ levels deep.** BFS up to depth 4. `bfs-descendant-search-for-cli`
- **Remote `lastActivity`: only bump when working.** `bug-remote-lastactivity-inflated`
- **`felt depends_on` is objects.** Extract `.id`. `portolan-depends-on-mapping`
- **Comma-separated felt tags.** Split on `,`. `comma-separated-tags-silently`
- **Evidence artifacts: `output` field only.** `evidence-artifacts-only-render`
- **Candide: tmux 2.7, node not in PATH.** `candide-tmux-2-7-incompatible`
- **Claude native build silent fail on remote.** `claude doctor`.
- **CSS context rules override class selectors.** Qualify selector. `css-specificity-gotcha-context`
- **`staticDataBase` regex over-strips.** Use `/\/tapestry$/` not `/\/[^/]+\/tapestry$/`. `fix-staticdatabase-url`
- **tmux `=` prefix needs trailing `:` for pane-target commands.** `paste-buffer`/`send-keys` parse `-t` as a pane target; bare `=name` is matched literally as a pane. Use `=name:`. `tmux-prefix-breaks-paste-buffer`
- **`reconnectTunnel` must kill ControlMaster first.** `ssh -fN` alone multiplexes through the stale master. `stale-controlmaster-breaks`
- **Remote origin ID derived from sshHost, not hostname.** Raw hostname (e.g. `login07.leonardo.local`) doesn't match persisted `remote-cineca`. `remote-origin-id-mismatch`
- **Dormant remote cities need `hasClaims` default.** No active session → agent never reports `hasClaims`. Pinned remote cities default `true`. `dormant-remote-cities-lack`
- **Vellum HtmlReader iframes default to 150px.** Cross-origin can't auto-size, and vellum has no `--html` height CSS. `index.html` flex-chains the modal column under `:has(.vellum-file-reader--html)`. `vellum-html-iframe-default-150`
- **Iframe pins need always-visible chrome AND a drag strip.** Cross-origin iframes inside `.dom-pin` eat right-click, hover, and pointerdown. Affordances pinned via `opacity:1 !important`; drag handled by a `data-pin-drag-handle="true"` strip at the top edge that bypasses the normal Cmd/Ctrl gate. `iframe-pin-needs-always-visible-chrome`
- **`astra.yaml` opens as lightcone paper view, not raw YAML.** Server's `/astra-paper-view/{originId}{path}` runs `lightcone-ui-core/buildBundle` and serves the rendered HTML; the adapter classifies astra paths as `'html'` so vellum iframes them. Remote works via SSH-tar mirror cached by astra.yaml mtime. `vellum-reader/astra-yaml-paper-view`
- **Modals inside astra pins need `createPortal(... , document.body)`.** Pins sit under a CSS-transformed canvas, and a transformed ancestor establishes a containing block for `position: fixed`. Without the portal, a `position: fixed; inset: 0;` modal renders inside the pin and is clipped to its size (paneW≈40px in the failure mode). Applies to the Stage-5 `<PaperModal>` and any future overlay (decision-flip, annotation popover). `vellum-reader/astra-stage-5-paper-modal`
- **Server-relative bundle URLs need adapter `resolveAssetUrl`.** Vite at :5173 and portolan server at :4004 are different origins; bare `/papers/...` or `/project-file/...` URLs from a server-rewritten Bundle hit Vite, not portolan, and either 404 or fall through to `index.html` (pdfjs then reports "Invalid PDF structure" — the worst failure mode). `PortolanAdapter.resolveAssetUrl` prefixes `API_BASE` for relative paths; `<AstraPaperView>`'s `resolveArtifact` and `resolvePaperPdf` both flow through it. `vite.config.ts` proxies the same paths as belt-and-suspenders for fresh starts.
- **Paper PDFs are origin-aware: `/papers/{originId}/{cacheKey}/paper.pdf`.** The legacy `/papers/{cacheKey}/paper.pdf` form still works (treated as `originId='local'`), but new code should emit the three-segment form so remote astra projects can serve their cached PDFs. For `originId !== 'local'`, the server SSH-cats the bytes from `~/.cache/astra/papers/<cacheKey>/paper.pdf` on the remote into a per-origin local mirror on first request — paper PDFs are immutable per cacheKey so the cache is permanent. The bundle's `papers` map is also re-resolved against a meta.json mirror for remote origins so the modal sees the remote's cache state, not the server's. `vellum-reader/astra-stage-5-remote-paper-pdfs`
- **Stacked modals need `window`-capture Escape + body-sibling inert.** A modal opened *inside* a host modal (vellum's `<PaperModal>` over portolan's workspace modal) needs both: (1) inert every body sibling of its scrim on open, restoring prior state on close — `aria-modal="true"` doesn't hide siblings, so a screen reader / agent-browser snapshot would see both modals at once; (2) listen for Escape on `window` capture phase, not `document` capture, and call `stopImmediatePropagation()` — capture order is `window → document → … → target`, and registration order on the same target wins, so a `document`-capture listener on the host modal (registered first) would otherwise close the host modal alongside the inner one. `vellum-reader/astra-paper-modal-inert`
- **Astra modal column needs the flex chain AND a right-gutter pad for margin notes.** Two CSS rules in `index.html`, both keyed off `.astra-paper-view-host` (the wrapping div the FileViewerPage emits for any astra rung): (1) the existing iframe-rung selector `:has(.vellum-file-reader--html)` must be paired with `:has(.astra-paper-view-host)` so the lightcone-linear theme's `.vellum-page { max-width: 720px }` clamp is dropped under linear / personal too, otherwise the host gets ~720px and the article (max-width 760, anchor too) collapses; (2) `.astra-paper-view-host:has(.astra-paper-view-anchor) { padding-right: calc(var(--canvas-overlay-width, 220px) + 12px); }` reserves room for `<TextAnnotationLayer>`'s margin notes, which hang at `left: calc(100% + 12px)` from the anchor and would otherwise be cut by the host's `overflow-x: hidden`. Scope on `:has(.astra-paper-view-anchor)` keeps the paper-view iframe at full host width; gate behind `@media (min-width: 961px)` so narrow viewports — where vellum already hides notes via `@media (max-width: 960px) .ann-margin-note { display: none; }` — don't waste a third of the column. `vellum-reader/astra-margin-note-gutter-clip`

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
| Static Tapestry | `static-rhizome-dashboard-on` |
| Extraction Pattern | `extraction-pattern` |
| Voice Ingress (Parakeet) | `constitution-portolan-voice-ingress`; daemon at `server/voice-ingress/parakeet_daemon.py`, Node wrapper at `server/src/ParakeetTranscriptSource.ts` |
