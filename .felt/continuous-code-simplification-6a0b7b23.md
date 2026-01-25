---
title: Continuous code simplification
status: closed
kind: spec
priority: 2
created-at: 2026-01-24T19:10:34.031937+01:00
closed-at: 2026-01-25T13:21:02.485139+01:00
close-reason: 'Iteration 18: surveyed fresh, found no new simplification opportunities. Previous iterations removed ~468 net lines including: FiberReader duplicate logic, HexGrid unused methods, index.ts helper extraction, OriginManager socket lookups, PALETTE_CSS, and debug logging. Build passes, 97/97 tests pass.'
---

# Spec

You are in a Ralph loop — autonomous iteration toward completion.

## Rhythm

1. **Discover** — Search for simplification opportunities. Don't rely on previous findings — look fresh each time.
2. **Simplify** — Pick the highest-value opportunity. Make the change.
3. **Verify** — Build passes, tests pass.
4. **Exit** — `kill $PPID` to continue the loop.

**Close when:** You searched thoroughly, found nothing worth changing, and made zero edits this iteration.

---

## Goal

Continuously simplify and reorganize hexarchy-v2 until the code is as clean as it can be.

## Philosophy

Each iteration is a fresh pair of eyes. Don't work from a checklist — discover what can be improved *now*. Look for:

- **Dead code** — exports, functions, types defined but never used
- **Redundancy** — similar logic repeated that could be unified
- **Indirection** — abstractions that don't earn their complexity
- **Bloat** — code that could be expressed more concisely
- **Stale artifacts** — commented code, outdated TODOs, debug leftovers
- **Structural opportunities** — files that should be merged or split

Breaking changes are fine. There's no backward compatibility requirement.

**Filing opportunities:** When you notice a simplification opportunity but aren't ready to tackle it this iteration, file it as a child fiber. Don't lose the insight.

## Discovery Techniques

Each iteration, use fresh searches:
```bash
# Find exports and check if they're imported elsewhere
grep -r "export " server/src/ src/ --include="*.ts"

# Find function definitions and check usage
grep -r "function \w\+\|const \w\+ = \(async \)\?(" --include="*.ts"

# Find interfaces/types and check if they're used
grep -r "interface \|type " --include="*.ts"

# Look for patterns that repeat
# Look for files with similar structure
# Look for code that feels heavier than it needs to be
```

Read files. Form opinions. Simplify.

## Context

- `server/src/` — Node.js backend
- `src/` — Browser frontend
- Tests: `server/src/index.test.ts`

## Completion

The codebase is as simple as it can reasonably be. Each iteration finds nothing worth changing.
