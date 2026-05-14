#!/bin/bash
# shuttle-worker -- remote single-shot Shuttle worker launcher.
#
# Remote portolan-agent runtimes call this script when
# PORTOLAN_SHUTTLE_ENABLED=1 and an eligible remote fiber needs a worker.
# The standalone Shuttle daemon owns local dispatch, but remote agents still
# need a small host-local launcher because they are intentionally able to
# dispatch while the laptop-side daemon is unreachable.

set -euo pipefail

usage() {
    echo "Usage: shuttle-worker.sh <fiber-id> [--agent <agent-id>] [extra flags...]" >&2
}

FIBER_ID="${1:-}"
if [ -z "$FIBER_ID" ]; then
    usage
    exit 2
fi
shift

AGENT_ID="claude-sonnet"
EXTRA_FLAGS=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --agent)
            if [ "$#" -lt 2 ]; then
                usage
                exit 2
            fi
            AGENT_ID="$2"
            shift 2
            ;;
        --agent=*)
            AGENT_ID="${1#--agent=}"
            shift
            ;;
        *)
            EXTRA_FLAGS+=("$1")
            shift
            ;;
    esac
done

shuttle_session_name() {
    local fiber_id="${1%/}"
    local leaf="${fiber_id##*/}"
    printf '%s-shuttle' "$leaf"
}

SESSION="$(shuttle_session_name "$FIBER_ID")"
WORK_DIR="$(pwd)"
FELT_BIN="${FELT_BIN:-felt}"

if "$FELT_BIN" show "$FIBER_ID" >/dev/null 2>&1; then
    FELT_HOST="$WORK_DIR"
elif [ -d "$HOME/loom" ] && (cd "$HOME/loom" && "$FELT_BIN" show "$FIBER_ID" >/dev/null 2>&1); then
    FELT_HOST="$HOME/loom"
else
    echo "shuttle-worker: fiber not found: $FIBER_ID" >&2
    exit 1
fi

STATUS="$(cd "$FELT_HOST" && "$FELT_BIN" show "$FIBER_ID" --field status 2>/dev/null || true)"
if [ "$STATUS" = "closed" ]; then
    echo "shuttle-worker: fiber is closed; refusing to dispatch: $FIBER_ID" >&2
    exit 1
fi

if tmux has-session -t "=$SESSION" 2>/dev/null; then
    echo "shuttle-worker: already running: $SESSION"
    exit 0
fi

case "$AGENT_ID" in
    claude|claude-sonnet)
        WRAPPER="claude"
        FLAGS=(--model sonnet --dangerously-skip-permissions)
        PROMPT_MODE="stdin"
        ;;
    claude-opus)
        WRAPPER="claude"
        FLAGS=(--model opus --dangerously-skip-permissions)
        PROMPT_MODE="stdin"
        ;;
    claude-haiku)
        WRAPPER="claude"
        FLAGS=(--model haiku --dangerously-skip-permissions)
        PROMPT_MODE="stdin"
        ;;
    codex)
        WRAPPER="codex"
        FLAGS=(--model gpt-5.5 --dangerously-bypass-approvals-and-sandbox)
        PROMPT_MODE="argv"
        ;;
    codex-spark)
        WRAPPER="codex"
        FLAGS=(--model gpt-5.3-codex-spark --dangerously-bypass-approvals-and-sandbox)
        PROMPT_MODE="argv"
        ;;
    pi|pi-deepseek-flash)
        WRAPPER="pi"
        FLAGS=(--provider openrouter --model deepseek/deepseek-v4-flash)
        PROMPT_MODE="argv"
        ;;
    pi-deepseek-pro)
        WRAPPER="pi"
        FLAGS=(--provider openrouter --model deepseek/deepseek-v4-pro)
        PROMPT_MODE="argv"
        ;;
    pi-kimi)
        WRAPPER="pi"
        FLAGS=(--provider openrouter --model moonshotai/kimi-k2.6)
        PROMPT_MODE="argv"
        ;;
    pi-sonnet)
        WRAPPER="pi"
        FLAGS=(--provider github-copilot --model claude-sonnet-4.6:high)
        PROMPT_MODE="argv"
        ;;
    pi-gpt-5.4)
        WRAPPER="pi"
        FLAGS=(--provider github-copilot --model gpt-5.4:xhigh)
        PROMPT_MODE="argv"
        ;;
    pi-gpt-5.4-mini)
        WRAPPER="pi"
        FLAGS=(--provider github-copilot --model gpt-5.4-mini:xhigh)
        PROMPT_MODE="argv"
        ;;
    pi-gpt-5-mini)
        WRAPPER="pi"
        FLAGS=(--provider github-copilot --model gpt-5-mini:xhigh)
        PROMPT_MODE="argv"
        ;;
    *)
        echo "shuttle-worker: unknown agent '$AGENT_ID'" >&2
        exit 2
        ;;
esac

if [ "${#EXTRA_FLAGS[@]}" -gt 0 ]; then
    FLAGS+=("${EXTRA_FLAGS[@]}")
fi

RUN_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/portolan-shuttle-run.XXXXXX")"
cat > "$RUN_SCRIPT" <<'RUN'
#!/bin/bash
set -euo pipefail

FIBER_ID="$1"
WORK_DIR="$2"
AGENT_ID="$3"
WRAPPER="$4"
PROMPT_MODE="$5"
shift 5

cd "$WORK_DIR"

echo ""
echo "----------------------------------------------------"
echo "Shuttle worker -- $FIBER_ID -- agent=$AGENT_ID -- $(date '+%H:%M:%S')"
echo "----------------------------------------------------"

PROMPT="$(cat <<PROMPTEOF
The orchestration system Shuttle dispatched you on this fiber. The constitution describes what "done" looks like; drive toward it across one or more sessions. The \`shuttle\` and \`felt\` skills carry the practice -- activate them next.

Fiber: $FIBER_ID

Exit Contract:
This is an autonomous Shuttle worker unless an Interactive Mode block explicitly says otherwise. After you update outcome/history, file findings, and commit at a clean checkpoint, your final action must be \`kill \$PPID\`. Do not substitute a normal chat final response for worker exit; the handoff belongs in the fiber.
PROMPTEOF
)"

case "$PROMPT_MODE" in
    stdin)
        "$WRAPPER" "$@" <<< "$PROMPT"
        ;;
    argv)
        "$WRAPPER" "$@" "$PROMPT"
        ;;
    *)
        echo "unknown prompt mode: $PROMPT_MODE" >&2
        exit 2
        ;;
esac

echo ""
echo "----------------------------------------------------"
echo "Shuttle worker exited -- agent=$AGENT_ID"
echo "----------------------------------------------------"
RUN

chmod +x "$RUN_SCRIPT"

tmux new-session -d -s "$SESSION" -c "$WORK_DIR" \
    bash -l "$RUN_SCRIPT" "$FIBER_ID" "$WORK_DIR" "$AGENT_ID" "$WRAPPER" "$PROMPT_MODE" "${FLAGS[@]}"

echo "shuttle-worker: started $SESSION agent=$AGENT_ID"
