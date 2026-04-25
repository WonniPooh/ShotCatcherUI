# Navigate to Timestamp

**Status:** ✅ IMPLEMENTED  
**Date:** 2026-04-21  
**Last Updated:** 2026-04-21  

---

## Overview

Chart navigation to a specific timestamp, triggered by clicking position cards in the Closed Trades sidebar or switching symbols. Supports both KlineCharts candle mode (`scrollToTimestamp`) and custom trades mode (viewport pan). Handles cross-symbol navigation via `pendingNavigation` in chartStore.

## How It Works

### Same-Symbol Navigation

1. User clicks a position card in ClosedTradesPanel
2. Panel dispatches `window.dispatchEvent(new CustomEvent('chart:navigateTo', { detail: { ts } }))`
3. `useChartInstance.ts` listener receives the event
4. Disables auto-scroll, resets vertical pan/zoom
5. In candle mode: `chart.scrollToTimestamp(ts / 1000)` (KlineCharts uses seconds)
6. In trades mode: centers viewport on `ts` with current zoom level

### Cross-Symbol Navigation

1. User clicks a position card for a different symbol
2. Panel auto-creates symbol tab if needed (`addTab`)
3. Sets `chartStore.pendingNavigation = { ts: entry_time_ms }`
4. Switches `activeSymbol` → triggers chart remount with new data
5. `useChartInstance.ts` on mount checks `pendingNavigation`
6. After 500ms delay (data loading), fires the same `onNavigateTo` handler
7. Clears `pendingNavigation`

### Event Flow

```text
ClosedTradesPanel click
    ├── Same symbol → CustomEvent('chart:navigateTo')
    │   → useChartInstance listener → scrollToTimestamp / viewport pan
    └── Different symbol → setPendingNavigation + setActiveSymbol
        → chart remount → consume pendingNavigation → navigateTo
```

## Configuration

No configuration needed. The feature is built into the chart rendering pipeline.

## Corner Cases & Error Handling

### Case: Navigate in candle mode to unloaded range
- **Trigger:** Click position from hours ago, KlineCharts may not have that data loaded
- **Behavior:** `scrollToTimestamp` scrolls to nearest loaded data point; KlineCharts' `getBars` callback may fetch more data via its data loader
- **Rationale:** KlineCharts handles lazy loading internally

### Case: Navigate in trades mode to unloaded range
- **Trigger:** Click position outside current viewport buffer
- **Behavior:** Viewport jumps to the timestamp; the existing scroll-back data loader in `useHistoryLoader` detects the gap and fetches missing data via `/ws/data-stream`
- **Rationale:** Trades mode viewport drives the data loader — moving viewport triggers loads automatically

### Case: Cross-symbol with slow data load
- **Trigger:** Switch to symbol with large DB, data takes >500ms to load
- **Behavior:** Navigation fires at 500ms, may land before data is fully rendered. User sees the correct time range once data arrives.
- **Rationale:** 500ms is a practical balance — most data loads complete within this window

### Case: Auto-scroll was active
- **Trigger:** User was in live-follow mode, then clicks a position card
- **Behavior:** Auto-scroll is disabled, chart pans to the historical position
- **Rationale:** Navigation is intentional user action that overrides live tracking

### Case: Panel closed during navigation
- **Trigger:** User closes sidebar while cross-symbol navigation is pending
- **Behavior:** `pendingNavigation` is still consumed by the chart instance; navigation completes regardless of panel visibility
- **Rationale:** The navigation action was already committed

## Files

| File | Purpose |
|------|---------|
| `chart-ui/src/components/chart/useChartInstance.ts` | `chart:navigateTo` listener, `pendingNavigation` consumer |
| `chart-ui/src/store/chartStore.ts` | `pendingNavigation` state, `setPendingNavigation` action |
| `chart-ui/src/components/ClosedTradesPanel.tsx` | Same-symbol event dispatch, cross-symbol setPendingNavigation |

## Testing

### Frontend Tests (vitest)

| Test | File | What it verifies |
|------|------|-----------------|
| `pendingNavigation can be set and cleared` | `__tests__/chartStoreSidebar.test.ts` | State management |
| `toggleSidebarPanel switches` | `__tests__/chartStoreSidebar.test.ts` | Panel toggle (navigation trigger) |

Navigation behavior is tested implicitly via integration — the custom event dispatch and consumption are wired in the chart lifecycle hooks. Manual testing verifies scroll behavior in both candle and trades modes.

## Related

- [closed-trades-sidebar.md](closed-trades-sidebar.md) — Primary navigation trigger
- [open-orders-sidebar.md](open-orders-sidebar.md) — Symbol switching (no timestamp navigation)
- [service-platform-plan.md](../chart-ui-server/service-platform-plan.md) — Overall plan (Phase 5)
