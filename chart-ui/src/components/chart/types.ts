import type { Chart, KLineData } from 'klinecharts';
import type { VolumeBar, Drawing, ChartMarker } from '../../types/chart';
import type { OrderTrace } from '../../types/orders';
import { LIVE_WINDOW_S } from './constants';

export type TradeDot = { time: number; value: number; color: string };

export interface ChartState {
  // KlineCharts instance (used in candle mode; null until chart is initialized)
  kchart: Chart | null;

  mode: 'trades' | 'candles';

  // Trade data — all times in milliseconds
  tradeDots: TradeDot[];
  lastTradeMs: number;
  volumeBuckets: Map<number, VolumeBar>;
  earliestTradeTime: number;  // ms, boundary for scroll-back fetch
  latestDBTradeTime: number;   // ms, boundary for forward gap-fill toward now
  wsStartTime: number;          // ms, timestamp of first WS trade (gap-fill target)

  // Viewport — both modes, times in ms
  viewport: { fromTime: number; toTime: number };

  autoScroll: boolean;
  dragging: boolean;
  vertPanOffset: number;  // price offset for vertical pan (trades mode)
  vertZoomFactor: number; // Y-axis zoom: >1 = zoomed in, <1 = zoomed out (trades mode)
  yAxisDragging: boolean; // true when drag started in Y-axis zone (trades mode)
  viewSpanMs: number;     // zoom level: fromTime = now - viewSpanMs  (autoScroll mode)

  // Computed price range for canvas Y-axis (set each render, read by useDrawings)
  priceMin: number;
  priceMax: number;

  // LOD cache
  lodCache: Map<number, TradeDot[]>;
  lodCacheBucketSpan: number;

  // Loaded range — ms timestamps of data we hold from the backend DB.
  // loadedFrom is updated on each successful load `done`; used to avoid
  // re-requesting already-covered range on viewport changes.
  loadedFrom: number;  // earliest ms we have DB data for (Infinity = nothing loaded)

  // Loading state
  loadingMore: boolean;
  historyLoaded: boolean;

  // Live bar callback injected by KlineCharts subscribeBar (candle mode)
  liveBarCallback: ((data: KLineData) => void) | null;

  // KlineCharts overlay IDs keyed by drawing ID (candle mode)
  kcOverlayIds: Map<string, string>;

  // Drawings snapshot — kept in sync with Zustand, read by canvasRenderer
  drawings: Drawing[];
  selectedDrawingId: string | null;

  // Markers — triangle arrows at specific time+price
  markers: ChartMarker[];

  // Canvas crosshair cursor position (CSS pixels, null when outside canvas)
  cursorX: number | null;
  cursorY: number | null;



  // Active ruler measurement (shift+drag) passed to canvasRenderer
  ruler: {
    startPrice: number; startTime: number;
    endPrice: number;   endTime: number;
  } | null;

  // Order traces — polylines for order lifecycle visualization
  orderTraces: OrderTrace[];

  // Loading progress: 0–100 percentage, null = not loading
  loadingProgress: number | null;
  // Label shown on the progress bar ("Loading" for chunks, "Syncing" for background)
  loadingLabel: string;
}

export function createInitialState(): ChartState {
  const now = Date.now();
  return {
    kchart: null,
    mode: 'candles',
    tradeDots: [],
    lastTradeMs: 0,
    volumeBuckets: new Map(),
    earliestTradeTime: Infinity,
    latestDBTradeTime: 0,
    wsStartTime: 0,
    viewport: {
      fromTime: now - LIVE_WINDOW_S * 1000,
      toTime: now + LIVE_WINDOW_S * 1000 * 0.25,
    },
    autoScroll: true,
    dragging: false,
    vertPanOffset: 0,
    vertZoomFactor: 1.0,
    yAxisDragging: false,
    viewSpanMs: LIVE_WINDOW_S * 1000,
    priceMin: 0,
    priceMax: 1,
    lodCache: new Map(),
    lodCacheBucketSpan: 0,
    loadedFrom: Infinity,
    loadingMore: false,
    historyLoaded: false,
    liveBarCallback: null,
    kcOverlayIds: new Map(),
    drawings: [],
    selectedDrawingId: null,
    markers: [],
    cursorX: null,
    cursorY: null,
    ruler: null,
    orderTraces: [],
    loadingProgress: null,
    loadingLabel: 'Loading',
  };
}
