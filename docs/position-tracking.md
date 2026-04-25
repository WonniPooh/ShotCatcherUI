# Position Tracking

**Status:** ✅ IMPLEMENTED (core reconstruction + DB + API)  
**Date:** 2026-04-21  
**Last Updated:** 2026-04-21  

---

## Overview

Reconstructs closed trading positions from user trade fills. One-way mode only (position_side=BOTH). Uses FIFO for matching entry/exit fills. Positions are stored in per-symbol `positions.db` and served via REST API.

## How It Works

### Reconstruction Algorithm

1. Process `user_trade` rows in `trade_time_ms` ascending order
2. Track running position: signed qty (+LONG / -SHORT), entry fills list
3. When a trade is in the same direction → adds to position
4. When a trade is in the opposite direction:
   - **Partial close**: reduces qty, consumes entry fills FIFO
   - **Full close** (qty matches): emits closed position record, resets state
   - **Flip** (qty exceeds): closes current position, opens new in opposite direction with remainder

### Data Sources

| Source | Table | Fields Used |
|--------|-------|-------------|
| WS ORDER_TRADE_UPDATE (TRADE) | `user_trade` | side, price, qty, commission, realized_pnl, order_id, trade_time_ms |
| REST `userTrades` | `user_trade` | Same fields (REST sync fills gaps) |

### Position Record

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | TEXT | e.g. BTCUSDT |
| `side` | TEXT | LONG / SHORT |
| `entry_price` | REAL | Qty-weighted avg of entry fills |
| `exit_price` | REAL | Qty-weighted avg of exit fills |
| `quantity` | REAL | Total position size |
| `realized_pnl` | REAL | Sum of Binance-reported PnL from exit fills |
| `pnl_pct` | REAL | `(pnl / entry_notional) * 100` |
| `fee_total` | REAL | Sum of commissions from all fills |
| `entry_time_ms` | INTEGER | First entry fill timestamp |
| `exit_time_ms` | INTEGER | Last exit fill timestamp |
| `entry_order_ids` | TEXT | JSON array of unique entry order IDs |
| `exit_order_ids` | TEXT | JSON array of unique exit order IDs |
| `duration_ms` | INTEGER | exit_time - entry_time |

## Storage

Per-symbol: `db_files/<SYMBOL>/positions.db`

```sql
CREATE TABLE position (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol, side, entry_price, exit_price, quantity,
    realized_pnl, pnl_pct, fee_total,
    entry_time_ms, exit_time_ms,
    entry_order_ids, exit_order_ids, duration_ms
);
CREATE INDEX idx_pos_symbol_time ON position(symbol, exit_time_ms);
CREATE INDEX idx_pos_exit_time ON position(exit_time_ms);
```

## API

| Endpoint | Method | Params | Description |
|----------|--------|--------|-------------|
| `/api/positions` | GET | `symbol` (required), `since_ms`, `limit` | Positions for one symbol |
| `/api/positions/all` | GET | `since_ms`, `limit` | Positions across all symbols |

Both return `exit_time_ms DESC` ordered arrays.

## Architecture

```
data_manager/position_manager/
├── __init__.py
├── position_db_manager.py      # PositionDB — SQLite CRUD
├── position_tracker.py         # reconstruct_positions() — pure function
└── position_service.py         # PositionService — DB + reconstruction orchestrator

chart-ui-server/routers/positions.py  # REST API endpoints
```

## Corner Cases

| Scenario | Behavior |
|----------|----------|
| Floating point qty mismatch | Uses 1e-8 epsilon for full-close detection |
| Position flip (BUY then larger SELL) | Closes current, opens new with remainder |
| Multiple fills on same order | Tracked as single entry/exit order ID |
| Open position (no close yet) | Not emitted — only closed positions stored |
| Zero-volume trades | Treated normally (rare edge case) |
| Binance-reported PnL available | Used directly (more accurate than price calc) |
| Binance PnL missing (=0) | Fallback: `(exit - entry) * qty` for LONG, inverse for SHORT |

## Testing

22 tests in `chart-ui-server/tests/test_positions.py`:

| Category | Count | Tests |
|----------|-------|-------|
| Reconstruction | 14 | simple long/short, multiple fills, partial close, flip, pnl%, loss, add-to-position |
| PositionDB | 5 | insert/query, last exit time, since_ms filter, count, limit |
| Integration | 1 | Reconstruct → persist → query full flow |
| API | 2 | Single-symbol + all-symbols endpoints |

Run: `cd chart-ui-server && python -m pytest tests/test_positions.py -v`

## Future: Live Position Tracking

The collector will be extended to:
1. On each TRADE event, check if position closed → write to `positions.db`
2. Forward `position_closed` event via Collector WS → chart-ui-server → frontend
3. On startup, gap-fill from last `exit_time_ms` in positions.db

The `position_closed` event type is already registered in:
- `chart-ui-server/collector_client.py` (_FORWARD_TYPES)
- `chart-ui-server/routers/ws_ui.py` (symbol-specific broadcast)
