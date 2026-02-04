---
title: Unify swarm, label, and card as draggable entity
status: closed
kind: task
priority: 2
depends-on:
    - murmuration-workers-68674cb9
created-at: 2026-02-04T01:11:43.797087+01:00
closed-at: 2026-02-04T01:11:43.821854+01:00
close-reason: |-
    Implemented unified worker entity where swarm, label, and card move together.

    **Architecture:**
    - Label attached to swarm.group via setLabel() (moves with swarm)
    - Card attached to swarm.group via addChild() (moves with swarm)
    - WorkerSwarm.userOffset stores persistent drag position
    - hideLabel()/showLabel() toggle visibility when card opens/closes

    **Drag behavior:**
    - Regular drag on card header moves entire swarm unit
    - Cmd+drag moves card offset only (reposition card relative to swarm)
    - Pixel-to-world conversion: 0.01 scale factor

    **Card positioning:**
    - translateY(-100%) anchors card bottom at CSS2D point
    - Card expands upward with max-height animation (36px → 600px)
    - Animation: 300ms ease-out

    **Files changed:**
    - WorkerSwarm.ts: userOffset, setLabel, hideLabel/showLabel, addChild/removeChild
    - ZoneRenderer.ts: attach card to swarm, call hide/show label
    - ConversationCard.ts: swarm drag callback, translateY in applyTransform
    - index.html: cardExpand animation, taller card (600px)
---
