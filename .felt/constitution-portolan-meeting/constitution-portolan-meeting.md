---
title: 'Constitution: Portolan meeting-to-ASTRA assistant'
status: open
tags:
    - constitution
    - portolan
    - astra
    - transcription
    - lightcone
depends-on:
    - meeting-to-astra-live-research
    - astra-document-viewer
created-at: 2026-04-02T18:35:59.969219+02:00
---

(constitution-portolan-meeting)=
# Constitution: Portolan meeting-to-ASTRA assistant

## Desired State

Portolan can host a local-first meeting assistant for scientific work: a meeting is heard, transcribed, narrated, queried, corrected, and filed into the felt/ASTRA continuum without requiring the humans to stop and perform bookkeeping.

The assistant behaves like a strong frontier-model collaborator embedded in the meeting, not like a brittle workflow engine. It listens, keeps the thread of the discussion, surfaces existing evidence when asked, records candidate decisions and open questions, and lets the participants correct the narrative in real time.

The system satisfies these invariants:

- **ASTRA/felt is the scientific object model.**
  - Durable meeting outputs live somewhere on the existing continuum: raw transcript context, candidate event, quick fiber, formalized fiber, ASTRA-grade node.
  - Do not invent a second parallel schema for scientific meaning unless an operational transport format is strictly necessary and ephemeral.
- **The frontier model is the primary interpreter and router.**
  - Use code for ingestion, persistence, indexing, presentation, and safety boundaries.
  - Do not overbuild a hand-coded ontology of meeting acts if the model can infer them more robustly from context.
- **Raw provenance is never lost.**
  - Audio or transcript chunks remain recoverable with timestamps and, when available, speaker attribution.
  - Every candidate note, question, or decision should be traceable back to source transcript spans.
- **Retrieval is first-class.**
  - During a meeting, the default useful action is to pull existing plots, artifacts, fibers, papers, decisions, and evidence chains into view.
  - Fresh computation is allowed, but it is a secondary lane that attaches to the same record.
- **Narrative is editable while live.**
  - The assistant maintains a rolling account of where the meeting stands: what we think, what changed, what remains open, and what evidence was pulled.
  - Humans can correct that account in place: “no, that is not the conclusion,” “that belongs under calibration,” “this is still unresolved.”
  - Current concrete correction path: the Portolan HUD and `POST /meeting-bridge/update` can inject operator steering/correction messages into the active meeting run, persist them under `operator-updates.jsonl`, and feed the same update back into the chosen worker thread.
- **Accepted structure has its own live lane.**
  - Current concrete promotion path: the Portolan HUD and `POST /meeting-bridge/candidate` can capture accepted notes, open questions, candidate decisions, and action items into `candidate-events.jsonl`, annotate them with transcript/operator provenance, and feed the accepted capture back into the chosen worker thread.
- **Tentative talk stays tentative.**
  - Speculation, brainstorming, and contradicted intermediate views must not silently harden into durable claims.
  - Promotion from live note to accepted fiber or ASTRA structure requires an explicit acceptance step or equivalent human confirmation.
- **Mac-local capture is a first-class ingress path.**
  - There is a practical way to get meeting audio from this Mac into the Portolan loop without manual file shuffling: hotkey, watched directory, local helper, or direct stream.
  - The ingestion boundary should be simple enough that alternate capture tools can plug in later.
  - Current concrete starting point: VoiceInk already persists completed transcripts locally in `~/Library/Application Support/com.prakashjoshipax.VoiceInk/default.store`, so Portolan can bridge from that store before deeper audio integration exists.
  - Current concrete alternate ingress: Portolan also accepts local transcript chunk uploads over `POST /meeting-bridge/chunk`, so other capture tools can target the same active meeting run without speaking tmux or replacing the worker bridge.
  - Current concrete limitation: VoiceInk's live partial transcript stays in process/UI state and is not written incrementally, so true streaming will require either modifying VoiceInk or choosing another capture path.
