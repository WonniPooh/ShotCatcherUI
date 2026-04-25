# Order Visualization & Local Data Layer

**Status:** 🚧 IN PROGRESS  
**Date:** 2026-04-03  
**Last Updated:** 2026-04-03  

---

## Overview

Adds order lifecycle visualization to the chart UI and a local SQLite data layer that
stores order events, user trades, and tick data. The system syncs with Binance Futures
on startup, maintains a live WebSocket feed, and serves historical data to the chart
through the Python controller backend.

## Architecture

```
[Binance Futures]
  ├── User Data WS ──→ [Python Backend] ──→ SQLite (order_events, user_trades)
  ├── REST /fapi/v1/* ──→       ↓                ↓
  └── Market Data WS ──→  [WS broadcast] ──→  [Chart UI]
                              ↑                    ↓
                     [Data Manager SQLite]    Canvas overlay
                     (klines + agg trades)   (markers, order lines)
```

**Key design decisions:**
- Futures only (`fapi` endpoints).
- Separate read-only API keys stored in controller config.
- One SQLite DB per symbol under `db_files/<SYMBOL>/`.
- Historical tick/candle data served from local DB; live data via direct Binance WS.
- Startup sync: WS first → REST backfill → deduplicate via idempotent upserts.

---

## Phases

### Phase 1 — Database Schema & Order Event Storage ✅ DONE

Create SQLite DB managers for:

| DB Manager | File | Table(s) | Purpose |
|------------|------|----------|---------|
| `OrderEventDB` | `data_manager/order_events_db_manager.py` | `order_event` | Full order lifecycle: place, modify, fill, cancel |
| `UserTradeDB` | `data_manager/user_trades_db_manager.py` | `user_trade` | Individual fill records with commission and PnL || `OrderAmendmentDB` | `data_manager/order_amendments_db_manager.py` | `order_amendment` | Price/qty modification history (from `/fapi/v1/orderAmendment`) |
**`order_event` table schema:**

| Column | Type | Description |
|--------|------|-------------|
| `order_id` | INTEGER | Binance order ID |
| `symbol` | TEXT | e.g. "ADAUSDT" |
| `client_order_id` | TEXT | For liquidation detection ("autoclose-" prefix) |
| `side` | TEXT | "BUY" / "SELL" |
| `order_type` | TEXT | "LIMIT", "MARKET", "STOP_MARKET", etc. |
| `execution_type` | TEXT | "NEW", "TRADE", "CANCELED", "EXPIRED", "AMENDMENT", "CALCULATED" |
| `order_status` | TEXT | "NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH" |
| `order_price` | REAL | Limit price |
| `stop_price` | REAL | Stop trigger price |
| `order_qty` | REAL | Original quantity |
| `last_fill_price` | REAL | Price of this fill (0 for non-fill events) |
| `last_fill_qty` | REAL | Quantity of this fill |
| `filled_qty_accumulated` | REAL | Total filled so far |
| `avg_price` | REAL | VWAP fill price |
| `commission` | REAL | Fee for this fill |
| `commission_asset` | TEXT | Fee asset (e.g. "USDT") |
| `realized_pnl` | REAL | PnL realized on this fill |
| `trade_id` | INTEGER | Binance trade ID (0 for non-fill events) |
| `event_time_ms` | INTEGER | Event creation timestamp (ms) |
| `transaction_time_ms` | INTEGER | Trade/transaction timestamp (ms) |
| `position_side` | TEXT | "BOTH", "LONG", "SHORT" |
| `is_maker` | INTEGER | 0/1 |
| `is_reduce_only` | INTEGER | 0/1 |
| `time_in_force` | TEXT | "GTC", "IOC", "FOK" |

**Primary key:** `(order_id, execution_type, transaction_time_ms)`  
— Uniquely identifies each event (same order can have multiple TRADE events at different times).

**`user_trade` table schema:**

