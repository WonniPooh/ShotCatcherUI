# Chart UI — Data Flow Redesign

**Status:** ✅ IMPLEMENTED  
**Date:** 2026-04-06  
**Last Updated:** 2026-04-06 (newest-first streaming, viewport-aware merge, logging)  

---

## Overview

This document captures the agreed design for the next iteration of chart-ui data loading,
session persistence, and date-range navigation. It replaces the current approach where:

- Historical trades are loaded in one shot after the first live WS tick
- The browser fully resets to BTCUSDT on every page refresh
- Navigation is viewport-only with no explicit date-range input

The new design introduces backend-driven streaming with incremental DB polling, persistent
browser session state, and a date-range picker.

---

## Goals

1. **Session persistence** — page refresh restores active symbol + full tab list
2. **Date-range navigation** — explicit `[from, to)` input (day granularity); min 1 day range
3. **Streaming load with collector integration** — backend streams chunks as Collector writes them
4. **Tab switch cancels in-flight load** — no wasted bandwidth once user moves away
5. **Single-symbol memory model** — trade dots only held for the active symbol
6. **Order data (events + amendments) loaded directly** — collector responsibility; no polling

---

## Non-Goals / Constraints

- Drawing tools: **do not touch** — working correctly as-is
- Live dot rendering on the right edge: keep as-is  
- Order amendments and order events: already collected; loaded once from DB on symbol change

---

## Architecture Overview

```
Browser
│
├── localStorage: tabs[], activeSymbol              ← persisted on every change
│
├── wss://fstream.binance.com/{symbol}@aggTrade     ← live dots (direct, unchanged)
│
├── ws://<host>/ws/data-stream                      ← unified WS (replaces /ws/trade-loader)
│   ├── browser → { type:"load", symbol, from_ms, to_ms }   ← initial + scroll-back
│   ├── browser → { type:"cancel", symbol }
│   ├── server  → { type:"chunk", trades:[...], from_ms, to_ms, chunk_seq }
│   ├── server  → { type:"done",  symbol, total }
│   └── server  → { type:"error", symbol, message }
│   WS stays open after initial done for scroll-back requests.
│   Scroll-back: debounced viewport watcher (200ms check, 1.5s idle) detects
│   viewport.fromTime < loadedFrom; sends new load for uncovered range + 1h padding.
│1
└── ws://<host>/ws/ui                               ← collector progress / live order events
    ├── browser → { type:"get_orders", symbol }         ← request full order history on symbol change
    └── server  → { type:"order_data", symbol, events, amendments, open_orders }
        + live  → { type:"order_event", ... }           ← pushed as orders arrive
    NOTE: REST /api/order-events and /api/order-amendments are NOT implemented;
          all order data is served over this WS.

chart-ui-server
│
├── DataStreamHandler                               ← NEW (replaces ws_trade_loader)
│   ├── Checks DB for requested [from_ms, to_ms)
│   ├── If data present → stream in ≤100 KB chunks immediately
│   ├── If data absent  → request Collector, poll DB every 1s
│   │   ├── As new rows appear → stream chunk, narrow awaited window
│   │   └── Cancel-aware: browser cancel or tab-switch stops poll + notifies Collector
│   └── Uses collector_client.request_load(symbol) / request_cancel(symbol) (already exists)
│
└── CollectorClient                                 ← unchanged

Collector                                           ← unchanged protocol
```

---

## Feature 1: Session Persistence

### Current State

All state lives in Zustand memory. On refresh: `activeSymbol = 'BTCUSDT'`, `tabs = [BTC, ETH, SOL]`.

### Solution

Use `localStorage` as the persistence backing. Write on every change; read once on startup.

**Persisted keys:**

| Key | Type | Description |
|-----|------|-------------|
| `sc_tabs` | `SymbolTab[]` JSON | Full ordered tab list |
| `sc_active_symbol` | string | Last active symbol |

**Rules:**

- On very first ever load (no `sc_tabs`): default to `[BTC, ETH, SOL]`, active = `BTCUSDT`
- On startup with saved state: restore tabs + active symbol, then proceed with normal load
- Write `sc_tabs` any time: tab added, tab removed, or tab reordered
- Write `sc_active_symbol` any time `activeSymbol` changes
- Max tabs: enforce the same limit as today (if any); silently cap if localStorage has more

