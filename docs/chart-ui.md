# Chart UI — Live Trading Chart

**Status:** 🚧 IN PROGRESS  
**Date:** 2026-04-01  
**Last Updated:** 2026-04-01  

---

## Overview

Web-based real-time trading chart for ShotCatcher. Connects directly to Binance WebSocket
streams for live market data (trades + klines). Built with React + TypeScript + TradingView
Lightweight Charts v4. Designed for per-trade analysis with ms-level zoom and extensible
indicator/overlay architecture.

Located in `controller/chart-ui/`.

---

## Features

### Chart Display
- **Candlestick chart** with green (buy) / red (sell) coloring
- **Price scale** on right axis
- **Time scale** at bottom with seconds/ms visibility at high zoom
- **Volume histogram** at bottom with buy/sell split (buy volume stacked on top of
  total volume, green overlay on semi-transparent base)

### Symbol Management
- **Tab bar** at top for quick symbol switching (BTC, ETH, SOL default)
- **+ button** opens searchable symbol dropdown
- Symbol list fetched from Binance `GET /api/v3/exchangeInfo` (USDT pairs, sorted)
- Tabs closeable (×), minimum 1 tab always visible
- Filter/search by typing symbol name

### Timeframe Selection
- Dropdown with: `trades`, `1s`, `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`
- `trades` and `1s` modes: raw trades aggregated into 1-second candles
- Other timeframes: standard Binance kline intervals
- Switching timeframe reloads historical data + reconnects WS stream

### Navigation & Zoom
- **Two-finger horizontal swipe** (touchpad): pan chart left/right
- **Two-finger vertical swipe** (touchpad): zoom in/out
- **Mouse wheel**: zoom
- **Click + drag**: pan
- **Pinch** (touch devices): zoom
- Auto-scroll to latest data when "Live" mode is active

### Measurement Tool
- **Shift + left-click drag**: creates a measurement overlay
- Shows percentage change (vertical) and time duration (horizontal)
- Yellow dashed border with label showing `+X.XXX% | Xs`
- Measurement clears when Shift is released

### Drawing Tools
- **Horizontal Line**: price level line (yellow dashed), visible on price axis
- **Ruler**: measurement from point A to point B (planned — same as shift+drag)
- **Segment**: line segment between two points (planned)
- **Select + Del**: delete any drawing; click drawing to select, press Delete key
- Tools toggled from toolbar (blue highlight when active)

### Live Data
- Binance WebSocket: `@trade` stream for trades mode, `@kline_<interval>` for candle modes
- Auto-reconnect on disconnect (2s delay)
- Historical data loaded on symbol/timeframe change:
  - Trades mode: `GET /api/v3/trades` (last 1000)
  - Kline mode: `GET /api/v3/klines` (last 500 candles)
- Live updates via `series.update()` — no full redraws

---

## Data Architecture

```
Binance WS  ──→  useBinanceStream hook  ──→  ChartCore component
                  │                            │
                  ├─ @trade stream ────────→ aggregate into 1s candles
                  └─ @kline stream ────────→ update candle directly
                                               │
                                          Lightweight Charts
                                          ├─ CandlestickSeries
                                          ├─ HistogramSeries (total vol)
                                          └─ HistogramSeries (buy vol)
```

### State Management
- **Zustand store** (`chartStore.ts`): active symbol, tabs, timeframe, drawings,
  auto-scroll, indicators list, measurement state
- No TanStack Query yet (direct Binance API calls for now)
- WebSocket managed per-component via `useBinanceStream` hook

---

## Configuration

No config files needed — the chart UI connects directly to Binance public APIs.

**Dev server:** `npm run dev` from `controller/chart-ui/` → http://localhost:5173

**Build:** `npm run build` → outputs to `controller/chart-ui/dist/`

**Proxy config** (vite.config.ts): `/api` and `/ws` proxied to `localhost:8080`
(FastAPI controller) for future integration.

---

## Extensibility

### Adding Indicators
1. Add indicator name to `indicators` array in Zustand store
2. Create a component in `components/indicators/` that subscribes to chart data
3. Add series to the chart via `chart.addLineSeries()` etc.
4. Register in toolbar dropdown

### Adding Drawing Tools
1. Add type to `DrawingType` union in `types/chart.ts`
2. Add click handler in `ChartCore` that creates a `Drawing` object
3. Render on chart (price lines for horizontal, custom rendering for segments)

### Adding Overlays (bot events, trade markers)
1. Use `SeriesMarker<Time>` for point markers (entry/exit arrows)
2. Use `createPriceLine()` for level lines (SL/TP)
3. Wire to controller WS events when integrated

---

## File Structure

```
controller/chart-ui/
├── index.html
├── vite.config.ts            # Vite + React + Tailwind, proxy config
├── package.json
├── src/
│   ├── main.tsx              # Entry point
│   ├── index.css             # Tailwind import + base styles
│   ├── App.tsx               # Root layout: tabs + toolbar + chart
│   ├── components/
│   │   ├── ChartCore.tsx     # Main chart: LWC setup, data, live updates, measurement
│   │   ├── SymbolTabs.tsx    # Tab bar + symbol search dropdown
│   │   └── Toolbar.tsx       # Timeframe dropdown, drawing tools, live toggle
│   ├── hooks/
│   │   ├── useBinanceStream.ts  # Binance WS connection + REST data fetchers
│   │   └── useKeyboard.ts      # Shift key + Delete key handlers
│   ├── store/
│   │   └── chartStore.ts     # Zustand store (symbols, timeframe, drawings, etc.)
│   └── types/
│       └── chart.ts          # TypeScript interfaces
```

---

## Corner Cases

- **Symbol with low volume**: 1-second candles may have gaps; chart handles sparse data
- **WS disconnect**: auto-reconnect after 2s; no data loss indicator yet (planned)
- **Rapid timeframe switching**: previous data cleared immediately, new load may flash
- **Measurement at chart edges**: coordinates may be null; silently ignored
- **exchangeInfo fetch failure**: symbol dropdown shows empty with "No matches"

---

## Future Work

- [ ] Integration with controller WS for bot event overlays (fills, SL/TP lines)
- [ ] Trade markers (entry = green arrow, exit = red arrow)
- [ ] Segment and ruler drawing tools (currently stubs)
- [ ] Web Worker for tick buffering at high trade rates
- [ ] Server-driven viewport pagination (request only visible range from controller)
- [ ] Historical session replay with scrubber
- [ ] Indicator framework (MA, RSI, etc.)
- [ ] Build output served from FastAPI as static files

---

## Related Docs

- [UI Stack Decisions](../controller/ui-stack.md) — tech stack rationale
- [Control WS Protocol](../controller/control-ws-protocol.md) — bot event integration
- [Architecture](../design/architecture.md) — system overview
