/**
 * Position types — shared between store, panel, and API.
 */
export interface ClosedPosition {
  id: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entry_price: number;
  exit_price: number;
  quantity: number;
  realized_pnl: number;
  pnl_pct: number;
  fee_total: number;
  entry_time_ms: number;
  exit_time_ms: number;
  entry_order_ids: string;   // JSON array
  exit_order_ids: string;    // JSON array
  duration_ms: number;
}
