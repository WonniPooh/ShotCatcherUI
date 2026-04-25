# Closed Trades Sidebar

**Status:** ✅ IMPLEMENTED  
**Date:** 2025-07-21  
**Last Updated:** 2025-07-21  

---

## Overview

Right-side panel in the chart UI showing closed trading positions with PnL, duration, and price ranges. Clicking a position card navigates the chart to that trade's entry time, including cross-symbol navigation. The panel is toggled via toolbar buttons and is mutually exclusive with the Open Orders panel.

## How It Works

### Data Flow

```text
Backend positions.db → GET /api/positions/all → positionStore → ClosedTradesPanel
                                                                        ↓
                                                              Click → navigate chart
```

1. User clicks the 📋 **Trades** button in the Toolbar
2. `chartStore.sidebarPanel` toggles to `'closedTrades'`
3. `App.tsx` renders `<ClosedTradesPanel>` in a flex sidebar (280px fixed width)
4. Panel fetches `GET /api/positions/all?since_ms=<now-period>&limit=500` on mount
5. Positions display as scrollable cards with PnL coloring
6. Auto-refreshes every 30 seconds

### Click-to-Navigate

When a position card is clicked:

1. **Same symbol** — dispatches `chart:navigateTo` custom event with `{ ts: entry_time_ms }`
2. **Different symbol** — adds the symbol tab if needed, sets `pendingNavigation` in chartStore, then switches `activeSymbol`. ChartCore consumes the pending navigation after mount (Phase 5 tie-in).

### Position Card Display

| Field | Format | Example |
|-------|--------|---------|
| Symbol | Plain text | `BTCUSDT` |
| Side | Color badge (green/red) | `LONG` / `SHORT` |
| PnL % | Signed percentage | `+2.30%` / `-0.80%` |
| PnL USD | Dollar amount | `+$45.20` / `-$12.10` |
| Entry → Exit | Price range | `64,230.50 → 64,520.10` |
| Time | HH:MM → HH:MM | `12:30 → 12:45` |
| Duration | Smart format | `15m`, `2h 30m`, `45s` |

### Smart Duration Format

- `< 1s` → `234ms`
- `1s–59s` → `45s`
- `1m–59m` → `12m 30s` (seconds omitted if 0)
- `1h+` → `2h 15m` (minutes omitted if 0)

### Summary Bar

When positions exist, a summary bar shows:
- Total PnL (colored green/red)
- Win/Loss count with win rate percentage

## Configuration

### Period Options

Users can filter positions by time period via buttons in the panel header:

| Period | Description |
|--------|-------------|
| 15m | Last 15 minutes |
| 1h | Last hour |
| 3h | Last 3 hours |
| 6h | Last 6 hours |
| 12h | Last 12 hours |
| 1d | Last 24 hours (default) |
| 2d | Last 2 days |
| 3d | Last 3 days |
| 7d | Last 7 days |

## Layout

```text
┌──────────────────────────────────────────────────────────┐
│ SymbolTabs                                               │
├──────────────────────────────────────────────────────────┤
│ Toolbar [...tools...]    hint    │ [📋 Trades] [📊 Orders] │
├──────────────────────────────┬───────────────────────────┤
│                              │ Closed Trades   12 trades │
│       Chart Area             │ [15m][1h][3h]...[7d]      │
│       (flex-1)               │ +$123.45  8W / 4L (67%)   │
│                              │─────────────────────────  │
│                              │ BTCUSDT   LONG             │
│                              │ +2.30%        +$45.20      │
│                              │ 64,230 → 64,520            │
│                              │ 12:30→12:45       15m      │
│                              │─────────────────────────  │
│                              │ ...scrollable...           │
└──────────────────────────────┴───────────────────────────┘
```

- Panel width: 280px fixed
- Chart area: `flex-1` (shrinks to accommodate panel)
- Toolbar toggle buttons: right-aligned after shift hint
- Panels are **mutually exclusive** — opening one closes the other

## Corner Cases & Error Handling

### Case: No positions in period
- **Trigger:** Selected period has no closed trades
- **Behavior:** Shows "No closed trades in this period" message
- **Rationale:** Clear feedback; user can select a longer period

### Case: API error
- **Trigger:** Backend unreachable or returns error
- **Behavior:** Shows error message in panel, keeps previous data if any
- **Rationale:** Graceful degradation

### Case: Live position arrives via WS
- **Trigger:** `position_closed` event forwarded from collector
- **Behavior:** `applyLivePosition()` inserts at top of list, deduplicates by ID, filters by period window
- **Rationale:** Real-time updates without full reload

### Case: Cross-symbol navigation
- **Trigger:** Click position card for a different symbol than active
- **Behavior:** Auto-adds symbol tab, sets pending navigation, switches active symbol
- **Rationale:** Seamless cross-symbol trade review

### Case: Panel toggle while loading
- **Trigger:** User closes panel while positions are loading
- **Behavior:** Component unmounts, fetch completes but state update is harmless (zustand persists)
- **Rationale:** No cleanup needed; zustand operates outside React lifecycle

## Files

| File | Purpose |
|------|---------|
| `chart-ui/src/components/ClosedTradesPanel.tsx` | Panel component with position cards |
| `chart-ui/src/store/positionStore.ts` | Zustand store — fetch, cache, live updates |
| `chart-ui/src/types/positions.ts` | TypeScript interfaces |
| `chart-ui/src/store/chartStore.ts` | Sidebar panel state, pending navigation |
| `chart-ui/src/components/Toolbar.tsx` | Toggle buttons for sidebar panels |
| `chart-ui/src/App.tsx` | Layout with conditional sidebar |

## Testing

### Unit Tests (vitest)

| Test | File | What it verifies |
|------|------|-----------------|
| `starts with empty state` | `__tests__/positionStore.test.ts` | Initial store state |
| `clear resets all state` | `__tests__/positionStore.test.ts` | Clear action |
| `loadPositions fetches all` | `__tests__/positionStore.test.ts` | Fetch all positions via /all endpoint |
| `loadPositions single symbol` | `__tests__/positionStore.test.ts` | Fetch with symbol param |
| `loadPositions HTTP error` | `__tests__/positionStore.test.ts` | Error handling for HTTP errors |
| `loadPositions network error` | `__tests__/positionStore.test.ts` | Error handling for network failures |
| `setPeriod triggers reload` | `__tests__/positionStore.test.ts` | Period change auto-fetches |
| `applyLivePosition adds new` | `__tests__/positionStore.test.ts` | Live position insertion |
| `applyLivePosition dedup` | `__tests__/positionStore.test.ts` | Duplicate rejection by ID |
| `applyLivePosition outside window` | `__tests__/positionStore.test.ts` | Filters old positions |
| `applyLivePosition insert order` | `__tests__/positionStore.test.ts` | Most recent first |
| `PERIOD_OPTIONS ascending` | `__tests__/positionStore.test.ts` | Options validation |
| `sidebarPanel toggle` | `__tests__/chartStoreSidebar.test.ts` | Mutual exclusivity |
| `pendingNavigation` | `__tests__/chartStoreSidebar.test.ts` | Navigation state |

**Test count:** 18 tests (12 positionStore + 6 chartStoreSidebar)

## Related

- [position-tracking.md](position-tracking.md) — Backend position reconstruction
- [security-auth.md](security-auth.md) — Auth required for API access
- [service-platform-plan.md](../chart-ui-server/service-platform-plan.md) — Overall plan (Phase 3)
