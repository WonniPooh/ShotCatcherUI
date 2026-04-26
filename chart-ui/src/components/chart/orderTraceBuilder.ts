/**
 * Order Trace Builder — pure functions that transform raw order events
 * and amendments into renderable OrderTrace polylines.
 *
 * Algorithm per order:
 *   1. Find the NEW event → initial price + start time
 *   2. Sort amendments by time → each creates a new segment
 *   3. Find terminal event (FILLED/CANCELED/EXPIRED) → end marker
 *   4. If no terminal → order is still open, last segment extends to Infinity
 */
import type {
  OrderEventRaw,
  OrderAmendmentRaw,
  OrderTrace,
  OrderTraceSegment,
  OrderEndMarker,
  OrderEndType,
} from '../../types/orders';

const TERMINAL_STATUSES = new Set([
  'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH',
]);

/**
 * Determine if an order is an entry (new position) or exit (reduce/close).
 * Heuristic: if is_reduce_only=1 or order type is SL/TP, it's an exit.
 */
function isExitOrder(event: OrderEventRaw): boolean {
  if (event.is_reduce_only) return true;
  const exitTypes = new Set([
    'STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT',
    'TRAILING_STOP_MARKET',
  ]);
  return exitTypes.has(event.order_type);
}

/**
 * Get the effective price for an order event.
 * For stop orders, use stop_price; for limit, use order_price.
 */
function getEffectivePrice(event: OrderEventRaw): number {
  if (event.stop_price > 0 && (
    event.order_type === 'STOP_MARKET' ||
    event.order_type === 'TAKE_PROFIT_MARKET' ||
    event.order_type === 'TRAILING_STOP_MARKET'
  )) {
    return event.stop_price;
  }
  return event.order_price;
}

/**
 * Build a single OrderTrace from events + amendments for one order.
 *
 * @param openOrderIds  When provided, only orders whose ID is in this set
 *   get an Infinity end segment. Orders with missing terminal events that
 *   are NOT in this set are capped at their last known event time — this
 *   prevents data-gap orders (missed WS events, restart) from drawing
 *   a permanent line to the right edge of the chart.
 */
