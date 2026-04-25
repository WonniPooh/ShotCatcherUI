import { useEffect, useRef, useCallback } from 'react';
import type { RawTrade, BinanceKline, TimeFrame } from '../types/chart';

const BINANCE_WS = 'wss://fstream.binance.com/ws';

type TradeHandler = (trade: RawTrade) => void;
type KlineHandler = (kline: BinanceKline, isClosed: boolean) => void;

/**
 * Manages a single Binance WS connection for a symbol.
 * Supports both raw trade streams and kline streams.
 */
export function useBinanceStream(
  symbol: string,
  timeframe: TimeFrame,
  onTrade: TradeHandler,
  onKline: KlineHandler,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const onTradeRef = useRef(onTrade);
  const onKlineRef = useRef(onKline);

  onTradeRef.current = onTrade;
  onKlineRef.current = onKline;

  const connect = useCallback(() => {
    const sym = symbol.toLowerCase();
    const streams: string[] = [];

    if (timeframe === 'trades' || timeframe === '1s') {
      streams.push(`${sym}@trade`);
    }

    // Always subscribe to kline for the selected interval (except pure trades mode)
    if (timeframe !== 'trades') {
      const interval = timeframe === '1s' ? '1m' : timeframe;
      streams.push(`${sym}@kline_${interval}`);
    }

    const url = `${BINANCE_WS}/${streams.join('/')}`;
    const ws = new WebSocket(url);

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.e === 'trade') {
        const trade: RawTrade = {
          time: msg.T,
          price: msg.p,
          qty: msg.q,
          isBuyerMaker: msg.m,
          id: msg.t,
        };
        onTradeRef.current(trade);
      } else if (msg.e === 'kline') {
        const k = msg.k as BinanceKline;
        onKlineRef.current(k, k.x);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      // Reconnect after 2s
      setTimeout(() => {
        if (wsRef.current === ws) {
          wsRef.current = null;
          connect();
        }
      }, 2000);
    };

    wsRef.current = ws;
  }, [symbol, timeframe]);

  useEffect(() => {
    connect();
    return () => {
      const ws = wsRef.current;
      if (ws) {
        wsRef.current = null;
        ws.close();
      }
    };
  }, [connect]);
}

/**
 * Fetch historical klines from local API (backed by SQLite).
 * Falls back to Binance REST API if local data is unavailable.
 * Returns up to `limit` candles, optionally ending at `endTime` (ms exclusive).
 */
export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 500,
  endTime?: number,
): Promise<BinanceKline[]> {
  // Try local API first
  try {
    const params = new URLSearchParams({ symbol, limit: String(limit) });
    if (endTime != null) params.set('endTime', String(endTime));
    const resp = await fetch(`/api/candles?${params.toString()}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.length > 0) {
        return data.map((c: Record<string, unknown>) => ({
          t: c.open_time_ms as number,
          T: (c.open_time_ms as number) + 59999,
          s: symbol,
          i: interval,
          o: String(c.open),
          h: String(c.high),
          l: String(c.low),
          c: String(c.close),
          v: String(c.volume),
          V: String(c.taker_buy_volume),
          x: true,
        }));
      }
    }
  } catch {
    // Fall through to Binance
  }

  // Fallback: Binance REST
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  });
  if (endTime != null) params.set('endTime', String(endTime));
  const url = `https://fapi.binance.com/fapi/v1/klines?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Kline fetch failed: ${resp.status}`);
  const data = await resp.json();
  return data.map((k: unknown[]) => ({
    t: k[0] as number,
    T: k[6] as number,
    s: symbol,
    i: interval,
    o: k[1] as string,
    h: k[2] as string,
    l: k[3] as string,
    c: k[4] as string,
    v: k[5] as string,
    V: k[9] as string,
    x: true,
  }));
}

