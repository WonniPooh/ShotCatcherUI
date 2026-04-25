# Open Orders Sidebar

**Status:** ✅ IMPLEMENTED  
**Date:** 2026-04-21  
**Last Updated:** 2026-04-21  

---

## Overview

Right-side panel showing live open orders across ALL symbols via WebSocket. Orders update in real-time as new orders are placed, modified, partially filled, or canceled. The panel uses the existing `/ws/ui` WebSocket connection — no REST endpoints, no additional connections.

## How It Works

### Data Flow

```text
Collector → order_event push → CollectorClient
    → broadcast_to_browsers (all clients, not symbol-filtered)
        → useOrderData WS consumer
            → openOrderStore.applyLiveEvent()
            → orderStore.applyLiveEvent() (active symbol only, for chart)

Browser → {type: "get_all_open_orders"} via /ws/ui
    → ws_ui.py scans all db_files/<SYMBOL>/order_events.db
        → returns deduplicated open orders across all symbols
            → openOrderStore.loadAll()
```

### Key Design Decisions

1. **All data via WS** — no REST endpoints for open orders. Uses the existing `/ws/ui` connection.
2. **`order_event` broadcasts to ALL clients** — removed from symbol-specific filter. The frontend handles filtering (chart: active symbol only; sidebar: all symbols).
3. **Deduplication** — `_collect_all_open_orders` returns only the latest event per `order_id` (highest `transaction_time_ms`).
4. **Live updates** — `applyLiveEvent()` adds new orders, updates existing, and removes terminal orders (FILLED, CANCELED, EXPIRED, REJECTED).

### WS Protocol Extension

```
Browser → Server:
  { "type": "get_all_open_orders" }
    → { "type": "all_open_orders", "orders": [...] }
```

### Order Card Display

| Field | Format | Example |
|-------|--------|---------|
| Symbol | Plain text | `BTCUSDT` |
| Side | Color badge (green/red) | `BUY` / `SELL` |
| Type | Short code + color | `LMT` (blue), `STOP` (orange), `TP` (green) |
| Price | Formatted with precision | `64,230.50` |
| Quantity | With filled amount if partial | `0.001 (0.0005 filled)` |
| Price Δ | % from current (active symbol only) | `+0.45%` |
| Time | Relative time | `2h 15m ago` |
| Reduce-only | Flag if applicable | `reduce` |

### Price Delta Logic

- Shown only for orders on the active symbol (where live price is available)
- Delta = `(currentPrice - orderPrice) / orderPrice × 100%`
- Color: green = price approaching order fill level, yellow = moving away
- Cross-symbol orders show no delta (would require additional WS subscriptions)

### Grouping

Orders are grouped in the panel:
1. **Active symbol orders** — shown first with section header, includes price delta
2. **Other symbols** — grouped under "Other symbols" header, no price delta

## Layout

Same sidebar slot as Closed Trades panel (280px, mutually exclusive toggle). The 📊 Orders button in the Toolbar toggles this panel.

## Corner Cases & Error Handling

### Case: Order filled while panel is open
- **Trigger:** Live `order_event` with `order_status: FILLED`
- **Behavior:** `applyLiveEvent()` removes the order from the list immediately
- **Rationale:** Real-time accuracy — user sees orders disappear as they fill

### Case: Order modified (amendment)
- **Trigger:** Live `order_event` with `execution_type: AMENDMENT`
- **Behavior:** `applyLiveEvent()` updates the order's price/qty in place
- **Rationale:** Shows current state, not historical

### Case: No order_events.db for a symbol
- **Trigger:** Symbol directory exists but no DB file
- **Behavior:** Silently skipped by `_collect_all_open_orders`
- **Rationale:** Not all symbols have order history

### Case: Multiple event rows for same order_id
- **Trigger:** Order has NEW + partial TRADE events in DB
- **Behavior:** Deduplication keeps only the latest `transaction_time_ms` row
- **Rationale:** Panel needs current state, not history

### Case: WS reconnect
- **Trigger:** Browser reconnects to `/ws/ui`
- **Behavior:** `onopen` sends `get_all_open_orders` alongside `get_orders`, refreshing both stores
- **Rationale:** Ensures consistency after network interruption

## Files

| File | Purpose |
|------|---------|
| `chart-ui-server/routers/ws_ui.py` | `get_all_open_orders` handler, `_collect_all_open_orders` helper, broadcast filter change |
| `chart-ui/src/store/openOrderStore.ts` | Zustand store — loadAll, applyLiveEvent, requestOpenOrders |
| `chart-ui/src/components/OpenOrdersPanel.tsx` | Panel component with order cards, grouping, price delta |
| `chart-ui/src/components/chart/useOrderData.ts` | WS consumer — forwards to openOrderStore |
| `chart-ui/src/App.tsx` | Renders panel when `sidebarPanel === 'openOrders'` |

## Testing

### Frontend Tests (vitest)

| Test | File | What it verifies |
|------|------|-----------------|
| `starts with empty state` | `__tests__/openOrderStore.test.ts` | Initial state |
| `clear resets state` | `__tests__/openOrderStore.test.ts` | Clear action |
| `loadAll populates` | `__tests__/openOrderStore.test.ts` | WS response loading + sort |
| `loadAll empty` | `__tests__/openOrderStore.test.ts` | Empty response handling |
| `applyLiveEvent adds new` | `__tests__/openOrderStore.test.ts` | New order insertion |
| `applyLiveEvent updates` | `__tests__/openOrderStore.test.ts` | Price/status update |
| `applyLiveEvent removes FILLED` | `__tests__/openOrderStore.test.ts` | Terminal removal |
| `applyLiveEvent removes CANCELED` | `__tests__/openOrderStore.test.ts` | Terminal removal |
| `applyLiveEvent removes EXPIRED` | `__tests__/openOrderStore.test.ts` | Terminal removal |
| `applyLiveEvent ignores unknown terminal` | `__tests__/openOrderStore.test.ts` | No false additions |
| `cross-symbol events` | `__tests__/openOrderStore.test.ts` | Multi-symbol handling |
| `inserts at beginning` | `__tests__/openOrderStore.test.ts` | Order preservation |

### Backend Tests (pytest)

| Test | File | What it verifies |
|------|------|-----------------|
| `test_empty_db_root` | `tests/test_open_orders_ws.py` | Empty directory |
| `test_nonexistent_db_root` | `tests/test_open_orders_ws.py` | Missing path |
| `test_single_symbol_single_open_order` | `tests/test_open_orders_ws.py` | Basic query |
| `test_skips_filled_orders` | `tests/test_open_orders_ws.py` | Terminal filtering |
| `test_skips_canceled_orders` | `tests/test_open_orders_ws.py` | Terminal filtering |
| `test_multiple_symbols` | `tests/test_open_orders_ws.py` | Cross-symbol scan |
| `test_deduplicates_same_order_id` | `tests/test_open_orders_ws.py` | Latest event dedup |
| `test_symbol_dir_without_db` | `tests/test_open_orders_ws.py` | Missing DB graceful skip |
| `test_partially_filled_order_is_open` | `tests/test_open_orders_ws.py` | Partial fill state |

**Test count:** 21 tests (12 frontend + 9 backend)

## Related

- [closed-trades-sidebar.md](closed-trades-sidebar.md) — Sibling sidebar panel
- [security-auth.md](security-auth.md) — Auth required for WS access
- [navigate-to-timestamp.md](navigate-to-timestamp.md) — Chart navigation from panels
- [service-platform-plan.md](../chart-ui-server/service-platform-plan.md) — Overall plan (Phase 4)
