---
title: Outcomes
tags:
    - tapestry:portolan
depends-on:
    - tapestry-structure-4401c64b
    - fibers-concept-a3f8d142
created-at: 2026-02-22T05:56:10.793549+01:00
outcome: The outcome is the interface between fibers. A downstream node reads the upstream outcome, not the upstream body. The graph is a chain of conclusions, not a chain of investigations.
---

The outcome is the contract between a fiber and everything downstream of it. A body can be rough, exploratory, revised — it's working space. The outcome is the crystallization: what was decided, what was found, why it matters. When a downstream fiber reads its upstream dependency, it reads the outcome, not the body.

This is what makes the DAG more than an organizational tool. A graph of bodies is a tangle of investigations. A graph of outcomes is a chain of reasoning. The difference between "we explored X" and "we found Y because Z" is the difference between a research log and an argument. The outcome field forces that crystallization at every node.

An open fiber without an outcome is not a failure — it's a signal that the concern is still live. A closed fiber without a substantive outcome is a broken link in the chain. Every fiber that depends on it has an ungrounded foundation. The archaeology of why something was decided becomes impossible.

The practical consequence for writing outcomes: they should be readable without the body. If someone walks the DAG from downstream and reads only your outcome, they should understand what was concluded and why — enough to assess whether their own reasoning still holds on top of yours. The body is the investigation; the outcome is the finding; the edge is the claim that the finding matters to what comes after.