**Implementation location:** `chartStore.ts` — add `persist` middleware (Zustand built-in) or
manual `localStorage.getItem`/`setItem` in the relevant actions.

---

## Feature 2: Date-Range Navigation

### UX

A compact input bar below `Toolbar`, only visible in **trades mode** (and optionally 1m candle mode).
Contains two date inputs: **From** and **To** (day/month/year only; no time picker — day granularity).

```
[ From: DD/MM/YYYY ] [ To: DD/MM/YYYY ] [Go]  [← Live]
```

- **From** and **To**: plain `<input type="date">`, locale-formatted`
- **[Go]**: triggers a ranged load replacing the current live viewport
- **[← Live]**: returns to live mode (clears date range, re-enables auto-scroll)
- Minimum range: 1 day (enforced: if `from == to`, show validation error; reject)
- Maximum range: limited by what the Collector has (backend returns `error` if outside DB range;
  show message to user — "Data not available for this range")
- While a ranged load is in progress: show spinner, disable [Go]
- While in date-range mode: live dots still arrive at right edge (not rendered unless viewport
  is scrolled to now; auto-scroll is off)

**State additions to `chartStore`:**

```ts
dateRangeFrom: number | null;   // ms, set when [Go] is pressed; null = live mode  
dateRangeTo:   number | null;   // ms, null = live mode
isDateRangeMode: boolean;       // true when showing historical range (auto-scroll off)
```

---

## Feature 3: Unified Data-Stream WS + Backend Streaming

### Summary of Changes

The current `/ws/trade-loader` endpoint:
- Waits for the first live WS tick (`wsStartTime`) before opening
- Loads everything in one query and streams it in one shot
- Has no awareness of what the Collector is doing in parallel

The new `/ws/data-stream` endpoint:
- Browser connects **immediately** on symbol selection (no waiting for live tick)
- Browser sends explicit `[from_ms, to_ms)` range
- Backend streams in ≤100 KB JSON chunks as data becomes available
- If data is missing → polls DB every 1 s, streams each new chunk as it appears
- Backend maintains per-symbol cancel state; browser cancel or tab-switch stops everything

---

### Protocol: `/ws/data-stream`

All messages are JSON.

#### Browser → Server

```jsonc
// Request historical data for a range
{ "type": "load", "symbol": "BTCUSDT", "from_ms": 1712000000000, "to_ms": 1712086400000 }

// Cancel in-flight load (tab switch, manual cancel)
{ "type": "cancel", "symbol": "BTCUSDT" }
```

#### Server → Browser

```jsonc
// A chunk of trades within [from_ms, to_ms)  
// chunk_covered_from/to is the actual time span covered by THIS chunk  
{ "type": "chunk", "symbol": "BTCUSDT", "trades": [...], 
  "chunk_covered_from": 1712000000000, "chunk_covered_to": 1712003600000,
  "chunk_seq": 1 }

// All requested data has been delivered  
{ "type": "done", "symbol": "BTCUSDT", "total": 142350 }

// Data not available (Collector failed, or range outside DB)  
{ "type": "error", "symbol": "BTCUSDT", "message": "..." }
```

#### Chunk Size

Each chunk ≤ 100 KB serialized JSON. At ~100 bytes/trade this is ~1000 trades/chunk.
Exact batch size: `1000` rows per DB fetch; server serializes and checks size before send.

---

### Backend: `DataStreamHandler` (new class in `routers/data_stream.py`)

```
on_connect(ws):
    wait for first message {type:"load", symbol, from_ms, to_ms}

    validate:
        from_ms < to_ms
        to_ms - from_ms <= MAX_RANGE_MS  (30 days)

    cancel any existing load for same WS

    start _load_coroutine(ws, symbol, from_ms, to_ms)

_load_coroutine(ws, symbol, from_ms, to_ms):
    remaining_to = to_ms  # retreats as data is sent — newest first
    collector_requested = False

    while remaining_to > from_ms and not cancelled:
        rows = db.get_trades_in_range_desc(symbol, from_ms, remaining_to, limit=1000)

        if rows:
            rows.reverse()     # send ascending within chunk
            send chunk(rows)
            remaining_to = rows[0]["trade_ts_ms"] - 1  # move left
            continue  # check for more immediately

        # No rows in DB for (from_ms, remaining_to]
        if not collector_requested:
            collector_client.request_load(symbol)
            collector_requested = True

        await asyncio.sleep(1.0)  # poll DB

    if not cancelled:
        send done(symbol, total_rows_sent)

