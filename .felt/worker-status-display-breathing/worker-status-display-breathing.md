---
title: 'Worker status display: breathing pulse for working state'
status: closed
created-at: 2026-01-18T18:01:39.400068+01:00
closed-at: 2026-01-18T18:15:52.299311+01:00
---

(worker-status-display-breathing)=
# Ralph Spec

You are in a Ralph loop — autonomous iteration toward completion.

---

## Your Rhythm

1. **Survey** — Read previous work for orientation (`felt downstream <fiber-id>`).
   Use it for context — files touched, concepts named — but apply fresh judgment.
   Scan the spec and codebase. What's incomplete? What needs verification? What could improve?

2. **Prioritize** — Identify the single highest-value task to work on yourself.
   This is what you'll focus on in this session.

3. **Delegate** — Any routine, isolated tasks can be launched as background agents (2-3 max, different files).
   For each: create child fiber, launch with Task tool (run_in_background: true).
   Do NOT check their progress or output. They will notify you when finished.

4. **Work** — Focus on your high-value task. If agents finish while you're working, briefly note their results and continue.
   If you have nothing to work on yourself, just wait for agents to complete.

5. **Exit** — End every iteration with `kill $PPID`. The loop continues.

   **NEVER close the fiber if you made changes this iteration.**
   Made an edit? Fixed a bug? Added a test? → `kill $PPID`. That's it. Don't close.

   **Only close when you've actively checked everything and found nothing:**
   - You surveyed the full design and verified each part is implemented
   - You ran tests and they pass
   - You tried interacting with what was built and it works
   - You looked for edge cases, documentation gaps, code smells — nothing found
   - You made zero changes this iteration

   If ALL of that is true → `felt off <fiber-id> -r "summary"` then `kill $PPID`.
   If ANY of it is false → just `kill $PPID`. The loop continues.

---

## Key Principles

- **Form your own understanding of completion.** Don't mechanically check boxes. Read the design, understand the intent, verify that the implementation matches.
- **Fresh eyes each iteration.** Previous work informs but doesn't bind. Apply fresh judgment.
- **Light parallelism.** Chunk when it helps, but don't force it. Sequential is fine.
- **Don't poll agents.** They notify you. Compulsive checking burns context.

---

## Goal

Worker hexes visually indicate their status (working vs waiting) at a glance, using motion vocabulary that future polish can build on.

## Design

### The Problem

Workers have meaningful states but they blur together visually. Color alone doesn't scan — you have to inspect each hex to see status. Good map design makes state legible from distance.

### Civ-Informed Principles

1. **Status legibility at distance** — Unit state readable before you click. Fortified units have shields. Sleeping units are grayed. Scan the map, know who needs orders.

2. **The map is quiet until it isn't** — Stillness is baseline. Motion catches the eye. A single animated element on a quiet map draws attention naturally.

3. **Motion vocabulary** — Different motions mean different things. Urgent != alive. A slow pulse reads as "breathing, processing." A fast bounce reads as "alert, error."

### Two States

| State | Meaning | Server value |
|-------|---------|--------------|
| **Working** | Actively processing, tokens flowing | `working` |
| **Waiting** | Idle, ready, could use attention | `idle` |

Drop `attention` for now — it was speculative. If needed later, it's a separate concern.

### Visual Encoding

**Working**: Slow breathing pulse on the hex mesh.
- Scale oscillates: 1.0 → 1.03 → 1.0 over ~2.5 seconds
- Subtle but visible — scans immediately when you look for it
- Reads as "alive, processing" not "urgent, error"

**Waiting**: Completely still.
- Stillness IS the indicator
- The contrast with motion is the message

### Implementation

**Animation approach**: Per-mesh scale in render loop.

```typescript
// In animation frame
const now = Date.now()
for (const [key, data] of this.workerMeshes) {
  if (data.status === 'working') {
    const t = (now % 2500) / 2500
    const scale = 1.0 + 0.03 * Math.sin(t * Math.PI * 2)
    data.mesh.scale.setScalar(scale)
  }
}
```

Why not shaders? Simpler for now. When we move to instancing (visual polish phase), migrate to ShaderMaterial with time uniform. The motion vocabulary stays the same.

**Data flow**: Server already sends `status`. Frontend just needs to animate based on it.

### Future Hooks (Don't Build Now)

These inform architecture but aren't in scope:

- **Activity trails** — hexes near working workers slightly warmer
- **Micro-terrain / context fullness** — workers accumulate "camp" details as their context fills. Early session = sparse. Deep session = established encampment. Visual metaphor: the worker is *settling in*, building up working memory. Could show as: small objects appearing around hex, terrain detail increasing, or hex getting slightly more elevated/defined.
- **Fog of inactivity** — areas without workers slightly hazed
- **Instanced rendering** — ShaderMaterial with status uniforms for scale

The breathing pulse establishes motion vocabulary. Future polish layers on top.

## Context

@src/render/ZoneRenderer.ts — Main rendering, `renderWorker()` creates worker meshes
@src/state/types.ts — `Session.status`, `PALETTE.workerActive/workerIdle`
@src/main.ts — Animation loop lives here, calls renderer

Current `renderWorker()` already picks color by status. Need to:
1. Store mesh reference for animation
2. Track status per worker
3. Add animation to render loop

## Completion

**Verify by doing:**
- Run `./dev.sh` to start frontend + backend
- Have two tmux sessions in same project directory
- One session: start `claude` and give it work (active processing)
- Other session: `claude` sitting idle at prompt
- View hexarchy — working session pulses slowly, waiting session is still
- Pulse should be subtle (not distracting) but visible (scans at glance)
- Zoom out — can you tell which worker is working without reading labels?

**The finished state:**
- Working workers breathe (slow scale pulse)
- Waiting workers are still
- Motion vocabulary is established for future states