| Column | Type | Description |
|--------|------|-------------|
| `trade_id` | INTEGER PK | Binance trade ID |
| `order_id` | INTEGER | Parent order |
| `symbol` | TEXT | |
| `side` | TEXT | "BUY" / "SELL" |
| `price` | REAL | Fill price |
| `qty` | REAL | Fill quantity |
| `quote_qty` | REAL | qty × price |
| `commission` | REAL | Fee |
| `commission_asset` | TEXT | Fee asset |
| `realized_pnl` | REAL | PnL on this trade |
| `is_maker` | INTEGER | 0/1 |
| `is_buyer` | INTEGER | 0/1 |
| `position_side` | TEXT | "BOTH", "LONG", "SHORT" |
| `trade_time_ms` | INTEGER | Timestamp (ms) |

**`order_amendment` table schema:**

Populated from `GET /fapi/v1/orderAmendment` (available up to 3 months back)
and from WS `ORDER_TRADE_UPDATE` events with `execution_type = "AMENDMENT"`.

| Column | Type | Description |
|--------|------|-------------|
| `amendment_id` | INTEGER PK | Binance amendment ID |
| `order_id` | INTEGER | Parent order |
| `symbol` | TEXT | |
| `client_order_id` | TEXT | |
| `time_ms` | INTEGER | Amendment timestamp (ms) |
| `price_before` | REAL | Price before modification |
| `price_after` | REAL | Price after modification |
| `qty_before` | REAL | Quantity before modification |
| `qty_after` | REAL | Quantity after modification |
| `amendment_count` | INTEGER | Cumulative modification count for this order |

All tables follow the existing `data_manager` patterns: WAL mode, idempotent upserts,
`meta` table for sync state, `_coerce_row()` for flexible input, batched inserts.

---

### Phase 2 — Binance Account Sync (Startup Reconciliation) ✅ DONE

**Goal:** On backend startup, fill DB gaps from Binance REST, no missed events.

**Algorithm:**
1. Start User Data WS **first** → buffer events in memory queue.
2. Read `last_sync_ts` from DB `meta` table.
3. REST: `GET /fapi/v1/allOrders?startTime=last_sync_ts` per active symbol (6-day windows, intra-window orderId pagination).
4. REST: `GET /fapi/v1/userTrades?startTime=last_sync_ts` per active symbol (6-day windows, intra-window fromId pagination).
5. REST: `GET /fapi/v1/orderAmendment` per order with modifications (available 3 months back).
6. Insert REST results into DB (duplicates ignored via upsert).
7. Drain WS buffer through same insert path.
8. Update `last_sync_ts` in meta. Switch to live-only mode.

**Amendment sync strategy:** For each order returned by `allOrders`, if the order
was a LIMIT type, call `/fapi/v1/orderAmendment?orderId=X&limit=100` to get the
full before/after price history. This captures modifications that happened while
we were offline. Weight is 1 per call, so batch carefully.

**Active symbols:** All symbols with any orders/trades on the account (discovered via
`GET /fapi/v2/account` → `positions` with non-zero `positionAmt`, plus symbols from
`allOrders` response).

**Ordering guarantee:** WS starts before REST → no gap. REST inserts are idempotent →
duplicates from WS buffer are harmless.

---

### Phase 3 — Live Order Event Processing (User Data WebSocket) ✅ DONE

**Goal:** Real-time order tracking via Binance User Data Stream.

| Component | Detail |
|-----------|--------|
| `UserDataWS` class | Python async WS client. listenKey create/refresh/reconnect. |
| Event parsing | `ORDER_TRADE_UPDATE` → extract all fields from `o` object. |
| DB insert + broadcast | Insert into SQLite → broadcast to chart UIs via `/ws/ui`. |
| Modification detection | Same orderId, `AMENDMENT` execution_type → `MODIFIED` event with old→new price. |

**WS message types broadcast to chart UI:**
- `order_placed` — new order on book (show price line)
- `order_modified` — price/qty changed (move price line)
- `order_filled` — full fill (remove line, add triangle marker)
- `order_partially_filled` — partial fill (update line, add small marker)
- `order_canceled` — canceled (remove line, add X marker)
- `position_update` — position quantity/entry price change

