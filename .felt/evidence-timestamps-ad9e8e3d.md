---
title: Evidence timestamps
depends-on:
    - staleness-computation-ae36c717
    - evidence-structure-df23b4ae
created-at: 2026-02-21T19:27:19.602931+01:00
outcome: Staleness compares evidence.json mtime (milliseconds since epoch) across the dependency graph. A fiber is stale if any upstream dependency has a newer mtime. The generated field is optional metadata — mtime from stat drives the actual comparison.
---

The staleness system compares `evidence.json` file modification times across the DAG to determine whether each fiber's evidence is up to date. `computeStaleness()` in `EvidenceReader.ts` takes a fiber's ID, its `dependsOn` list, an evidence map, and a fiber-to-specName map. For each upstream dependency that has evidence, it compares `depEvidence.mtime > myEvidence.mtime` — if any dependency's evidence file was modified more recently, the fiber is stale.

The `mtime` value is the file's modification time in milliseconds since epoch. For local files, `stat(path).mtimeMs` provides this directly. For remote files, `stat -c '%Y'` (Linux) or `stat -f '%m'` (macOS) returns seconds, which is multiplied by 1000. This millisecond precision matters — it prevents false deduplication when multiple evidence files are regenerated within the same second (see the `gotcha-ms-precision-timestamps` fiber).

The `generated` field in `evidence.json` is an optional ISO timestamp string recording when the evidence was produced. It is stored on the `Evidence` object and displayed in the detail panel as metadata, but it does not participate in staleness computation. Only `mtime` drives freshness, because `mtime` reflects when the file was actually written to disk — which is the ground truth for whether downstream results need regeneration.

Three staleness states exist: `fresh` (evidence exists and is newer than all dependencies), `stale` (at least one dependency has newer evidence), and `no-evidence` (no `evidence.json` found for this fiber's spec name). These map to visual colors throughout the tapestry: forest green, wine red, and umber.
