#!/bin/bash
# shuttle-worker — single-shot dispatch for Shuttle.
#
# Usage: shuttle-worker <fiber-id> [--agent claude|codex] [extra-flags...]
#
# Renders a self-contained dispatch prompt and runs the chosen
# coding-agent CLI *once* through its loom shell wrapper, then exits
# when the CLI exits. No inner loop. The tmux session terminates
# naturally; if the fiber is still eligible on Shuttle's next poll
# tick, Shuttle redispatches a fresh worker.
#
# Why call the wrappers (claude / codex shell functions in
# loom/shell-functions.sh) instead of bypassing them: the wrappers
# inject WAKE.md and felt session context for us. WAKE.md isn't
# auto-loaded by either CLI when invoked directly — claude needs
# `--system-prompt-file ~/.claude/WAKE.md`, codex needs `--config
# developer_instructions=...` — and that's exactly what the wrappers
# already do. Single source of truth; same wake-up shape interactive
# sessions get. (`bash -l` in the tmux session below sources
# `.bash_profile`, which sources shell-functions.sh, which defines the
# wrappers.)
#
# Why everything in one user message rather than a system prompt:
# system-prompt manipulation is per-CLI plumbing that risks colliding
# with the wrapper's own system-prompt usage (claude's WAKE.md flag,
# codex's developer_instructions). Putting the full dispatch context
# in a single user message — fiber id + worker framing + skill
# activation — keeps shuttle agnostic to the CLI's prompt machinery.
# The shuttle/felt skills auto-activate from the prompt's bare-word
# references on both CLIs (loom symlinks the skills into both
# ~/.claude/skills/ and ~/.agents/skills/).
#
# Agents:
#   claude (default) — claude wrapper from loom/shell-functions.sh;
#                      loads WAKE.md as system-prompt-file; runs
#                      interactively in the tmux pane.
#   codex            — codex wrapper from loom/shell-functions.sh;
#                      injects WAKE.md + felt-hook output into
#                      developer_instructions; we use `codex exec`
#                      for non-interactive single-shot semantics
#                      (see ~/.claude/skills/confer/SKILL.md on why
#                      interactive codex in tmux is unreliable).
#                      Selection is tag-driven: a `codex` tag on the
#                      constitution fiber tells Shuttle to dispatch
#                      via codex.
#
# Contrast with `~/.claude/skills/felt/scripts/ralph`, which wraps
# claude in a `while ... status:open|active` respawn loop. Shuttle
# owns iteration cadence at the orchestrator level (see
# `Shuttle.tick()`), so the worker is single-shot by design.

set -e

FIBER_ID="${1:?Usage: shuttle-worker <fiber-id> [--agent claude|codex] [extra-flags...]}"
shift

# Parse --agent flag (default: claude). Remaining args become EXTRA_FLAGS,
# passed verbatim to the chosen CLI — useful for debugging or per-fiber
# overrides (e.g. `--model …`).
AGENT="claude"
EXTRA_FLAGS=""
while (( $# )); do
    case "$1" in
        --agent)
            AGENT="$2"
            shift 2
            ;;
        --agent=*)
            AGENT="${1#--agent=}"
            shift
            ;;
        *)
            EXTRA_FLAGS="${EXTRA_FLAGS:+$EXTRA_FLAGS }$1"
            shift
            ;;
    esac
done

case "$AGENT" in
    claude|codex) ;;
    *)
        echo "shuttle-worker: unknown --agent '$AGENT' (expected claude|codex)" >&2
        exit 2
        ;;
esac

FELT="felt"
SESSION="shuttle-$FIBER_ID"
WORK_DIR="$(pwd)"

# Locate the fiber: project .felt/ first, then ~/loom.
FELT_DIR=""
if "$FELT" show "$FIBER_ID" >/dev/null 2>&1; then
    FELT_DIR="$WORK_DIR"
elif (cd "$HOME/loom" && "$FELT" show "$FIBER_ID" >/dev/null 2>&1); then
    FELT_DIR="$HOME/loom"
else
    echo "Fiber not found: $FIBER_ID"
    exit 1
fi

