import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usePositionStore, PERIOD_OPTIONS } from '../store/positionStore';
import type { ClosedPosition } from '../types/positions';

const NOW = Date.now();
const H = 3_600_000;

function makePosition(overrides: Partial<ClosedPosition> = {}): ClosedPosition {
  return {
    id: 1,
    symbol: 'BTCUSDT',
    side: 'LONG',
    entry_price: 50000,
    exit_price: 51000,
    quantity: 0.01,
    realized_pnl: 10,
    pnl_pct: 2.0,
    fee_total: 0.5,
    entry_time_ms: NOW - 2 * H,
    exit_time_ms: NOW - H,
    entry_order_ids: '["o1"]',
    exit_order_ids: '["o2"]',
    duration_ms: H,
    ...overrides,
  };
}

describe('usePositionStore', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    usePositionStore.getState().clear();
  });

  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore();
  });

  it('starts with empty state', () => {
    const s = usePositionStore.getState();
    expect(s.positions).toEqual([]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.periodLabel).toBe('1d');
  });

  it('clear resets all state', () => {
    usePositionStore.setState({ positions: [makePosition()], error: 'test' });
    usePositionStore.getState().clear();
    const s = usePositionStore.getState();
    expect(s.positions).toEqual([]);
    expect(s.error).toBeNull();
  });

  // ── loadPositions ──────────────────────────────────────────────────────

  it('loadPositions fetches all positions', async () => {
    const data = [makePosition(), makePosition({ id: 2, symbol: 'ETHUSDT' })];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(data), { status: 200 }),
    );

    await usePositionStore.getState().loadPositions();
    const s = usePositionStore.getState();
    expect(s.positions).toHaveLength(2);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    // Should use /all endpoint when no symbol given
    const url = (fetchSpy.mock.calls[0][0] as string);
    expect(url).toContain('/api/positions/all');
    expect(url).toContain('since_ms=');
  });

  it('loadPositions fetches single symbol', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify([makePosition()]), { status: 200 }),
    );

    await usePositionStore.getState().loadPositions('BTCUSDT');
    const url = (fetchSpy.mock.calls[0][0] as string);
    expect(url).toContain('/api/positions?symbol=BTCUSDT');
  });

  it('loadPositions handles HTTP error', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('error', { status: 500 }),
    );

    await usePositionStore.getState().loadPositions();
    const s = usePositionStore.getState();
    expect(s.error).toBe('HTTP 500');
    expect(s.loading).toBe(false);
  });

  it('loadPositions handles network error', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Network failure');
    });

    await usePositionStore.getState().loadPositions();
    const s = usePositionStore.getState();
    expect(s.error).toBe('Network failure');
    expect(s.loading).toBe(false);
  });

  // ── setPeriod ──────────────────────────────────────────────────────────

  it('setPeriod updates period and triggers reload', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify([]), { status: 200 }),
    );

    usePositionStore.getState().setPeriod('3h', 3 * H);
    const s = usePositionStore.getState();
    expect(s.periodLabel).toBe('3h');
    expect(s.periodMs).toBe(3 * H);
    // Should have triggered a fetch
    expect(fetchSpy).toHaveBeenCalled();
  });

  // ── applyLivePosition ─────────────────────────────────────────────────

  it('applyLivePosition adds new position', () => {
    const pos = makePosition({ exit_time_ms: NOW - 1000 });
    usePositionStore.getState().applyLivePosition(pos);
    const s = usePositionStore.getState();
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0].id).toBe(1);
  });

  it('applyLivePosition deduplicates by id', () => {
    const pos = makePosition({ exit_time_ms: NOW - 1000 });
    usePositionStore.getState().applyLivePosition(pos);
    usePositionStore.getState().applyLivePosition(pos);
    expect(usePositionStore.getState().positions).toHaveLength(1);
  });

  it('applyLivePosition ignores position outside period window', () => {
    // Default period is 1d = 24h
    const old = makePosition({ exit_time_ms: NOW - 25 * H });
    usePositionStore.getState().applyLivePosition(old);
    expect(usePositionStore.getState().positions).toHaveLength(0);
  });

  it('applyLivePosition inserts at beginning (most recent first)', () => {
    usePositionStore.setState({
      positions: [makePosition({ id: 1, exit_time_ms: NOW - 2000 })],
    });
    usePositionStore.getState().applyLivePosition(
      makePosition({ id: 2, exit_time_ms: NOW - 1000 }),
    );
    const ids = usePositionStore.getState().positions.map((p) => p.id);
    expect(ids).toEqual([2, 1]);
  });

  // ── PERIOD_OPTIONS ─────────────────────────────────────────────────────

  it('PERIOD_OPTIONS are in ascending order', () => {
    for (let i = 1; i < PERIOD_OPTIONS.length; i++) {
      expect(PERIOD_OPTIONS[i].ms).toBeGreaterThan(PERIOD_OPTIONS[i - 1].ms);
    }
  });
});
