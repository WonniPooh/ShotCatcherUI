import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOrderStore } from '../store/orderStore';
import type { OrderEventRaw } from '../types/orders';

const NOW = Date.now();
const H = 3_600_000;

function makeEvent(overrides: Partial<OrderEventRaw> = {}): OrderEventRaw {
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

describe('useOrderStore', () => {
  beforeEach(() => {
    useOrderStore.getState().clear();
  });

  it('starts with empty state', () => {
    const state = useOrderStore.getState();
    expect(state.traces).toEqual([]);
    expect(state.loaded).toBe(false);
    expect(state.loading).toBe(false);
  });

  it('clear resets all state', () => {
    // Manually mutate then clear
    useOrderStore.setState({
      traces: [{ orderId: 1, symbol: 'X', side: 'BUY', orderType: 'LIMIT', segments: [], endMarker: null }],
      loaded: true,
      loading: true,
    });
    useOrderStore.getState().clear();
    const state = useOrderStore.getState();
    expect(state.traces).toEqual([]);
    expect(state.loaded).toBe(false);
    expect(state.loading).toBe(false);
  });

  it('applyLiveEvent adds a new trace for a new order', () => {
    const event = makeEvent();
    useOrderStore.getState().applyLiveEvent(event);

    const state = useOrderStore.getState();
    expect(state.traces).toHaveLength(1);
    expect(state.traces[0].orderId).toBe(1001);
    expect(state.traces[0].segments[0].price).toBe(50000);
    expect(state.traces[0].endMarker).toBeNull(); // still open
  });

  it('applyLiveEvent updates existing trace on fill', () => {
    // First: NEW event
    useOrderStore.getState().applyLiveEvent(makeEvent());
    expect(useOrderStore.getState().traces).toHaveLength(1);
    expect(useOrderStore.getState().traces[0].endMarker).toBeNull();

    // Then: TRADE event
    useOrderStore.getState().applyLiveEvent(makeEvent({
      execution_type: 'TRADE',
      order_status: 'FILLED',
      last_fill_price: 49999,
      transaction_time_ms: NOW - H,
    }));

    const state = useOrderStore.getState();
    expect(state.traces).toHaveLength(1); // same order, updated
    expect(state.traces[0].endMarker).not.toBeNull();
    expect(state.traces[0].endMarker!.type).toBe('entry_fill');
  });

  it('applyLiveEvent deduplicates identical events', () => {
    const event = makeEvent();
    useOrderStore.getState().applyLiveEvent(event);
    useOrderStore.getState().applyLiveEvent(event); // duplicate

    const state = useOrderStore.getState();
    expect(state.traces).toHaveLength(1);
    // Check events cache has only 1 entry
    expect(state.eventsByOrder.get(1001)).toHaveLength(1);
  });

  it('applyLiveEvent handles multiple orders', () => {
    useOrderStore.getState().applyLiveEvent(makeEvent({ order_id: 1001 }));
    useOrderStore.getState().applyLiveEvent(makeEvent({ order_id: 1002, order_price: 51000 }));

    const state = useOrderStore.getState();
    expect(state.traces).toHaveLength(2);
  });

  it('loadSymbol fetches and builds traces', async () => {
    const mockEvents = [makeEvent()];
    const mockAmendments = [
      {
        amendment_id: 7001, order_id: 1001, symbol: 'BTCUSDT',
        client_order_id: 'test', time_ms: NOW - H,
        price_before: 50000, price_after: 49500,
        qty_before: 0.001, qty_after: 0.001, amendment_count: 1,
      },
    ];

    // Mock fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('order-events')) {
        return new Response(JSON.stringify(mockEvents), { status: 200 });
      }
      if (urlStr.includes('order-amendments')) {
        return new Response(JSON.stringify(mockAmendments), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    await useOrderStore.getState().loadSymbol('BTCUSDT');

    const state = useOrderStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.traces).toHaveLength(1);
    expect(state.traces[0].segments).toHaveLength(2); // original + amended

    fetchSpy.mockRestore();
  });

  it('loadSymbol handles API failure gracefully', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('', { status: 503 });
    });

    await useOrderStore.getState().loadSymbol('BTCUSDT');

    const state = useOrderStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.traces).toEqual([]);

    fetchSpy.mockRestore();
  });

  it('loadSymbol handles network error gracefully', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Network error');
    });

    await useOrderStore.getState().loadSymbol('BTCUSDT');

    const state = useOrderStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.traces).toEqual([]);

    fetchSpy.mockRestore();
  });
});
