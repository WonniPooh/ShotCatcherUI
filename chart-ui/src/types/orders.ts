// Types for order visualization on the chart

/** Raw order event from backend /api/order-events */
export interface OrderEventRaw {
  order_id: number;
  symbol: string;
  client_order_id: string;
  side: 'BUY' | 'SELL';
  order_type: string;
  execution_type: string;
  order_status: string;
  order_price: number;
  stop_price: number;
  order_qty: number;
  last_fill_price: number;
  last_fill_qty: number;
  filled_qty_accumulated: number;
  avg_price: number;
  commission: number;
  commission_asset: string;
  realized_pnl: number;
  trade_id: number;
  event_time_ms: number;
  transaction_time_ms: number;
  position_side: string;
  is_maker: number;
  is_reduce_only: number;
  time_in_force: string;
}

/** Raw order amendment from backend /api/order-amendments */
export interface OrderAmendmentRaw {
  amendment_id: number;
  order_id: number;
  symbol: string;
  client_order_id: string;
  time_ms: number;
  price_before: number;
  price_after: number;
  qty_before: number;
  qty_after: number;
  amendment_count: number;
}

/** A horizontal segment in an order trace polyline */
export interface OrderTraceSegment {
  startTime: number;  // ms
  endTime: number;    // ms (Infinity if extends to viewport edge)
  price: number;
}

/** End marker type for terminal order events */
export type OrderEndType = 'entry_fill' | 'exit_fill' | 'cancel';

/** End marker on an order trace */
export interface OrderEndMarker {
  time: number;   // ms
  price: number;
  type: OrderEndType;
  side: 'BUY' | 'SELL';
}

/** Complete order trace: polyline segments + optional end marker */
export interface OrderTrace {
  orderId: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  segments: OrderTraceSegment[];
  endMarker: OrderEndMarker | null;  // null = still open
}

/** Color mapping for order types */
export const ORDER_TYPE_COLORS: Record<string, string> = {
  LIMIT:                 '#3b82f6',   // blue
  STOP_MARKET:           '#f97316',   // orange
  TAKE_PROFIT_MARKET:    '#22c55e',   // green
  STOP:                  '#a855f7',   // purple (stop-limit)
  TAKE_PROFIT:           '#06b6d4',   // cyan
  TRAILING_STOP_MARKET:  '#6b7280',   // gray
  MARKET:                '#eab308',   // yellow
};

export const ORDER_COLOR_DEFAULT = '#6b7280';  // gray fallback

/** Live WS event from /ws/ui for order updates */
export interface OrderWsEvent {
  event: string;
  symbol: string;
  order_id: number;
  client_order_id: string;
  side: 'BUY' | 'SELL';
  order_type: string;
  execution_type: string;
  order_status: string;
  order_price: number;
  stop_price: number;
  order_qty: number;
  last_fill_price: number;
  last_fill_qty: number;
  filled_qty_accumulated: number;
  avg_price: number;
  commission: number;
  commission_asset: string;
  realized_pnl: number;
  trade_id: number;
  event_time_ms: number;
  transaction_time_ms: number;
}
