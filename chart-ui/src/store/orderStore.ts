/**
 * Zustand store for order visualization data.
 *
 * Holds order traces (built from events + amendments) for the active symbol.
 * Updated on symbol change (REST fetch) and live WS events.
 */
import { create } from 'zustand';
import type { OrderTrace, OrderEventRaw, OrderAmendmentRaw } from '../types/orders';
import { buildAllTraces, buildOrderTrace } from '../components/chart/orderTraceBuilder';

interface OrderState {
  /** Active symbol's order traces (rendered on chart) */
  traces: OrderTrace[];
  /** Raw events cache per order_id (for re-building on amendment) */
  eventsByOrder: Map<number, OrderEventRaw[]>;
  /** Raw amendments cache per order_id */
  amendmentsByOrder: Map<number, OrderAmendmentRaw[]>;
  /** Whether initial data has been loaded */
  loaded: boolean;
  /** Loading indicator */
  loading: boolean;

  /** Load order data from REST API for a symbol */
  loadSymbol: (symbol: string) => Promise<void>;
  /** Load order data synchronously from a WS response (replaces REST loadSymbol) */
  loadFromData: (
    symbol: string,
    events: OrderEventRaw[],
    amendments: OrderAmendmentRaw[],
    openOrders: OrderEventRaw[],
  ) => void;
  /** Apply a live WS order event (creates synthetic amendment for instant display) */
  applyLiveEvent: (event: OrderEventRaw & {
    price_before?: number;
    price_after?: number;
    qty_before?: number;
    qty_after?: number;
  }) => void;
  /** Clear all data (on symbol change) */
  clear: () => void;
}

const API_BASE = '/api';

