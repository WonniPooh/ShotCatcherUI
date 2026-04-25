import { useState, useEffect } from 'react';

let cachedSymbols: string[] | null = null;
let fetchPromise: Promise<string[]> | null = null;

async function fetchFuturesSymbols(): Promise<string[]> {
  const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
  if (!res.ok) return [];
  const data = await res.json() as { symbols?: Array<{ symbol: string; status: string; quoteAsset: string; contractType: string }> };
  const symbols: string[] = [];
  for (const s of data.symbols ?? []) {
    if (s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL') {
      symbols.push(s.symbol);
    }
  }
  symbols.sort();
  return symbols;
}

/**
 * Returns a list of all USDT-M perpetual futures symbols from Binance.
 * Fetched once and cached in-memory for the session.
 */
export function useFuturesSymbols(): string[] {
  const [symbols, setSymbols] = useState<string[]>(cachedSymbols ?? []);

  useEffect(() => {
    if (cachedSymbols) return;
    if (!fetchPromise) {
      fetchPromise = fetchFuturesSymbols();
    }
    fetchPromise
      .then((result) => {
        cachedSymbols = result;
        setSymbols(result);
      })
      .catch(() => {});
  }, []);

  return symbols;
}
