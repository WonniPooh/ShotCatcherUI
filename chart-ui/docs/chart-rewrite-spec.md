# Chart UI — Rewrite Spec (KlineCharts)

Reference for rewriting `controller/chart-ui` from scratch using KlineCharts instead of LWC.

---

## Goals

- Replace LWC with KlineCharts (native ms timestamps, built-in drawing tools)
- Trades mode: pure canvas overlay for dot rendering, KlineCharts Y-axis and pan/zoom
- Candles mode: KlineCharts native OHLCV + volume histograms
- Eliminate: hidden line series, `as unknown as Time` casts, `allLineDataRef` duplicate, 1µs offset hacks

---

## Data Sources (keep as-is)

All data comes direct from Binance — no backend.

| Source | URL | Usage |
|--------|-----|-------|
| REST recent trades | `https://api.binance.com/api/v3/trades?symbol=X&limit=1000` | Initial load in trades mode |
| REST older trades | `https://api.binance.com/api/v3/aggTrades?symbol=X&endTime=T&limit=1000` | Scroll-back pagination |
| REST klines | `https://api.binance.com/api/v3/klines?symbol=X&interval=I&limit=500` | Initial load in candle mode |
| WS trades | `wss://stream.binance.com:9443/ws/{symbol}@trade` | Live trades |
| WS klines | `wss://stream.binance.com:9443/ws/{symbol}@kline_{interval}` | Live candles |

---

## Two Rendering Modes

### Trades Mode (`timeframe === 'trades'` or `'1s'`)

Each individual trade is a colored dot:
- **Green** = buyer is taker (`isBuyerMaker = false`) — price went up
- **Red** = buyer is maker (`isBuyerMaker = true`) — price went down

Dots are connected by a thin gray line (`#888888`).

KlineCharts role: provide Y-axis, price scale, pan/zoom, drawing tools.  
Canvas overlay role: render dots + connecting line + time-proportional X-axis grid/labels.

**Dot radius:** 2.5 CSS px (5px diameter) — LWC setMarkers had a min-size floor which is why we did canvas; KlineCharts custom overlay won't have this problem.

### Candles Mode (all other timeframes)

Standard OHLCV candlestick chart. KlineCharts handles this natively — no canvas overlay needed.

Volume histogram below candles (split pane):
- Total volume bar (semi-transparent, green/red based on buy dominance)
- Buy-only volume bar on top (more opaque green)

---

## Live Viewport Behavior

### Live Mode (autoScroll = true)

The viewport scrolls in **real time** driven by wall clock, not by trade arrival.

```
fromTime = now - 600s    (10 minutes of history)
toTime   = now + 150s    (25% right margin — live price at ~80% of width)
```

This is recalculated every rAF frame so the chart scrolls at constant speed regardless of trade frequency.

### Browse Mode (autoScroll = false)

User has panned/zoomed away from live edge. Chart freezes — no viewport updates. New trades still accumulate in the buffer but don't move anything.

Going back to live: Toolbar dispatches `chart:goLive` event → reset vertical pan, resync data, scroll to live edge.

---

## Canvas Overlay (Trades Mode)

Trade dots are rendered on a `<canvas>` layered on top of the KlineCharts DOM element.  
KlineCharts owns pan/zoom/Y-axis/drawing tools; the canvas owns dot rendering.

### Coordinate System

```
toX(t) = ((t - fromTime) / viewSpan) * paneWidth   // time (ms) → X pixel

// Y: ask KlineCharts directly — no hidden series needed
const { x, y } = chart.convertToPixel(
  { timestamp: tradeMs, value: price },
  { paneId: 'candle_pane', absolute: true }
)
```

`convertToPixel` replaces LWC's `series.priceToCoordinate()`. No hidden series, no `as unknown as Time`.

### LOD (Level of Detail)

When there are more dots than `paneWidth * 2` pixels, bucket them:

1. Compute `bucketTimeSpan = viewSpan / paneWidth` snapped to nearest power-of-10 (prevents boundary shift as viewSpan grows)
2. Per bucket: keep only min-value dot (red) and max-value dot (green)
3. Sort bucket result by time

