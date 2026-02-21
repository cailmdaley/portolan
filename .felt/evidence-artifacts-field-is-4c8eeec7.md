---
title: Evidence artifacts field is redundant for image display
tags:
    - portolan
    - decision
depends-on:
    - array-artifact-values-crash-ad036e78
created-at: 2026-02-15T03:27:31.175703+01:00
outcome: 'mergeImageArtifacts scans results/claims/{specName}/ for *.png/*.jpg and adds them as artifacts automatically. The artifacts/artifact_paths field in evidence.json only adds: (1) human-readable names as keys, (2) non-image metadata like individual_evidence arrays pointing to sub-evidence JSON files. Images display fine from directory scan alone. The JSON field is optional convenience, not required.'
---
