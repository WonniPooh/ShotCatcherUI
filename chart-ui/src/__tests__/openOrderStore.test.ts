import { describe, it, expect, beforeEach } from 'vitest';
import { useOpenOrderStore } from '../store/openOrderStore';
import type { OrderEventRaw } from '../types/orders';

const NOW = Date.now();
const H = 3_600_000;

function makeRawOrder(overrides: Partial<OrderEventRaw> = {}): OrderEventRaw {
  return {
    order_id: 1001,
    symbol: 'BTCUSDT',
    client_order_id: 'test',
    side: 'BUY',
    order_type: 'LIMIT',
    execution_type: 'NEW',
    order_status: 'NEW',
    order_price: 50000,
    stop_price: 0,
    order_qty: 0.001,
    last_fill_price: 0,
    last_fill_qty: 0,
    filled_qty_accumulated: 0,
    avg_price: 0,
    commission: 0,
    commission_asset: '',
    realized_pnl: 0,
    trade_id: 0,
    event_time_ms: NOW - 2 * H,
    transaction_time_ms: NOW - 2 * H,
    position_side: 'BOTH',
    is_maker: 0,
    is_reduce_only: 0,
    time_in_force: 'GTC',
    ...overrides,
  };
}

describe('useOpenOrderStore', () => {
  beforeEach(() => {
    useOpenOrderStore.getState().clear();
  });

  it('starts with empty state', () => {
    const s = useOpenOrderStore.getState();
    expect(s.orders).toEqual([]);
    expect(s.loaded).toBe(false);
  });

  it('clear resets state', () => {
    useOpenOrderStore.getState().loadAll([makeRawOrder()]);
    useOpenOrderStore.getState().clear();
    expect(useOpenOrderStore.getState().orders).toEqual([]);
    expect(useOpenOrderStore.getState().loaded).toBe(false);
  });

  // ── loadAll ────────────────────────────────────────────────────────────

  it('loadAll populates orders from WS response', () => {
    const orders = [
      makeRawOrder({ order_id: 1, transaction_time_ms: NOW - H }),
      makeRawOrder({ order_id: 2, transaction_time_ms: NOW - 2 * H }),
      makeRawOrder({ order_id: 3, symbol: 'ETHUSDT', transaction_time_ms: NOW }),
    ];
    useOpenOrderStore.getState().loadAll(orders);
    const s = useOpenOrderStore.getState();
    expect(s.orders).toHaveLength(3);
    expect(s.loaded).toBe(true);
    // Sorted by most recent first
    expect(s.orders[0].order_id).toBe(3);
    expect(s.orders[1].order_id).toBe(1);
    expect(s.orders[2].order_id).toBe(2);
  });

  it('loadAll with empty array sets loaded=true', () => {
    useOpenOrderStore.getState().loadAll([]);
    const s = useOpenOrderStore.getState();
    expect(s.orders).toEqual([]);
    expect(s.loaded).toBe(true);
  });

  // ── applyLiveEvent ─────────────────────────────────────────────────────

  it('applyLiveEvent adds new order', () => {
    useOpenOrderStore.getState().applyLiveEvent(
      makeRawOrder({ order_id: 100, order_status: 'NEW' }),
    );
    expect(useOpenOrderStore.getState().orders).toHaveLength(1);
    expect(useOpenOrderStore.getState().orders[0].order_id).toBe(100);
  });

  it('applyLiveEvent updates existing order', () => {
    useOpenOrderStore.getState().loadAll([
      makeRawOrder({ order_id: 100, order_price: 50000 }),
    ]);
    useOpenOrderStore.getState().applyLiveEvent(
      makeRawOrder({ order_id: 100, order_price: 51000, order_status: 'PARTIALLY_FILLED' }),
    );
    const s = useOpenOrderStore.getState();
    expect(s.orders).toHaveLength(1);
    expect(s.orders[0].order_price).toBe(51000);
  });

  it('applyLiveEvent removes FILLED order', () => {
    useOpenOrderStore.getState().loadAll([
      makeRawOrder({ order_id: 100 }),
    ]);
    useOpenOrderStore.getState().applyLiveEvent(
      makeRawOrder({ order_id: 100, order_status: 'FILLED', execution_type: 'TRADE' }),
    );
    expect(useOpenOrderStore.getState().orders).toHaveLength(0);
  });

  it('applyLiveEvent removes CANCELED order', () => {
    useOpenOrderStore.getState().loadAll([
      makeRawOrder({ order_id: 100 }),
    ]);
    useOpenOrderStore.getState().applyLiveEvent(
      makeRawOrder({ order_id: 100, order_status: 'CANCELED', execution_type: 'CANCELED' }),
    );
    expect(useOpenOrderStore.getState().orders).toHaveLength(0);
  });

  it('applyLiveEvent removes EXPIRED order', () => {
    useOpenOrderStore.getState().loadAll([
      makeRawOrder({ order_id: 100 }),
    ]);
    useOpenOrderStore.getState().applyLiveEvent(
      makeRawOrder({ order_id: 100, order_status: 'EXPIRED' }),
    );
    expect(useOpenOrderStore.getState().orders).toHaveLength(0);
  });

  it('applyLiveEvent ignores terminal event for unknown order', () => {
    useOpenOrderStore.getState().applyLiveEvent(
      makeRawOrder({ order_id: 999, order_status: 'FILLED' }),
    );
    // Should not add it
    expect(useOpenOrderStore.getState().orders).toHaveLength(0);
  });

  it('applyLiveEvent handles cross-symbol events', () => {
    useOpenOrderStore.getState().loadAll([
      makeRawOrder({ order_id: 1, symbol: 'BTCUSDT' }),
    ]);
    useOpenOrderStore.getState().applyLiveEvent(
      makeRawOrder({ order_id: 2, symbol: 'ETHUSDT', order_status: 'NEW' }),
    );
    const s = useOpenOrderStore.getState();
    expect(s.orders).toHaveLength(2);
    expect(s.orders.map((o) => o.symbol)).toContain('ETHUSDT');
  });

  it('applyLiveEvent inserts new orders at beginning', () => {
    useOpenOrderStore.getState().loadAll([
      makeRawOrder({ order_id: 1, transaction_time_ms: NOW - H }),
    ]);
    useOpenOrderStore.getState().applyLiveEvent(
      makeRawOrder({ order_id: 2, transaction_time_ms: NOW }),
    );
    const ids = useOpenOrderStore.getState().orders.map((o) => o.order_id);
    expect(ids).toEqual([2, 1]);
  });
});
