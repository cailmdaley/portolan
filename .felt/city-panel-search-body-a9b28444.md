---
title: 'City panel: search + body visibility + handoff'
status: closed
kind: spec
priority: 2
created-at: 2026-01-18T17:36:40.052876+01:00
closed-at: 2026-01-18T17:45:11.967177+01:00
close-reason: Complete. Search filters fibers by title/kind/body/reason with instant filtering and clear button. Reason preview shows first ~80 chars inline for closed fibers, chevron indicates expandable content, click expands to full markdown. Handoff button (↗) launches new Kitty tab with 'felt on <id> && claude'. All styling follows Porch Morning palette. 80 tests pass.
---

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
- **Use the frontend-design skill** when implementing visual polish — don't settle for default styling.

---

## Goal

Enhance the CityPanel fiber listing with search/filter, improved body/reason visibility, and a handoff action.

---

# City Panel Enhancements

Two features for the fiber listing in CityPanel.

---

## 1. Search / Filter

Add a search input that filters displayed fibers by title, kind, or body content.

**Placement:** Below city name/path, above "Open Fibers" section

**Behavior:**
- Filters both open and recently closed lists simultaneously
- Case-insensitive substring match
- Searches: title, kind, body, close-reason
- Instant filtering as you type (no debounce needed, small lists)
- Clear button (×) when non-empty
- Shows "No matches" when filter yields nothing
- **Clicking a search result shows the same markdown view as clicking a regular fiber** — same render feature, full body/reason with KaTeX support

**Scope:** Current city only (the one whose panel is open)

---

## 2. Body / Reason Visibility

**Current state:** Fibers with body or reason get `has-content` class and expand on click. But:
- No visual indicator that content exists
- Most fibers only have reason (no body)
- Reason is the documentation — should be more visible

**Approach:** Mix of options — preview inline, expand for full, clear affordance.

- **Reason preview inline** — show first ~80 chars under title for closed fibers
- **Expand indicator** — `▸` chevron for items with more content
- **Click to expand** — full body/reason with markdown rendering
- **Visual polish** — use frontend design skill to make it feel good

```
○ Some open fiber                            task
▸ ● Camera drag uses screenToWorld...        decision
    Changed camera pan from approxi...
```

---

## 3. Handoff Button

Fibers are view-only in hexarchy — no editing. But add a "handoff" action:

- Small button or icon on each fiber (or on expanded view)
- Clicking opens a new Claude session with this fiber as context
- Reference `/handoff` skill for implementation pattern

---

## Context

@/Users/cd280747/Documents/projects/hexarchy-v2/src/ui/CityPanel.ts — panel component, fiber rendering, markdown support
@/Users/cd280747/Documents/projects/hexarchy-v2/index.html — CSS styles for panel
@/Users/cd280747/Documents/projects/hexarchy-v2/server/src/FiberReader.ts — Fiber type definition, body parsing

---

## Verification

**Verify by doing, not by checking boxes:**
- Run `./dev.sh` and open browser
- Open city panel
- Type in search — fibers filter live
- Clear search — all fibers return
- See reason preview inline on closed fibers
- Click fiber with content — expands with full markdown
- Click handoff button — new session opens (or placeholder if handoff not wired)
- Visual check: styling feels polished, matches Porch Morning aesthetic
- No regressions — existing fiber display still works
