/**
 * Hook that loads order data from the backend on symbol change
 * and subscribes to live order events via /ws/ui.
 */
import { useEffect, useRef } from 'react';
import { useOrderStore } from '../../store/orderStore';
import { usePositionStore } from '../../store/positionStore';
import { useOpenOrderStore } from '../../store/openOrderStore';
import { useAuthStore } from '../../store/authStore';
import type { OrderEventRaw } from '../../types/orders';
import type { ClosedPosition } from '../../types/positions';
import type { ChartState } from './types';

function _buildWsUiUrl(ticket: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${location.host}/ws/ui`;
  return ticket ? `${base}?ticket=${encodeURIComponent(ticket)}` : base;
}

/**
 * Maps a live WS order event message to an OrderEventRaw.
 * The WS message has the same field names as the DB rows.
 * For AMENDMENT events, also extracts price_before/price_after if present.
 */
function wsEventToOrderEvent(msg: Record<string, unknown>): OrderEventRaw & {
  price_before?: number;
  price_after?: number;
  qty_before?: number;
  qty_after?: number;
} {
  const base: OrderEventRaw = {
    order_id: msg.order_id as number,
    symbol: msg.symbol as string,
    client_order_id: (msg.client_order_id as string) ?? '',
    side: msg.side as 'BUY' | 'SELL',
    order_type: (msg.order_type as string) ?? '',
    execution_type: (msg.execution_type as string) ?? '',
    order_status: (msg.order_status as string) ?? '',
    order_price: (msg.order_price as number) ?? 0,
    stop_price: (msg.stop_price as number) ?? 0,
    order_qty: (msg.order_qty as number) ?? 0,
    last_fill_price: (msg.last_fill_price as number) ?? 0,
    last_fill_qty: (msg.last_fill_qty as number) ?? 0,
    filled_qty_accumulated: (msg.filled_qty_accumulated as number) ?? 0,
    avg_price: (msg.avg_price as number) ?? 0,
    commission: (msg.commission as number) ?? 0,
    commission_asset: (msg.commission_asset as string) ?? '',
    realized_pnl: (msg.realized_pnl as number) ?? 0,
    trade_id: (msg.trade_id as number) ?? 0,
    event_time_ms: (msg.event_time_ms as number) ?? 0,
    transaction_time_ms: (msg.transaction_time_ms as number) ?? 0,
    position_side: (msg.position_side as string) ?? 'BOTH',
    is_maker: (msg.is_maker as number) ?? 0,
    is_reduce_only: (msg.is_reduce_only as number) ?? 0,
    time_in_force: (msg.time_in_force as string) ?? 'GTC',
  };

  // Attach amendment details if present (enriched by backend)
  const result: ReturnType<typeof wsEventToOrderEvent> = base;
  if (typeof msg.price_before === 'number') result.price_before = msg.price_before;
  if (typeof msg.price_after === 'number') result.price_after = msg.price_after;
  if (typeof msg.qty_before === 'number') result.qty_before = msg.qty_before;
  if (typeof msg.qty_after === 'number') result.qty_after = msg.qty_after;

  return result;
}

const ORDER_EVENT_TYPES = new Set([
  'order_placed', 'order_filled', 'order_partially_filled',
  'order_canceled', 'order_modified',
]);

export function useOrderData(
  stateRef: React.RefObject<ChartState>,
  activeSymbol: string,
) {
  const loadFromData = useOrderStore(s => s.loadFromData);
  const clear = useOrderStore(s => s.clear);
  const applyLiveEvent = useOrderStore(s => s.applyLiveEvent);
  const traces = useOrderStore(s => s.traces);

  // Sync traces into mutable ref for canvas rendering (avoids re-render latency)
  if (stateRef.current) {
    stateRef.current.orderTraces = traces;
  }

  // Subscribe to live WS order events and initial order data via /ws/ui.
  // On connect (and reconnect), send get_orders for the current symbol.
  // On symbol change, re-send get_orders without closing/reopening the WS.
  const wsRef = useRef<WebSocket | null>(null);
  const symbolRef = useRef(activeSymbol);
  symbolRef.current = activeSymbol;

  // Clear store and re-request when symbol changes
  useEffect(() => {
    clear();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'get_orders', symbol: activeSymbol }));
    }
  }, [activeSymbol, clear]);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    async function connect() {
      if (cancelled) return;
      const ticket = await useAuthStore.getState().getWsTicket();
      if (cancelled) return;
      const ws = new WebSocket(_buildWsUiUrl(ticket));

      ws.onopen = () => {
        // Clear stale data before re-requesting — prevents duplicates from
        // events that arrived between disconnect and the new get_orders response.
        useOrderStore.getState().clear();
        // Request initial order data for current symbol on every (re)connect
        ws.send(JSON.stringify({ type: 'get_orders', symbol: symbolRef.current }));
        // Request all open orders for the sidebar panel
        ws.send(JSON.stringify({ type: 'get_all_open_orders' }));
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as Record<string, unknown>;

          if (msg.type === 'order_data') {
            // Initial / refresh order data response
            if (msg.symbol !== symbolRef.current) return;
            loadFromData(
              msg.symbol as string,
              (msg.events      as OrderEventRaw[]) ?? [],
              (msg.amendments  as import('../../types/orders').OrderAmendmentRaw[]) ?? [],
              (msg.open_orders as OrderEventRaw[]) ?? [],
            );
            return;
          }

          // All open orders response (cross-symbol, for sidebar panel)
          if (msg.type === 'all_open_orders') {
            useOpenOrderStore.getState().loadAll(
              (msg.orders as OrderEventRaw[]) ?? [],
            );
            return;
          }

          // Account sync completed — order data is now available / updated.
          // Re-request order data for the active symbol.
          if (msg.type === 'account_sync_done') {
            if (msg.symbol === symbolRef.current) {
              useOrderStore.getState().clear();
              ws.send(JSON.stringify({ type: 'get_orders', symbol: symbolRef.current }));
            }
            return;
          }

          // Collector progress events (REST / archive / gap phases).
          // Only show when data-stream is not actively loading chunks.
          if (msg.type === 'progress' && msg.phase === 'trades') {
            if (msg.symbol !== symbolRef.current) return;
            const s = stateRef.current;
            if (s.historyLoaded && !s.loadingMore) {
              const pct = msg.pct as number;
              if (pct >= 100) {
                s.loadingProgress = null;
              } else {
                s.loadingProgress = pct;
                s.loadingLabel = 'Syncing';
              }
            }
            return;
          }

          // Live position closed event — all symbols, forwarded to sidebar
          if (msg.type === 'position_closed') {
            usePositionStore.getState().applyLivePosition(msg as unknown as ClosedPosition);
            return;
          }

          // Live order event push — forward to open orders panel (all symbols)
          if (ORDER_EVENT_TYPES.has(msg.event as string)) {
            const orderEvent = wsEventToOrderEvent(msg);
            useOpenOrderStore.getState().applyLiveEvent(orderEvent);
            // Continue to chart handler (symbol-filtered below)
          }

          // Live order event push — chart rendering (active symbol only)
          if (!ORDER_EVENT_TYPES.has(msg.event as string)) return;
          if (msg.symbol !== symbolRef.current) return;
          const orderEvent = wsEventToOrderEvent(msg);
          applyLiveEvent(orderEvent);
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        reconnectTimer = setTimeout(() => {
          if (wsRef.current === ws) {
            wsRef.current = null;
            connect();
          }
        }, 3000);
      };

      ws.onerror = () => ws.close();
      wsRef.current = ws;
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws) {
        wsRef.current = null;
        ws.close();
      }
    };
  }, [applyLiveEvent, loadFromData]);
}
