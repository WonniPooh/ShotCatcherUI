import { useRef } from 'react';
import { useChartStore } from '../../store/chartStore';
import { createInitialState } from './types';
import { useChartInstance } from './useChartInstance';
import { useSeriesManager } from './useSeriesManager';
import { useHistoryLoader } from './useHistoryLoader';
import { useTradeUpdates } from './useTradeUpdates';
import { useDrawings } from './useDrawings';
import { useOrderData } from './useOrderData';

export default function ChartCore() {
  const containerRef  = useRef<HTMLDivElement>(null);
  const dotsCanvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef      = useRef(createInitialState());

  const activeSymbol = useChartStore(s => s.activeSymbol);
  const timeframe    = useChartStore(s => s.timeframe);
  const autoScroll   = useChartStore(s => s.autoScroll);
  const drawings     = useChartStore(s => s.drawings);
  const selectedDrawingId = useChartStore(s => s.selectedDrawingId);
  const markers      = useChartStore(s => s.markers);

  // Sync reactive state into the mutable ref (read each frame / on demand)
  stateRef.current.autoScroll = autoScroll;
  stateRef.current.drawings   = drawings;
  stateRef.current.selectedDrawingId = selectedDrawingId;
  stateRef.current.markers    = markers;

  const isTradesMode = timeframe === 'trades' || timeframe === '1s';

  useChartInstance(containerRef, dotsCanvasRef, stateRef);
  useSeriesManager(stateRef, isTradesMode, activeSymbol, timeframe);
  useHistoryLoader(stateRef, activeSymbol, isTradesMode);
  useTradeUpdates(stateRef, activeSymbol, timeframe, isTradesMode);
  useOrderData(stateRef, activeSymbol);
  const { cursorClass } = useDrawings(
    stateRef, containerRef, dotsCanvasRef, isTradesMode, activeSymbol,
  );

  return (
    <div className={`relative flex-1 min-w-0 h-full bg-[#0f1117] ${cursorClass}`}>
      {/* KlineCharts mounts into this div (candle mode) */}
      <div ref={containerRef} className="w-full h-full" />
      {/* Canvas overlay (trades mode) — opaque, covers KlineCharts */}
      <canvas
        ref={dotsCanvasRef}
        className="absolute inset-0"
        style={{
          width: '100%',
          height: '100%',
          zIndex: 10,
          display: isTradesMode ? 'block' : 'none',
          pointerEvents: isTradesMode ? 'auto' : 'none',
          cursor: 'crosshair',
        }}
      />
    </div>
  );
}

