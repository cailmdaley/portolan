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
#
# Anchor to the literal `Status:` header line in `felt show` output.
# A loose `status:.*closed` match false-positives on prose in `outcome:`
# that mentions a prior status transition (e.g. "flipped status from
# `closed` → `active`"), since `felt show` wraps the outcome onto one
# logical line.
if (cd "$FELT_DIR" && $FELT show "$FIBER_ID" 2>/dev/null | grep -qE '^Status:[[:space:]]+closed[[:space:]]*$'); then
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

SYSPROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/shuttle-sys.XXXXXX")
cat > "$SYSPROMPT_FILE" << SYSEOF
Shuttle dispatch. Fiber ID: $FIBER_ID
SYSEOF

PROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/shuttle-prompt.XXXXXX")
cat > "$PROMPT_FILE" << 'PROMPTEOF'
You are a Shuttle-dispatched worker on this fiber.

Activate the /shuttle and /felt skills before anything else, then follow them.

The fiber ID is in the system prompt above; read the constitution fresh via `felt show <fiber-id>`. The work may take one session or many. End this session with `kill $PPID` when context fills, when you've reached a clean break, or when the constitution is realized.

Update the constitution's `outcome:` to reflect where the work now stands, and append an editorial event with `felt history append <fiber-id> --summary "…"` as the handoff for the next worker; file crystallizations as sub-fibers; commit. Status `closed` signals the constitution is realized; `tempered: true` is human-only.
PROMPTEOF

PROMPT=$(cat "$PROMPT_FILE")

# Interactive claude — output streams into the tmux pane. Agent runs
# `kill $PPID` at end of turn to end the session; Shuttle redispatches
# on next poll if the fiber is still active.
claude \
    --dangerously-skip-permissions \
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
