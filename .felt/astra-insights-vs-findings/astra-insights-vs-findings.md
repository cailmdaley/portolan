---
title: ASTRA insights vs findings naming
status: open
tags:
    - question
    - astra
    - mystra
created-at: 2026-04-02T03:51:51.699131+02:00
---

(astra-insights-vs-findings)=
felt export --format astra writes `insights` as the field name, but MySTRA's type system (ASTRAAnalysis) expects `findings`. The yaml-loader now normalizes insights→findings as a workaround. Need to decide: which is canonical? The ASTRA spec Python models use `findings` for new results and `prior_insights` for imported ones. felt's exporter should probably use `findings` to match.