---

### Phase 4 — Tick/Candle Data Integration with Data Manager ✅ DONE

**Goal:** Serve historical klines/trades from local SQLite; live data stays direct WS.

| Task | Detail |
|------|--------|
| API: `GET /api/candles` | Read from `CandleDB`, pass through to chart |
| API: `GET /api/agg-trades` | Read from `AggTradeDB`, with time range + pagination |
| API: `GET /api/agg-trades/before` | Scroll-back pagination (latest N trades before timestamp) |
| Chart UI switchover | `fetchKlines`, `fetchRecentTrades`, `fetchOlderTrades` try local API first, fallback to Binance REST |

**DB paths** (populated by data_manager downloaders):
- Candles: `db_files/<SYMBOL>/<SYMBOL>_1m.db`
- AggTrades: `db_files/<SYMBOL>/trades.db`

---

### Phase 5 — Chart UI: Order Annotations ✅ DONE

**Goal:** Render full order lifecycle history on the chart canvas. Nothing is erased —
all historical data remains visible as a permanent trace.

#### Visualization Model: Order Trace

Each order is rendered as a **connected polyline** (step chart) showing its full
price history over time, terminated by an end marker:

```
Order placed at $100             Order modified to $95           Canceled
        ┌───────────────────────────┐                               
  $100  │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤                               
        │                           │                               
   $95  │                           └─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ✕  
        └───────────────────────────────────────────────────────────→ time
```

Segments are **horizontal dashed lines** at each price level, connected by
**vertical connectors** at modification timestamps. The trace ends with:

| End Marker | Visual | Condition |
|------------|--------|----------|
| Entry fill | Green ▲ (long) or ▼ (short) | `FILLED` + is entry order |
| Close fill | Red ▲ or ▼ | `FILLED` + is exit order |
| Cancel | ✕ (gray/red) | `CANCELED`, `EXPIRED`, `EXPIRED_IN_MATCH` |
| Still open | No end marker (line extends to viewport edge) | `NEW` / `PARTIALLY_FILLED` |

#### Constructing the Order Trace

For each order, the trace is built from `order_amendment` + `order_event` tables:

1. **Start point:** `order_event` with `execution_type = 'NEW'` → `(event_time_ms, order_price)`
2. **Modifications:** `order_amendment` rows sorted by `time_ms` → each gives
   `(time_ms, price_before → price_after)` — draw horizontal at `price_before`
   from previous time to this time, then vertical connector to `price_after`.
3. **End point:** terminal `order_event` (`FILLED`, `CANCELED`, `EXPIRED`) →
   draw horizontal from last amendment to terminal time, then end marker.

If no amendments exist, it's a single horizontal line from NEW to terminal event.

#### Color Legend (by order type, shown in chart legend panel)

| Color | Order Type |
|-------|------------|
| Blue dashed | LIMIT |
| Orange dashed | STOP_MARKET |
| Green dashed | TAKE_PROFIT_MARKET |
| Purple dashed | STOP_LIMIT |
| Gray dashed | TRAILING_STOP_MARKET |

#### All Timeframes

Markers appear on the correct candle in candle modes (1m, 5m, 1h, etc.) and at
exact pixel timestamp in trades mode. Order traces span across candles as needed.

#### Data Flow

1. Symbol switch → `GET /api/order-events?symbol=X` + `GET /api/order-amendments?symbol=X`
   → build all order traces from DB.
2. Live WS events → append to existing traces in real-time via zustand store
   (new amendment extends the polyline, terminal event adds end marker).

---

