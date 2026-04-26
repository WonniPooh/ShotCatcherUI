/**
 * Open orders store — tracks open orders across ALL symbols via WS.
 *
 * Data source: `/ws/ui` WebSocket (shared with useOrderData).
 * Initial load: browser sends `get_all_open_orders` → receives `all_open_orders`.
 * Live updates: `order_event` pushes from collector (all symbols).
 */
import { create } from 'zustand';
import type { OrderEventRaw } from '../types/orders';

/** Deduplicated open order — latest state per order_id. */
export interface OpenOrder {
  order_id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  order_type: string;
  order_status: string;
  order_price: number;
  stop_price: number;
  order_qty: number;
  filled_qty_accumulated: number;
  event_time_ms: number;
  transaction_time_ms: number;
  time_in_force: string;
  is_reduce_only: number;
  position_side: string;
}

const TERMINAL_STATUSES = new Set([
  'FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED',
]);

function rawToOpenOrder(raw: OrderEventRaw): OpenOrder {
  return {
    order_id: raw.order_id,
    symbol: raw.symbol,
    side: raw.side,
    order_type: raw.order_type,
    order_status: raw.order_status,
    order_price: raw.order_price,
    stop_price: raw.stop_price,
    order_qty: raw.order_qty,
    filled_qty_accumulated: raw.filled_qty_accumulated,
    event_time_ms: raw.event_time_ms,
    transaction_time_ms: raw.transaction_time_ms,
    time_in_force: raw.time_in_force,
    is_reduce_only: raw.is_reduce_only,
    position_side: raw.position_side,
  };
}

interface OpenOrderState {
  orders: OpenOrder[];
  loaded: boolean;

  /** Load from `all_open_orders` WS response. */
  loadAll: (rawOrders: OrderEventRaw[]) => void;

  /** Apply a live order event (any symbol). Updates or removes orders. */
  applyLiveEvent: (event: OrderEventRaw) => void;

  /** Request initial data via WS (sends message on the given socket). */
  requestOpenOrders: (ws: WebSocket) => void;

  clear: () => void;
}

export const useOpenOrderStore = create<OpenOrderState>((set, _get) => ({
  orders: [],
  loaded: false,

  loadAll: (rawOrders) => {
    const orders = rawOrders.map(rawToOpenOrder);
    // Sort: most recent first
    orders.sort((a, b) => b.transaction_time_ms - a.transaction_time_ms);
    set({ orders, loaded: true });
  },

  applyLiveEvent: (event) => {
    set((s) => {
      const isTerminal = TERMINAL_STATUSES.has(event.order_status);

      if (isTerminal) {
        // Remove this order from the list
        const filtered = s.orders.filter((o) => o.order_id !== event.order_id);
        if (filtered.length === s.orders.length) return s; // wasn't tracked
        return { orders: filtered };
      }

      // New or updated order
      const updated = rawToOpenOrder(event);
      const idx = s.orders.findIndex((o) => o.order_id === event.order_id);
      if (idx >= 0) {
        // Update existing
        const orders = [...s.orders];
        orders[idx] = updated;
        return { orders };
      }
      // New order — insert at beginning
      return { orders: [updated, ...s.orders] };
    });
  },

  requestOpenOrders: (ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'get_all_open_orders' }));
    }
  },

  clear: () => set({ orders: [], loaded: false }),
}));
