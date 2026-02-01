---
title: 'Iteration 3: refine nano-banana prompting for diff-mat transparency'
status: closed
kind: task
priority: 2
depends-on:
    - city-sprites-nano-banana-21de7409
created-at: 2026-02-01T02:44:28.986341+01:00
closed-at: 2026-02-01T03:00:24.89978+01:00
close-reason: |-
    Successfully refined nano-banana prompting and generated 5 new default city sprites:

    PROMPTING BREAKTHROUGH:
    - Rich context about portolan maps helps Gemini understand the aesthetic
    - Explicit 'organic trailing edges' and 'as if cartographer stopped drawing' eliminates hard circular frames
    - 'NO paper texture' prevents competing with vellum layer

    DIFF-MAT WORKFLOW:
    - Generate on white → edit to black → extract_alpha.py → composite on vellum
    - Works reliably when edit prompt emphasizes 'keep EVERYTHING else exactly unchanged'

    NEW DEFAULTS (public/sprites/cities/):
    1. Port city - harbor with ships, winding streets
    2. Hilltop fortress - concentric walls, switchback roads
    3. River city - winding river, bridges, organic flow
    4. Island city - Venice-like lagoon, canals, verdigris water
    5. Market town - oval walls, central square, radial streets

    All sprites blend seamlessly into vellum with no hard edges or competing textures. Major visual upgrade from the old magenta-bordered circular sprites.
---