**Cache:** Buckets older than 60s are stable — cache them in `lodCache: Map<bucketStart, dot[]>`. Invalidate entire cache when `bucketTimeSpan` changes by >1% (zoom event).

### 2-Layer Compositing

**Historical layer** (dots older than 60s):
- Rendered to an offscreen `histCanvas`
- Only redrawn when viewport fingerprint changes (`"fromTime|toTime|w|h"`)
- Blitted to main canvas every frame via `drawImage` (identity transform, device-pixel coords)

**Recent layer** (last 60s):
- Always redrawn every frame
- Boundary dot shared between layers for continuous connecting line

This keeps historical dots pixel-stable even at 1000+ trades/minute.

### Time Labels (X-axis)

Canvas renders its own X-axis at bottom (`X_AXIS_HEIGHT = 22px`):
- Grid lines at "nice" intervals: `[0.001, 0.01, 0.1, 1, 5, 10, 30, 60, 300, 600, 1800, 3600, ...]`
- Target ~8 labels across the pane
- Format: `HH:MM:SS` for ≥1s intervals, `HH:MM:SS.mmm` for sub-second

---

## State Architecture

Single `ChartState` mutable ref object shared across all hooks — avoids prop-drilling 20+ individual `useRef`s:

```ts
interface ChartState {
  chart, lineSeries, candleSeries, volumeSeries, buyVolSeries
  mode: 'trades' | 'candles'
  tradeDots: TradeDot[]         // { time: ms, value: price, color }  ← ms now!
  allLineData: LineDataPoint[]  // { time: ms, value: price }         ← ms now!
  lastTradeTime: number         // ms
  volumeBuckets: Map<number, VolumeBar>
  earliestTradeTime: number     // ms boundary for scroll-back fetch
  loadingMore, historyLoaded, dragging
  vertPanOffset: number
  lodCache, lodCacheBucketSpan
  histCanvas, histCanvasKey
  lastViewportScroll: number
  liveViewport: { fromTime: number; toTime: number } | null  // ms
  autoScroll: boolean
  priceLineMap: Map<string, OverlayHandle>
}
```

**Note:** In the new implementation, all times are **milliseconds** throughout. No division by 1000, no `as unknown as Time`.

---

## Zoom & Pan

### Wheel handler (capture phase, before KlineCharts sees it)

**Vertical scroll → zoom** (cursor-centered):
```
base = 1.02 + 0.04 * min(1, logicalSpan / 500)   // adaptive: gentler when zoomed in tight
zoomFactor = deltaY > 0 ? base : 1/base
newSpan = clamp(logicalSpan * zoomFactor, 3 bars, 12h worth of bars)
```

**Horizontal scroll → pan** → disables autoScroll.

### Vertical drag → price offset

LWC: used `autoscaleInfoProvider` with `vertPanOffset`.  
KlineCharts: use `chart.setPriceVolumePrecision` / `setOffsetRightDistance` … or keep canvas-side offset in Y coordinate math.

---

## Y-Axis (Trades Mode)

In live mode: scan visible window (`now - 600s` to `now`) for min/max price, add 15% buffer each side.  
In browse mode: KlineCharts natural auto-scale + `vertPanOffset` applied.

```
span = hi - lo  (or |lo| * 0.01 or 1 if flat)
visibleMin = lo - span * 0.15
visibleMax = hi + span * 0.15
```

---

## Drawing Tools

Keep via **KlineCharts built-in overlays**:
- `horizontalStraightLine` → replaces our `hline`
- `segment` → replaces our `segment`
- `priceLine` → price annotation

KlineCharts has built-in keyboard Delete for removing selected overlay — likely covers our current Delete-key handler.

### Measurement Tool (Shift+drag)

Current: custom shift+mousedown/mousemove draws a bounding box, displays `±X.XXX% | Ys`.  
New: implement as a KlineCharts custom overlay (`totalStep: 3`, two points → rectangle + label) using `createPointFigures`.

---

## Scroll-Back Pagination (Trades Mode)

