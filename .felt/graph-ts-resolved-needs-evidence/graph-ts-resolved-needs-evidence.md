---
title: graph.ts resolved needs evidence
status: closed
tags:
    - gotcha
    - mystra
    - astra
depends-on:
    - astra-document-viewer
created-at: 2026-04-03T03:38:08.699357+02:00
outcome: inferAnalysisStatus in graph.ts requires findings WITH evidence (f.evidence?.length > 0) for 'resolved' status. An insight/finding with only a claim field (no evidence array) falls through to 'open'. Always include at least one evidence entry when adding insights to ASTRA fiber frontmatter.
---

(graph-ts-resolved-needs-evidence)=
# graph.ts resolved needs evidence
