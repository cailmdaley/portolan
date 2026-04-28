#!/bin/bash
# shuttle-worker — single-shot dispatch for Shuttle.
#
# Usage: shuttle-worker <fiber-id>
#
# Renders the fiber as the system prompt and runs claude *once*, then
# exits when claude exits. No inner loop. The tmux session terminates
# naturally; if the fiber is still eligible on Shuttle's next poll
# tick, Shuttle redispatches a fresh worker.
#
# Contrast with `~/.claude/skills/felt/scripts/ralph`, which wraps
# claude in a `while ... status:open|active` respawn loop. Shuttle
# owns iteration cadence at the orchestrator level (see
# `Shuttle.tick()`), so the worker is single-shot by design.

set -e

FIBER_ID="${1:?Usage: shuttle-worker <fiber-id>}"
shift

EXTRA_FLAGS="$*"

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
if (cd "$FELT_DIR" && $FELT show "$FIBER_ID" 2>/dev/null | grep -qiE 'status:.*closed'); then
    echo "Fiber $FIBER_ID is closed; refusing to dispatch."
    exit 1
fi

# Already running?
if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Shuttle worker already running: $SESSION"
    echo "  Attach: tmux attach -t $SESSION"
    exit 0
fi

# Single-shot run script — claude once, then session ends.
RUN_SCRIPT=$(mktemp "${TMPDIR:-/tmp}/shuttle-run.XXXXXX")
cat > "$RUN_SCRIPT" << 'RUN'
#!/bin/bash
FIBER_ID="$1"
FELT_DIR="$2"
WORK_DIR="$3"
EXTRA_FLAGS="$4"
FELT="felt"

cd "$WORK_DIR"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Shuttle worker — $FIBER_ID — $(date '+%H:%M:%S')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

FIBER_CONTENT=$(cd "$FELT_DIR" && $FELT show "$FIBER_ID")

SYSPROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/shuttle-sys.XXXXXX")
cat > "$SYSPROMPT_FILE" << SYSEOF
Shuttle dispatch. Fiber ID: $FIBER_ID

$FIBER_CONTENT
SYSEOF

PROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/shuttle-prompt.XXXXXX")
cat > "$PROMPT_FILE" << 'PROMPTEOF'
You are a Shuttle-dispatched worker on this fiber. This is a SINGLE-SHOT iteration — you do not loop, Shuttle does (poll-driven redispatch on the next tick if the fiber is still eligible).

Activate the felt skill (/felt) before anything else.

Survey:
- Read the fiber's Desired State, Scope, Quality Bar.
- Check current evidence (git log, the fiber body, sibling state.md if any).
- Decide whether the desired state is already satisfied.

If already satisfied:
- Update `outcome:` to reflect "I believe this is complete; awaiting review" if it doesn't already.
- Exit. Do nothing else. Do not rewrite work that's already done.

Otherwise:
- Do substantive work toward the desired state — make the highest-value move available in this iteration.
- Commit changes with a clear message.
- File fibers (decisions, findings, gotchas) as crystallizations warrant.
- Update `outcome:` with a one-paragraph rolling summary.
- Exit naturally.

Do NOT `kill $PPID`. Shuttle owns iteration cadence; when claude exits, the tmux session ends, and Shuttle's next poll dispatches again if work remains. Never self-temper (`tempered: true` is the human's signal of acceptance).
PROMPTEOF

PROMPT=$(cat "$PROMPT_FILE")

claude --dangerously-skip-permissions \
    $EXTRA_FLAGS \
    --append-system-prompt "$(cat "$SYSPROMPT_FILE")" \
    <<< "$PROMPT"

rm -f "$SYSPROMPT_FILE" "$PROMPT_FILE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Shuttle worker exited"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
RUN

chmod +x "$RUN_SCRIPT"

echo "Starting shuttle worker on $FIBER_ID"
echo "  Work dir: $WORK_DIR"
echo "  Fiber in: $FELT_DIR"
[[ -n "$EXTRA_FLAGS" ]] && echo "  Flags:    $EXTRA_FLAGS"

# Detached tmux session. When claude exits, the script falls through
# and the session ends — no `exec bash` keep-alive. That natural
# exit is what makes Shuttle's eligibility-driven redispatch tractable.
tmux new-session -d -s "$SESSION" -c "$WORK_DIR" \
    bash -l "$RUN_SCRIPT" "$FIBER_ID" "$FELT_DIR" "$WORK_DIR" "$EXTRA_FLAGS"

echo "  Session:  $SESSION"
echo "  Attach:   tmux attach -t $SESSION"
