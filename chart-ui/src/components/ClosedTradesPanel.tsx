/**
 * ClosedTradesPanel — sidebar showing closed positions with PnL.
 * Click a card to navigate the chart to that position's entry time.
 */
import { useEffect, useRef, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import { usePositionStore, PERIOD_OPTIONS } from '../store/positionStore';
import type { ClosedPosition } from '../types/positions';

/** Smart duration format: ms → human-readable. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/** Format timestamp to HH:MM. */
function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Format price with appropriate precision. */
function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

/** Format USD PnL. */
function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '';
  if (Math.abs(pnl) >= 1000) return `${sign}$${pnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${sign}$${pnl.toFixed(2)}`;
}

function PositionCard({ pos, onNavigate }: { pos: ClosedPosition; onNavigate: (pos: ClosedPosition) => void }) {
  const isProfit = pos.realized_pnl >= 0;
  const pnlColor = isProfit ? 'text-green-400' : 'text-red-400';
  const sideColor = pos.side === 'LONG' ? 'text-green-400' : 'text-red-400';
  const sideBg = pos.side === 'LONG' ? 'bg-green-500/10' : 'bg-red-500/10';

  return (
    <button
      onClick={() => onNavigate(pos)}
      className={`w-full text-left px-3 py-2.5 border-b border-[#2a2d3a] hover:bg-[#1e2130] transition-colors cursor-pointer`}
    >
      {/* Header row: symbol + side badge */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-200">{pos.symbol}</span>
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${sideBg} ${sideColor}`}>
          {pos.side}
        </span>
      </div>

      {/* PnL row */}
      <div className="flex items-baseline justify-between mb-1">
        <span className={`text-sm font-semibold ${pnlColor}`}>
          {pos.pnl_pct >= 0 ? '+' : ''}{pos.pnl_pct.toFixed(2)}%
        </span>
        <span className={`text-xs ${pnlColor}`}>
          {formatPnl(pos.realized_pnl)}
        </span>
      </div>

      {/* Price range */}
      <div className="text-[11px] text-gray-400 mb-0.5">
        {formatPrice(pos.entry_price)} → {formatPrice(pos.exit_price)}
      </div>

      {/* Time + duration */}
      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span>{formatTime(pos.entry_time_ms)} → {formatTime(pos.exit_time_ms)}</span>
        <span>{formatDuration(pos.duration_ms)}</span>
      </div>
    </button>
  );
}

export default function ClosedTradesPanel() {
  const { positions, loading, error, periodLabel, sortBy, loadPositions, setPeriod, setSortBy } = usePositionStore();
  const setActiveSymbol = useChartStore((s) => s.setActiveSymbol);
  const activeSymbol = useChartStore((s) => s.activeSymbol);
  const setPendingNavigation = useChartStore((s) => s.setPendingNavigation);
  const tabs = useChartStore((s) => s.tabs);
  const addTab = useChartStore((s) => s.addTab);

  const [periodOpen, setPeriodOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const periodRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (periodRef.current && !periodRef.current.contains(e.target as Node)) setPeriodOpen(false);
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Load positions on mount and when period changes
  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  // Reload when period changes (handled inside setPeriod)
  // Also reload periodically (every 30s)
  useEffect(() => {
    const id = setInterval(() => loadPositions(), 30_000);
    return () => clearInterval(id);
  }, [loadPositions]);

  const handleNavigate = (pos: ClosedPosition) => {
    // Skip navigation if the position closed less than 30s ago — chart is already there
    if (Date.now() - pos.exit_time_ms < 30_000) return;

    if (pos.symbol !== activeSymbol) {
      // Switch to that symbol (add tab if needed)
      if (!tabs.some((t) => t.symbol === pos.symbol)) {
        addTab({ symbol: pos.symbol, label: pos.symbol.replace('USDT', '') });
      }
      setPendingNavigation({ ts: pos.entry_time_ms });
      setActiveSymbol(pos.symbol);
    } else {
      // Same symbol — navigate directly
      window.dispatchEvent(new CustomEvent('chart:navigateTo', { detail: { ts: pos.entry_time_ms } }));
    }
  };

  // Summary stats — all
  const totalPnl = positions.reduce((sum, p) => sum + p.realized_pnl, 0);
  const wins = positions.filter((p) => p.realized_pnl > 0).length;
  const losses = positions.filter((p) => p.realized_pnl < 0).length;

  // Summary stats — current symbol
  const symbolPositions = positions.filter((p) => p.symbol === activeSymbol);
  const symPnl = symbolPositions.reduce((sum, p) => sum + p.realized_pnl, 0);
  const symWins = symbolPositions.filter((p) => p.realized_pnl > 0).length;
  const symLosses = symbolPositions.filter((p) => p.realized_pnl < 0).length;

  // Sort
  const sorted = sortBy === 'time'
    ? positions // already time-sorted from server (newest first)
    : [...positions].sort((a, b) => {
        if (sortBy === 'current') {
          const aActive = a.symbol === activeSymbol ? 0 : 1;
          const bActive = b.symbol === activeSymbol ? 0 : 1;
          if (aActive !== bActive) return aActive - bActive;
        }
        return a.symbol.localeCompare(b.symbol) || b.exit_time_ms - a.exit_time_ms;
      });

  return (
    <div className="flex flex-col h-full bg-[#13151f] border-l border-[#2a2d3a] overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#2a2d3a]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-300">Closed Trades</span>
          <span className="text-[10px] text-gray-500">{positions.length} trades</span>
        </div>

        {/* Period + Sort dropdowns */}
        <div className="flex items-center gap-1.5">
          {/* Period dropdown */}
          <div ref={periodRef} className="relative">
            <button
              onClick={() => { setPeriodOpen(!periodOpen); setSortOpen(false); }}
              className="px-2 py-0.5 rounded bg-[#22253a] hover:bg-[#2a2d4a] text-gray-200 flex items-center gap-1"
            >
              <span className="text-[10px] text-gray-400">Period</span>
              <span className="text-[10px] font-medium">{periodLabel}</span>
              <svg className="w-2.5 h-2.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {periodOpen && (
              <div className="absolute top-full left-0 mt-1 bg-[#22253a] border border-[#2a2d3a] rounded shadow-xl z-50 min-w-[80px]">
                {PERIOD_OPTIONS.map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => { setPeriod(opt.label, opt.ms); setPeriodOpen(false); }}
                    className={`block w-full text-left px-3 py-1.5 text-[11px] hover:bg-[#2a2d4a] ${
                      periodLabel === opt.label ? 'text-blue-400 font-medium' : 'text-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sort dropdown */}
          <div ref={sortRef} className="relative">
            <button
              onClick={() => { setSortOpen(!sortOpen); setPeriodOpen(false); }}
              className="px-2 py-0.5 rounded bg-[#22253a] hover:bg-[#2a2d4a] text-gray-200 flex items-center gap-1"
            >
              <span className="text-[10px] text-gray-400">Sort</span>
              <span className="text-[10px] font-medium">{sortBy === 'time' ? 'Time' : sortBy === 'symbol' ? 'Symbol' : 'Current'}</span>
              <svg className="w-2.5 h-2.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {sortOpen && (
              <div className="absolute top-full left-0 mt-1 bg-[#22253a] border border-[#2a2d3a] rounded shadow-xl z-50 min-w-[90px]">
                {([['time', 'Time'], ['symbol', 'Symbol'], ['current', 'Current first']] as const).map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => { setSortBy(v); setSortOpen(false); }}
                    className={`block w-full text-left px-3 py-1.5 text-[11px] hover:bg-[#2a2d4a] ${
                      sortBy === v ? 'text-blue-400 font-medium' : 'text-gray-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Summary bar — all */}
      {positions.length > 0 && (
        <div className="px-3 py-1.5 border-b border-[#2a2d3a] flex items-center justify-between text-[10px]">
          <span className="text-gray-500">All</span>
          <span className={totalPnl >= 0 ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
            {formatPnl(totalPnl)}
          </span>
          <span className="text-gray-500">
            <span className="text-green-500">{wins}W</span>
            {' / '}
            <span className="text-red-500">{losses}L</span>
            {positions.length > 0 && (
              <span className="ml-1 text-gray-400">
                ({((wins / positions.length) * 100).toFixed(0)}%)
              </span>
            )}
          </span>
        </div>
      )}

      {/* Summary bar — current symbol */}
      {symbolPositions.length > 0 && (
        <div className="px-3 py-1.5 border-b border-[#2a2d3a] flex items-center justify-between text-[10px]">
          <span className="text-blue-400 font-medium">{activeSymbol.replace('USDT', '')}</span>
          <span className={symPnl >= 0 ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
            {formatPnl(symPnl)}
          </span>
          <span className="text-gray-500">
            <span className="text-green-500">{symWins}W</span>
            {' / '}
            <span className="text-red-500">{symLosses}L</span>
            <span className="ml-1 text-gray-400">
              ({((symWins / symbolPositions.length) * 100).toFixed(0)}%)
            </span>
          </span>
        </div>
      )}

      {/* Position list */}
      <div className="flex-1 overflow-y-auto">
        {loading && positions.length === 0 && (
          <div className="p-4 text-center text-xs text-gray-500">Loading...</div>
        )}
        {error && (
          <div className="p-4 text-center text-xs text-red-400">{error}</div>
        )}
        {!loading && !error && positions.length === 0 && (
          <div className="p-4 text-center text-xs text-gray-500">No closed trades in this period</div>
        )}
        {sorted.map((pos, i) => {
          const showSeparator = sortBy !== 'time' && i > 0 && sorted[i - 1].symbol !== pos.symbol;
          return (
            <div key={pos.id}>
              {showSeparator && <div className="h-2 bg-[#0f1117]" />}
              <PositionCard pos={pos} onNavigate={handleNavigate} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
