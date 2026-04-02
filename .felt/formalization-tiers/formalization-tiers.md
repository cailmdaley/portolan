---
title: formalization tiers
tags:
    - felt:formalization
    - astra:design
depends-on:
    - formalization-gradient-cli
    - formalization-reference-v2
status: closed
created-at: 2026-04-01T22:19:11.871757+02:00
closed-at: 2026-04-01T22:21:00+02:00
outcome: 'Collapsed the pre-ASTRA gradient into one annotated tier. Proposed the deterministic three-tier model: annotated, formalized, analysis-grade; kept the three formalized kinds: decision, computation, finding. Outcome is not a gate. Formalized means ASTRA-valid structure; analysis-grade means explicitly marked human-validated scientific argument.'
---

(formalization-tiers)=
# formalization tiers

Human feedback simplifies the model:

- Pre-ASTRA fibers do not need multiple named formalization levels. A bare title, a sentence, an outcome, and a long doc-like body are all the same tier: annotated.
- The next threshold is mechanical, not semantic: formalized means the ASTRA-bearing frontmatter for at least one object is present and would pass export/validation.
- The final threshold is social/scientific, not structural: analysis-grade means the fiber is actually part of the scientific argument and has been human-validated enough to rely on.

## Three tiers

**Annotated**

Any valid felt fiber. Title/body/outcome/tags/links may be sparse or rich. No ASTRA requirement. Progressive disclosure inside this tier belongs to felt, not to the formalization taxonomy.

**Formalized**

A fiber with at least one well-formed ASTRA object in frontmatter. Deterministic test: `felt export --format astra` can emit it without schema error.

**Analysis-grade**

A formalized fiber that is explicitly flagged as relied on in the real analysis. This is where human validation matters. It is a scientific-status marker, not a richer schema shape.

## Three kinds

The natural formalized shapes remain:

- decision
- computation
- finding

These are not tiers. They are the kinds of ASTRA-bearing content a formalized fiber may contain.

## Workflow consequence

Outcome is not a prerequisite for formalization. Agents should be able to:

1. create or activate a fiber,
2. start a computation,
3. write inputs / outputs / expected products while the command runs,
4. add findings or outcome when the result is known.

This makes formalization compatible with asynchronous work instead of forcing retrospective cleanup.

## Body vs frontmatter

Frontmatter carries the mechanically structured ASTRA fields. The markdown body carries the human explanation, caveats, interpretation, and running notes. They should correspond, but not duplicate each other line-for-line.

MyST-like principle: structured metadata and prose coexist. The structured layer is for machines and export; the body is for reading, argument, and nuance.