on_cancel(ws, symbol):
    cancel _load_coroutine for this ws+symbol
    collector_client.request_cancel(symbol)
```

**Newest-first rationale:** The user's viewport is at "now" on initial load.
Streaming newest-first means the first chunk covers the visible viewport;
subsequent chunks fill in the historical tail off-screen. The frontend's
`mergeChunk` only invalidates the LOD render cache when a chunk overlaps the
current viewport — off-screen chunks are stored silently without triggering a
re-render.

**Data consistency guarantee:** The poller retreats `remaining_to` only by rows
it has already read, so there are no gaps in what is delivered. The Collector
writes rows in ascending time order; once written, they're visible to the next
DB read via WAL mode.

---

### Data Consistency

The question: how do we know the data coming from the DB in parts is contiguous (no
time gaps due to Collector writing non-contiguously)?

**Approach: Collector reports its write progress via the existing WS protocol.**

When the Collector finishes writing a time segment, it broadcasts:

```jsonc
{ "type": "progress", "symbol": "BTCUSDT", "phase": "trades",
  "covered_from_ms": 1712000000000, "covered_to_ms": 1712003600000, "pct": 40 }
```

This is a natural extension of the already-existing `progress` event (currently only has `pct`).

**Backend rule:**  
`DataStreamHandler` only advances `remaining_from` past a time T if:
1. It found rows in DB up to T **AND**
2. The last `progress` event from Collector confirms `covered_to_ms >= T`  
   — meaning the Collector has finished writing everything up to T.

This prevents the UI from receiving a chunk with a gap in the middle caused by the
Collector writing a later window first.

**Alternative (simpler, less strict):** The Collector always downloads in ascending time
order front-to-back. In that case, `covered_to_ms` from the progress event is sufficient
as the "safe advance boundary". This is the recommended starting approach; the strict
cross-check can be added later if needed.

**Edge case — data already fully present:** if the full `[from_ms, to_ms)` range is already
in DB (e.g. previously downloaded), `collector_requested` stays false and the entire range
is streamed immediately without polling.

---

## Feature 4: Tab Switch → Cancel In-Flight Load

When the browser sends `{ "type": "cancel", "symbol": "X" }`:

1. `DataStreamHandler` cancels the asyncio coroutine for that symbol on that WS connection
2. `collector_client.request_cancel("X")` is sent to the Collector (best-effort)
3. Simultaneously, browser starts `{ "type": "load", "symbol": "Y", ... }` for new symbol

On the browser side (from `useHistoryLoader`):
- Cleanup function of `useEffect` sends the cancel message and closes the WS  
- A new `useEffect` fires (because `activeSymbol` changed) → new load starts

---

## Feature 5: Single-Symbol Memory Model

**Current state:** all symbols accumulate `tradeDots` in stateRef as the user switches tabs.
Old data is never freed.

**New rule:**  
On symbol switch (in `useSeriesManager`), after clearing `stateRef.tradeDots = []`, also
discard the stateRef for the previous symbol entirely. Since all hot-path data is in a single
shared `stateRef`, clearing it means old data is immediately GC'd.

No separate per-symbol cache needed — the WS history load is fast enough (chunked streaming)
that switching back to a previously visited symbol simply re-loads it.

---

## Startup Sequence (New)

```
1. App mounts
   → Read localStorage: restore tabs[], activeSymbol  (Feature 1)

2. SymbolTabs renders with restored tabs

3. ChartCore mounts for activeSymbol:
   a. useBinanceStream: open wss://fstream.binance.com for live dots  ← unchanged, immediate

   b. useHistoryLoader:
      - compute default range: [now - 12h, now)   (no wsStartTime wait anymore)
      - open /ws/data-stream immediately
      - send { type:"load", symbol, from_ms: now-12h, to_ms: now }
      - stream chunks as they arrive → prepend to tradeDots in order
      - on done: historyLoaded = true

   c. useOrderData:
      - sends { type:"get_orders", symbol } on /ws/ui open (and on symbol change)
      - receives { type:"order_data" } response → loads into orderStore via loadFromData()
      - live { type:"order_event" } pushed by server → applyLiveEvent()

