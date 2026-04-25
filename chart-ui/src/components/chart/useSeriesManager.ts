import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { Period } from 'klinecharts';
import { LIVE_WINDOW_S } from './constants';
import type { ChartState } from './types';

/** Map a Zustand timeframe string to a KlineCharts Period. */
function parsePeriod(tf: string): Period {
  const map: Record<string, Period> = {
    '1m':  { span: 1,  type: 'minute' },
    '3m':  { span: 3,  type: 'minute' },
    '5m':  { span: 5,  type: 'minute' },
    '15m': { span: 15, type: 'minute' },
    '30m': { span: 30, type: 'minute' },
    '1h':  { span: 1,  type: 'hour'   },
    '4h':  { span: 4,  type: 'hour'   },
    '1d':  { span: 1,  type: 'day'    },
  };
  return map[tf] ?? { span: 1, type: 'minute' };
}

/**
 * Resets chart state on every mode / symbol / timeframe change.
 * For candle mode, also drives KlineCharts symbol + period which triggers getBars.
 */
export function useSeriesManager(
  stateRef: MutableRefObject<ChartState>,
  isTradesMode: boolean,
  activeSymbol: string,
  timeframe: string,
): void {
  useEffect(() => {
    const s = stateRef.current;

    // Clear all accumulated data
    s.tradeDots = [];
    s.lastTradeMs = 0;
    s.earliestTradeTime = Infinity;
    s.loadingMore = false;
    s.historyLoaded = false;
    s.volumeBuckets.clear();
    s.lodCache.clear();
    s.lodCacheBucketSpan = 0;
    s.vertPanOffset = 0;
    s.liveBarCallback = null;
    s.kcOverlayIds.clear();

    // Reset viewport + zoom to live defaults
    const now = Date.now();
    s.viewSpanMs = LIVE_WINDOW_S * 1000;
    s.viewport = {
      fromTime: now - LIVE_WINDOW_S * 1000,
      toTime: now + LIVE_WINDOW_S * 1000 * 0.25,
    };

    s.mode = isTradesMode ? 'trades' : 'candles';

    if (!isTradesMode) {
      const chart = s.kchart;
      if (!chart) return;
      // Updating period first, then symbol, so only one getBars 'init' fires (for the new symbol/period)
      chart.setPeriod(parsePeriod(timeframe));
      chart.setSymbol({ ticker: activeSymbol });
    }
  }, [isTradesMode, activeSymbol, timeframe, stateRef]);
}
