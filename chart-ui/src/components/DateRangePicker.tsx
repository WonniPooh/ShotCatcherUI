/**
 * DateRangePicker — compact date-range selector for the chart's trades view.
 *
 * Only shown when timeframe is "trades" or "1s".
 * Sends a custom [from_ms, to_ms) range to useHistoryLoader via chartStore.
 * Clicking "Live" clears the range and returns to the default 12-hour window.
 */
import { useState } from 'react';
import { useChartStore } from '../store/chartStore';

/** Format a ms timestamp as "YYYY-MM-DDTHH:MM" for <input type="datetime-local"> */
function msToLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Parse an "YYYY-MM-DDTHH:MM" local datetime string to ms epoch (local TZ). */
function localToMs(s: string): number {
  return new Date(s).getTime();
}

export default function DateRangePicker() {
  const timeframe       = useChartStore((s) => s.timeframe);
  const isDateRangeMode = useChartStore((s) => s.isDateRangeMode);
  const dateRangeFrom   = useChartStore((s) => s.dateRangeFrom);
  const dateRangeTo     = useChartStore((s) => s.dateRangeTo);
  const setDateRange    = useChartStore((s) => s.setDateRange);
  const clearDateRange  = useChartStore((s) => s.clearDateRange);

  const isTradesMode = timeframe === 'trades' || timeframe === '1s';

  // Local state for the two inputs (controlled)
  const [fromValue, setFromValue] = useState<string>(() => {
    if (dateRangeFrom != null) return msToLocal(dateRangeFrom);
    return msToLocal(Date.now() - 12 * 60 * 60 * 1000);
  });
  const [toValue, setToValue] = useState<string>(() => {
    if (dateRangeTo != null) return msToLocal(dateRangeTo);
    return msToLocal(Date.now());
  });
  const [error, setError] = useState<string | null>(null);

  if (!isTradesMode) return null;

  const handleApply = () => {
    const fromMs = localToMs(fromValue);
    const toMs   = localToMs(toValue);
    if (!isFinite(fromMs) || !isFinite(toMs)) {
      setError('Invalid date');
      return;
    }
    if (fromMs >= toMs) {
      setError('"From" must be before "To"');
      return;
    }
    const maxRangeMs = 30 * 24 * 60 * 60 * 1000;
    if (toMs - fromMs > maxRangeMs) {
      setError('Range exceeds 30 days');
      return;
    }
    setError(null);
    setDateRange(fromMs, toMs);
  };

  const handleLive = () => {
    setError(null);
    setFromValue(msToLocal(Date.now() - 12 * 60 * 60 * 1000));
    setToValue(msToLocal(Date.now()));
    clearDateRange();
  };

  return (
    <div className="flex items-center gap-2 px-3 py-1 bg-[#181d27] border-b border-[#2a2f3e] text-xs text-gray-300 flex-wrap">
      <span className="text-gray-500 shrink-0">Range:</span>

      <input
        type="datetime-local"
        value={fromValue}
        onChange={(e) => setFromValue(e.target.value)}
        className="bg-[#0f1117] border border-[#2a2f3e] rounded px-1 py-0.5 text-xs
                   text-gray-200 focus:outline-none focus:border-blue-500"
      />

      <span className="text-gray-500">→</span>

      <input
        type="datetime-local"
        value={toValue}
        onChange={(e) => setToValue(e.target.value)}
        className="bg-[#0f1117] border border-[#2a2f3e] rounded px-1 py-0.5 text-xs
                   text-gray-200 focus:outline-none focus:border-blue-500"
      />

      <button
        onClick={handleApply}
        className="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white
                   text-xs font-medium transition-colors"
      >
        Load
      </button>

      {isDateRangeMode && (
        <button
          onClick={handleLive}
          className="px-2 py-0.5 rounded bg-[#2a2f3e] hover:bg-[#353b4f] text-gray-300
                     text-xs transition-colors"
        >
          Live
        </button>
      )}

      {error && <span className="text-red-400">{error}</span>}
    </div>
  );
}
