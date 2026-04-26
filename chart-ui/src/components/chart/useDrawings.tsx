import { useEffect, useCallback, useState, useRef } from 'react';
import type { RefObject, MutableRefObject } from 'react';
import type { OverlayCreate } from 'klinecharts';
import { useChartStore } from '../../store/chartStore';
import { useShiftKey, useDeleteKey, useChartKeys } from '../../hooks/useKeyboard';
import { X_AXIS_HEIGHT, Y_AXIS_WIDTH } from './constants';
import type { ChartState } from './types';

let drawingIdCounter = 0;

type MeasurePoint = { price: number; time: number; x: number; y: number };

export function useDrawings(
  stateRef: MutableRefObject<ChartState>,
  containerRef: RefObject<HTMLDivElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  isTradesMode: boolean,
  activeSymbol: string,
): { cursorClass: string } {
  const s = stateRef.current;

  const drawings          = useChartStore(st => st.drawings);
  const addDrawing        = useChartStore(st => st.addDrawing);
  const removeDrawing     = useChartStore(st => st.removeDrawing);
  const selectedDrawingId = useChartStore(st => st.selectedDrawingId);
  const setSelectedDrawingId = useChartStore(st => st.setSelectedDrawingId);
  const activeDrawingTool = useChartStore(st => st.activeDrawingTool);
  const setActiveDrawingTool = useChartStore(st => st.setActiveDrawingTool);
  const setIsMeasuring    = useChartStore(st => st.setIsMeasuring);

  const [_measureStart, setMeasureStart] = useState<MeasurePoint | null>(null);
  const [_measureEnd,   setMeasureEnd]   = useState<MeasurePoint | null>(null);
  const shiftHeldRef  = useRef(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const measureStartRef = useRef<MeasurePoint | null>(null);

  // --- Shift key: toggle ruler mode (press to activate, press again to deactivate) ---
  useShiftKey(
    useCallback(
      (pressed: boolean) => {
        if (!pressed) return; // Only act on keydown, not keyup
        const store = useChartStore.getState();
        const rulerActive = store.activeDrawingTool === 'ruler';
        if (rulerActive) {
          // Deactivate ruler
          setActiveDrawingTool(null);
          setIsMeasuring(false);
          shiftHeldRef.current = false;
          setShiftHeld(false);
          stateRef.current.ruler = null;
          setMeasureStart(null);
          setMeasureEnd(null);
          const chart = stateRef.current.kchart;
          if (chart) chart.setScrollEnabled(true);
        } else {
          // Activate ruler
          setActiveDrawingTool('ruler');
          setIsMeasuring(true);
          shiftHeldRef.current = true;
          setShiftHeld(true);
          const chart = stateRef.current.kchart;
          if (chart) chart.setScrollEnabled(false);
        }
      },
      [setIsMeasuring, setActiveDrawingTool, stateRef],
    ),
  );

  // --- Delete key: remove selected drawing ---
  useDeleteKey(
    useCallback(() => {
      if (selectedDrawingId) removeDrawing(selectedDrawingId);
    }, [selectedDrawingId, removeDrawing]),
  );

  // --- Alt+R / Escape: reset pan / cancel measurement ---
  useChartKeys(
    useCallback(() => {
      const s = stateRef.current;
      s.vertPanOffset = 0;
      if (isTradesMode) {
        s.viewSpanMs = 10 * 60 * 1000;
        s.autoScroll = true;
        useChartStore.getState().setAutoScroll(true);
      } else {
        s.kchart?.scrollToRealTime();
      }
    }, [stateRef, isTradesMode]),
    useCallback(() => {
      stateRef.current.ruler = null;
      measureStartRef.current = null;
      setMeasureStart(null);
      setMeasureEnd(null);
      // Also deactivate ruler tool if active
      const store = useChartStore.getState();
      if (store.activeDrawingTool === 'ruler') {
        store.setActiveDrawingTool(null);
        store.setIsMeasuring(false);
        shiftHeldRef.current = false;
        setShiftHeld(false);
        const chart = stateRef.current.kchart;
        if (chart) chart.setScrollEnabled(true);
      }
    }, [stateRef]),
  );

  // --- Coordinate helpers ---
  const pixelToPrice = useCallback(
    (x: number, y: number): { price: number | null; time: number | null } => {
      const container = containerRef.current;
      if (!container) return { price: null, time: null };

      if (!isTradesMode) {
        const chart = stateRef.current.kchart;
        if (!chart) return { price: null, time: null };
        const pts = chart.convertFromPixel([{ x, y }]) as Array<{ timestamp?: number; value?: number }>;
        return { price: pts[0]?.value ?? null, time: pts[0]?.timestamp ?? null };
      }

      // Trades mode: self-computed from viewport + price range
      const { priceMin, priceMax, viewport } = stateRef.current;
      const drawH  = container.offsetHeight - X_AXIS_HEIGHT;
      const chartW = container.offsetWidth  - Y_AXIS_WIDTH;
      if (drawH <= 0 || chartW <= 0) return { price: null, time: null };
      const price = priceMin + (1 - y / drawH) * (priceMax - priceMin);
      const time  = viewport.fromTime + (x / chartW) * (viewport.toTime - viewport.fromTime);
      return { price, time };
    },
    [isTradesMode, containerRef, stateRef],
  );

  // --- Chart click handler for drawing tools ---
  useEffect(() => {
    const container = isTradesMode ? canvasRef.current : containerRef.current;
    if (!container) return;

    const handler = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const { price, time } = pixelToPrice(x, y);
      if (price == null) return;

      // --- No tool active: try to select a nearby drawing ---
      if (!activeDrawingTool) {
        const HIT_PX = 8; // click tolerance in pixels
        const st = stateRef.current;
        const cW = (isTradesMode ? canvasRef.current?.offsetWidth : containerRef.current?.offsetWidth) ?? 0;
        const cH = (isTradesMode ? canvasRef.current?.offsetHeight : containerRef.current?.offsetHeight) ?? 0;
        const drawH = cH - X_AXIS_HEIGHT;
        const chartW = cW - Y_AXIS_WIDTH;
        if (drawH <= 0 || chartW <= 0) return;

        let hitId: string | null = null;
        for (const d of st.drawings) {
          if (d.type === 'hline') {
            const dy = drawH * (1 - (d.price - st.priceMin) / (st.priceMax - st.priceMin));
            if (Math.abs(y - dy) <= HIT_PX) { hitId = d.id; break; }
          }
        }
        setSelectedDrawingId(hitId);
        return;
      }

      if (activeDrawingTool === 'ruler') {
        // Ruler: click to anchor start point, then mousemove shows preview,
        // second click (or any tool change) fixes it on screen
        const st = stateRef.current;
        if (!measureStartRef.current) {
          // First click: set start
          measureStartRef.current = { price, time: time ?? Date.now(), x, y };
          setMeasureStart(measureStartRef.current);
          setMeasureEnd(null);
          st.ruler = null;
        } else {
          // Second click: freeze the ruler on screen — deactivate tool
          setActiveDrawingTool(null);
          setIsMeasuring(false);
          shiftHeldRef.current = false;
          setShiftHeld(false);
          measureStartRef.current = null;
          const chart = st.kchart;
          if (chart) chart.setScrollEnabled(true);
          // Leave ruler/measureStart/measureEnd as-is so it stays visible
        }
        return;
      }

      addDrawing({
        id: `draw_${++drawingIdCounter}`,
        type: activeDrawingTool,
        price,
        time: time ?? undefined,
        label: price.toFixed(2),
      });
      setActiveDrawingTool(null);
    };

    container.addEventListener('click', handler as EventListener);
    return () => container.removeEventListener('click', handler as EventListener);
  }, [activeDrawingTool, addDrawing, setActiveDrawingTool, setSelectedDrawingId, containerRef, canvasRef, isTradesMode, pixelToPrice, stateRef]);

  // --- Ruler mousemove tracking (after first click, before second click) ---
  useEffect(() => {
    const container = isTradesMode ? canvasRef.current : containerRef.current;
    if (!container) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!measureStartRef.current) return;
      const store = useChartStore.getState();
      if (store.activeDrawingTool !== 'ruler') return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const { price, time } = pixelToPrice(x, y);
      if (price == null || time == null) return;
      const endPt = { price, time, x, y };
      setMeasureEnd(endPt);
      stateRef.current.ruler = {
        startPrice: measureStartRef.current.price, startTime: measureStartRef.current.time,
        endPrice: price, endTime: time,
      };
    };

    container.addEventListener('mousemove', onMouseMove as EventListener);
    return () => container.removeEventListener('mousemove', onMouseMove as EventListener);
  }, [containerRef, canvasRef, isTradesMode, pixelToPrice, stateRef]);

  // --- Sync hline drawings to KlineCharts overlays (candle mode only) ---
  useEffect(() => {
    if (isTradesMode) return;
    const chart = s.kchart;
    if (!chart) return;

    const currentIds = new Set(drawings.map(d => d.id));

    // Remove deleted drawings
    for (const [drawId, overlayId] of s.kcOverlayIds) {
      if (!currentIds.has(drawId)) {
        chart.removeOverlay({ id: overlayId });
        s.kcOverlayIds.delete(drawId);
      }
    }

    // Add new hline drawings
    for (const d of drawings) {
      if (d.type !== 'hline' || s.kcOverlayIds.has(d.id)) continue;
      const overlayCreate: OverlayCreate = {
        name: 'horizontalStraightLine',
        points: [{ value: d.price }],
        styles: {
          line: { color: selectedDrawingId === d.id ? '#3b82f6' : '#eab308' },
        },
        lock: false,
      };
      const id = chart.createOverlay(overlayCreate);
      if (typeof id === 'string') s.kcOverlayIds.set(d.id, id);
    }

    // Update selected drawing color
    for (const [drawId, overlayId] of s.kcOverlayIds) {
      chart.overrideOverlay({
        id: overlayId,
        styles: {
          line: { color: selectedDrawingId === drawId ? '#3b82f6' : '#eab308' },
        },
      });
    }
  }, [drawings, selectedDrawingId, isTradesMode, activeSymbol, s]);

  const cursorClass = shiftHeld || activeDrawingTool ? 'cursor-crosshair' : '';

  return { cursorClass };
}

