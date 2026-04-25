# ShotCatcher Service Platform — Implementation Plan

**Goal:** Turn ShotCatcher from a local dev tool into a secured multi-user service with trade analytics UI.

## Current State

| Component | Tech | Security |
|-----------|------|----------|
| Collector | Python asyncio, `ws://localhost:8001` | None |
| Chart UI Server | FastAPI + Uvicorn, port 8080 | Optional X-Api-Key (disabled) |
| Frontend | React 19 + KlineCharts + Canvas 2D | None |
| Browser ↔ Server WS | `/ws/ui`, `/ws/data-stream` | None |
| Frontend → Binance | `wss://fstream.binance.com` | Public stream |

## New Features

1. **Security layer** — WSS, login, user management, rate limiting
2. **Closed trades sidebar** — position list with PnL, click-to-navigate
3. **Open orders sidebar** — live order list with price delta
4. **Navigate to timestamp** — chart jumps to a specific trade time

---

## Phase 1: Security & Auth

**Components:** chart-ui-server, frontend

### 1.1 TLS / WSS (self-signed certs)

- Generate self-signed cert + key on first run if not present
- Uvicorn `--ssl-certfile` / `--ssl-keyfile` flags
- Config fields: `ssl_certfile`, `ssl_keyfile` in `chart-ui-server/config.py`
- All WS endpoints become WSS automatically (Uvicorn handles it)
- Frontend WS URLs switch from `ws://` to `wss://` (detect from `window.location.protocol`)
- Collector ↔ chart-ui-server stays plain `ws://localhost:8001` (loopback, not exposed)

**Files:**
- `chart-ui-server/config.py` — add SSL fields
- `chart-ui-server/main.py` — pass SSL to Uvicorn
- `chart-ui-server/scripts/gen_self_signed.sh` — cert generation helper
- Frontend: auto-detect protocol in WS hook URLs

### 1.2 User DB + Auth

**Storage:** SQLite `config/users.db`

```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,       -- bcrypt
    role TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'user'
    created_at TEXT NOT NULL,
    last_login TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sessions (
    token TEXT PRIMARY KEY,            -- secure random 32-byte hex
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip_address TEXT
);
```

**Auth flow:**
1. `POST /api/auth/login` — username + password → bcrypt verify → create session → set `HttpOnly` + `Secure` + `SameSite=Strict` cookie
2. All `/api/*`, `/ws/*` routes check session cookie via middleware
3. Login page served at `/login` — unauthenticated catch-all redirects there
4. `POST /api/auth/logout` — delete session
5. Session expiry: 7 days (configurable), checked on each request

**Admin CLI:**
```bash
python -m chart_ui_server.manage_users add <username> [--admin]
python -m chart_ui_server.manage_users list
python -m chart_ui_server.manage_users remove <username>
python -m chart_ui_server.manage_users reset-password <username>
```

Passwords entered interactively (getpass), never on command line.

**Files:**
- `chart-ui-server/auth/user_db.py` — UserDB class (SQLite + bcrypt)
- `chart-ui-server/auth/middleware.py` — FastAPI dependency for session auth
- `chart-ui-server/auth/routes.py` — `/api/auth/*` endpoints
- `chart-ui-server/manage_users.py` — CLI tool
- Frontend: `LoginPage.tsx`, auth state in zustand, redirect logic

### 1.3 Rate Limiting & IP Blocking

**App-level (FastAPI middleware):**
- Login endpoint: max 5 attempts per IP per 5 min → 429 + 15 min lockout
- WS connect: max 10 connections per IP
- Track in-memory dict (IP → timestamps), cleaned periodically
- After 20 failed logins from same IP in 1 hour → block IP for 1 hour
- Blocked IPs logged at WARNING level for fail2ban pickup

**OS-level (fail2ban config provided):**
- Ship a `fail2ban/shotcatcher.conf` filter that watches log for blocked-IP lines
- Users can optionally install it — not required

**Files:**
- `chart-ui-server/auth/rate_limiter.py` — in-memory rate limiter
- `chart-ui-server/auth/middleware.py` — integrate rate limiting
- `docs/deployment/fail2ban-setup.md` — optional fail2ban instructions

### 1.4 WS Auth for WebSocket Endpoints

WS connections cannot send cookies in the handshake in all browsers. Two options:

**Chosen approach: token query parameter**
1. On page load, authenticated frontend calls `GET /api/auth/ws-ticket` → short-lived token (60s TTL)
2. Frontend connects `wss://host/ws/ui?ticket=<token>`
3. Server validates ticket on WS handshake, rejects if invalid/expired
4. Ticket is single-use (deleted after first validation)

This avoids storing tokens in localStorage (XSS-safe) while working with browser WS API.

---

## Phase 2: Position Tracking

**Components:** collector, chart-ui-server

### 2.1 Position Reconstruction

Reconstruct closed positions from `user_trades` table in the collector's per-symbol DBs.

**Position table** — new SQLite DB `db_files/<SYMBOL>/positions.db`:

