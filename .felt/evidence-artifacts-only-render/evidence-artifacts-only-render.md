---
title: 'Evidence artifacts: only render output field images'
status: closed
tags:
    - portolan
depends-on:
    - evidence-artifacts-field-is
created-at: 2026-02-18T02:37:20.614686+01:00
outcome: EvidenceReader was scanning the claims directory for *.png/*.jpg and merging them with artifacts/artifact_paths fields from evidence.json. Per tapestry skill update, only files listed in the output field of evidence.json should render. Removed mergeImageArtifacts() directory scan, removed parseArtifactsFromData() legacy field fallback, buildEvidence() now extracts image entries from output field only. Also simplified Evidence.artifacts type from Record<string, string | string[]> to Record<string, string> — array values (like individual_evidence) are no longer possible.
---

(evidence-artifacts-only-render)=
# Evidence artifacts: only render output field images
