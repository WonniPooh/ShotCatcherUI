import { useEffect, useRef } from 'react';
import type { RefObject, MutableRefObject } from 'react';
import { init, dispose, type KLineData } from 'klinecharts';
import { useChartStore } from '../../store/chartStore';
import { fetchKlines } from '../../hooks/useBinanceStream';
import { GREEN, GRID_COLOR, TEXT_COLOR, Y_AXIS_WIDTH, X_AXIS_HEIGHT } from './constants';
import type { ChartState } from './types';
import { renderDotsCanvas } from './canvasRenderer';
import type { Period } from 'klinecharts';

// DEBUG: prove which version of renderDotsCanvas is loaded
console.log('[useChartInstance] renderDotsCanvas has markers?', renderDotsCanvas.toString().includes('markers'));
console.log('[useChartInstance] renderDotsCanvas has RENDER v2?', renderDotsCanvas.toString().includes('RENDER v2'));
console.log('[useChartInstance] renderDotsCanvas has MODULE LOADED?', renderDotsCanvas.toString().includes('MODULE LOADED'));
console.log('[useChartInstance] renderDotsCanvas length:', renderDotsCanvas.toString().length);
// Search for 'marker' section
const src = renderDotsCanvas.toString();
const markerIdx = src.indexOf('markers');
console.log('[useChartInstance] first "markers" at char:', markerIdx, 'context:', markerIdx > 0 ? src.slice(markerIdx, markerIdx + 100) : 'NOT FOUND');

