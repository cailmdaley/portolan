---
title: ASTRA decisions in tapestry
status: open
tags:
    - tapestry
created-at: 2026-03-31T00:13:39.349065+02:00
---

(astra-decisions-in-tapestry)=
## What was built

Three changes to portolan, all type-checked and building but **not yet tested in browser** (server needs restart).

### 1. Server: read astra.yaml and inject decisions into tapestry API response

**File: server/src/HttpApiTapestry.ts**

Added `readASTRADecisions()` method (~90 lines) that:
- Reads `astra.yaml` from the city path (local or via SSH)
- Parses top-level + per-analysis decisions
- Wires `evidenceIds` by matching `tapestry_nodes` specNames against node specNames, with `evidence:{decision_id}` tag fallback
- Returns `[]` gracefully if no astra.yaml exists

Called in `handleTapestry()` — the response now includes a `decisions` array alongside nodes/links/downstream/config/fibers.

**To verify:** restart server, then:
```bash
curl -s 'http://localhost:4004/tapestry?cityId=2c749e0f3fbd50c6e3ccc4095b9d380f' | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('decisions',[])))"
```
Should return 7 (the KineLens decisions). If 0, the server is running old code.

### 2. Viewer: decision rendering in detail panel for tier:1 nodes

**Files:**
- `src/ui/tapestry-types.ts` — added `TapestryDecision`, `TapestryDecisionOption` types, `decisions?` field on `TapestryResponse`
- `src/ui/tapestry-helpers.ts` — added `decisionsForSection()` (finds decisions whose evidenceIds overlap a section's subtree), `decisionStatus()` (resolved/open/suspicious from evidence node states), `decisionVerdict()` (first evidence node outcome), `decisionStatusIcon()`
- `src/ui/TapestryDetailPanel.ts` — added `renderDecisions()` method that generates accordion rows for each decision, and `bindDecisionRows()` for expand/collapse click handling. Inserted between graphHtml and outcomeHtml in `renderNode()`, gated by `isSectionNode(node)`
- `src/static/index.html` — CSS for `.tapestry-decisions-section`, `.tapestry-decision-row`, status-colored left borders (teal resolved, amber suspicious, gray open), accordion expand/collapse

**What it should look like:** Click a tier:1 node (Mocks, Likelihood, Inference, Calibration). Below the upstream/downstream tags, a 'Decisions (N/M)' collapsible section appears. Each decision row shows: status icon (✓/○/?), label, chevron. Expanding shows: selected option label, verdict (first evidence node outcome), clickable evidence node tags.

### 3. Delta view: mtime-driven initial fog visibility (Codex)

**Files:**
- `src/ui/TapestryDagVisibility.ts` — `initializeSectionVisibility()` now seeds expanded set with nodes whose `evidence.mtime` is newer than threshold
- `src/ui/TapestryViewRuntime.ts` — threshold from URL params: `?since=2026-03-20` or `?days=7` (default 7 days)
- Threaded through `TapestryView.ts` → `TapestryDagGraph.ts` → Visibility

**To test:** `?days=30` reveals nodes with evidence from last 30 days. `?days=1` fogs most things.

## What's NOT done

- Server not restarted — running process has old code, so decisions array is empty
- No visual verification yet — need browser testing after restart
- The `decisionsForSection()` logic may need tuning — it checks if any evidenceIds are in the section's subtree (node itself + downstream), but the mapping from decision to section depends on the DAG structure being correct

## Decision→section mapping (KineLens)

Mocks (tier:1) should get: intensity_profile, rotation_curve, noise_scaling, sigma_floor, mask_strategy (all under build_mocks analysis, evidence nodes downstream of Mocks)
shear_frame and grid_resolution are top-level — they should appear on whichever tier:1 node their evidence nodes (shear_reference_frame, phi_symmetry, spin2_rotation, signal_interpolation_negligible, signal_error_scaling) are downstream of.

## Also in this session (in felt repo)

- `felt/internal/tapestry/astra.go` — Go ASTRA parser for `felt tapestry export` (static export path, separate from server)
- `felt/internal/tapestry/export.go` — Decision types + Decisions field on exportPayload
- Tests passing: `go test ./internal/tapestry/`

## Comments
**2026-03-31 23:22** — Session 2: Server code works — KineLens on candide returns 7 decisions, 6 with evidence wired (mask_strategy has no tapestry_nodes). Root cause of initial 0-decisions was remote astra.yaml missing tapestry_nodes field (synced via scp). Decision→section mapping verified: Mocks gets 4 decisions, Likelihood gets 2. Delta view logic works (mtime threshold + expandedNodes), tested via API. Slider UI partially implemented but not rendering — tried sidebar legend, dag-wrapper absolute, dag inner div; all invisible likely due to flex/overflow/z-index interaction. Needs debugging with browser devtools. Decision accordion expand/collapse and teal status borders also need CSS polish.
