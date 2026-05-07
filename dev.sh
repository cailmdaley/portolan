#!/bin/bash
# dev.sh - Start portolan (frontend + backend) + shuttle daemon in tmux
#
# Human path: `./dev.sh` starts or attaches the shared tmux session.
# Agent path: `./dev.sh restart` bounces the session without finding a terminal.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHUTTLE="$HOME/Documents/projects/shuttle/bin/shuttle"
SESSION_NAME="portolan-dev"

# Ports
FRONTEND_PORT=5173
BACKEND_PORT=4004
SHUTTLE_PORT=4000

has_session() {
  tmux has-session -t "=${SESSION_NAME}" 2>/dev/null
}

run_stack() {
  # Kill anything stale on our ports
  echo "Cleaning ports..."
  lsof -ti:$FRONTEND_PORT | xargs kill -9 2>/dev/null || true
  lsof -ti:$BACKEND_PORT | xargs kill -9 2>/dev/null || true
  lsof -ti:$SHUTTLE_PORT | xargs kill -9 2>/dev/null || true
  sleep 1

  # Start shuttle daemon
  echo "Starting shuttle on :$SHUTTLE_PORT..."
  /opt/homebrew/bin/escript "$SHUTTLE" start >/dev/null 2>&1 &
  SHUTTLE_PID=$!

  # Start backend (in subshell with explicit directory)
  echo "Starting backend on :$BACKEND_PORT..."
  (cd "$SCRIPT_DIR/server" && npm run dev) &
  BACKEND_PID=$!

  # Give backend a moment to start
  sleep 2

  # Start frontend (in subshell with explicit directory)
  echo "Starting frontend on :$FRONTEND_PORT..."
  (cd "$SCRIPT_DIR" && npm run dev) &
  FRONTEND_PID=$!

  echo ""
  echo "Portolan running:"
  echo "  Frontend: http://localhost:$FRONTEND_PORT"
  echo "  Backend:  ws://localhost:$BACKEND_PORT"
  echo "  Shuttle:  http://localhost:$SHUTTLE_PORT"
  echo ""
  echo "Detach with Ctrl+B then D. Stop with: ./dev.sh kill"

  cleanup() {
    echo ""
    echo "Stopping..."
    kill $SHUTTLE_PID $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
    wait $SHUTTLE_PID $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
    exit 0
  }
  trap cleanup INT TERM EXIT

  wait
}

start_session() {
  if has_session; then
    echo "Portolan tmux session already running: $SESSION_NAME"
    return
  fi

  tmux new-session -d -s "$SESSION_NAME" -c "$SCRIPT_DIR" "bash '$SCRIPT_DIR/dev.sh' run"
  echo "Started Portolan tmux session: $SESSION_NAME"
}

case "${1:-attach}" in
run)
  run_stack
  ;;

start)
  start_session
  ;;

attach|"")
  start_session
  exec tmux attach-session -t "=${SESSION_NAME}"
  ;;

restart)
  if has_session; then
    echo "Restarting Portolan tmux session: $SESSION_NAME"
    tmux kill-session -t "=${SESSION_NAME}"
  fi
  start_session
  ;;

kill|stop)
  echo "Killing portolan processes..."
  if has_session; then
    tmux kill-session -t "=${SESSION_NAME}"
  fi
  lsof -ti:$FRONTEND_PORT | xargs kill -9 2>/dev/null || true
  lsof -ti:$BACKEND_PORT | xargs kill -9 2>/dev/null || true
  lsof -ti:$SHUTTLE_PORT | xargs kill -9 2>/dev/null || true
  exit 0
  ;;

status)
  if has_session; then
    echo "Portolan tmux session is running: $SESSION_NAME"
  else
    echo "Portolan tmux session is not running: $SESSION_NAME"
  fi
  echo ""
  lsof -nP -iTCP:$FRONTEND_PORT -sTCP:LISTEN 2>/dev/null || true
  lsof -nP -iTCP:$BACKEND_PORT -sTCP:LISTEN 2>/dev/null || true
  lsof -nP -iTCP:$SHUTTLE_PORT -sTCP:LISTEN 2>/dev/null || true
  ;;

*)
  echo "Usage: $0 [attach|start|restart|kill|status]"
  exit 1
  ;;
esac
