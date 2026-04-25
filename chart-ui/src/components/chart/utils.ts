export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Binary search: returns first index where dots[i].time >= target */
export function bisectLeft(dots: { time: number }[], target: number): number {
  let lo = 0, hi = dots.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (dots[mid].time < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Choose a tick interval in seconds that gives ~8 ticks for the given span (in seconds). */
export function chooseTickInterval(viewSpanSeconds: number): number {
  const raw = viewSpanSeconds / 8;
  const nice = [
    0.001, 0.002, 0.005,
    0.01, 0.02, 0.05,
    0.1, 0.2, 0.5,
    1, 2, 5, 10, 15, 30,
    60, 120, 300, 600, 900, 1800, 3600,
    7200, 14400, 21600, 43200,
  ];
  for (const n of nice) {
    if (n >= raw) return n;
  }
  return 43200;
}

/** Format a time value (in seconds) as HH:MM, HH:MM:SS, or HH:MM:SS.mmm */
export function formatTimeLabel(timeSec: number, intervalSec: number): string {
  const date = new Date(timeSec * 1000);
  const hh = date.getHours().toString().padStart(2, '0');
  const mm = date.getMinutes().toString().padStart(2, '0');
  const ss = date.getSeconds().toString().padStart(2, '0');
  const ms = date.getMilliseconds();
  if (intervalSec < 1) {
    return `${hh}:${mm}:${ss}.${ms.toString().padStart(3, '0')}`;
  }
  if (intervalSec >= 60) {
    return `${hh}:${mm}`;
  }
  return `${hh}:${mm}:${ss}`;
}

/** Format a price for Y-axis display, choosing decimal places based on the visible range. */
export function formatPriceAxis(price: number, priceRange: number): string {
  const decimals = priceRange < 0.01 ? 6
    : priceRange < 1 ? 4
    : priceRange < 100 ? 2
    : 0;
  return price.toFixed(decimals);
}