```sql
CREATE TABLE position (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,           -- 'LONG' | 'SHORT'
    entry_price REAL NOT NULL,   -- avg weighted entry price
    exit_price REAL NOT NULL,    -- avg weighted exit price
    quantity REAL NOT NULL,      -- total qty
    realized_pnl REAL NOT NULL,  -- USD
    pnl_pct REAL NOT NULL,       -- % based on entry notional
    fee_total REAL NOT NULL,     -- sum of commissions
    entry_time_ms INTEGER NOT NULL,   -- first entry fill ts
    exit_time_ms INTEGER NOT NULL,    -- last exit fill ts
    entry_order_ids TEXT NOT NULL,     -- JSON array of order IDs
    exit_order_ids TEXT NOT NULL,      -- JSON array of order IDs
    duration_ms INTEGER NOT NULL
);
CREATE INDEX idx_pos_symbol_time ON position(symbol, exit_time_ms);
```

**Reconstruction algorithm (per-symbol):**
1. Read `user_trade` rows ordered by `time` ascending
2. Maintain running position: `qty=0`, accumulate fills
3. When position flips sign or hits zero → emit a closed-position record
4. Partial close: emit proportional PnL for the closed portion, keep remainder
5. PnL: `(exit_price - entry_price) * qty` for LONG, inverse for SHORT
6. PnL %: `pnl / (entry_price * qty) * 100`
7. Fee: sum of `commission` fields from constituent trades

**Live updates:**
- Collector's `OrderEventPersister` already processes every fill
- Extend it: on each TRADE event, check if position closed → write to `positions.db`
- Forward `position_closed` event via Collector WS → chart-ui-server → frontend

**Gap-fill on startup:**
- On collector start, for each symbol: read last `exit_time_ms` from positions.db
- Reconstruct any positions from trades after that timestamp
- This handles collector downtime (REST sync fills the user_trade gaps, then positions are reconstructed)

### 2.2 Chart UI Server — Position API

**New endpoints:**
- REST: `GET /api/positions?symbol=<all|SYM>&period=<ms>` — returns position list
- WS push via `/ws/ui`: `position_closed` event (forwarded from collector)

**Files:**
- `chart-ui-server/routers/positions.py` — REST endpoint
- `chart-ui-server/routers/ws_ui.py` — add position_closed forwarding
- Collector: `collector/position_tracker.py` — reconstruction + live tracking

---

## Phase 3: Closed Trades Sidebar

**Component:** frontend

### 3.1 UI Layout

```
┌──────────────────────────────────────────────────────────┐
│ SymbolTabs                                               │
├──────────────────────────────────────┬───────────────────┤
│ Toolbar [TF] [Line] [Ruler] [...]   │ [📋] [📊] toggle │
├──────────────────────────────────────┼───────────────────┤
│                                      │ Period: [1h ▾]    │
│                                      │                   │
│          Chart Area                  │ BTCUSDT LONG      │
│          (shrinks ~15-18%)           │ +2.3% ($45.20)    │
│                                      │ 12:30 → 12:45    │
│                                      │ 15m duration      │
│                                      │─────────────────  │
│                                      │ ETHUSDT SHORT     │
│                                      │ -0.8% (-$12.10)  │
│                                      │ 11:15 → 11:22    │
│                                      │ 7m duration       │
│                                      │ ...scrollable...  │
└──────────────────────────────────────┴───────────────────┘
```

- **Toggle buttons:** Two icons on the right end of the Toolbar
  - 📋 = Closed trades panel
  - 📊 = Open orders panel
  - Click toggles visibility. Only one can be open at a time (or both, TBD)
- **Panel width:** 15% of screen, collapsible
- **Period dropdown:** 15m, 1h, 3h, 6h, 12h, 1d, 2d, 3d, 7d
- **Scrollable list** of position cards

### 3.2 Position Card Display

Each card shows:
| Field | Format |
|-------|--------|
| Symbol | `BTCUSDT` |
| Side | `LONG` / `SHORT` (color-coded) |
| Entry → Exit price | `64,230.50 → 64,520.10` |
| PnL % | `+2.3%` green / `-0.8%` red |
| PnL USD | `$45.20` / `-$12.10` |
| Time | `12:30 → 12:45` |
| Duration | Smart format (see below) |

**Smart duration format:**
- `< 1s` → `234ms`
- `1s–59s` → `45s`
- `1m–59m` → `12m 30s`
- `1h+` → `2h 15m`

### 3.3 Click-to-Navigate

Clicking a position card:
1. If different symbol → switch to that symbol tab (or open it)
2. Navigate chart to `entry_time_ms` centered in viewport
3. Chart timeframe stays as-is (usually trades mode)
4. Highlight the position's time range (optional: subtle background overlay)

**Files:**
- `chart-ui/src/components/ClosedTradesPanel.tsx`
- `chart-ui/src/stores/positionStore.ts`
- `chart-ui/src/components/Toolbar.tsx` — add toggle buttons
- `chart-ui/src/App.tsx` — layout with conditional panel

---

## Phase 4: Open Orders Sidebar

