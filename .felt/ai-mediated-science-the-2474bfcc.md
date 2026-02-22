---
title: 'AI-mediated science: the verification problem'
tags:
    - tapestry:portolan
depends-on:
    - tapestry-evidence-0b72e4b2
created-at: 2026-02-22T05:40:40.715691+01:00
outcome: "When participation becomes negligible, consensus becomes theater. Felt is infrastructure for the alternative: provenance (who produced each outcome), staleness (is the computation current), evidence (what grounds the claim). Not bookkeeping — epistemic trust made structural and traversable."
---

Denario generates papers end-to-end. Kosmos claims six months of postdoc work in a day — 85% accuracy on data analysis, 57% on interpretation — and provides no infrastructure for verification. The output rate already exceeds what scientific communities can meaningfully review. When every result is produced at machine speed, peer consensus can converge on something no one has fully checked.

The response is structural. A scientific claim should be a node in a graph: what it asserts, what it rests on, what produced it, how confident, what uncertainties were acknowledged. That structure makes verification *checkpointable*. A reviewer — human or AI — can enter at any node, understand dependencies, assess how solid the chain is from observation to interpretation, and move on. Without the structure, verification requires holding the entire project in context. That's exactly what we're losing the capacity to do.

Felt is a lightweight version of this. Each fiber has a body (the reasoning), an outcome (the conclusion), dependencies (what it rests on), and evidence (computation that grounds it). The tapestry makes that structure navigable: staleness colors encode whether evidence is current, the DAG shows what depends on what. It doesn't solve the verification crisis — but it makes your own work auditable, to yourself and to anyone who inherits it.

Three epistemic registers matter: observation (grounded in data), interpretation (meaning-making with acknowledged leaps), prediction (reaching forward with acknowledged uncertainty). Felt doesn't enforce this distinction, but naming it in fiber bodies — "this is an interpretation, not a finding" — is epistemically honest in a way that matters more as output speeds increase.
