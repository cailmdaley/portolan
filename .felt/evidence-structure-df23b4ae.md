---
title: Evidence structure
tags:
    - tapestry:portolan
depends-on:
    - tapestry-evidence-0b72e4b2
created-at: 2026-02-21T19:11:55.603278+01:00
outcome: Evidence lives in results/claims/{specName}/evidence.json. The output field maps names to filenames; only image files become artifacts. mtime drives staleness; generated is optional metadata.
---

Evidence connects fibers to computational results. Each fiber's `tapestry:` tag specifies a spec name (e.g., `tapestry:cosebis_data_vector` → spec name `cosebis_data_vector`), and the server looks for evidence at `{cityPath}/results/claims/{specName}/evidence.json`. This JSON file contains an `evidence` object (metrics like chi-squared values or p-values), an `output` object (mapping output names to filenames), and an optional `generated` ISO timestamp.

The `buildEvidence()` function in `EvidenceReader.ts` extracts artifacts exclusively from the `output` field. Only entries whose values are strings matching the image regex (`/\.(png|jpe?g)$/i`) become artifacts — arrays, non-image files, and nested objects are silently skipped. This is deliberate: artifacts are visual evidence (plots, figures), not arbitrary build outputs. The `mtime` of `evidence.json` (via `stat`) drives staleness computation.

For remote cities, evidence is read over SSH. Single-fiber reads use `readRemoteEvidence()` with a stat+cat pipeline. When multiple fibers need evidence, `readEvidenceBatch()` constructs a single SSH command that loops over all spec names with delimited output (`===SPEC:name===` separators), avoiding the connection exhaustion that parallel per-spec SSH calls caused. The batch reader has a 30-second timeout and 10MB buffer limit.