**Component:** frontend + chart-ui-server

### 4.1 Data Source

Open orders already flow through the system:
1. `GET /ws/ui` → `get_orders` → response includes `open_orders[]`
2. Live `order_event` pushes update them

For price delta: use last trade price from the active aggTrade WS stream. For symbols not currently on-screen, show order price only (no delta) — or subscribe to a lightweight stream.

**Approach for multi-symbol price:**
- Frontend already connects to `wss://fstream.binance.com/stream?streams=...` for the active symbol
- For open orders on OTHER symbols: subscribe to `<sym>@aggTrade` for each symbol with open orders
- This is a small number of extra streams (typically 1-10 symbols)
- Unsubscribe when order is filled/canceled

### 4.2 UI

Same right panel as closed trades, toggled by a different button.

Each order card:
| Field | Format |
|-------|--------|
| Symbol | `BTCUSDT` |
| Side | `BUY` / `SELL` (color-coded) |
| Type | `LIMIT` / `STOP_MARKET` / etc |
| Price | `64,230.50` |
| Current Δ | `+0.45%` (green if in profit direction) |
| Qty | `0.5 BTC ($32,115)` |
| Time placed | `2h 15m ago` |

**Click → opens that symbol on chart.**

### 4.3 Price Delta Logic

For a BUY LIMIT at 64,000 with current price 64,500:
- Delta = `(current - order_price) / order_price * 100` = +0.78%
- Color: green (price moved favorably for buyer — it's above entry, but for a limit buy this means the price is ABOVE the order, so it hasn't filled yet; show as neutral/red since order is far from fill)

Actually simpler: just show `|current - order_price|` as distance, and color based on whether order is likely to fill soon (price approaching order price = green).

**Files:**
- `chart-ui/src/components/OpenOrdersPanel.tsx`
- `chart-ui/src/stores/orderStore.ts` — extend with price tracking
- `chart-ui/src/hooks/useMultiSymbolPrices.ts` — subscribe to extra streams

---

## Phase 5: Navigate to Timestamp

**Component:** frontend

This is the core "click a trade → jump to that chart location" feature.

### 5.1 Implementation

The chart has two modes:
1. **KlineCharts mode** (candle timeframes) — use `chart.scrollToTimestamp(ts)`
2. **Trades mode** (custom canvas) — viewport is controlled by `stateRef.viewStart/viewEnd`

**For trades mode:**
```ts
function navigateToTimestamp(ts: number) {
    const viewRange = stateRef.viewEnd - stateRef.viewStart;
    stateRef.viewStart = ts - viewRange / 2;
    stateRef.viewEnd = ts + viewRange / 2;
    // Trigger data load if range not covered
    historyLoader.ensureCoverage(stateRef.viewStart, stateRef.viewEnd);
    requestAnimationFrame(render);
}
```

**For candle mode:**
```ts
chart.scrollToTimestamp(ts);
```

**Data loading:** If navigating to a past timestamp not in the current loaded range, trigger a `/ws/data-stream` load for that range. The existing scroll-back loader already handles this — we just need to set the viewport first.

### 5.2 Symbol Switch + Navigate

When clicking a position from a different symbol:
1. `chartStore.setActiveSymbol(symbol)` — triggers tab switch
2. Wait for chart initialization (existing logic)
3. Then `navigateToTimestamp(entry_time_ms)`

Need a "pending navigation" queue — set before symbol switch, consumed after chart mounts.

**Files:**
- `chart-ui/src/stores/chartStore.ts` — add `pendingNavigation: { ts: number } | null`
- `chart-ui/src/components/chart/ChartCore.tsx` — consume pending navigation after mount
- `chart-ui/src/components/chart/useChartInstance.ts` — expose `navigateToTimestamp()`

---

## Implementation Order

| Phase | Scope | Depends On | Status |
|-------|-------|------------|--------|
| **1** | Security (WSS + auth + rate limit) | Nothing | ✅ Done |
| **2** | Position tracking (collector + DB) | Nothing (parallel with Phase 1) | ✅ Done |
| **3** | Closed trades sidebar (frontend) | Phase 1 (auth), Phase 2 (data) | ✅ Done |
| **4** | Open orders sidebar (frontend) | Phase 1 (auth) | ✅ Done |
| **5** | Navigate to timestamp (frontend) | Phase 3 or 4 (needs a trigger) | ✅ Done |

Phases 1 and 2 can run **in parallel**. Phase 3 needs both. Phase 5 is incremental on Phase 3.

---

## Confirmed Decisions

1. **Position mode** — One-way only (no hedge). Simplifies reconstruction: per-symbol position is always flat → long or flat → short.
2. **Fees in PnL** — Include trading fees (commission from fill events). Funding fees excluded (would require extra REST calls).
3. **Multiple accounts** — One Binance API key per deployment. All users see the same data.
4. **Registration** — Add `POST /api/auth/register` endpoint, disabled by default (`allow_registration: false` in config). Ready to enable when needed.
5. **Sidebar panels** — Mutually exclusive (opening one hides the other). Width: 15–18% of screen.
