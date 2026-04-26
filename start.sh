#!/usr/bin/env bash
# ShotCatcherUI — start script
#
# Starts the FastAPI backend and optionally the Vite dev frontend and/or
# the ShotCatcherCollector data collector.
#
# Usage:
#   ./start.sh [options]
#
# Options:
#   --backend-only      Start backend only (skip Vite frontend)
#   --with-collector    Also start ShotCatcherCollector in the background
#   --no-trades         Disable aggTrades loading in the UI and skip aggTrades
#                       collection in the collector (positions/orders still work)
#   --tmux              Run everything in a detached tmux session
#   -h, --help          Show this help
#
# Examples:
#   ./start.sh                              # backend + Vite frontend (foreground)
#   ./start.sh --tmux                       # same, inside tmux
#   ./start.sh --backend-only --tmux        # backend only, detached
#   ./start.sh --with-collector --no-trades # backend + collector, no trade data
#   ./start.sh --tmux --with-collector --no-trades
#
# Prereqs (first time):
#   pip install -r requirements.txt --break-system-packages
#   cd chart-ui && npm install   (only needed for Vite dev mode)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RUN_FRONTEND=true
RUN_COLLECTOR=false
NO_TRADES=false
USE_TMUX=false
SESSION="shotcatcher-ui"

for arg in "$@"; do
  case "$arg" in
    --backend-only)    RUN_FRONTEND=false ;;
    --with-collector)  RUN_COLLECTOR=true ;;
    --no-trades)       NO_TRADES=true ;;
    --tmux)            USE_TMUX=true ;;
    -h|--help)
      sed -n '/^# /p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

if $NO_TRADES; then
    export CHART_UI_TRADES_ENABLED=false
fi

# --- Python path for shared DB managers ---
DM="$SCRIPT_DIR/../BinanceDataManagers"
export PYTHONPATH="$DM:$DM/order_data_manager:$DM/trades_manager:$DM/user_trades_manager:$DM/klines_manager:$DM/position_manager${PYTHONPATH:+:$PYTHONPATH}"

# --- Build uvicorn command ---
CERT_DIR="$SCRIPT_DIR/../config"
UVICORN_CMD="python3 -m uvicorn main:app --host 0.0.0.0 --port 8080 --log-level info"
if [[ -f "$CERT_DIR/server.crt" && -f "$CERT_DIR/server.key" ]]; then
    UVICORN_CMD="$UVICORN_CMD --ssl-certfile $CERT_DIR/server.crt --ssl-keyfile $CERT_DIR/server.key"
    SCHEME="https"
else
    SCHEME="http"
fi

# ── tmux mode ────────────────────────────────────────────────────────────────
if $USE_TMUX; then
    if ! command -v tmux &>/dev/null; then
        echo "ERROR: tmux not found. Install with: sudo apt install tmux"; exit 1
    fi
    if tmux has-session -t "$SESSION" 2>/dev/null; then
        echo "Session '$SESSION' already running. Attaching..."
        exec tmux attach -t "$SESSION"
    fi

    EXPORT_CMD="export PYTHONPATH=\"$PYTHONPATH\""

    tmux new-session -d -s "$SESSION" -n "backend" -c "$SCRIPT_DIR" -x 200 -y 50
    tmux set-option -t "$SESSION" -g history-limit 50000
    tmux send-keys -t "$SESSION:backend" "$EXPORT_CMD && $UVICORN_CMD" Enter

    if $RUN_FRONTEND; then
        tmux new-window -t "$SESSION" -n "frontend" -c "$SCRIPT_DIR/chart-ui"
        tmux send-keys -t "$SESSION:frontend" "npx vite --host 0.0.0.0" Enter
    fi

    tmux select-window -t "$SESSION:backend"
    echo ""
    echo "Session '$SESSION' started."
    echo "  Ctrl+B 0/1 — switch windows  |  Ctrl+B [ — scroll  |  Ctrl+B d — detach"
    echo "  Stop: tmux kill-session -t $SESSION"
    echo ""
    exec tmux attach -t "$SESSION"
fi

# ── foreground mode ──────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "Shutting down..."
    kill "$BACKEND_PID" 2>/dev/null || true
    kill "${FRONTEND_PID:-}" 2>/dev/null || true
    wait 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "Starting backend on :8080 ..."
cd "$SCRIPT_DIR"
$UVICORN_CMD &
BACKEND_PID=$!

for i in $(seq 1 30); do
    if curl -sk ${SCHEME}://localhost:8080/api/auth/me > /dev/null 2>&1; then
        echo "Backend ready."
        break
    fi
    sleep 0.5
done

if $RUN_FRONTEND; then
    echo "Starting frontend on :5173 ..."
    cd "$SCRIPT_DIR/chart-ui"
    npx vite --host 0.0.0.0 &
    FRONTEND_PID=$!
fi

echo ""
echo "============================================"
echo "  API:       ${SCHEME}://localhost:8080"
$RUN_FRONTEND && echo "  Chart UI:  http://localhost:5173"
echo "============================================"
echo ""
echo "Press Ctrl+C to stop."

wait
