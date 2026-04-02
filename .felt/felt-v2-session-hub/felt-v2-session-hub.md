---
title: felt v2 session hub
status: closed
tags:
    - doc
    - felt
    - astra
depends-on:
    - felt-v2-constitution
    - astra-decisions-in-tapestry
created-at: 2026-04-01T15:36:13.687577+02:00
closed-at: 2026-04-01T23:52:15.475258+02:00
outcome: 'Daily-driver deployment complete. Portolan migrated (608 fibers), FiberReader updated, CLAUDE.md hex refs stripped, felt v1.0.0-rc1 tagged and pushed. Installed on Candide, loom and felt repo migrated. Migration tool fixed to rewrite pre-existing directory fiber deps. Migration reference written. Design questions resolved: contradictions not felt''s problem, session recipe stays, DAG delta sufficient, no blocks keyword.'
---

(felt-v2-session-hub)=
# felt v2 session hub

Hub for the felt v2 design session (2026-03-31 evening to 2026-04-01 morning).

## What happened

Ideation on merging ASTRA (open spec for computational science) with felt (fiber DAG tracker). Designed the formalization gradient: fibers start as quick notes and accrete ASTRA fields (decisions, evidence, I/O) as understanding crystallizes. Drafted a constitution, ran a ralph loop on Codex overnight (14 iterations), reviewed and tested results. Installed v2 binary.

## Key artifacts

- **Constitution:** felt-v2-constitution-8a08fc28 (portolan .felt/) and ~/Documents/projects/felt/.felt/felt-v2-constitution/
- **Meeting notes:** lightcone-meeting-2026-03-31.md (3-hour UX meeting: Francois, Liam, Alexandre, Cail)
- **Meeting transcript:** transcription.md
- **DESI BAO paper (MyST example):** /tmp/desi-bao/ (real ASTRA analysis rendered as MyST)
- **felt v2 code:** ~/Documents/projects/felt/ branch felt-v2
- **Migration test:** /tmp/felt-migrate-test/ (607 portolan fibers migrated)
- **MyST preview:** /tmp/myst-preview/.felt/ (5-fiber subset, rendered with myst start at localhost:3000)

## What's built (felt-v2 branch, tests passing)

Directory-based fibers (slug/slug.md), slug-only IDs, command consolidation (22 to ~10), ASTRA fields in frontmatter (decisions, inputs, outputs, insights, success_criteria), felt export --format astra, felt migrate, MyST project setup. Ralph SKILL.md rewritten around "earn the vantage point" principle.

## The gradient (not built, open design)

The accretion CLI for climbing the formalization gradient. ASTRA fields parse and marshal. What's missing is the CLI layer. Open question: are decide/evidence/exclude the right verbs? How does formalization feel mid-work vs batch? What about the funnel (synthesis fibers), contradictions, MyST styling?

## Before daily use

1. Migrate portolan .felt/ for real
2. Update portolan FiberReader for directory-based fibers
3. Verify felt hook session output
4. Strip hex suffixes from CLAUDE.md references
5. Design and build the gradient CLI