export function buildOrderTrace(
  events: OrderEventRaw[],
  amendments: OrderAmendmentRaw[],
  openOrderIds?: Set<number>,
): OrderTrace | null {
  if (events.length === 0) return null;

  // Sort events by transaction_time_ms
  const sorted = [...events].sort(
    (a, b) => a.transaction_time_ms - b.transaction_time_ms,
  );

  // Find the NEW event (first one, or earliest)
  const newEvent = sorted.find(e => e.execution_type === 'NEW') ?? sorted[0];
  const hasExplicitNew = sorted.some(e => e.execution_type === 'NEW');

  // Sort amendments by time (needed early — used for start price recovery)
  const sortedAmendments = [...amendments].sort((a, b) => a.time_ms - b.time_ms);

  // Determine start price.
  // If the NEW event was captured via WS, order_price is the original price.
  // But REST-synced orders only have the TRADE/FILLED event whose order_price
  // is the final (post-amendment) price, not the original.  In that case,
  // recover the original price from the first amendment's price_before field.
  let startPrice: number;
  if (!hasExplicitNew && sortedAmendments.length > 0 && sortedAmendments[0].price_before > 0) {
    startPrice = sortedAmendments[0].price_before;
  } else {
    startPrice = getEffectivePrice(newEvent);
  }

  // For the start time, prefer the earliest known timestamp.
  // REST-synced orders have event_time_ms = creation time (Binance `time` field)
  // and transaction_time_ms = last update (possibly much later).
  // If event_time_ms is earlier, use it so the trace starts at order creation.
  const startTime = !hasExplicitNew &&
    newEvent.event_time_ms > 0 &&
    newEvent.event_time_ms < newEvent.transaction_time_ms
    ? newEvent.event_time_ms
    : newEvent.transaction_time_ms;

  // Build segments
  const segments: OrderTraceSegment[] = [];
  let currentPrice = startPrice;
  let currentTime = startTime;

  for (const amend of sortedAmendments) {
    // Segment from current to amendment time at current price
    if (amend.time_ms > currentTime) {
      segments.push({
        startTime: currentTime,
        endTime: amend.time_ms,
        price: currentPrice,
      });
    }
    currentPrice = amend.price_after > 0 ? amend.price_after : currentPrice;
    currentTime = amend.time_ms;
  }

  // Find terminal event.
  // Primary: FILLED / CANCELED / EXPIRED / REJECTED.
  // Fallback: if no terminal status but a TRADE event exists and the order
  // is not confirmed open, treat the last TRADE as terminal.  This handles
  // the case where two fills land at the same ms and the FILLED event was
  // lost to the upsert dedup (same PK as the PARTIALLY_FILLED event).
  let terminalEvent = sorted.find(e => TERMINAL_STATUSES.has(e.order_status));
  if (!terminalEvent) {
    const isConfirmedOpen = openOrderIds == null || openOrderIds.has(newEvent.order_id);
    if (!isConfirmedOpen) {
      const lastTrade = [...sorted].reverse().find(e => e.execution_type === 'TRADE');
      if (lastTrade) terminalEvent = lastTrade;
    }
  }

  let endMarker: OrderEndMarker | null = null;

  if (terminalEvent) {
    // Use the later of event_time_ms and transaction_time_ms for fill markers.
    // WS-sourced fills: transaction_time_ms (root T) is matching-engine time, ~20-30ms
    //   before the public @trade stream T. event_time_ms (E) ≈ trade stream T.
    // REST-sourced fills: transaction_time_ms = fill time, event_time_ms = order creation
    //   time (much earlier). Math.max picks the correct one in both cases.
    const terminalTime = Math.max(
      terminalEvent.transaction_time_ms,
      terminalEvent.event_time_ms,
    );

    // Detect unrecorded amendment: if the order was filled and its effective
    // price (= LIMIT price for limit orders) differs from the last known
    // segment price, there's a missing amendment.  Synthesize a segment
    // transition 1ms before the fill.
    const isFill = terminalEvent.order_status === 'FILLED' ||
      terminalEvent.order_status === 'PARTIALLY_FILLED';
    if (isFill) {
      const fillPrice = getEffectivePrice(terminalEvent);
      if (fillPrice > 0 && Math.abs(fillPrice - currentPrice) > 1e-12) {
        const stepTime = Math.max(terminalTime - 1, currentTime);
        // Close current segment at the step-down point
        if (stepTime > currentTime) {
          segments.push({
            startTime: currentTime,
            endTime: stepTime,
            price: currentPrice,
          });
          currentTime = stepTime;
        }
        currentPrice = fillPrice;
      }
    }

    // Amendment timestamps can exceed the fill's matching-engine time
    // (WS event ordering).  Trim the last segment so it ends at the fill
    // and push a 1-ms segment at the final order price so the last
    // step-down is visible on the chart.
    if (terminalTime > currentTime) {
      segments.push({
        startTime: currentTime,
        endTime: terminalTime,
        price: currentPrice,
      });
    } else {
      if (segments.length > 0) {
        const last = segments[segments.length - 1];
        if (last.endTime > terminalTime) {
          last.endTime = terminalTime;
        }
      }
      segments.push({
        startTime: terminalTime,
        endTime: terminalTime + 1,
        price: currentPrice,
      });
    }

    // Determine end marker type
    let endType: OrderEndType;
    if (terminalEvent.order_status === 'FILLED' ||
        terminalEvent.order_status === 'PARTIALLY_FILLED') {
      endType = isExitOrder(terminalEvent) ? 'exit_fill' : 'entry_fill';
    } else {
      endType = 'cancel';
    }

    const endPrice = terminalEvent.execution_type === 'TRADE' &&
                     terminalEvent.last_fill_price > 0
      ? terminalEvent.last_fill_price
      : terminalEvent.avg_price > 0
        ? terminalEvent.avg_price
        : currentPrice;

    endMarker = {
      time: terminalTime,
      price: endPrice,
      type: endType,
      side: terminalEvent.side as 'BUY' | 'SELL',
    };
  } else {
    // No terminal event found.
    // If the order is confirmed open (in openOrderIds, or openOrderIds was not
    // provided), extend to Infinity so it tracks to the live edge.
    // Otherwise it's a data gap (missed WS event / bot restart) — cap the
    // segment at the last known event time so it doesn't pollute the chart.
    const isConfirmedOpen = openOrderIds == null || openOrderIds.has(newEvent.order_id);
    segments.push({
      startTime: currentTime,
      endTime: isConfirmedOpen ? Infinity : currentTime,
      price: currentPrice,
    });
  }

  return {
    orderId: newEvent.order_id,
    symbol: newEvent.symbol,
    side: newEvent.side as 'BUY' | 'SELL',
    orderType: newEvent.order_type,
    segments,
    endMarker,
  };
}

/**
 * Build all order traces for a symbol from raw events + amendments.
 * Groups events by order_id, matches amendments, produces traces.
 */
export function buildAllTraces(
  events: OrderEventRaw[],
  amendments: OrderAmendmentRaw[],
  openOrderIds?: Set<number>,
): OrderTrace[] {
  // Group events by order_id
  const eventsByOrder = new Map<number, OrderEventRaw[]>();
  for (const e of events) {
    const arr = eventsByOrder.get(e.order_id);
    if (arr) arr.push(e);
    else eventsByOrder.set(e.order_id, [e]);
  }

  // Group amendments by order_id
  const amendmentsByOrder = new Map<number, OrderAmendmentRaw[]>();
  for (const a of amendments) {
    const arr = amendmentsByOrder.get(a.order_id);
    if (arr) arr.push(a);
    else amendmentsByOrder.set(a.order_id, [a]);
  }

  const traces: OrderTrace[] = [];
  for (const [orderId, orderEvents] of eventsByOrder) {
    const orderAmendments = amendmentsByOrder.get(orderId) ?? [];
    const trace = buildOrderTrace(orderEvents, orderAmendments, openOrderIds);
    if (trace) traces.push(trace);
  }

  return traces;
}

/**
 * Apply a live WS order event to update existing traces.
 * Returns a new trace to add/replace, or null if no change.
 */
export function applyOrderEvent(
  traces: OrderTrace[],
  event: OrderEventRaw,
  amendments: OrderAmendmentRaw[],
): { traces: OrderTrace[]; changed: boolean } {
  // Find all events for this order from existing traces + new event
  const existingIdx = traces.findIndex(t => t.orderId === event.order_id);

  // Rebuild the trace with the new event included
  // We need the full event list — collect from caller context
  const newTrace = buildOrderTrace([event], amendments);
  if (!newTrace) return { traces, changed: false };

  const updated = [...traces];
  if (existingIdx >= 0) {
    updated[existingIdx] = newTrace;
  } else {
    updated.push(newTrace);
  }
  return { traces: updated, changed: true };
}
