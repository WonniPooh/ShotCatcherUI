import { describe, it, expect } from 'vitest';
import { buildOrderTrace, buildAllTraces } from '../components/chart/orderTraceBuilder';
import type { OrderEventRaw, OrderAmendmentRaw } from '../types/orders';

// ── Helpers ─────────────────────────────────────────────────────────

const NOW = Date.now();
const H = 3_600_000; // 1 hour in ms

function makeEvent(overrides: Partial<OrderEventRaw> = {}): OrderEventRaw {
  return {
    order_id: 1001,
    symbol: 'BTCUSDT',
    client_order_id: 'test_order',
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

function makeAmendment(overrides: Partial<OrderAmendmentRaw> = {}): OrderAmendmentRaw {
  return {
    amendment_id: 7001,
    order_id: 1001,
    symbol: 'BTCUSDT',
    client_order_id: 'test_order',
    time_ms: NOW - H,
    price_before: 50000,
    price_after: 49500,
    qty_before: 0.001,
    qty_after: 0.001,
    amendment_count: 1,
    ...overrides,
  };
}

// ── buildOrderTrace ─────────────────────────────────────────────────

describe('buildOrderTrace', () => {
  it('returns null for empty events', () => {
    expect(buildOrderTrace([], [])).toBeNull();
  });

  it('builds a simple open order with no amendments', () => {
    const events = [makeEvent()];
    const trace = buildOrderTrace(events, []);

    expect(trace).not.toBeNull();
    expect(trace!.orderId).toBe(1001);
    expect(trace!.symbol).toBe('BTCUSDT');
    expect(trace!.side).toBe('BUY');
    expect(trace!.orderType).toBe('LIMIT');
    expect(trace!.segments).toHaveLength(1);
    expect(trace!.segments[0].price).toBe(50000);
    expect(trace!.segments[0].startTime).toBe(NOW - 2 * H);
    expect(trace!.segments[0].endTime).toBe(Infinity); // still open
    expect(trace!.endMarker).toBeNull();
  });

  it('builds a filled order with no amendments', () => {
    const events = [
      makeEvent(),
      makeEvent({
        execution_type: 'TRADE',
        order_status: 'FILLED',
        last_fill_price: 49999.5,
        last_fill_qty: 0.001,
        filled_qty_accumulated: 0.001,
        avg_price: 49999.5,
        trade_id: 5001,
        transaction_time_ms: NOW - H,
      }),
    ];
    const trace = buildOrderTrace(events, []);

    expect(trace).not.toBeNull();
    expect(trace!.segments).toHaveLength(1);
    expect(trace!.segments[0].price).toBe(50000);
    expect(trace!.segments[0].startTime).toBe(NOW - 2 * H);
    expect(trace!.segments[0].endTime).toBe(NOW - H);
    expect(trace!.endMarker).not.toBeNull();
    expect(trace!.endMarker!.type).toBe('entry_fill');
    expect(trace!.endMarker!.price).toBe(49999.5);
    expect(trace!.endMarker!.side).toBe('BUY');
  });

  it('builds an order with one amendment', () => {
    const events = [makeEvent()];
    const amendments = [makeAmendment()];
    const trace = buildOrderTrace(events, amendments);

    expect(trace).not.toBeNull();
    expect(trace!.segments).toHaveLength(2);
    // First segment: original price until amendment
    expect(trace!.segments[0].price).toBe(50000);
    expect(trace!.segments[0].startTime).toBe(NOW - 2 * H);
    expect(trace!.segments[0].endTime).toBe(NOW - H);
    // Second segment: amended price, open-ended
    expect(trace!.segments[1].price).toBe(49500);
    expect(trace!.segments[1].startTime).toBe(NOW - H);
    expect(trace!.segments[1].endTime).toBe(Infinity);
    expect(trace!.endMarker).toBeNull();
  });

  it('builds an order with multiple amendments', () => {
    const events = [makeEvent()];
    const amendments = [
      makeAmendment({ time_ms: NOW - 90 * 60000, price_before: 50000, price_after: 49500 }),
      makeAmendment({
        amendment_id: 7002, time_ms: NOW - 60 * 60000,
        price_before: 49500, price_after: 49000, amendment_count: 2,
      }),
      makeAmendment({
        amendment_id: 7003, time_ms: NOW - 30 * 60000,
        price_before: 49000, price_after: 48500, amendment_count: 3,
      }),
    ];
    const trace = buildOrderTrace(events, amendments);

    expect(trace!.segments).toHaveLength(4);
    expect(trace!.segments[0].price).toBe(50000);
    expect(trace!.segments[1].price).toBe(49500);
    expect(trace!.segments[2].price).toBe(49000);
    expect(trace!.segments[3].price).toBe(48500);
    expect(trace!.segments[3].endTime).toBe(Infinity);
  });

  it('builds a modified then filled order', () => {
    const events = [
      makeEvent(),
      makeEvent({
        execution_type: 'TRADE',
        order_status: 'FILLED',
        order_price: 49500, // Binance sends current (post-amendment) order price
        last_fill_price: 49500,
        last_fill_qty: 0.001,
        filled_qty_accumulated: 0.001,
        avg_price: 49500,
        trade_id: 5001,
        transaction_time_ms: NOW - 30 * 60000,
      }),
    ];
    const amendments = [
      makeAmendment({ time_ms: NOW - H, price_before: 50000, price_after: 49500 }),
    ];
    const trace = buildOrderTrace(events, amendments);

    expect(trace!.segments).toHaveLength(2);
    expect(trace!.segments[0].price).toBe(50000);
    expect(trace!.segments[1].price).toBe(49500);
    expect(trace!.segments[1].endTime).toBe(NOW - 30 * 60000);
    expect(trace!.endMarker!.type).toBe('entry_fill');
    expect(trace!.endMarker!.price).toBe(49500);
  });

  it('builds a canceled order', () => {
    const events = [
      makeEvent(),
      makeEvent({
        execution_type: 'CANCELED',
        order_status: 'CANCELED',
        transaction_time_ms: NOW - H,
      }),
    ];
    const trace = buildOrderTrace(events, []);

    expect(trace!.segments).toHaveLength(1);
    expect(trace!.segments[0].endTime).toBe(NOW - H);
    expect(trace!.endMarker!.type).toBe('cancel');
  });

  it('marks exit fill for SL/TP orders', () => {
    const events = [
      makeEvent({ order_type: 'STOP_MARKET', stop_price: 48000, order_price: 0 }),
      makeEvent({
        order_type: 'STOP_MARKET',
        execution_type: 'TRADE',
        order_status: 'FILLED',
        last_fill_price: 47999,
        stop_price: 48000,
        transaction_time_ms: NOW - H,
      }),
    ];
    const trace = buildOrderTrace(events, []);

    expect(trace!.segments[0].price).toBe(48000); // stop price used
    expect(trace!.endMarker!.type).toBe('exit_fill');
    expect(trace!.endMarker!.price).toBe(47999);
  });

  it('marks exit fill for reduce-only orders', () => {
    const events = [
      makeEvent({ is_reduce_only: 1 }),
      makeEvent({
        execution_type: 'TRADE',
        order_status: 'FILLED',
        is_reduce_only: 1,
        last_fill_price: 50100,
        transaction_time_ms: NOW - H,
      }),
    ];
    const trace = buildOrderTrace(events, []);
    expect(trace!.endMarker!.type).toBe('exit_fill');
  });

  it('uses stop_price for TAKE_PROFIT_MARKET orders', () => {
    const events = [
      makeEvent({
        order_type: 'TAKE_PROFIT_MARKET',
        order_price: 0,
        stop_price: 55000,
      }),
    ];
    const trace = buildOrderTrace(events, []);
    expect(trace!.segments[0].price).toBe(55000);
  });

  it('handles expired order status', () => {
    const events = [
      makeEvent(),
      makeEvent({
        execution_type: 'EXPIRED',
        order_status: 'EXPIRED',
        transaction_time_ms: NOW - H,
      }),
    ];
    const trace = buildOrderTrace(events, []);
    expect(trace!.endMarker!.type).toBe('cancel');
  });

  it('handles EXPIRED_IN_MATCH status', () => {
    const events = [
      makeEvent(),
      makeEvent({
        execution_type: 'EXPIRED',
        order_status: 'EXPIRED_IN_MATCH',
        transaction_time_ms: NOW - H,
      }),
    ];
    const trace = buildOrderTrace(events, []);
    expect(trace!.endMarker!.type).toBe('cancel');
  });

  it('handles events arriving out of order', () => {
    // TRADE event arrives before NEW event in the array
    const events = [
      makeEvent({
        execution_type: 'TRADE',
        order_status: 'FILLED',
        last_fill_price: 49999,
        transaction_time_ms: NOW - H,
      }),
      makeEvent({ transaction_time_ms: NOW - 2 * H }),
    ];
    const trace = buildOrderTrace(events, []);

    // Should sort by time and find NEW event first
    expect(trace!.segments[0].startTime).toBe(NOW - 2 * H);
    expect(trace!.endMarker!.time).toBe(NOW - H);
  });

  it('recovers start price from first amendment when NEW event is missing', () => {
    // REST-synced order: only TRADE/FILLED event, no NEW.
    // order_price = final amended price (12.291), but original TP was 12.328.
    const events = [
      makeEvent({
        order_id: 2001,
        execution_type: 'TRADE',
        order_status: 'FILLED',
        order_price: 12.291, // final amended price
        last_fill_price: 12.291,
        last_fill_qty: 4.0,
        filled_qty_accumulated: 4.0,
        avg_price: 12.291,
        trade_id: 5001,
        side: 'SELL',
        is_reduce_only: 1,
        event_time_ms: NOW - 2 * H,
        transaction_time_ms: NOW - H,
      }),
    ];
    const amendments = [
      makeAmendment({
        order_id: 2001, amendment_id: 9001,
        time_ms: NOW - 90 * 60000,
        price_before: 12.328, price_after: 12.316,
        amendment_count: 1,
      }),
      makeAmendment({
        order_id: 2001, amendment_id: 9002,
        time_ms: NOW - 80 * 60000,
        price_before: 12.316, price_after: 12.304,
        amendment_count: 2,
      }),
      makeAmendment({
        order_id: 2001, amendment_id: 9003,
        time_ms: NOW - 70 * 60000,
        price_before: 12.304, price_after: 12.291,
        amendment_count: 3,
      }),
    ];
    const trace = buildOrderTrace(events, amendments);

    expect(trace).not.toBeNull();
    // Start price must be 12.328 (original TP), NOT 12.291 (fill/amended price)
    expect(trace!.segments[0].price).toBe(12.328);
    // Subsequent segments reflect amendments
    expect(trace!.segments[1].price).toBe(12.316);
    expect(trace!.segments[2].price).toBe(12.304);
    expect(trace!.segments[3].price).toBe(12.291);
    expect(trace!.endMarker!.type).toBe('exit_fill');
  });

  it('uses NEW event price when NEW event exists even with amendments', () => {
    // Sanity check: when NEW event IS present, startPrice comes from it
    const events = [
      makeEvent({ order_id: 3001, order_price: 50000 }),
    ];
    const amendments = [
      makeAmendment({
        order_id: 3001, time_ms: NOW - H,
        price_before: 50000, price_after: 49500,
      }),
    ];
    const trace = buildOrderTrace(events, amendments);

    expect(trace!.segments[0].price).toBe(50000);
    expect(trace!.segments[1].price).toBe(49500);
  });

  it('synthesizes segment for unrecorded amendment before fill', () => {
    // Last recorded amendment goes to 49500, but the order was actually
    // amended to 49000 before filling — that amendment is missing.
    const events = [
      makeEvent({ order_id: 4001, order_price: 50000 }),
      makeEvent({
        order_id: 4001,
        execution_type: 'TRADE',
        order_status: 'FILLED',
        order_price: 49000, // final order price at fill
        last_fill_price: 49000,
        last_fill_qty: 0.001,
        filled_qty_accumulated: 0.001,
        avg_price: 49000,
        trade_id: 6001,
        transaction_time_ms: NOW - 30 * 60000,
      }),
    ];
    const amendments = [
      makeAmendment({
        order_id: 4001, time_ms: NOW - H,
        price_before: 50000, price_after: 49500,
      }),
    ];
    const trace = buildOrderTrace(events, amendments);

    expect(trace!.segments).toHaveLength(3);
    expect(trace!.segments[0].price).toBe(50000);  // original
    expect(trace!.segments[1].price).toBe(49500);  // last recorded amendment
    expect(trace!.segments[2].price).toBe(49000);  // synthesized from fill price
    expect(trace!.endMarker!.price).toBe(49000);
  });

  it('does not synthesize segment when fill price matches last amendment', () => {
    // Fill price matches — no extra segment needed
    const events = [
      makeEvent({ order_id: 5001, order_price: 50000 }),
      makeEvent({
        order_id: 5001,
        execution_type: 'TRADE',
        order_status: 'FILLED',
        order_price: 49500,
        last_fill_price: 49500,
        last_fill_qty: 0.001,
        filled_qty_accumulated: 0.001,
        avg_price: 49500,
        trade_id: 6002,
        transaction_time_ms: NOW - 30 * 60000,
      }),
    ];
    const amendments = [
      makeAmendment({
        order_id: 5001, time_ms: NOW - H,
        price_before: 50000, price_after: 49500,
      }),
    ];
    const trace = buildOrderTrace(events, amendments);

    expect(trace!.segments).toHaveLength(2);
    expect(trace!.segments[0].price).toBe(50000);
    expect(trace!.segments[1].price).toBe(49500);
  });

  it('shows final step-down when amendment timestamp exceeds fill time', () => {
    // Real scenario: rapid TP stepdown where amendment WS confirmations
    // arrive after the fill event due to WS ordering.
    // Fill at time 764, but last amendment arrives at time 777.
    const fillTime = NOW - H;
    const events = [
      makeEvent({
        order_id: 6001,
        execution_type: 'TRADE',
        order_status: 'FILLED',
        order_price: 12.291,  // LIMIT price at fill
        last_fill_price: 12.291,
        avg_price: 12.291,
        last_fill_qty: 4.0,
        filled_qty_accumulated: 4.0,
        trade_id: 7001,
        side: 'SELL',
        is_reduce_only: 1,
        event_time_ms: fillTime - 254,
        transaction_time_ms: fillTime,
      }),
    ];
    const amendments = [
      makeAmendment({
        order_id: 6001, amendment_id: 10001,
        time_ms: fillTime - 148,
        price_before: 12.328, price_after: 12.316,
      }),
      makeAmendment({
        order_id: 6001, amendment_id: 10002,
        time_ms: fillTime - 68,
        price_before: 12.316, price_after: 12.304,
      }),
      makeAmendment({
        order_id: 6001, amendment_id: 10003,
        time_ms: fillTime + 13, // after fill timestamp!
        price_before: 12.304, price_after: 12.291,
      }),
    ];
    const trace = buildOrderTrace(events, amendments);

    expect(trace).not.toBeNull();
    // Should have 4 segments: 12.328, 12.316, 12.304, 12.291
    expect(trace!.segments).toHaveLength(4);
    expect(trace!.segments[0].price).toBe(12.328);
    expect(trace!.segments[1].price).toBe(12.316);
    // The segment at 12.304 should be trimmed to end at fillTime, not fillTime+13
    expect(trace!.segments[2].price).toBe(12.304);
    expect(trace!.segments[2].endTime).toBe(fillTime);
    // Final 1ms segment at the fill price
    expect(trace!.segments[3].price).toBe(12.291);
    expect(trace!.segments[3].startTime).toBe(fillTime);
    expect(trace!.endMarker!.type).toBe('exit_fill');
  });
});

// ── buildAllTraces ──────────────────────────────────────────────────

describe('buildAllTraces', () => {
  it('returns empty array for no events', () => {
    expect(buildAllTraces([], [])).toEqual([]);
  });

  it('builds traces for multiple orders', () => {
    const events = [
      makeEvent({ order_id: 1001 }),
      makeEvent({ order_id: 1002, order_price: 51000, transaction_time_ms: NOW - H }),
      makeEvent({
        order_id: 1001, execution_type: 'TRADE', order_status: 'FILLED',
        last_fill_price: 49999, transaction_time_ms: NOW - H,
      }),
    ];
    const traces = buildAllTraces(events, []);

    expect(traces).toHaveLength(2);
    const t1 = traces.find(t => t.orderId === 1001)!;
    const t2 = traces.find(t => t.orderId === 1002)!;
    expect(t1.endMarker).not.toBeNull();
    expect(t2.endMarker).toBeNull(); // still open
  });

  it('matches amendments to correct orders', () => {
    const events = [
      makeEvent({ order_id: 1001 }),
      makeEvent({ order_id: 1002, order_price: 51000 }),
    ];
    const amendments = [
      makeAmendment({ order_id: 1002, price_before: 51000, price_after: 50800 }),
    ];
    const traces = buildAllTraces(events, amendments);

    const t1 = traces.find(t => t.orderId === 1001)!;
    const t2 = traces.find(t => t.orderId === 1002)!;
    expect(t1.segments).toHaveLength(1); // no amendments
    expect(t2.segments).toHaveLength(2); // 1 amendment
  });

  it('handles order with partial fill then cancel', () => {
    const events = [
      makeEvent({ order_id: 1001 }),
      makeEvent({
        order_id: 1001, execution_type: 'TRADE', order_status: 'PARTIALLY_FILLED',
        last_fill_price: 50000, last_fill_qty: 0.0005,
        filled_qty_accumulated: 0.0005, transaction_time_ms: NOW - 90 * 60000,
      }),
      makeEvent({
        order_id: 1001, execution_type: 'CANCELED', order_status: 'CANCELED',
        transaction_time_ms: NOW - H,
      }),
    ];
    const traces = buildAllTraces(events, []);

    expect(traces).toHaveLength(1);
    const t = traces[0];
    // Terminal status is CANCELED (last event by time)
    expect(t.endMarker!.type).toBe('cancel');
  });
});