Trigger: visible left edge approaches `earliestTradeTime`.

```
leftEdgeMs < earliestTradeTime + 5000ms → fetch more
```

Fetch: `fetchOlderTrades(symbol, earliestTradeTime - 1, 1000)` → prepend to `tradeDots`.

After prepend: fix any non-ascending timestamps across the join point (`+0.1ms` offset).

KlineCharts `getBars` with `type: 'forward'` callback is the natural hook for this.

---

## Volume (Both Modes)

Aggregated per whole second (`Math.floor(tradeTimeMs / 1000) * 1000`).

Per bucket stored as `{ time, value: totalVol, buyVolume, sellVolume, color }`.  
Color: green if `buyVolume >= sellVolume`, else red.

Chart display:
- Total volume: 80% opacity
- Buy volume: overlaid at ~80% opacity green

---

## Constants

```ts
GREEN = '#22c55e'
RED   = '#ef4444'
BG    = '#0f1117'
GRID  = '#1e2030'
TEXT  = '#94a3b8'
DOT_RADIUS    = 2.5   // CSS px
X_AXIS_HEIGHT = 22    // CSS px (canvas bottom label strip)
LIVE_WINDOW   = 600   // seconds shown in live mode
LIVE_Y_BUFFER = 0.15  // 15% padding above/below price range
STABLE_LAG    = 60    // seconds — historical layer cutoff
```

---

## File Structure (proposed, rewrite)

```
src/
├── components/
│   ├── chart/
│   │   ├── constants.ts
│   │   ├── types.ts               // ChartState, TradeDot, etc.
│   │   ├── utils.ts               // bisectLeft, formatTime, chooseTickInterval
│   │   ├── overlays/
│   │   │   ├── tradeDots.ts       // KlineCharts custom overlay for dot rendering
│   │   │   └── measurement.ts     // Shift+drag measurement overlay
│   │   ├── useChartInstance.ts    // chart init, wheel/pointer events, rAF loop
│   │   ├── useSeriesManager.ts    // mode switch (trades/candles), volume pane
│   │   ├── useHistoryLoader.ts    // setDataLoader (getBars + subscribeBar)
│   │   ├── useTradeUpdates.ts     // live trade/kline handlers
│   │   ├── useDrawings.tsx        // drawing tool state, keyboard shortcuts
│   │   └── ChartCore.tsx          // orchestrator (~40 lines)
│   ├── SymbolTabs.tsx
│   └── Toolbar.tsx
├── hooks/
│   ├── useBinanceStream.ts        // WS + REST data fetching (keep as-is)
│   └── useKeyboard.ts             // keep as-is
├── store/
│   └── chartStore.ts              // Zustand (keep as-is)
└── types/
    └── chart.ts                   // keep as-is (RawTrade, BinanceKline, etc.)
```

---

## What to Keep Unchanged

- `useBinanceStream.ts` — data fetching hooks work fine
- `useKeyboard.ts` — keyboard hooks work fine
- `store/chartStore.ts` — Zustand store works fine
- `types/chart.ts` — type definitions fine
- `SymbolTabs.tsx`, `Toolbar.tsx` — UI components fine
- CSS / Tailwind setup

---

## KlineCharts Key APIs to Use

```ts
import { init, registerOverlay } from 'klinecharts'

const chart = init(container)
chart.setStyles({ ... })           // theme / colors
chart.setSymbol({ ticker: 'BTCUSDT' })
chart.setPeriod({ span: 1, type: 'minute' })
chart.setDataLoader({ getBars, subscribeBar, unsubscribeBar })

// Overlays
chart.createOverlay('horizontalStraightLine')
chart.createOverlay({ name: 'tradeDots' })
chart.removeOverlay()
chart.overrideOverlay({ ... })

// Coordinate conversion (for canvas overlay Y)
chart.convertToPixel({ value: price }, { paneId: 'candle_pane', absolute: true })

// Scroll/zoom
chart.scrollToTimestamp(timestamp)
chart.zoomAtTimestamp(scale, timestamp)
chart.scrollToDataIndex(index)
```