4. [Optional: user opens date-range picker]
   - sends cancel for current load (if still in progress)
   - sends new load with [from_ms, to_ms) from the picker
   - UI enters dateRangeMode (auto-scroll off)
   - [← Live] button: cancel range load, restart default load with [now-12h, now)
```

---

## Implementation Phases

### Phase 1 — Session Persistence (small, safe, no backend)

**Files touched:** `chartStore.ts`  
**What:** Add `localStorage` read on init + write on `setActiveSymbol` / `addTab` / `removeTab`.  
No other changes.

### Phase 2 — Default Range-Based Load (no date picker yet)

**Files touched:**  
- `chart-ui-server/routers/data_stream.py` (new file)
- `chart-ui-server/main.py` (register new router)
- `chart-ui/src/components/chart/useHistoryLoader.ts` (switch to `/ws/data-stream`)

**What:**
- Replace `/ws/trade-loader` round-trip (wait for wsStartTime → load) with immediate
  `/ws/data-stream` load of `[now - 12h, now)`
- Backend: `DataStreamHandler` with immediate-stream path (no polling yet)
- Keep existing `/ws/trade-loader` alive in parallel for backwards compat during transition

### Phase 3 — Collector Integration + Polling  

**Files touched:**
- `chart-ui-server/routers/data_stream.py` (add poll loop)
- `collector/ws_server.py` (add `covered_from_ms` / `covered_to_ms` to `progress` events)
- `collector/market_data_loader.py` (emit progress with time bounds)

**What:**
- Add poll-on-missing path in `DataStreamHandler`
- Add time-bound progress events from Collector
- Add cancel propagation to Collector

### Phase 4 — Tab Switch → Cancel

**Files touched:**
- `chart-ui/src/components/chart/useHistoryLoader.ts` (send cancel on cleanup)
- No backend changes — cancel already supported in `CollectorClient`

### Phase 5 — Date-Range Picker UI

**Files touched:**
- `chartStore.ts` (add `dateRangeFrom`, `dateRangeTo`, `isDateRangeMode`)
- New component `DateRangePicker.tsx`
- `App.tsx` or `ChartCore.tsx` (mount DateRangePicker below Toolbar)
- `useHistoryLoader.ts` (support explicit `[from, to)` range)

**What:** The range picker sends the custom `[from_ms, to_ms)` instead of `[now-12h, now)`.
All backend streaming is already in place from Phase 2–3.

---

## Open Questions / Decisions Made

| Question | Decision |
|----------|----------|
| How to detect data consistency? | Collector reports `covered_to_ms` in progress events; backend only advances past data the Collector has confirmed written |
| What guarantees the Collector writes in ascending order? | Current implementation downloads front-to-back; document this as a requirement in collector/architecture.md |
| Max date range? | No hard cap on backend; Collector limits to 90 days (orderAmendment API limit). UI should reflect "Data available from: X" |
| Candle mode vs trades mode: does date range apply to both? | Phase 5 spec: trades mode only initially; candle mode uses KlineCharts native pagination which already handles this |
| Do we remove `/ws/trade-loader`? | Still present — can be removed once new path is validated in production |
| Where do scroll-back (pan left) requests go? | **`/ws/data-stream` (same persistent WS as the initial load).** REST scroll-back (`/api/agg-trades/before`) removed. A debounced viewport watcher (200ms poll, 1.5s idle threshold) detects when `viewport.fromTime` moves past `loadedFrom`, then sends a new `load` message on the open socket with 1h prefetch padding on the left edge. Backend cancels any in-flight coroutine and starts the new range. `loadedFrom` tracked in `ChartState`; gaps under 5min are skipped to avoid micro-requests. |

---

## Related Docs

- [docs/chart-ui-server/architecture.md](../chart-ui-server/architecture.md) — server component diagram
- [docs/collector/architecture.md](../collector/architecture.md) — collector internals
- [docs/features/order-visualization.md](order-visualization.md) — order events + amendment flow
