#!/bin/bash
# dev.sh - Start portolan (frontend + backend) + shuttle daemon
# Kill via: Ctrl+C, or `bash dev.sh kill` from another shell

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHUTTLE="$HOME/Documents/projects/shuttle/shuttle/bin/shuttle"

# Ports
FRONTEND_PORT=5173
BACKEND_PORT=4004
SHUTTLE_PORT=4000

if [ "$1" = "kill" ]; then
  echo "Killing portolan processes..."
  lsof -ti:$FRONTEND_PORT | xargs kill -9 2>/dev/null || true
  lsof -ti:$BACKEND_PORT | xargs kill -9 2>/dev/null || true
  lsof -ti:$SHUTTLE_PORT | xargs kill -9 2>/dev/null || true
  exit 0
fi

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
echo "Press Ctrl+C to stop all"

# Trap Ctrl+C to kill all
cleanup() {
    echo ""
    echo "Stopping..."
    kill $SHUTTLE_PID $BACKEND_PID $FRONTEND_PID 2>/dev/null
    wait $SHUTTLE_PID $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit 0
}
trap cleanup INT TERM

# Wait for any to exit
wait