/** Map a KlineCharts Period back to a Binance interval string. */
function periodToInterval(period: Period): string {
  const { span, type } = period;
  if (type === 'minute') {
    const m: Record<number, string> = { 1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m' };
    return m[span] ?? '1m';
  }
  if (type === 'hour') {
    const h: Record<number, string> = { 1: '1h', 4: '4h' };
    return h[span] ?? '1h';
  }
  if (type === 'day') return '1d';
  return '1m';
}

export function useChartInstance(
  containerRef: RefObject<HTMLDivElement | null>,
  dotsCanvasRef: RefObject<HTMLCanvasElement | null>,
  stateRef: MutableRefObject<ChartState>,
): void {
  const getBarsIdRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    const canvas    = dotsCanvasRef.current;
    if (!container || !canvas) return;
    const s = stateRef.current;

    // --- KlineCharts init ---
    const chart = init(container, {
      styles: {
        grid: {
          horizontal: { color: GRID_COLOR, style: 'dashed' as const, dashedValue: [3, 3] },
          vertical: { show: false },
        },
        candle: {
          bar: {
            upColor: GREEN,
            downColor: '#ef4444',
            noChangeColor: '#888888',
            upBorderColor: GREEN,
            downBorderColor: '#ef4444',
            noChangeBorderColor: '#888888',
            upWickColor: GREEN,
            downWickColor: '#ef4444',
            noChangeWickColor: '#888888',
          },
          tooltip: {
            showRule: 'follow_cross' as const,
          },
        },
        xAxis: {
          axisLine: { color: GRID_COLOR },
          tickLine: { color: GRID_COLOR },
          tickText: { color: TEXT_COLOR, size: 11 },
        },
        yAxis: {
          axisLine: { color: GRID_COLOR },
          tickLine: { color: GRID_COLOR },
          tickText: { color: TEXT_COLOR, size: 11 },
        },
        crosshair: {
          horizontal: {
            line: { color: '#555' },
            text: { backgroundColor: '#333', color: TEXT_COLOR },
          },
          vertical: {
            line: { color: '#555' },
            text: { backgroundColor: '#333', color: TEXT_COLOR },
          },
        },
      },
    });
    if (!chart) return;
    s.kchart = chart;

    // VOL indicator — created once, lives for the lifetime of the component
    chart.createIndicator('VOL', false, { id: 'vol_pane', height: 80 });

    // Allow scrolling past the last candle into the future
    chart.setOffsetRightDistance(200);
    chart.setMaxOffsetRightDistance(800);

    // --- Data loader for candle mode ---
    chart.setDataLoader({
      getBars: async ({ type, timestamp, symbol, period, callback }) => {
        const reqId = ++getBarsIdRef.current;
        const interval = periodToInterval(period);
        try {
          let klines: KLineData[];
          if (type === 'backward' && timestamp != null) {
            // Load older bars: endTime = timestamp - 1ms to exclude the current earliest bar
            const raw = await fetchKlines(symbol.ticker, interval, 500, timestamp - 1);
            klines = raw.map(k => ({
              timestamp: k.t,
              open: parseFloat(k.o),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              close: parseFloat(k.c),
              volume: parseFloat(k.v),
            }));
          } else {
            // init / update: load latest 500 bars
            const raw = await fetchKlines(symbol.ticker, interval, 500);
            klines = raw.map(k => ({
              timestamp: k.t,
              open: parseFloat(k.o),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              close: parseFloat(k.c),
              volume: parseFloat(k.v),
            }));
          }
          // Discard stale responses
          if (reqId !== getBarsIdRef.current) return;
          const more = type === 'backward' ? klines.length === 500 : false;
          callback(klines, { backward: more });
          stateRef.current.historyLoaded = true;
        } catch (err) {
          if (reqId !== getBarsIdRef.current) return;
          console.error('getBars error:', err);
          callback([]);
        }
      },
      subscribeBar: ({ callback }) => {
        stateRef.current.liveBarCallback = callback;
      },
      unsubscribeBar: () => {
        stateRef.current.liveBarCallback = null;
      },
    });

    // --- Subscribe to KlineCharts scroll action to detect browse mode (candle mode) ---
    const onKcScroll = () => {
      if (s.mode === 'candles' && s.autoScroll) {
        useChartStore.getState().setAutoScroll(false);
      }
    };
    chart.subscribeAction('onScroll', onKcScroll);

    // --- Wheel event — trades mode only (canvas receives events; container is a sibling) ---
    // Gesture axis lock: first significant axis wins for 200ms. Prevents inertia deltaY
    // from leaking into zoom at the tail of a horizontal pan gesture.
    let wheelAxis: 'x' | 'y' | null = null;
    let wheelAxisTimer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      if (s.mode !== 'trades') return;
      // Suppress zoom while pointer-dragging — trackpads fire wheel events concurrently with drag.
      if (s.dragging) { e.preventDefault(); return; }

      const all = s.tradeDots;
      const paneWidth = canvas.offsetWidth - Y_AXIS_WIDTH;
      if (paneWidth <= 0) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);

      // Lock gesture axis on first significant movement; hold 200ms after last event.
      if (wheelAxis === null && (absX > 2 || absY > 2))
        wheelAxis = absX >= absY ? 'x' : 'y';
      if (wheelAxisTimer !== null) clearTimeout(wheelAxisTimer);
      wheelAxisTimer = setTimeout(() => { wheelAxis = null; }, 200);

      if (wheelAxis === 'x') {
        // Horizontal scroll → pan; only this should kill autoScroll
        if (s.autoScroll) {
          s.autoScroll = false; // immediate — don't wait for React re-render; rAF reads this directly
          useChartStore.getState().setAutoScroll(false);
        }
        const viewSpan = s.viewport.toTime - s.viewport.fromTime;
        const shift = (e.deltaX / paneWidth) * viewSpan;
        s.viewport = { fromTime: s.viewport.fromTime + shift, toTime: s.viewport.toTime + shift };
      } else if (wheelAxis === 'y') {
        // Vertical scroll → zoom
        // Scale by scroll magnitude: mouse (deltaY≈100) and trackpad (many small events)
        // both feel proportional — 8% zoom per 100px of scroll input.
        const pixelDelta = e.deltaMode === 1 ? Math.abs(e.deltaY) * 40 : Math.abs(e.deltaY);
        const factor = Math.pow(1.08, pixelDelta / 100);
        const zoomFactor = e.deltaY > 0 ? factor : 1 / factor;
        const avgDt = all.length > 1
          ? (all[all.length - 1].time - all[0].time) / (all.length - 1)
          : 1000;
        // Hard floor of 50ms regardless of data density so user can always zoom in deep
        const MIN_SPAN_MS = 50;
        const MAX_SPAN_MS = Math.max((all.length * 2) * avgDt, 12 * 3600 * 1000);

        if (s.autoScroll) {
          // Zoom while live: update span, rAF recomputes viewport — do NOT disable autoScroll
          s.viewSpanMs = Math.max(MIN_SPAN_MS, Math.min(MAX_SPAN_MS, s.viewSpanMs * zoomFactor));
        } else {
          // Zoom while browsing: cursor-centred zoom on the static viewport
          const vp = s.viewport;
          const viewSpan = vp.toTime - vp.fromTime;
          const rect = canvas.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const cursorFrac = Math.max(0, Math.min(1, mouseX / paneWidth));
          const newSpan = Math.max(MIN_SPAN_MS, Math.min(MAX_SPAN_MS, viewSpan * zoomFactor));
          const cursorMs = vp.fromTime + cursorFrac * viewSpan;
          s.viewport = {
            fromTime: cursorMs - cursorFrac * newSpan,
            toTime:   cursorMs + (1 - cursorFrac) * newSpan,
          };
          // Sync so go-live uses the current zoom level
          s.viewSpanMs = newSpan;
        }
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // --- Pointer events — horizontal + vertical pan in trades mode ---
    let prevPanX = 0, prevPanY = 0;
    const onPointerDown = (e: PointerEvent) => {
      if (s.mode !== 'trades') return;
      // Don't start pan when measuring (Shift+drag) or placing a drawing
      const store = useChartStore.getState();
      if (store.isMeasuring || store.activeDrawingTool) return;
      s.dragging = true;
      prevPanX = e.clientX;
      prevPanY = e.clientY;
      // Detect if click is in Y-axis zone (right strip)
      const rect = canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const chartW = canvas.offsetWidth - Y_AXIS_WIDTH;
      s.yAxisDragging = localX > chartW;
      // Capture pointer so fast moves outside the canvas don't drop the drag.
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerUp = () => { s.dragging = false; s.yAxisDragging = false; };
    const onPointerMove = (e: PointerEvent) => {
      // Don't require buttons===1: tap-drag on trackpad can report buttons===0.
      if (!s.dragging || s.mode !== 'trades') return;

      if (s.yAxisDragging) {
        // Y-axis drag → zoom the vertical price range
        const dY = e.clientY - prevPanY;
        prevPanY = e.clientY;
        if (Math.abs(dY) > 1) {
          // Drag down = zoom out (smaller factor), drag up = zoom in (larger factor)
          const zoomSpeed = 0.005;
          s.vertZoomFactor = Math.max(0.05, Math.min(50, s.vertZoomFactor * (1 - dY * zoomSpeed)));
        }
        prevPanX = e.clientX;
        return;
      }

      // Horizontal pan
      const dX = e.clientX - prevPanX;
      prevPanX = e.clientX;
      if (Math.abs(dX) > 1) {
        if (s.autoScroll) {
          s.autoScroll = false; // immediate — rAF reads stateRef directly, can't wait for re-render
          useChartStore.getState().setAutoScroll(false);
        }
        const chartW = canvas.offsetWidth - Y_AXIS_WIDTH;
        if (chartW > 0) {
          const vp = s.viewport;
          const span = vp.toTime - vp.fromTime;
          const shift = -(dX / chartW) * span;
          s.viewport = { fromTime: vp.fromTime + shift, toTime: vp.toTime + shift };
        }
      }
      // Vertical pan
      const dY = e.clientY - prevPanY;
      prevPanY = e.clientY;
      if (Math.abs(dY) > 1) {
        if (s.autoScroll) {
          s.autoScroll = false;
          useChartStore.getState().setAutoScroll(false);
        }
        const { priceMin, priceMax } = s;
        const drawH = canvas.offsetHeight - X_AXIS_HEIGHT;
        const pricePerPixel = (priceMax - priceMin) / drawH;
        if (pricePerPixel < 1e-10) return;
        // +dY = drag down → shift price range down → positive offset
        s.vertPanOffset += dY * pricePerPixel;
      }
    };
    // --- Cursor tracking for crosshair ---
    const onMouseMove = (e: MouseEvent) => {
      if (s.mode !== 'trades') return;
      const rect = canvas.getBoundingClientRect();
      s.cursorX = e.clientX - rect.left;
      s.cursorY = e.clientY - rect.top;
    };
    const onMouseLeave = () => {
      s.cursorX = null;
      s.cursorY = null;
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);

    // --- "Go Live" event ---
    const onGoLive = () => {
      s.vertPanOffset = 0;
      s.vertZoomFactor = 1.0;
      if (s.mode === 'candles') {
        chart.scrollToRealTime();
      } else {
        // Trades mode: viewport restored by rAF loop on next frame
        useChartStore.getState().setAutoScroll(true);
      }
    };
    window.addEventListener('chart:goLive', onGoLive);

    // --- "Navigate To" event (from ClosedTradesPanel click) ---
    const onNavigateTo = (e: Event) => {
      const ts = (e as CustomEvent).detail?.ts as number;
      if (!ts) return;
      s.vertPanOffset = 0;
      s.vertZoomFactor = 1.0;
      if (s.autoScroll) {
        s.autoScroll = false;
        useChartStore.getState().setAutoScroll(false);
      }
      if (s.mode === 'candles') {
        chart.scrollToTimestamp(ts / 1000); // KlineCharts uses seconds
      } else {
        // Trades mode: center viewport on the timestamp
        const span = s.viewSpanMs;
        s.viewport = { fromTime: ts - span / 2, toTime: ts + span / 2 };
        s.lodCache.clear();
      }
    };
    window.addEventListener('chart:navigateTo', onNavigateTo);

    // --- Consume pending navigation (cross-symbol click) ---
    // Subscribe to pendingNavigation changes — fires when ClosedTradesPanel
    // sets a target timestamp after switching symbols.
    const waitAndNavigate = (ts: number) => {
      // Wait for historyLoaded to transition: true (old) → false (reset) → true (new data).
      // Poll rapidly; timeout after 15s.
      const navStart = Date.now();
      let sawReset = false;
      const pollNav = () => {
        if (Date.now() - navStart > 15_000) {
          console.log(`[nav] timeout after 15s, navigating to ${ts} anyway`);
          onNavigateTo(new CustomEvent('chart:navigateTo', { detail: { ts } }));
          return;
        }
        const loaded = s.historyLoaded;
        if (!sawReset) {
          // Detect the reset (historyLoaded went false)
          if (!loaded) {
            sawReset = true;
            console.log(`[nav] saw reset after ${Date.now() - navStart}ms`);
          }
          setTimeout(pollNav, 30);
          return;
        }
        // Phase 2: wait for new data to finish loading
        if (loaded && s.tradeDots.length > 0) {
          console.log(`[nav] data loaded after ${Date.now() - navStart}ms, ${s.tradeDots.length} dots, navigating to ${ts}`);
          onNavigateTo(new CustomEvent('chart:navigateTo', { detail: { ts } }));
          return;
        }
        setTimeout(pollNav, 100);
      };
      // Start polling on next tick (after the setActiveSymbol call)
      setTimeout(pollNav, 0);
    };

    const unsubPendingNav = useChartStore.subscribe((state, prev) => {
      if (state.pendingNavigation && state.pendingNavigation !== prev.pendingNavigation) {
        const target = state.pendingNavigation;
        useChartStore.getState().setPendingNavigation(null);
        waitAndNavigate(target.ts);
      }
    });
    // Also check on initial mount (in case it was set before this effect ran)
    const pendingNow = useChartStore.getState().pendingNavigation;
    if (pendingNow) {
      useChartStore.getState().setPendingNavigation(null);
      waitAndNavigate(pendingNow.ts);
    }

    // --- rAF loop — trades mode canvas rendering ---
    let rafId = requestAnimationFrame(function loop() {
      // DEBUG: log mode every second regardless
      if (!((window as any).__rafLogTs) || Date.now() - (window as any).__rafLogTs > 1000) {
        (window as any).__rafLogTs = Date.now();
      }
      if (s.mode === 'trades') {
        if (s.autoScroll) {
          // Viewport slides continuously at wall-clock rate; zoom level comes from viewSpanMs
          const now = Date.now();
          s.viewport = {
            fromTime: now - s.viewSpanMs,
            toTime:   now + s.viewSpanMs * 0.1,
          };
        }
        const canvas = dotsCanvasRef.current;
        if (canvas) renderDotsCanvas(s, canvas);
      }
      rafId = requestAnimationFrame(loop);
    });

    // --- Resize observer ---
    const ro = new ResizeObserver(() => {
      chart.resize();
    });
    ro.observe(container);

    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('chart:goLive', onGoLive);
      window.removeEventListener('chart:navigateTo', onNavigateTo);
      unsubPendingNav();
      chart.unsubscribeAction('onScroll', onKcScroll);
      if (wheelAxisTimer !== null) clearTimeout(wheelAxisTimer);
      if (wheelAxisTimer !== null) clearTimeout(wheelAxisTimer);
      cancelAnimationFrame(rafId);
      ro.disconnect();
      dispose(container);
      s.kchart = null;
      s.liveBarCallback = null;
    };
  }, [containerRef, dotsCanvasRef, stateRef, getBarsIdRef]);
}