# Refuse to dispatch closed fibers — Shuttle's eligibility predicate
# already enforces this, but defence-in-depth is cheap.
#
# Read the raw frontmatter status field, not pretty-printed `felt show`
# output: `--field` returns the unwrapped value (or empty for missing),
# immune to prose echoing the keyword. Replaces the line-anchored grep
# from gotcha-shuttle-worker-status-grep.
if [[ "$(cd "$FELT_DIR" && $FELT show "$FIBER_ID" --field status 2>/dev/null)" == "closed" ]]; then
    echo "Fiber $FIBER_ID is closed; refusing to dispatch."
    exit 1
fi

# Already running?
if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Shuttle worker already running: $SESSION"
    echo "  Attach: tmux attach -t $SESSION"
    exit 0
fi

# Single-shot run script — agent runs once, then session ends.
RUN_SCRIPT=$(mktemp "${TMPDIR:-/tmp}/shuttle-run.XXXXXX")
cat > "$RUN_SCRIPT" << 'RUN'
#!/bin/bash
FIBER_ID="$1"
FELT_DIR="$2"
WORK_DIR="$3"
AGENT="$4"
EXTRA_FLAGS="$5"

cd "$WORK_DIR"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Shuttle worker — $FIBER_ID — agent=$AGENT — $(date '+%H:%M:%S')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Self-contained dispatch prompt. Everything the agent needs to start
# work lives here as a single user message:
#   - dispatch line (fiber id) — what would have been the system
#     prompt; now first line of the user message.
#   - worker framing — "you are a shuttle worker."
#   - skill activation — bare-word references to `shuttle` and `felt`
#     skills, picked up by both claude's and codex's
#     description-matched skill activation.
#   - exit etiquette — `kill $PPID`, status flips, tempered: human-only.
PROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/shuttle-prompt.XXXXXX")
cat > "$PROMPT_FILE" << PROMPTEOF
Shuttle dispatch. Fiber ID: $FIBER_ID

You are a Shuttle-dispatched worker on this fiber.

Activate the shuttle and felt skills before anything else, then follow them.

Read the constitution fresh via \`felt show $FIBER_ID\`. The work may take one session or many. End this session with \`kill \$PPID\` when context fills, when you've reached a clean break, or when the constitution is realized.

Update the constitution's \`outcome:\` to reflect where the work now stands, and append an editorial event with \`felt history append $FIBER_ID --summary "…"\` as the handoff for the next worker; file crystallizations as sub-fibers; commit. Status \`closed\` signals the constitution is realized; \`tempered: true\` is human-only.
PROMPTEOF

PROMPT=$(cat "$PROMPT_FILE")

case "$AGENT" in
    claude)
        # claude wrapper (loom/shell-functions.sh) injects
        # --system-prompt-file ~/.claude/WAKE.md when no system prompt
        # is set. Output streams into the tmux pane; agent runs `kill
        # $PPID` to end the session; Shuttle redispatches on next poll
        # if the fiber is still active.
        claude --dangerously-skip-permissions $EXTRA_FLAGS <<< "$PROMPT"
        ;;
    codex)
        # codex wrapper (loom/shell-functions.sh) injects WAKE.md +
        # felt-hook output into developer_instructions. `codex exec` is
        # non-interactive (interactive codex in tmux is unreliable per
        # confer/SKILL.md), single-shot, exits when done. We pass the
        # user message via stdin (`-`) so multi-line content stays
        # clean.
        codex exec --dangerously-bypass-approvals-and-sandbox $EXTRA_FLAGS - <<< "$PROMPT"
        ;;
esac

rm -f "$PROMPT_FILE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Shuttle worker exited (agent=$AGENT)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
RUN

chmod +x "$RUN_SCRIPT"

echo "Starting shuttle worker on $FIBER_ID"
echo "  Work dir: $WORK_DIR"
echo "  Fiber in: $FELT_DIR"
echo "  Agent:    $AGENT"
[[ -n "$EXTRA_FLAGS" ]] && echo "  Flags:    $EXTRA_FLAGS"

# Detached tmux session via login bash so the claude/codex wrappers
# from loom/shell-functions.sh are in scope. When the agent exits, the
# script falls through and the session ends — no `exec bash`
# keep-alive. That natural exit is what makes Shuttle's
# eligibility-driven redispatch tractable.
tmux new-session -d -s "$SESSION" -c "$WORK_DIR" \
    bash -l "$RUN_SCRIPT" "$FIBER_ID" "$FELT_DIR" "$WORK_DIR" "$AGENT" "$EXTRA_FLAGS"

echo "  Session:  $SESSION"
echo "  Attach:   tmux attach -t $SESSION"
