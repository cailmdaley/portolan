---
title: SVG feTurbulence grain invisible on light canvas at low opacity
tags:
    - portolan
depends-on:
    - tapestry-fog-visual-treatment-65c0e0ea
created-at: 2026-02-22T01:56:16.193034+01:00
outcome: 'Tried feTurbulence-based grain for fog nodes on warm beige canvas (#E8DDD0). At opacity 0.07-0.22 the grain was invisible regardless of approach. Three failure modes: (1) bright green grain on light background has insufficient contrast, (2) dark grain at low opacity barely shifts pixel values, (3) feComposite(in) with Gaussian blur of thin ring strokes: blur of thin strokes has near-zero alpha, so feComposite(in) suppresses any clipped grain entirely. Decided to drop grain; simple feGaussianBlur + opacity 0.09 is cleaner and sufficient for the ghost effect.'
---
