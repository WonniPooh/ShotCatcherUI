/**
 * Position store — fetches and caches closed positions from the backend.
 */
import { create } from 'zustand';
import type { ClosedPosition } from '../types/positions';

/** Period options for filtering (ms values). */
export const PERIOD_OPTIONS = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h',  ms: 60 * 60_000 },
  { label: '3h',  ms: 3 * 60 * 60_000 },
  { label: '6h',  ms: 6 * 60 * 60_000 },
  { label: '12h', ms: 12 * 60 * 60_000 },
  { label: '1d',  ms: 24 * 60 * 60_000 },
  { label: '2d',  ms: 2 * 24 * 60 * 60_000 },
  { label: '3d',  ms: 3 * 24 * 60 * 60_000 },
  { label: '7d',  ms: 7 * 24 * 60 * 60_000 },
] as const;

export type SortBy = 'time' | 'symbol' | 'current';

interface PositionState {
  positions: ClosedPosition[];
  loading: boolean;
  error: string | null;
  periodLabel: string;
  periodMs: number;
  sortBy: SortBy;

  /** Fetch positions from backend for the selected period. */
  loadPositions: (symbol?: string) => Promise<void>;
  setPeriod: (label: string, ms: number) => void;
  setSortBy: (v: SortBy) => void;
  applyLivePosition: (pos: ClosedPosition) => void;
  clear: () => void;
}

export const usePositionStore = create<PositionState>((set, get) => ({
  positions: [],
  loading: false,
  error: null,
  periodLabel: '1d',
  periodMs: 24 * 60 * 60_000,
  sortBy: 'time',

  loadPositions: async (symbol?: string) => {
    const { periodMs } = get();
    set({ loading: true, error: null });
    try {
      const sinceMs = Date.now() - periodMs;
      const url = symbol
        ? `/api/positions?symbol=${encodeURIComponent(symbol)}&since_ms=${sinceMs}&limit=500`
        : `/api/positions/all?since_ms=${sinceMs}&limit=500`;
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as ClosedPosition[];
      set({ positions: data, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  setPeriod: (label, ms) => {
    set({ periodLabel: label, periodMs: ms });
    // Auto-reload after period change
    get().loadPositions();
  },

  setSortBy: (v) => set({ sortBy: v }),

  applyLivePosition: (pos) => {
    set((s) => {
      const { periodMs } = s;
      // Only add if within current period window
      if (pos.exit_time_ms < Date.now() - periodMs) return s;
      // Insert at the beginning (most recent first), dedup by id
      const existing = s.positions.some((p) => p.id === pos.id);
      if (existing) return s;
      return { positions: [pos, ...s.positions] };
    });
  },

  clear: () => set({ positions: [], loading: false, error: null }),
}));
