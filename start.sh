#!/usr/bin/env bash
# Start the Chart UI backend (FastAPI) and frontend (Vite) together.
# Usage: ./start.sh
#
# Prereqs (first time):
#   pip install -r requirements.txt
#   cd chart-ui && npm install

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
    echo ""
    echo "Shutting down..."
    kill "$BACKEND_PID" 2>/dev/null || true
    kill "${FRONTEND_PID:-}" 2>/dev/null || true
    wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# --- Python path for shared DB managers ---
DM="$SCRIPT_DIR/../BinanceDataManagers"
export PYTHONPATH="$DM:$DM/order_data_manager:$DM/trades_manager:$DM/user_trades_manager:$DM/klines_manager:$DM/position_manager${PYTHONPATH:+:$PYTHONPATH}"

# --- Backend (FastAPI on port 8080) ---
echo "Starting backend on :8080 ..."
cd "$SCRIPT_DIR"

# Build uvicorn command — add SSL flags if cert files exist
UVICORN_CMD="python3 -m uvicorn main:app --host 0.0.0.0 --port 8080 --log-level info"
CERT_DIR="$SCRIPT_DIR/../config"
if [[ -f "$CERT_DIR/server.crt" && -f "$CERT_DIR/server.key" ]]; then
    UVICORN_CMD="$UVICORN_CMD --ssl-certfile $CERT_DIR/server.crt --ssl-keyfile $CERT_DIR/server.key"
    SCHEME="https"
    WS_SCHEME="wss"
    echo "  TLS enabled (self-signed)"
else
    SCHEME="http"
    WS_SCHEME="ws"
fi
$UVICORN_CMD &
BACKEND_PID=$!

# Wait for backend to be ready
for i in $(seq 1 30); do
    if curl -sk ${SCHEME:-http}://localhost:8080/api/auth/me > /dev/null 2>&1; then
        echo "Backend ready."
        break
    fi
    sleep 0.5
done

# --- Frontend (Vite on port 5173) ---
echo "Starting frontend on :5173 ..."
cd "$SCRIPT_DIR/chart-ui"
npx vite --host 0.0.0.0 &
FRONTEND_PID=$!

echo ""
echo "============================================"
echo "  Chart UI:  http://localhost:5173"
echo "  API:       ${SCHEME:-http}://localhost:8080/api/auth/me"
echo "============================================"
echo ""
echo "Press Ctrl+C to stop."

wait
