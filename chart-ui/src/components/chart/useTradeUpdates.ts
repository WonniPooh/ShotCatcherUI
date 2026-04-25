import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { useBinanceStream } from '../../hooks/useBinanceStream';
import { useChartStore } from '../../store/chartStore';
import { GREEN, RED } from './constants';
import type { ChartState } from './types';
import type { RawTrade, BinanceKline } from '../../types/chart';

export function useTradeUpdates(
  stateRef: MutableRefObject<ChartState>,
  activeSymbol: string,
  timeframe: string,
  isTradesMode: boolean,
): void {
  const handleTrade = useCallback(
    (trade: RawTrade) => {
      if (!isTradesMode) return;
      const s = stateRef.current;

      const p = parseFloat(trade.price);
      const q = parseFloat(trade.qty);
      if (!(p > 0) || !isFinite(p)) return; // skip garbage prices

      // Record first WS trade timestamp for gap-fill
      if (s.wsStartTime === 0) {
        s.wsStartTime = trade.time;
      }

      // Guarantee strictly ascending ms timestamps
      let ms = trade.time;
      if (ms <= s.lastTradeMs) ms = s.lastTradeMs + 0.001;
      s.lastTradeMs = ms;

      s.tradeDots.push({ time: ms, value: p, color: trade.isBuyerMaker ? RED : GREEN });
      useChartStore.getState().setCurrentPrice(p);

      // Volume bucket (1s resolution, key = ms bucket start)
      const bucket = Math.floor(trade.time / 1000) * 1000;
      const vol = s.volumeBuckets.get(bucket);
      if (!vol) {
        s.volumeBuckets.set(bucket, {
          time: bucket,
          value: q,
          buyVolume: trade.isBuyerMaker ? 0 : q,
          sellVolume: trade.isBuyerMaker ? q : 0,
          color: trade.isBuyerMaker ? RED : GREEN,
        });
      } else {
        vol.value += q;
        if (trade.isBuyerMaker) vol.sellVolume += q;
        else vol.buyVolume += q;
        vol.color = vol.buyVolume >= vol.sellVolume ? GREEN : RED;
      }
    },
    [isTradesMode, stateRef],
  );

  const handleKline = useCallback(
    (kline: BinanceKline) => {
      if (isTradesMode) return;
      const s = stateRef.current;

      // Push live bar update to KlineCharts via subscribeBar callback
      if (s.liveBarCallback) {
        s.liveBarCallback({
          timestamp: kline.t,
          open: parseFloat(kline.o),
          high: parseFloat(kline.h),
          low: parseFloat(kline.l),
          close: parseFloat(kline.c),
          volume: parseFloat(kline.v),
        });
      }
      // Keep currentPrice in sync so marker buttons work in candle mode too
      useChartStore.getState().setCurrentPrice(parseFloat(kline.c));

      if (s.autoScroll) {
        s.kchart?.scrollToRealTime();
      }
    },
    [isTradesMode, stateRef],
  );

  useBinanceStream(activeSymbol, timeframe, handleTrade, handleKline);
}