- **Existing Portolan workers are a viable meeting substrate.**
  - A user can designate an existing worker session, local or remote, as the meeting assistant target.
  - Portolan can bootstrap that worker with an initial meeting prompt and continue feeding it meeting context over time.
  - The preferred first implementation is direct transcript chunk injection into that session via tmux paste-buffer, optionally in the background, using the exact chat form factor people already know.
  - This path should work for both local and remote workers through the existing Kitty/tmux session model.
- **Portolan remains coherent as a product.**
  - This work deliberately expands Portolan beyond pure navigation, but it should do so through one intentional meeting/assistant surface rather than dissolving the app into a generic chat client.
  - Existing spatial/tapestry/document affordances should become more useful, not be replaced by an undifferentiated transcript pane.

Quality bar:

- A real research meeting can be run with the assistant active without it becoming a distraction.
- Asking for prior evidence reliably pulls back the right artifact often enough to be worth using.
- The meeting story after the fact is better than ordinary notes: clearer, more faithful, and easier to formalize.
- Corrections made during the meeting actually reshape the resulting record.

## Scope

- Includes local audio/transcript ingress into Portolan, including a stable handoff boundary for macOS capture tools.
- Includes choosing a worker session as the active meeting assistant target and feeding transcript chunks directly into it.
- Includes rolling transcript/chunk ingestion, frontier-model note synthesis, candidate event generation, and explicit promotion into fibers.
- Includes retrieval and presentation of existing artifacts, evidence, fibers, and external references during the meeting.
- Includes UI work for a live meeting/assistant surface inside Portolan, plus links outward to tapestry/document views where appropriate.
- Includes ASTRA/MySTRA integration insofar as meeting outcomes should become structured narrative/document state.
- Includes using the model for heuristic interpretation, note-taking, summarization, and retrieval orchestration.

- Excludes low-latency optimization as a primary goal.
- Excludes a hard requirement that all checks compute in real time.
- Excludes replacing the frontier model with a fully programmatic planner/router.
- Excludes building a totally separate product outside Portolan unless the loop discovers a strict architectural necessity.

## Context

Existing Portolan surfaces relevant to this work:

- Server bootstrap, HTTP, WebSocket, and runtime wiring:
  - `server/src/index.ts`
- Existing event-ingest pattern from local hook file into live state:
  - `server/src/EventWatcher.ts`
- Existing HTTP hook runtime and session resolution pattern:
  - `server/src/HttpApi.ts`
  - `server/src/HttpApiHooksRuntime.ts`
- State build/broadcast loop:
  - `server/src/BrowserStateCoordinator.ts`
- Existing recent-activity/file trail pattern:
  - `server/src/RecentFileTracker.ts`
- Frontend bootstrap and global runtime:
  - `src/main.ts`
- Existing artifact and evidence presentation surfaces:
  - `src/ui/TapestryView.ts`
  - `src/ui/TapestryDetailPanel.ts`
  - `src/ui/ArtifactMedia.ts`
  - `src/ui/TapestryArtifactLightbox.ts`
- Existing worker/session launch and terminal control surfaces:
  - `server/src/KittyIntegration.ts`
  - `server/src/KittyHandoff.ts`
  - `server/src/KittySessionController.ts`
  - `server/src/MessageRouter.ts`

Existing project direction relevant to this work:

- Meeting-to-ASTRA design exploration:
  - `.felt/meeting-to-astra-live-research/meeting-to-astra-live-research.md`
- ASTRA/MySTRA document rendering direction:
  - `.felt/astra-document-viewer/astra-document-viewer.md`
- Minimal ASTRA stub in repo root:
  - `astra.yaml`
- Recent Lightcone UX discussion recorded in-repo:
  - `lightcone-meeting-2026-03-31.md`

Architectural constraint to treat explicitly:

- `ARCHITECTURE.md` still defines Portolan as “navigation, not interaction.” This constitution intentionally stretches that boundary. Iterations should preserve Portolan’s clarity by introducing a specific meeting-assistant surface, not by gradually reintroducing every generic interaction feature that was previously cut.

Design direction:

