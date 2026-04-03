---
title: MySTRA inp.from must resolve
status: closed
tags:
    - gotcha
    - mystra
    - astra
depends-on:
    - astra-document-viewer
created-at: 2026-04-03T03:26:58.644084+02:00
outcome: 'inp.from in ASTRA sub-analysis inputs must match either: (1) an output ID registered by another sub-analysis (via sub.outputs[].id → outputToAnalysis map in graph.ts), OR (2) a sub-analysis slug (analysis.analyses[inp.from]). Global input IDs (from the top-level analysis.inputs[]) do NOT create data-flow links — graph.ts never looks there. Symptom: node remains in periphery column despite having from: references.'
---

(mystra-inp-from-must-resolve)=
# MySTRA inp.from must resolve
