import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { useChartStore } from '../../store/chartStore';
import { useAuthStore } from '../../store/authStore';
import { GREEN, RED, LIVE_WINDOW_S } from './constants';
import type { ChartState } from './types';
// ── /ws/data-stream protocol types ───────────────────────────────────────────
interface WSTrade {
  agg_trade_id: number;
  trade_ts_ms: number;
  price: number;
  qty: number;
  is_buyer_maker: boolean;
}
interface WSChunkMsg  { type: 'chunk'; symbol: string; trades: WSTrade[];
                        chunk_covered_from: number; chunk_covered_to: number; chunk_seq: number; }
interface WSDoneMsg   { type: 'done';  symbol: string; total: number; }
interface WSErrorMsg  { type: 'error'; symbol: string; message: string; }
type WSDataStreamMsg = WSChunkMsg | WSDoneMsg | WSErrorMsg;

// Default history window: 12 hours on initial load
const HISTORY_WINDOW_MS = 12 * 60 * 60 * 1000;
// Left-side prefetch padding: load this much extra before the viewport edge
// so minor further panning does not immediately trigger another round-trip.
const PREFETCH_PADDING_MS = 60 * 60 * 1000;  // 1 h
// Minimum uncovered gap to bother requesting (avoids micro-loads on tiny drift)
const MIN_GAP_MS = 5 * 60 * 1000;  // 5 min
// Debounce: wait this long after last viewport change before issuing a load
const VIEWPORT_IDLE_MS = 1500;

const _ts = (ms: number): string => {
  const d = new Date(ms);
  return `${d.toISOString().slice(5, 19)}`;  // MM-DDTHH:MM:SS
};
const _dur = (ms: number): string => {
  const h = ms / 3_600_000;
  return h >= 1 ? `${h.toFixed(1)}h` : `${(ms / 60_000).toFixed(0)}m`;
};