export const useOrderStore = create<OrderState>((set, get) => ({
  traces: [],
  eventsByOrder: new Map(),
  amendmentsByOrder: new Map(),
  loaded: false,
  loading: false,

  loadSymbol: async (symbol: string) => {
    set({ loading: true, loaded: false });
    try {
      const [eventsResp, amendsResp, openResp] = await Promise.all([
        fetch(`${API_BASE}/order-events?symbol=${encodeURIComponent(symbol)}`),
        fetch(`${API_BASE}/order-amendments?symbol=${encodeURIComponent(symbol)}`),
        fetch(`${API_BASE}/open-orders?symbol=${encodeURIComponent(symbol)}`),
      ]);

      if (!eventsResp.ok || !amendsResp.ok) {
        // Backend not available — silently continue without order data
        set({ traces: [], loaded: true, loading: false });
        return;
      }

      const events: OrderEventRaw[] = await eventsResp.json();
      const amendments: OrderAmendmentRaw[] = await amendsResp.json();

      // --- Diagnostic logging: detect gaps in order event timeline ---
      const sortedEvents = [...events].sort((a, b) => a.transaction_time_ms - b.transaction_time_ms);
      if (sortedEvents.length > 0) {
        const first = new Date(sortedEvents[0].transaction_time_ms).toISOString();
        const last = new Date(sortedEvents[sortedEvents.length - 1].transaction_time_ms).toISOString();
        console.log(`[orderStore] ${symbol}: loaded ${events.length} events, ${amendments.length} amendments  range=[${first} → ${last}]`);

        // Find gaps > 30 min between consecutive events
        for (let i = 1; i < sortedEvents.length; i++) {
          const gap = sortedEvents[i].transaction_time_ms - sortedEvents[i - 1].transaction_time_ms;
          if (gap > 30 * 60 * 1000) {
            const gapStart = new Date(sortedEvents[i - 1].transaction_time_ms).toISOString();
            const gapEnd = new Date(sortedEvents[i].transaction_time_ms).toISOString();
            console.warn(
              `[orderStore] ${symbol}: GAP detected — ${(gap / 3_600_000).toFixed(1)}h — ` +
              `from ${gapStart} to ${gapEnd}  ` +
              `(order ${sortedEvents[i - 1].order_id} → order ${sortedEvents[i].order_id})`
            );
          }
        }

        // Per-order event count summary for orders with amendments
        const orderIds = new Set(amendments.map(a => a.order_id));
        for (const oid of orderIds) {
          const oEvents = events.filter(e => e.order_id === oid);
          const oAmends = amendments.filter(a => a.order_id === oid);
          if (oEvents.length > 0) {
            const oFirst = new Date(Math.min(...oEvents.map(e => e.transaction_time_ms))).toISOString();
            const oLast = new Date(Math.max(...oEvents.map(e => e.transaction_time_ms))).toISOString();
            // Check for gaps within this order's events
            const sorted = [...oEvents].sort((a, b) => a.transaction_time_ms - b.transaction_time_ms);
            let maxGapMs = 0;
            for (let i = 1; i < sorted.length; i++) {
              maxGapMs = Math.max(maxGapMs, sorted[i].transaction_time_ms - sorted[i - 1].transaction_time_ms);
            }
            if (maxGapMs > 10 * 60 * 1000) {
              console.warn(
                `[orderStore] order ${oid}: ${oEvents.length} events, ${oAmends.length} amends  ` +
                `range=[${oFirst} → ${oLast}]  MAX GAP: ${(maxGapMs / 60_000).toFixed(0)}min`
              );
            }
          }
        }
      } else {
        console.log(`[orderStore] ${symbol}: no order events loaded`);
      }

      // Build confirmed-open set from /open-orders.
      // Only orders in this set get Infinity segments; others with missing
      // terminal events are capped at their last known event time.
      let openOrderIds: Set<number> | undefined;
      if (openResp.ok) {
        const openEvents: OrderEventRaw[] = await openResp.json();
        openOrderIds = new Set(openEvents.map(e => e.order_id));
      }

      // Build caches
      const eventsByOrder = new Map<number, OrderEventRaw[]>();
      for (const e of events) {
        const arr = eventsByOrder.get(e.order_id);
        if (arr) arr.push(e);
        else eventsByOrder.set(e.order_id, [e]);
      }

      const amendmentsByOrder = new Map<number, OrderAmendmentRaw[]>();
      for (const a of amendments) {
        const arr = amendmentsByOrder.get(a.order_id);
        if (arr) arr.push(a);
        else amendmentsByOrder.set(a.order_id, [a]);
      }

      const traces = buildAllTraces(events, amendments, openOrderIds);

      set({ traces, eventsByOrder, amendmentsByOrder, loaded: true, loading: false });
    } catch {
      // Network error — continue without order data
      set({ traces: [], loaded: true, loading: false });
    }
  },

  loadFromData: (symbol, events, amendments, openOrders) => {
    const openOrderIds = new Set(openOrders.map(e => e.order_id));

    const sortedEvents = [...events].sort((a, b) => a.transaction_time_ms - b.transaction_time_ms);
    if (sortedEvents.length > 0) {
      const first = new Date(sortedEvents[0].transaction_time_ms).toISOString();
      const last  = new Date(sortedEvents[sortedEvents.length - 1].transaction_time_ms).toISOString();
      console.log(`[orderStore] ${symbol}: ws loaded ${events.length} events, ${amendments.length} amendments  range=[${first} → ${last}]`);
    } else {
      console.log(`[orderStore] ${symbol}: ws loaded — no order events`);
    }

    const eventsByOrder = new Map<number, OrderEventRaw[]>();
    for (const e of events) {
      const arr = eventsByOrder.get(e.order_id);
      if (arr) arr.push(e);
      else eventsByOrder.set(e.order_id, [e]);
    }

    const amendmentsByOrder = new Map<number, OrderAmendmentRaw[]>();
    for (const a of amendments) {
      const arr = amendmentsByOrder.get(a.order_id);
      if (arr) arr.push(a);
      else amendmentsByOrder.set(a.order_id, [a]);
    }

    const traces = buildAllTraces(events, amendments, openOrderIds);
    set({ traces, eventsByOrder, amendmentsByOrder, loaded: true, loading: false });
  },

  applyLiveEvent: (event) => {
    const { eventsByOrder, amendmentsByOrder } = get();

    // Update events cache
    const orderEvents = eventsByOrder.get(event.order_id) ?? [];
    // Check for duplicate by transaction_time_ms + execution_type
    const isDup = orderEvents.some(
      e => e.transaction_time_ms === event.transaction_time_ms &&
           e.execution_type === event.execution_type,
    );
    if (!isDup) {
      orderEvents.push(event);
      eventsByOrder.set(event.order_id, orderEvents);
    }

    // Handle AMENDMENT events: create a synthetic OrderAmendmentRaw for
    // instant display.  Real data from REST replaces this via
    // applyAmendmentSync within ~100ms.
    if (event.execution_type === 'AMENDMENT' && event.order_price > 0) {
      const existingAmends = amendmentsByOrder.get(event.order_id) ?? [];
      const isAmdDup = existingAmends.some(a => a.time_ms === event.transaction_time_ms);
      if (!isAmdDup) {
        const lastPrice = existingAmends.length
          ? existingAmends[existingAmends.length - 1].price_after
          : ((): number => {
              const t = get().traces.find(t => t.orderId === event.order_id);
              return t?.segments.length
                ? t.segments[t.segments.length - 1].price
                : event.order_price;
            })();
        const syntheticAmend: OrderAmendmentRaw = {
          amendment_id: -event.transaction_time_ms,  // negative = synthetic
          order_id: event.order_id,
          symbol: event.symbol,
          client_order_id: event.client_order_id,
          time_ms: event.transaction_time_ms,
          price_before: event.price_before ?? lastPrice,
          price_after: event.price_after ?? event.order_price,
          qty_before: event.qty_before ?? event.order_qty,
          qty_after: event.qty_after ?? event.order_qty,
          amendment_count: existingAmends.length + 1,
        };
        amendmentsByOrder.set(event.order_id, [...existingAmends, syntheticAmend]);
      }
    }

    // Rebuild trace for this order.
    // Derive openOrderIds from the store to avoid Infinity segments for
    // orders that are actually closed (missed terminal WS event).
    const TERMINAL = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH']);
    const openOrderIds = new Set<number>();
    for (const [oid, evts] of eventsByOrder) {
      const isTerminal = evts.some(e => TERMINAL.has(e.order_status));
      if (!isTerminal) openOrderIds.add(oid);
    }

    const orderAmendments = amendmentsByOrder.get(event.order_id) ?? [];
    const newTrace = buildOrderTrace(orderEvents, orderAmendments, openOrderIds);
    if (!newTrace) return;

    set(state => {
      const idx = state.traces.findIndex(t => t.orderId === event.order_id);
      const updated = [...state.traces];
      if (idx >= 0) {
        updated[idx] = newTrace;
      } else {
        updated.push(newTrace);
      }
      return { traces: updated };
    });
  },

  clear: () => set({
    traces: [],
    eventsByOrder: new Map(),
    amendmentsByOrder: new Map(),
    loaded: false,
    loading: false,
  }),
}));
