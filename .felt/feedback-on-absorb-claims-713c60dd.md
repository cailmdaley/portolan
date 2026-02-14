---
title: Feedback on absorb-claims-dashboard-into-ed04e0e9.md
status: closed
kind: task
priority: 2
created-at: 2026-02-08T16:27:42.627037+01:00
closed-at: 2026-02-09T03:06:38.569865+01:00
close-reason: 'All feedback incorporated: three-kind taxonomy dropped (rule: tags only), staleness coloring (teal/red/gray) replaces kind colors, D3 tree-shaken via npm individual packages, no-evidence renders as muted gray, detail panel layout follows requested order (title/status → artifact plot → fiber body → evidence metrics → downstream concerns), full-page overlay pattern matches original ClaimsDashboard.'
---

## Annotations

1. (L74) **"kind=claim,foundation,synthesis"**
   > we have dropped this terminology. we identify dashboard candidates only by whether they have are tagged to snakemake rules

2. (L93) **"RhizomeView"**
   > i like rhizome view. we can drop the three-kind taxonomy, color by mtime; red if older than upstream in the dashboard dag, otherwise teal

3. (L95) **"**D3 in portolan's bundle?** The dashboard currently load..."**
   > no preference, best software practice

4. (L97) **"viz should handle fibers-without-evidence gracefully"**
   > agreed

5. (L70) **"### Data flow "**
   > i think we need to think more about this, and the layout what we want for the new fiber view. it contains the fiber, the plots, evidence sometimes... i'd say it should go description/title, plot, rest of fiber, evidence.

6. (L99) **"or overlay it?"**
   > overlay, same pattern