export function useHistoryLoader(
  stateRef: MutableRefObject<ChartState>,
  activeSymbol: string,
  isTradesMode: boolean,
): void {
  const isDateRangeMode = useChartStore((s) => s.isDateRangeMode);
  const dateRangeFrom   = useChartStore((s) => s.dateRangeFrom);
  const dateRangeTo     = useChartStore((s) => s.dateRangeTo);

  // ── Unified WS: initial load + scroll-back on the same connection ─────────
  // - Connects immediately on symbol/mode change, no wsStartTime gate.
  // - Initial request: [now-12h, now) (or date-range if picker is active).
  // - After `done`: WS stays open for scroll-back requests.
  // - Scroll-back: when user pans left past earliestTradeTime, sends a new
  //   `load` on the same socket for [earliestTradeTime - SCROLLBACK_MS, earliestTradeTime).
  //   Backend cancels the previous coroutine and starts the new one.
  // - Cleanup: sends `cancel` + closes WS (tab switch / unmount).
  useEffect(() => {
    if (!isTradesMode) return;

    const s = stateRef.current;

    // Reset all state for new symbol
    console.log(`[history] init  symbol=${activeSymbol}  mode=${isTradesMode ? 'trades' : 'candles'}  dateRange=${isDateRangeMode}`);
    s.historyLoaded  = false;
    s.tradeDots      = [];
    s.volumeBuckets  = new Map();
    s.lastTradeMs    = 0;
    s.lodCache       = new Map();
    s.wsStartTime    = 0;
    s.latestDBTradeTime  = 0;
    s.earliestTradeTime  = Infinity;
    s.loadedFrom         = Infinity;
    s.loadingMore        = false;

    const now = Date.now();
    s.viewport = {
      fromTime: now - LIVE_WINDOW_S * 1000,
      toTime:   now + LIVE_WINDOW_S * 1000 * 0.25,
    };

    let cancelled = false;

    // ── Per-request state ────────────────────────────────────────────────────
    // Tracks request bounds for progress % calculation; reset on each sendLoad.
    let requestFromMs = 0;
    let requestToMs   = 0;
    let isScrollBack  = false;  // false = initial load, true = scroll-back

    // ── Merge helper — used for both initial load and scroll-back ────────────
    // Deduplicates, converts to TradeDots, merges into existing tradeDots.
    // Chunks arrive newest-first during initial load (backend streams desc).
    // Each chunk is internally ascending (backend reverses the DB rows).
    //
    // Viewport optimization: if the chunk's time range doesn't overlap the
    // current viewport, the dots are stored but the LOD cache is NOT
    // invalidated — avoiding an expensive re-render for off-screen data.
    const mergeChunk = (raw: WSTrade[], chunkFrom: number, chunkTo: number) => {
      if (cancelled) return;
      const s2 = stateRef.current;

      const seen = new Set<number>();
      const unique = raw.filter(t => {
        if (seen.has(t.agg_trade_id)) return false;
        seen.add(t.agg_trade_id);
        return true;
      });
      unique.sort((a, b) => a.trade_ts_ms - b.trade_ts_ms || a.agg_trade_id - b.agg_trade_id);

      const dots: ChartState['tradeDots'] = [];
      let lastMs = 0;

      for (const t of unique) {
        const p = t.price;
        const q = t.qty;
        if (!(p > 0) || !isFinite(p)) continue;
        let ms = t.trade_ts_ms;
        if (ms <= lastMs) ms = lastMs + 0.001;
        lastMs = ms;

        dots.push({ time: ms, value: p, color: t.is_buyer_maker ? RED : GREEN });

        const bucket = Math.floor(t.trade_ts_ms / 1000) * 1000;
        const vol = s2.volumeBuckets.get(bucket);
        if (!vol) {
          s2.volumeBuckets.set(bucket, {
            time: bucket, value: q,
            buyVolume:  t.is_buyer_maker ? 0 : q,
            sellVolume: t.is_buyer_maker ? q : 0,
            color: t.is_buyer_maker ? RED : GREEN,
          });
        } else {
          vol.value += q;
          if (t.is_buyer_maker) vol.sellVolume += q;
          else                  vol.buyVolume  += q;
          vol.color = vol.buyVolume >= vol.sellVolume ? GREEN : RED;
        }
      }

      if (dots.length === 0) return;

      // Merge into tradeDots array maintaining ascending time order.
      // New chunks can land at any position (newest-first initial load,
      // scroll-back prepend, etc.), so we insert sorted and fixup.
      const existing = s2.tradeDots;
      let merged: ChartState['tradeDots'];

      if (existing.length === 0) {
        merged = dots;
      } else if (dots[dots.length - 1].time <= existing[0].time) {
        // Entire chunk is older → prepend
        merged = [...dots, ...existing];
      } else if (dots[0].time >= existing[existing.length - 1].time) {
        // Entire chunk is newer → append
        merged = [...existing, ...dots];
      } else {
        // Interleaved (rare: live trades arrived between chunks) → merge-sort
        merged = [...existing, ...dots];
        merged.sort((a, b) => a.time - b.time);
      }

      // Enforce strictly ascending times (identical timestamps from exchange)
      for (let i = 1; i < merged.length; i++) {
        if (merged[i].time <= merged[i - 1].time)
          merged[i] = { ...merged[i], time: merged[i - 1].time + 0.001 };
      }
      s2.tradeDots = merged;

      // Update bookkeeping
      s2.earliestTradeTime = Math.min(s2.earliestTradeTime, dots[0].time);
      s2.loadedFrom = Math.min(s2.loadedFrom, dots[0].time);
      s2.latestDBTradeTime = Math.max(s2.latestDBTradeTime, dots[dots.length - 1].time);
      useChartStore.getState().setCurrentPrice(merged[merged.length - 1].value);

      // Invalidate LOD cache only if chunk overlaps the visible viewport;
      // off-screen chunks are stored but don't trigger a re-render.
      const vp = s2.viewport;
      if (chunkTo >= vp.fromTime && chunkFrom <= vp.toTime) {
        s2.lodCache.clear();
      }
    };

    // ── WebSocket ────────────────────────────────────────────────────────────
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

    // We need a WS ticket before connecting. Use a local holder so
    // the rest of the synchronous setup (sendLoad, onopen, etc.) can
    // reference `ws` via the mutable variable.
    let ws: WebSocket;

    const sendLoad = (fromMs: number, toMs: number, scrollBack: boolean) => {
      requestFromMs = fromMs;
      requestToMs   = toMs;
      isScrollBack  = scrollBack;
      stateRef.current.loadingProgress = 0;
      if (scrollBack) stateRef.current.loadingMore = true;
      ws.send(JSON.stringify({ type: 'load', symbol: activeSymbol, from_ms: fromMs, to_ms: toMs }));
      console.log(
        `[history] → ${scrollBack ? 'SCROLL-BACK' : 'INITIAL'} load  [${_ts(fromMs)} → ${_ts(toMs)}] (${_dur(toMs - fromMs)})  symbol=${activeSymbol}`,
      );
    };

    // Create WS connection with ticket auth (async init, handlers below use `ws`)
    const initWs = async () => {
      if (cancelled) return;
      const ticket = await useAuthStore.getState().getWsTicket();
      if (cancelled) return;
      const ticketParam = ticket ? `?ticket=${encodeURIComponent(ticket)}` : '';
      ws = new WebSocket(`${proto}//${location.host}/ws/data-stream${ticketParam}`);
      ws.onopen = onWsOpen;
      ws.onmessage = onWsMessage;
      ws.onerror = onWsError;
      ws.onclose = onWsClose;
    };

    const onWsOpen = () => {
      if (cancelled) { ws.close(); return; }
      console.log(`[history] WS connected to /ws/data-stream  symbol=${activeSymbol}`);

      // Date-range mode: use picker bounds immediately.
      if (isDateRangeMode && dateRangeFrom != null && dateRangeTo != null) {
        sendLoad(dateRangeFrom, dateRangeTo, false);
        return;
      }

      // Normal mode: wait for the first live WS trade so we load history
      // up to exactly that timestamp — zero gap, zero overlap.
      const WS_WAIT_MS  = 15000; // max wait for first live trade
      const WS_POLL_MS  = 50;
      const waitStart   = Date.now();

      const pollForWsStart = () => {
        if (cancelled) return;
        const wsTs = stateRef.current.wsStartTime;
        if (wsTs > 0) {
          console.log(`[history] got wsStartTime=${_ts(wsTs)} after ${Date.now() - waitStart}ms`);
          sendLoad(wsTs - HISTORY_WINDOW_MS, wsTs, false);
          return;
        }
        if (Date.now() - waitStart < WS_WAIT_MS) {
          setTimeout(pollForWsStart, WS_POLL_MS);
          return;
        }
        // Timeout — fall back to Date.now()
        const fallback = Date.now();
        console.log(`[history] wsStartTime not set after ${WS_WAIT_MS}ms, using Date.now()=${_ts(fallback)}`);
        sendLoad(fallback - HISTORY_WINDOW_MS, fallback, false);
      };
      pollForWsStart();
    };

    const onWsMessage = (event: MessageEvent<string>) => {
      if (cancelled) return;
      let msg: WSDataStreamMsg;
      try { msg = JSON.parse(event.data) as WSDataStreamMsg; } catch { return; }

      if (msg.type === 'chunk') {
        const span = requestToMs - requestFromMs;
        if (span > 0) {
          // Progress: chunks arrive newest-first, so coverage grows from to_ms toward from_ms
          stateRef.current.loadingProgress = Math.min(
            99,
            Math.round(((requestToMs - msg.chunk_covered_from) / span) * 100),
          );
          stateRef.current.loadingLabel = 'Loading';
        }
        const s2 = stateRef.current;
        const vp = s2.viewport;
        const overlapsViewport = msg.chunk_covered_to >= vp.fromTime && msg.chunk_covered_from <= vp.toTime;
        console.log(
          `[history] ← chunk #${msg.chunk_seq}: ${msg.trades.length} trades` +
          `  [${_ts(msg.chunk_covered_from)}..${_ts(msg.chunk_covered_to)}]` +
          `  progress=${stateRef.current.loadingProgress}%` +
          `  viewport=${overlapsViewport ? 'HIT' : 'off-screen'}` +
          `  tradeDots=${s2.tradeDots.length}`,
        );
        mergeChunk(msg.trades, msg.chunk_covered_from, msg.chunk_covered_to);
        console.log(
          `[history]   merged → tradeDots=${s2.tradeDots.length}` +
          `  earliest=${s2.earliestTradeTime === Infinity ? '∞' : _ts(s2.earliestTradeTime)}` +
          `  latest=${s2.latestDBTradeTime ? _ts(s2.latestDBTradeTime) : 'none'}`,
        );
      } else if (msg.type === 'done') {
        const s2 = stateRef.current;
        console.log(
          `[history] ← DONE  total=${msg.total}  tradeDots=${s2.tradeDots.length}` +
          `  range=[${s2.earliestTradeTime === Infinity ? '∞' : _ts(s2.earliestTradeTime)} → ${s2.latestDBTradeTime ? _ts(s2.latestDBTradeTime) : 'none'}]`,
        );
        stateRef.current.loadingProgress = null;
        stateRef.current.loadingMore     = false;
        if (!isScrollBack) stateRef.current.historyLoaded = true;
        // WS stays open — scroll-back will send new requests on it
      } else if (msg.type === 'error') {
        console.error('[history] ← ERROR:', msg.message);
        stateRef.current.loadingProgress = null;
        stateRef.current.loadingMore     = false;
        if (!stateRef.current.historyLoaded) stateRef.current.historyLoaded = true;
      }
    };

    const onWsError = (e: Event) => {
      console.error('[history] WS error', e);
      stateRef.current.loadingProgress = null;
      stateRef.current.loadingMore     = false;
      if (!cancelled && !stateRef.current.historyLoaded) stateRef.current.historyLoaded = true;
    };

    const onWsClose = (e: CloseEvent) => {
      console.log(`[history] WS closed  code=${e.code}  clean=${e.wasClean}  tradeDots=${stateRef.current.tradeDots.length}`);
      stateRef.current.loadingMore = false;
      if (!cancelled && !stateRef.current.historyLoaded) stateRef.current.historyLoaded = true;
    };

    // Start async WS init (fetches ticket, then opens connection)
    initWs();

    // ── Debounced viewport watcher ───────────────────────────────────────────
    // Checks every 200ms whether the viewport left edge has moved past the
    // loaded range. Fires a load request only after VIEWPORT_IDLE_MS of no
    // viewport change, avoiding churn during active pan/zoom.
    // Requests [viewport.fromTime - PREFETCH_PADDING_MS, loadedFrom) so
    // minor further panning does not immediately trigger another request.
    let lastViewportFrom = stateRef.current.viewport.fromTime;
    let lastChangeAt     = 0;  // 0 = no change detected yet

    const scrollPollId = setInterval(() => {
      if (cancelled) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      const s2 = stateRef.current;
      if (!s2.historyLoaded) return;
      if (s2.loadingMore) return;  // request in-flight

      // Detect viewport movement
      if (s2.viewport.fromTime !== lastViewportFrom) {
        lastViewportFrom = s2.viewport.fromTime;
        lastChangeAt     = Date.now();
        return;  // wait for idle
      }

      // Not yet idle or no change at all
      if (lastChangeAt === 0) return;
      if (Date.now() - lastChangeAt < VIEWPORT_IDLE_MS) return;

      // Check whether viewport left edge is outside our loaded range
      const gap = s2.loadedFrom - s2.viewport.fromTime;
      if (gap < MIN_GAP_MS) {
        lastChangeAt = 0;  // satisfied, reset so we don't keep re-evaluating
        return;
      }

      // Request uncovered range with prefetch padding on the left
      const toMs   = s2.loadedFrom;
      const fromMs = s2.viewport.fromTime - PREFETCH_PADDING_MS;
      lastChangeAt = 0;  // reset so next pan starts a new idle countdown
      console.log(
        `[history] scroll-back triggered  gap=${_dur(gap)}  loadedFrom=${_ts(s2.loadedFrom)}` +
        `  viewport.from=${_ts(s2.viewport.fromTime)}  requesting [${_ts(fromMs)} → ${_ts(toMs)}]`,
      );
      sendLoad(fromMs, toMs, true);
    }, 200);

    return () => {
      cancelled = true;
      clearInterval(scrollPollId);
      console.log(`[history] cleanup  symbol=${activeSymbol}  tradeDots=${stateRef.current.tradeDots.length}`);
      stateRef.current.loadingProgress = null;
      stateRef.current.loadingMore     = false;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'cancel', symbol: activeSymbol })); } catch { /* ignore */ }
      }
      if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    };
  }, [activeSymbol, isTradesMode, isDateRangeMode, dateRangeFrom, dateRangeTo, stateRef]);
}
