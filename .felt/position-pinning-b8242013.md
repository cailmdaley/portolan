---
title: Position pinning
depends-on:
    - burn-in-phase-a0859c3f
created-at: 2026-02-21T19:27:07.602931+01:00
outcome: After burn-in, section nodes get fx pinned at their final X. Interior nodes snap to their section parent's X then release fx, floating freely. Drag sets fx/fy during drag; on release, fx stays but fy is released so the node settles in Y.
---

After the 800-tick burn-in completes, the simulation transitions from a structural layout phase to a gentle settling phase. The key mechanism is D3's `fx` and `fy` fixed-position properties. Section nodes (those with `tier:1` tags) get their `fx` set to their current `x` — this locks them horizontally, preserving the left-to-right DAG ordering that burn-in established.

Interior nodes receive different treatment. Each interior node's `x` is snapped to the X position of its nearest section parent (the first `dependsOn` entry that is a section node), giving it a sensible starting column. But `fx` is left undefined — the node floats freely in X, pulled toward its section parent only by the link force. This lets interior nodes find natural positions rather than being rigidly columnar.

During interactive drag (D3 drag behavior), both `fx` and `fy` are set to the cursor position, locking the node under the pointer. On drag end, `fx` is set to the final `x` (keeping horizontal position) but `fy` is released to `null`, allowing the node to settle vertically under the remaining forces. This asymmetry — X pinned, Y free — means dragged nodes stay where you put them horizontally but gently adjust their vertical position to avoid overlaps.

When no section nodes exist in the tapestry (the `hasSectionsEarly` flag is false), all nodes get `fx` pinned, since there's no section structure to organize around.
