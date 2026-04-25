import { useState, useRef, useEffect } from 'react';
import { useChartStore } from '../store/chartStore';

type SidebarPanel = 'closedTrades' | 'openOrders';

const ALL_TIMEFRAMES = [
  'trades',
  '1s',
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
] as const;

// Module-level counter survives component re-renders
let markerCounter = 0;

export default function Toolbar() {
  const timeframe = useChartStore((s) => s.timeframe);
  const setTimeframe = useChartStore((s) => s.setTimeframe);
  const autoScroll = useChartStore((s) => s.autoScroll);
  const setAutoScroll = useChartStore((s) => s.setAutoScroll);
  const activeDrawingTool = useChartStore((s) => s.activeDrawingTool);
  const setActiveDrawingTool = useChartStore((s) => s.setActiveDrawingTool);
  const currentPrice = useChartStore((s) => s.currentPrice);
  const addMarker    = useChartStore((s) => s.addMarker);
  const sidebarPanel = useChartStore((s) => s.sidebarPanel);
  const toggleSidebarPanel = useChartStore((s) => s.toggleSidebarPanel);
  const isTradesMode = timeframe === 'trades' || timeframe === '1s';

  const [tfOpen, setTfOpen] = useState(false);
  const tfRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tfRef.current && !tfRef.current.contains(e.target as Node)) {
        setTfOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-[#1a1d27] border-b border-[#2a2d3a] text-sm">
      {/* Timeframe dropdown */}
      <div ref={tfRef} className="relative">
        <button
          onClick={() => setTfOpen(!tfOpen)}
          className="px-2 py-1 rounded bg-[#22253a] hover:bg-[#2a2d4a] text-gray-200 flex items-center gap-1"
        >
          <span className="text-xs text-gray-400">TF</span>
          <span className="font-medium">{timeframe}</span>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {tfOpen && (
          <div className="absolute top-full left-0 mt-1 bg-[#22253a] border border-[#2a2d3a] rounded shadow-xl z-50 min-w-[100px]">
            {ALL_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => {
                  setTimeframe(tf);
                  setTfOpen(false);
                }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-[#2a2d4a] ${
                  timeframe === tf ? 'text-blue-400 font-medium' : 'text-gray-300'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="w-px h-5 bg-[#2a2d3a]" />

      {/* Drawing tools */}
      <button
        onClick={() =>
          setActiveDrawingTool(activeDrawingTool === 'hline' ? null : 'hline')
        }
        className={`px-2 py-1 rounded text-xs ${
          activeDrawingTool === 'hline'
            ? 'bg-blue-600 text-white'
            : 'bg-[#22253a] hover:bg-[#2a2d4a] text-gray-300'
        }`}
        title="Horizontal Line"
      >
        ─ Line
      </button>
      <button
        onClick={() =>
          setActiveDrawingTool(activeDrawingTool === 'ruler' ? null : 'ruler')
        }
        className={`px-2 py-1 rounded text-xs ${
          activeDrawingTool === 'ruler'
            ? 'bg-blue-600 text-white'
            : 'bg-[#22253a] hover:bg-[#2a2d4a] text-gray-300'
        }`}
        title="Ruler (measure)"
      >
        📏 Ruler
      </button>
      <div className="w-px h-5 bg-[#2a2d3a]" />

      {/* Test marker buttons — trades mode only (dotsCanvas hidden in candle mode) */}
      <button
        disabled={!isTradesMode || currentPrice === 0}
        onClick={() => addMarker({ id: `m${++markerCounter}_${Date.now()}`, time: Date.now(), price: currentPrice, direction: 'up', color: 'green' })}
        className={`px-2 py-1 rounded text-xs ${
          isTradesMode && currentPrice > 0
            ? 'bg-[#22253a] hover:bg-[#2a2d4a] text-green-400 cursor-pointer'
            : 'bg-[#22253a] text-green-900 cursor-not-allowed'
        }`}
        title={currentPrice > 0 ? `Add ▲ at ${currentPrice.toFixed(2)}` : 'Switch to trades mode first'}
      >
        ▲ {isTradesMode && currentPrice > 0 ? currentPrice.toFixed(2) : '--'}
      </button>
      <button
        disabled={!isTradesMode || currentPrice === 0}
        onClick={() => addMarker({ id: `m${++markerCounter}_${Date.now()}`, time: Date.now(), price: currentPrice, direction: 'down', color: 'red' })}
        className={`px-2 py-1 rounded text-xs ${
          isTradesMode && currentPrice > 0
            ? 'bg-[#22253a] hover:bg-[#2a2d4a] text-red-400 cursor-pointer'
            : 'bg-[#22253a] text-red-900 cursor-not-allowed'
        }`}
        title={currentPrice > 0 ? `Add ▼ at ${currentPrice.toFixed(2)}` : 'Switch to trades mode first'}
      >
        ▼ {isTradesMode && currentPrice > 0 ? currentPrice.toFixed(2) : '--'}
      </button>

      <div className="w-px h-5 bg-[#2a2d3a]" />

      {/* Auto-scroll toggle — re-enabling scrolls to live edge + fits scale */}
      <button
        onClick={() => {
          if (!autoScroll) {
            setAutoScroll(true);
            // Dispatch custom event so ChartCore can scrollToRealTime + fitContent
            window.dispatchEvent(new Event('chart:goLive'));
          } else {
            setAutoScroll(false);
          }
        }}
        className={`px-2 py-1 rounded text-xs ${
          autoScroll
            ? 'bg-green-700 text-white'
            : 'bg-[#22253a] hover:bg-[#2a2d4a] text-gray-300'
        }`}
        title="Auto-scroll to latest data"
      >
        {autoScroll ? '▶ Live' : '⏸ Paused'}
      </button>

      {/* Shift hint */}
      <span className="ml-auto text-xs text-gray-500">
        Shift+Drag to measure | Del to remove selected
      </span>

      <div className="w-px h-5 bg-[#2a2d3a]" />

      {/* Sidebar panel toggles — mutually exclusive */}
      <button
        onClick={() => toggleSidebarPanel('closedTrades' as SidebarPanel)}
        className={`px-2 py-1 rounded text-xs ${
          sidebarPanel === 'closedTrades'
            ? 'bg-blue-600 text-white'
            : 'bg-[#22253a] hover:bg-[#2a2d4a] text-gray-300'
        }`}
        title="Closed Trades"
      >
        📋 Trades
      </button>
      <button
        onClick={() => toggleSidebarPanel('openOrders' as SidebarPanel)}
        className={`px-2 py-1 rounded text-xs ${
          sidebarPanel === 'openOrders'
            ? 'bg-blue-600 text-white'
            : 'bg-[#22253a] hover:bg-[#2a2d4a] text-gray-300'
        }`}
        title="Open Orders"
      >
        📊 Orders
      </button>
    </div>
  );
}