### Phase 6 — Backend API Endpoints ✅ DONE

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/order-events?symbol=X&startTime=T&endTime=T&limit=N` | GET | Historical order events from DB |
| `/api/order-lifecycle/{order_id}?symbol=X` | GET | Full event history for one order |
| `/api/order-amendments?symbol=X&orderId=N&startTime=T&endTime=T` | GET | Order modification history (before/after prices) |
| `/api/trades?symbol=X&orderId=N&startTime=T&endTime=T` | GET | User trades (fills) from DB |
| `/api/open-orders?symbol=X` | GET | Currently open orders (live lines) |
| `/api/symbols` | GET | List symbols with local data |
| `/api/pnl?symbol=X&startTime=T&endTime=T` | GET | Realized PnL + commission totals |
| `/ws/ui` (extend existing) | WS | New msg types: `order_event`, `position_update` |

---

## Dependency Graph & Implementation Order

```
Phase 1 (DB schema)           ✅
    ↓
Phase 2 (startup sync)        ✅
    ↓
Phase 3 (live WS)             ✅
    ↓
Phase 6 (API endpoints)        ✅
    ↓
Phase 5 (chart UI rendering)   ✅

Phase 4 (tick data integration) ✅   [independent]
```

---

## Corner Cases

| Case | Handling |
|------|----------|
| REST + WS overlap during startup | Idempotent upserts — duplicates are safe |
| Order modified multiple times | Each amendment stored in `order_amendment` with before/after price; up to 10k mods per order |
| Amendment history on startup | `GET /fapi/v1/orderAmendment` per order, available 3 months back; older mods lost |
| Order modified then filled | Trace shows full price path ending with fill triangle |
| Cancel+replace (not modify) | Two separate orders, two separate traces |
| Partial fill → cancel remainder | TRADE event + CANCELED event, both stored |
| Liquidation | Detected via `client_order_id` prefix "autoclose-" |
| WS disconnect during live mode | Reconnect + backfill gap via REST (same as C++ recovery) |
| Symbol with no history | Empty result set, no error |
| Multiple chart UIs connected | All receive same broadcast on `/ws/ui` |

## Files Changed

### Phase 1 — DB Schema

| File | Change |
|------|--------|
| `data_manager/order_events_db_manager.py` | **New** — `OrderEventDB` class |
| `data_manager/user_trades_db_manager.py` | **New** — `UserTradeDB` class |
| `data_manager/order_amendments_db_manager.py` | **New** — `OrderAmendmentDB` class |
| `docs/features/order-visualization.md` | **New** — This document |

### Phase 2 — Account Sync

| File | Change |
|------|--------|
| `controller/binance_futures_client.py` | **New** — Async Binance Futures REST client (HMAC-SHA256, aiohttp) |
| `controller/account_sync.py` | **New** — `AccountSyncService` — paginated REST sync, WS buffer drain, per-symbol DBs |
| `controller/tests/test_account_sync.py` | **New** — 18 unit tests (row mapping, mock sync, dedup, multi-symbol) |
| `controller/tests/test_binance_live.py` | **New** — Live integration test (mainnet read-only, 11 tests) |

### Phase 3 — Live User Data WS

| File | Change |
|------|--------|
| `controller/user_data_ws.py` | **New** — Binance User Data WS client (connect, buffer, keepalive, reconnect) |
| `controller/order_event_handler.py` | **New** — ORDER_TRADE_UPDATE → DB insert + UI broadcast |
| `controller/main.py` | **Modified** — Lifespan wires up WS + sync + drain on startup |
| `controller/tests/test_user_data_ws.py` | **New** — 15 unit tests (buffering, parsing, handler, broadcast format) |
| `controller/tests/test_user_data_ws_live.py` | **New** — Live integration test (listen key, WS connect, keepalive) |

### Phase 6 — Backend API Endpoints

| File | Change |
|------|--------|
| `controller/routers/orders.py` | **New** — 7 REST endpoints (order-events, order-lifecycle, amendments, trades, open-orders, symbols, pnl) |
| `controller/main.py` | **Modified** — Added `orders` router import and `app.include_router()` |
| `controller/tests/test_orders_api.py` | **New** — 15 unit tests (all endpoints, 503/404 error cases, multi-symbol) |

### Phase 5 — Chart UI: Order Annotations

| File | Change |
|------|--------|
| `controller/chart-ui/src/types/orders.ts` | **New** — OrderEventRaw, OrderAmendmentRaw, OrderTrace, OrderTraceSegment, OrderEndMarker types, ORDER_TYPE_COLORS |
| `controller/chart-ui/src/components/chart/orderTraceBuilder.ts` | **New** — `buildOrderTrace()`, `buildAllTraces()` — pure logic: events + amendments → polyline traces |
| `controller/chart-ui/src/components/chart/orderRenderer.ts` | **New** — `renderOrderTraces()` — canvas drawing of dashed polylines, vertical connectors, fill/cancel end markers |
| `controller/chart-ui/src/store/orderStore.ts` | **New** — Zustand store: `loadSymbol()` (REST fetch), `applyLiveEvent()` (WS updates), event/amendment caches |
| `controller/chart-ui/src/components/chart/useOrderData.ts` | **New** — Hook: fetches on symbol change, subscribes to `/ws/ui` for live order events |
| `controller/chart-ui/src/components/chart/types.ts` | **Modified** — Added `orderTraces: OrderTrace[]` to ChartState |
| `controller/chart-ui/src/components/chart/canvasRenderer.ts` | **Modified** — Added `renderOrderTraces()` call for trades mode |
| `controller/chart-ui/src/components/chart/ChartCore.tsx` | **Modified** — Wired `useOrderData()` hook |
| `controller/chart-ui/src/__tests__/orderTraceBuilder.test.ts` | **New** — 17 tests (trace building, amendments, fills, cancels, edge cases) |
| `controller/chart-ui/src/__tests__/orderRenderer.test.ts` | **New** — 7 tests (rendering logic, viewport culling, markers) |
| `controller/chart-ui/src/__tests__/orderStore.test.ts` | **New** — 9 tests (store lifecycle, live events, API fetch/error) |

### Phase 4 — Tick/Candle Data Integration

| File | Change |
|------|--------|
| `data_manager/klines_db_manager.py` | **Modified** — Added `get_candles()`, `get_latest_candle_time()`, `_row_to_dict()` query methods |
| `data_manager/trades_db_manager.py` | **Modified** — Added `get_trades()`, `get_trades_before()`, `_row_to_dict()` query methods |
| `controller/routers/market_data.py` | **New** — 3 REST endpoints (`/api/candles`, `/api/agg-trades`, `/api/agg-trades/before`) with lazy per-symbol DB caching |
| `controller/main.py` | **Modified** — Added `market_data` router import and `app.include_router()` |
| `controller/chart-ui/src/hooks/useBinanceStream.ts` | **Modified** — `fetchKlines`, `fetchRecentTrades`, `fetchOlderTrades` now try local API first with Binance REST fallback |
| `controller/tests/test_market_data_api.py` | **New** — 16 unit tests (candle queries, agg-trade queries, before pagination, 404 cases, _row_to_dict) |

## Cross-References

- C++ order types: [src/api/binance/order_types.h](../../src/api/binance/order_types.h)
- C++ order event parsing: [src/api/binance/ws_impl/user_data_ws_dispatch.cpp](../../src/api/binance/ws_impl/user_data_ws_dispatch.cpp)
- C++ trade records: [src/strategy/trade_record.h](../../src/strategy/trade_record.h)
- Existing DB patterns: [data_manager/trades_db_manager.py](../../data_manager/trades_db_manager.py)
- Chart UI: [controller/chart-ui/src/components/chart/](../../controller/chart-ui/src/components/chart/)
- Controller backend: [controller/main.py](../../controller/main.py)
- Binance User Data Stream ref: [docs/reference/binance-user-stream-events.md](../reference/binance-user-stream-events.md)
- Binance Order Amendment API: `GET /fapi/v1/orderAmendment` (weight 1, 3 month history)
- Binance Modify Order API: `PUT /fapi/v1/order` (weight 1 order rate, LIMIT only)
