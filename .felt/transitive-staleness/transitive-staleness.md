---
title: Transitive staleness
status: closed
depends-on:
    - conventions-evidence
created-at: 2026-03-15T11:02:07.049337+01:00
outcome: ComputeStaleness walks upstream transitively through no-evidence nodes. Fixed in felt Go (evidence.go) and portolan TS (EvidenceReader.ts). TS signature changed to take depsMap. Tests cover 1-hop, 2-hop, and fresh-through-group cases.
---

(transitive-staleness)=
# Transitive staleness
