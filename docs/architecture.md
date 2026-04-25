# Chart UI Server — Architecture

**Last Updated:** 2026-04-05
**Status:** Design / Pre-implementation

---

## Purpose

The Chart UI Server is a standalone Python process responsible for:

- Serving the React chart frontend to the browser
- Providing read-only market data API (klines, trades) from local SQLite (`db_files/`)
- Maintaining a persistent WS connection to the Collector to request data loads and
  receive loading progress events
- Proxying Collector progress events to browser clients via `/ws/ui`

This process has **no Binance API keys**, performs **no trading operations**, and has
**no connection to C++ worker processes**. It is purely for analysis and visualization.

For worker management and trading control, see
[controller/architecture.md](../controller/architecture.md).  
For market data collection, see [collector/architecture.md](../collector/architecture.md).

---

## Component Diagram

```
┌───────────────────────────────────────────────────────────────────┐
│                        Browser / Operator                         │
└───────────────────────────┬───────────────────────────────────────┘
                            │  HTTPS / WSS
┌───────────────────────────▼───────────────────────────────────────┐
│                     Chart UI Server Process                       │
│                       (Python / FastAPI)                          │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  WebSocket /ws/ui                                           │  │
│  │  - Browser connects here                                    │  │
│  │  - Receives: load requests from browser                     │  │
│  │  - Sends: progress/done/error events from Collector        │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
│                             │                                     │
│  ┌──────────────────────────▼──────────────────────────────────┐  │
│  │  CollectorClient                                            │  │
│  │  - Persistent outbound WS to Collector :8001/ws            │  │
│  │  - Translates browser load requests → Collector messages   │  │
│  │  - Forwards Collector progress events → /ws/ui broadcast   │  │
│  │  - Reconnects automatically on drop                        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  market_data router  (read-only)                            │  │
│  │  - GET /api/klines?symbol=&start=&end=                      │  │
│  │  - GET /api/trades?symbol=&start=&end=                      │  │
│  │  - Reads from db_files/ via SQLite (WAL, read-only)        │  │
│  │  - If symbol has no/stale data: sends load request to      │  │
│  │    CollectorClient and returns 202 Accepted                │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Static file serving                                        │  │
│  │  - Serves built chart-ui/ React app                        │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
                            │  read-only SQLite (WAL)
                    ┌───────▼──────────┐
                    │   db_files/      │
                    │  SYMBOL/         │
                    │   SYMBOL_1m.db   │
                    │   trades.db      │
                    │   trades_daily.db│
                    └──────────────────┘
                            │  (written by Collector)

ws://localhost:8001/ws  ←→  CollectorClient  (internal only, not browser-accessible)
```

---

## Data Flow: Browser Requests a Symbol

```
Browser opens chart for ETHUSDT
  → GET /api/klines?symbol=ETHUSDT&start=...&end=...
  → market_data router: check db_files/ETHUSDT/ETHUSDT_1m.db
  → If data exists and fresh: return rows immediately
  → If missing or stale:
      → CollectorClient.request_load("ETHUSDT")
          → sends {"type": "load", "symbol": "ETHUSDT"} to Collector WS
      → return HTTP 202 {"status": "loading", "symbol": "ETHUSDT"}
  → Browser listens on /ws/ui for progress events
  → Collector sends progress/done events → CollectorClient → /ws/ui broadcast
  → Browser re-requests klines once "done" event arrives
```

---

## Collector ↔ Chart UI Server WS Protocol

See [collector/architecture.md](../collector/architecture.md#ws-protocol-collector--ui-server)
for the full message type reference. Summary:

**Chart UI Server → Collector:**
- `load` — request data for a symbol
- `cancel` — cancel in-progress load
- `status` — query load state
- `list` — list all watched symbols

**Collector → Chart UI Server (forwarded to `/ws/ui`):**
- `progress` — download progress (pct, phase)
- `done` — symbol fully loaded
- `error` — load failed
- `auto_loaded` — symbol proactively loaded

---

## Module Structure (planned)

```
chart-ui-server/
  main.py                   — FastAPI app, lifespan, mounts
  config.py                 — settings: db_root, collector_ws_url, port
  collector_client.py       — CollectorClient: persistent WS, reconnect loop
  routers/
    data_stream.py          — WS /ws/data-stream: chunked trade streaming (newest-first)
    market_data.py          — Read-only klines/trades REST endpoints
    ws_ui.py                — WS /ws/ui: browser connection + event broadcast
  static/                   — Built chart-ui React app (from chart-ui/dist/)
  requirements.txt
```

---

## Configuration

| Field | Description | Default |
|-------|-------------|---------|
| `port` | HTTP/WS listen port | `8000` |
| `db_root` | Path to `db_files/` | `../db_files` |
| `collector_ws_url` | Internal WS URL for Collector | `ws://localhost:8001/ws` |
| `api_key` | Auth token for browser connections | required |

---

## What This Process Does NOT Do

- No Binance API calls of any kind
- No connection to C++ worker processes
- No strategy control or command dispatch
- No persistent database of its own (reads shared `db_files/` only)
