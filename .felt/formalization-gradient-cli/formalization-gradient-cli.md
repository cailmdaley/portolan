---
title: Formalization gradient CLI design
status: closed
tags:
    - felt
    - astra
    - decision
depends-on:
    - frontmatter-as-astra-source-of
    - felt-v2-session-hub
created-at: 2026-04-01T20:20:10.637216+02:00
closed-at: 2026-04-01T22:33:06.64381+02:00
outcome: 'Implemented full 3x3 formalization model through three rounds of Claude-Codex confer. Three tiers (annotated/formalized/analysis-grade) × three kinds (decision/computation/finding). Deliverables: formalization.md reference, SKILL.md with 3x3 table, hook session with scoped nudge. Tested on pure-eB fibers. Design converged through iterative review: Codex caught fake-precision risk and YAML weight issues, user clarified that outcome is not a gate and body serves agents too. Confer skill fixed (exec resume, stdin piping).'
---

(formalization-gradient-cli)=
# Formalization gradient CLI design

How fibers climb from bare breadcrumbs to exportable ASTRA sub-analyses. Surveyed 523 pure-eB fibers (copied to `~/Documents/projects/ASTRA/examples/pure_eb/.felt/`) as testing ground. Walked the PSF leakage story as concrete case study.

## Key decisions reached

**Direct file editing over CLI flags for ASTRA fields.** The agent should edit `.felt/<path>/<slug>.md` directly (Read/Edit tools) for body content and ASTRA frontmatter, not use CLI flags like `--body` with heredocs. CLI stays useful for metadata operations: `--status`, `--tag`, `--outcome`, `--comment`, `--link`. The line: CLI for metadata, file edit for content and structure.

**No new `--decide`/`--claim` CLI flags (for now).** Originally proposed atomic CLI flags for ASTRA field accretion. But if the guidance is "edit files directly," the agent adds YAML frontmatter fields the same way it adds body content. Simpler, more natural, avoids implementing complex structured CLI parsing in Go. Revisit if direct editing proves too error-prone.

**The gradient is skill-guided, not CLI-driven.** The felt skill needs a `references/formalization.md` that teaches agents how to accrete ASTRA structure during work — progressive examples from bare fiber to full sub-analysis, field templates, when to formalize vs when to comment. The skill is the engine; the CLI is plumbing.

**Hook should nudge skill activation.** Add to `felt hook session` output: "Activate `/felt` before working with fibers. Prefer editing fiber files directly for body content and ASTRA fields." This ensures formalization guidance is present during work, not just at extraction time.

## The gradient (concrete)

```
bare fiber       →  felt "PSF leakage check"
outcome          →  felt edit <id> -o "PTEs shift <0.05"
body + structure →  agent edits .md: adds sections, evidence pointers
ASTRA frontmatter → agent edits .md: adds decisions/inputs/outputs to YAML
sub-analysis     →  fiber has enough structure for felt export --format astra
```

## What to build next session

1. **`references/formalization.md`** — ASTRA field templates mapped to fiber frontmatter, progressive examples (bare → medium → full), the direct-edit pattern with before/after examples
2. **Update `SKILL.md`** — Add formalization context, reference to new file, mention it's not just retroactive anymore
3. **Update `felt hook session`** — Add skill activation nudge and direct-edit guidance
4. **Test on pure-eB fibers** — Take 2-3 real fibers from the testing ground and manually formalize them to validate the workflow

## ASTRA schema notes

Full schema at `~/Documents/projects/ASTRA/spec/0.1/analysis.schema.json`. Key required fields:
- **Analysis (root):** `version`, `name`, `inputs`, `outputs`
- **Decision:** `label`, `options` (map of `{label}`)
- **Insight:** `id`, `claim`, `created_at`, `evidence[]` (min 1, each needs `id` + `doi` or `artifact`)
- **Input:** `id`, `type` (data|analysis)
- **Output:** `id`, `type` (metric|figure|table|data|report)

felt Go types (in `internal/felt/felt.go`) are close but missing some optional schema fields: Decision `tags`/`when`, Option `insights`/`incompatible_with`/`requires`, Evidence `figure`/`table`/`location`/`version`, Insight `derived`/`scope`/`tags`/`notes`, Output `from`, Recipe `inputs`/`container`.

## Context from the meeting (2026-03-31)

The exploration–formalization tension: Liam wants formalization during exploration (preserves provenance), François wants free exploration then astrify after, Cail is testing the middle path. This design leans toward Liam's position — formalize on the fly, because agents don't forget reasoning the way humans do. Batch/astrify is less urgent but still worth building as a skill mode later.