- Prefer a simple ingress boundary. A watched directory, local HTTP endpoint, local WebSocket, or helper process are all acceptable if they keep capture tools replaceable.
- Prefer the discovered easy bridge over hypothetical purity: poll completed transcript rows from VoiceInk first, then decide later whether true streaming is worth modifying VoiceInk for.
- Prefer additive ingress paths over capture-specific rewrites: alternate tools should be able to POST transcript chunks into the active meeting bridge rather than duplicating worker-delivery logic.
- Prefer model-mediated interpretation over deeply encoded rules.
- Prefer existing ASTRA/felt structures over bespoke meeting schemas.
- Prefer retrieval and evidence presentation before fresh execution.
- Prefer reversible, inspectable state: transcript chunks on disk, accepted notes in fibers, promoted narrative in ASTRA/MySTRA.
- Prefer reusing existing worker/session infrastructure for local and remote meeting agents before inventing a new transport stack.
- Prefer direct tmux/terminal delivery of transcript chunks in the first implementation before introducing a separate log-copying system.

## Skills

- `/constitution`
- `/felt`
- `/confer` for architecture review when the meeting surface starts to distort Portolan’s boundaries
- `/electron` only if desktop automation is the cleanest way to integrate a capture tool or global hotkey on macOS

## Evidence

Use these as durable pointers while iterating:

- Build and test integrity:
  - `npm run build`
  - `cd server && npm test && npm run build`
- Existing ingress/state-loop audit:
  - `rg -n "events\\.jsonl|hook/file-touch|broadcastCurrentState|broadcastActivity|WebSocketServer" server/src src`
- Existing artifact/evidence surface audit:
  - `rg -n "artifact|tapestry|lightbox|openFile" src/ui server/src`
- Existing meeting/transcript architecture pointers:
  - `rg -n "meeting|transcript|conversation|audio" .felt server/src src`
- Runtime diagnostics:
  - `curl http://localhost:4004/debug-runtime`

Meeting-assistant evidence should eventually include:

- A local capture loop from the Mac into Portolan without manual file copying.
- Transcript chunks appearing in the app while a meeting is ongoing or immediately after chunk completion.
- The assistant maintaining a rolling note/narrative state that can be corrected live.
- Accepted candidate events appearing in the app with transcript provenance before later felt/ASTRA formalization.
- A spoken/requested retrieval pulling an existing plot, artifact, fiber, or evidence chain into view.
- Promotion of accepted meeting outputs into felt, with source provenance intact.
- A path from accepted meeting narrative into ASTRA/MySTRA renderable structure.
- Live human steering updates appearing in the app, being injected into the assistant thread, and remaining inspectable as provenance alongside transcript and worker-injection logs.

## Open Questions

- What is the best first ingress boundary on macOS: watched directory, local HTTP upload, local WebSocket stream, or a tiny companion recorder?
- Current default answer: use VoiceInk as the first bridge by polling newly completed transcript rows from its local SwiftData/SQLite store, then inject those chunks straight into the chosen worker session.
- The remaining ingress question is narrower: whether to keep that chunked-complete-transcript bridge for v1 or modify/supplement VoiceInk to expose truly live partial transcript streaming.
- The local HTTP chunk endpoint now reduces the boundary question further: capture-tool experiments can target the existing active meeting run directly, so the remaining choice is mainly which live partial source is worth wiring first.
- Should the meeting assistant live as its own Portolan mode/panel, or as a worker/city-adjacent surface that reuses existing map metaphors?
- How should live transcript chunks be persisted: one append-only log, chunk files, or transcript fibers from the start?
- What is the minimum explicit structure needed before candidate notes become useful without overformalizing live conversation?
- How should user corrections be represented so the model learns the meeting’s intended narrative rather than merely appending amendments?
- When a retrieval request points to multiple plausible plots or evidence bundles, what disambiguation interaction is least disruptive in a meeting?
- How much external search should the assistant do during the meeting by default: local corpus only, local plus explicit web requests, or proactive literature lookup?
- When fresh computation is needed, what is the cleanest handoff from meeting assistant to worker/session so the resulting artifacts return to the same narrative thread?
- What chunk format works best when feeding a live session: raw transcript, speaker-labeled transcript, or short wrapped blocks with explicit delimiters and instructions?
