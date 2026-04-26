import { describe, it, expect } from 'vitest';
import { renderOrderTraces } from '../components/chart/orderRenderer';
import type { OrderTrace } from '../types/orders';

// ── Mock Canvas Context ─────────────────────────────────────────────

function createMockCtx() {
  const calls: { method: string; args: unknown[] }[] = [];
  const handler = {
    get(_target: unknown, prop: string) {
      if (prop === '_calls') return calls;
      if (prop === 'save' || prop === 'restore' || prop === 'beginPath' ||
          prop === 'closePath' || prop === 'fill' || prop === 'stroke') {
        return (...args: unknown[]) => calls.push({ method: prop, args });
      }
      if (prop === 'moveTo' || prop === 'lineTo' || prop === 'arc' ||
          prop === 'fillRect' || prop === 'strokeRect' || prop === 'fillText' ||
          prop === 'setLineDash' || prop === 'measureText') {
        if (prop === 'measureText') return () => ({ width: 40 });
        return (...args: unknown[]) => calls.push({ method: prop, args });
      }
      // Properties (strokeStyle, fillStyle, etc.) — just accept any set
      return undefined;
    },
    set(_target: unknown, _prop: string, _value: unknown) {
      return true;
    },
  };
  return new Proxy({}, handler) as unknown as CanvasRenderingContext2D & { _calls: typeof calls };
}

// ── Helpers ─────────────────────────────────────────────────────────

const NOW = Date.now();
const H = 3_600_000;

function makeTrace(overrides: Partial<OrderTrace> = {}): OrderTrace {
  return {
    orderId: 1001,
    symbol: 'BTCUSDT',
    side: 'BUY',
    orderType: 'LIMIT',
    segments: [
      { startTime: NOW - 2 * H, endTime: NOW - H, price: 50000 },
    ],
    endMarker: null,
    ...overrides,
  };
}

function makeRenderContext(ctx: CanvasRenderingContext2D) {
  const from = NOW - 3 * H;
  const to = NOW;
  const chartW = 800;
  const drawH = 400;
  return {
    ctx,
    toX: (t: number) => ((t - from) / (to - from)) * chartW,
    toY: (p: number) => drawH * (1 - (p - 49000) / 2000),
    chartW,
    drawH,
    viewportFrom: from,
    viewportTo: to,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('renderOrderTraces', () => {
  it('does nothing for empty traces', () => {
    const ctx = createMockCtx();
    const rc = makeRenderContext(ctx);
    renderOrderTraces(rc, []);
    // Only no canvas calls (no save/restore even)
    expect(ctx._calls).toHaveLength(0);
  });

  it('renders a single open order trace with dashed line', () => {
    const ctx = createMockCtx();
    const rc = makeRenderContext(ctx);
    const trace = makeTrace({
      segments: [{ startTime: NOW - 2 * H, endTime: Infinity, price: 50000 }],
    });
    renderOrderTraces(rc, [trace]);

    // Should call save + restore
    expect(ctx._calls[0].method).toBe('save');
    expect(ctx._calls[ctx._calls.length - 1].method).toBe('restore');

    // Should call setLineDash with dashes for the segment
    const dashCalls = ctx._calls.filter(
      c => c.method === 'setLineDash' && Array.isArray(c.args[0]) && (c.args[0] as number[]).length > 0,
    );
    expect(dashCalls.length).toBeGreaterThan(0);

    // Should call moveTo + lineTo for the horizontal segment
    const moveTos = ctx._calls.filter(c => c.method === 'moveTo');
    const lineTos = ctx._calls.filter(c => c.method === 'lineTo');
    expect(moveTos.length).toBeGreaterThan(0);
    expect(lineTos.length).toBeGreaterThan(0);
  });

  it('renders a filled order with end marker triangle', () => {
    const ctx = createMockCtx();
    const rc = makeRenderContext(ctx);
    const trace = makeTrace({
      segments: [{ startTime: NOW - 2 * H, endTime: NOW - H, price: 50000 }],
      endMarker: {
        time: NOW - H,
        price: 49999.5,
        type: 'entry_fill',
        side: 'BUY',
      },
    });
    renderOrderTraces(rc, [trace]);

    // Should draw triangle (3 vertices: moveTo + 2 lineTo + closePath + fill)
    const closePaths = ctx._calls.filter(c => c.method === 'closePath');
    expect(closePaths.length).toBeGreaterThan(0);
    const fills = ctx._calls.filter(c => c.method === 'fill');
    expect(fills.length).toBeGreaterThan(0);
  });

  it('renders a canceled order with X marker', () => {
    const ctx = createMockCtx();
    const rc = makeRenderContext(ctx);
    const trace = makeTrace({
      segments: [{ startTime: NOW - 2 * H, endTime: NOW - H, price: 50000 }],
      endMarker: {
        time: NOW - H,
        price: 50000,
        type: 'cancel',
        side: 'BUY',
      },
    });
    renderOrderTraces(rc, [trace]);

    // X marker: 2 lines (4 moveTo/lineTo calls)
    const moveTos = ctx._calls.filter(c => c.method === 'moveTo');
    // At least 3 moveTos: segment start + 2 for X
    expect(moveTos.length).toBeGreaterThanOrEqual(3);
  });

  it('renders multiple traces', () => {
    const ctx = createMockCtx();
    const rc = makeRenderContext(ctx);
    const traces = [
      makeTrace({ orderId: 1001 }),
      makeTrace({
        orderId: 1002,
        orderType: 'STOP_MARKET',
        segments: [{ startTime: NOW - H, endTime: Infinity, price: 49800 }],
      }),
    ];
    renderOrderTraces(rc, traces);

    // Should have beginPath calls for both traces' segments
    const beginPaths = ctx._calls.filter(c => c.method === 'beginPath');
    expect(beginPaths.length).toBeGreaterThanOrEqual(2);
  });

  it('renders vertical connectors between segments', () => {
    const ctx = createMockCtx();
    const rc = makeRenderContext(ctx);
    const trace = makeTrace({
      segments: [
        { startTime: NOW - 2 * H, endTime: NOW - 90 * 60000, price: 50000 },
        { startTime: NOW - 90 * 60000, endTime: Infinity, price: 49500 },
      ],
    });
    renderOrderTraces(rc, [trace]);

    // Should have lineTo calls at different Y values (vertical connector)
    const lineTos = ctx._calls.filter(c => c.method === 'lineTo');
    const yValues = lineTos.map(c => (c.args as number[])[1]);
    const uniqueYs = new Set(yValues);
    // At least 2 different Y values (connector + segment)
    expect(uniqueYs.size).toBeGreaterThanOrEqual(2);
  });

  it('skips traces entirely outside viewport', () => {
    const ctx = createMockCtx();
    const rc = makeRenderContext(ctx);
    const trace = makeTrace({
      segments: [
        { startTime: NOW - 10 * H, endTime: NOW - 8 * H, price: 50000 },
      ],
      endMarker: {
        time: NOW - 8 * H,
        price: 50000,
        type: 'cancel',
        side: 'BUY',
      },
    });
    renderOrderTraces(rc, [trace]);

    // Should still call save/restore but no fill or moveTo for the X marker
    // (marker is outside viewport)
    const fills = ctx._calls.filter(c => c.method === 'fill');
    expect(fills).toHaveLength(0);
  });
});
