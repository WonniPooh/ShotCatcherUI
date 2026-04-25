// Shared types for the chart UI

export interface RawTrade {
  /** Event time in ms */
  time: number;
  /** Price as string from Binance */
  price: string;
  /** Quantity as string */
  qty: string;
  /** true = buyer is maker (i.e. this is a SELL) */
  isBuyerMaker: boolean;
  /** Trade ID */
  id: number;
}

export interface TradePoint {
  time: number; // seconds (UTC) for Lightweight Charts
  value: number;
  color: string;
  qty: number;
}

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumeBar {
  time: number;
  value: number;       // total volume
  buyVolume: number;
  sellVolume: number;
  color: string;
}

export type TimeFrame =
  | 'trades'
  | '1s'
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '4h'
  | '1d';

export type DrawingType = 'hline' | 'ruler';

export interface Drawing {
  id: string;
  type: DrawingType;
  /** price for hline */
  price: number;
  time?: number;
  /** For display */
  label?: string;
}

export interface ChartMarker {
  id: string;
  time: number;
  price: number;
  direction: 'up' | 'down';
  color: 'green' | 'red';
}

export interface SymbolTab {
  symbol: string;
  label: string;
}

/** Binance kline WS payload */
export interface BinanceKline {
  t: number;  // kline start time
  T: number;  // kline close time
  s: string;  // symbol
  i: string;  // interval
  o: string;  // open
  h: string;  // high
  l: string;  // low
  c: string;  // close
  v: string;  // base asset volume
  V: string;  // taker buy base asset volume
  x: boolean; // is this kline closed?
}
