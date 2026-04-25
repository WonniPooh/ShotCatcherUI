import { create } from 'zustand';
import type { TimeFrame, Drawing, SymbolTab, ChartMarker } from '../types/chart';

const DEFAULT_SYMBOLS: SymbolTab[] = [
  { symbol: 'BTCUSDT', label: 'BTC' },
  { symbol: 'ETHUSDT', label: 'ETH' },
  { symbol: 'SOLUSDT', label: 'SOL' },
];

// ── localStorage persistence helpers ─────────────────────────────────────────
const LS_TABS   = 'sc_tabs';
const LS_SYMBOL = 'sc_active_symbol';

function loadPersistedTabs(): SymbolTab[] {
  try {
    const raw = localStorage.getItem(LS_TABS);
    if (!raw) return DEFAULT_SYMBOLS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_SYMBOLS;
    return parsed as SymbolTab[];
  } catch {
    return DEFAULT_SYMBOLS;
  }
}

function loadPersistedSymbol(tabs: SymbolTab[]): string {
  try {
    const sym = localStorage.getItem(LS_SYMBOL);
    if (sym && tabs.some((t) => t.symbol === sym)) return sym;
  } catch { /* ignore */ }
  return tabs[0]?.symbol ?? 'BTCUSDT';
}

function saveTabs(tabs: SymbolTab[]): void {
  try { localStorage.setItem(LS_TABS, JSON.stringify(tabs)); } catch { /* ignore */ }
}

function saveSymbol(symbol: string): void {
  try { localStorage.setItem(LS_SYMBOL, symbol); } catch { /* ignore */ }
}

const _persistedTabs   = loadPersistedTabs();
const _persistedSymbol = loadPersistedSymbol(_persistedTabs);

interface ChartState {
  // Symbol
  activeSymbol: string;
  tabs: SymbolTab[];
  setActiveSymbol: (symbol: string) => void;
  addTab: (tab: SymbolTab) => void;
  removeTab: (symbol: string) => void;

  // Timeframe
  timeframe: TimeFrame;
  setTimeframe: (tf: TimeFrame) => void;

  // Drawing tools
  drawings: Drawing[];
  activeDrawingTool: DrawingType | null;
  setActiveDrawingTool: (tool: DrawingType | null) => void;
  addDrawing: (d: Drawing) => void;
  removeDrawing: (id: string) => void;
  selectedDrawingId: string | null;
  setSelectedDrawingId: (id: string | null) => void;

  // Measurement (shift+click)
  isMeasuring: boolean;
  setIsMeasuring: (v: boolean) => void;

  // Markers (triangle arrows on chart)
  markers: ChartMarker[];
  addMarker: (m: ChartMarker) => void;
  removeMarker: (id: string) => void;
  clearMarkers: () => void;

  // Latest trade price (updated on every trade for toolbar access)
  currentPrice: number;
  setCurrentPrice: (p: number) => void;

  // Auto-scroll (follow live data)
  autoScroll: boolean;
  setAutoScroll: (v: boolean) => void;

  // Indicator slots (extensible)
  indicators: string[];
  addIndicator: (name: string) => void;
  removeIndicator: (name: string) => void;

  // Date-range mode (trades timeframe only)
  isDateRangeMode: boolean;
  dateRangeFrom: number | null;  // ms epoch
  dateRangeTo:   number | null;  // ms epoch
  setDateRange: (from: number, to: number) => void;
  clearDateRange: () => void;

  // Sidebar panels (mutually exclusive)
  sidebarPanel: 'closedTrades' | 'openOrders' | null;
  setSidebarPanel: (panel: 'closedTrades' | 'openOrders' | null) => void;
  toggleSidebarPanel: (panel: 'closedTrades' | 'openOrders') => void;

  // Pending navigation (for cross-symbol click-to-navigate)
  pendingNavigation: { ts: number } | null;
  setPendingNavigation: (nav: { ts: number } | null) => void;
}

type DrawingType = Drawing['type'];

export const useChartStore = create<ChartState>((set) => ({
  activeSymbol: _persistedSymbol,
  tabs: _persistedTabs,
  setActiveSymbol: (symbol) => {
    saveSymbol(symbol);
    set({ activeSymbol: symbol });
  },
  addTab: (tab) =>
    set((s) => {
      if (s.tabs.some((t) => t.symbol === tab.symbol)) return s;
      const tabs = [...s.tabs, tab];
      saveTabs(tabs);
      return { tabs };
    }),
  removeTab: (symbol) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.symbol !== symbol);
      const activeSymbol =
        s.activeSymbol === symbol
          ? tabs.find((t) => t.symbol !== symbol)?.symbol ?? 'BTCUSDT'
          : s.activeSymbol;
      saveTabs(tabs);
      saveSymbol(activeSymbol);
      return { tabs, activeSymbol };
    }),

  timeframe: 'trades',
  setTimeframe: (tf) => set({ timeframe: tf }),

  drawings: [],
  activeDrawingTool: null,
  setActiveDrawingTool: (tool) => set({ activeDrawingTool: tool }),
  addDrawing: (d) => set((s) => ({ drawings: [...s.drawings, d] })),
  removeDrawing: (id) =>
    set((s) => ({
      drawings: s.drawings.filter((d) => d.id !== id),
      selectedDrawingId: s.selectedDrawingId === id ? null : s.selectedDrawingId,
    })),
  selectedDrawingId: null,
  setSelectedDrawingId: (id) => set({ selectedDrawingId: id }),

  isMeasuring: false,
  setIsMeasuring: (v) => set({ isMeasuring: v }),

  markers: [],
  addMarker: (m) => set((s) => ({ markers: [...s.markers, m] })),
  removeMarker: (id) => set((s) => ({ markers: s.markers.filter((m) => m.id !== id) })),
  clearMarkers: () => set({ markers: [] }),

  currentPrice: 0,
  setCurrentPrice: (p) => set({ currentPrice: p }),

  autoScroll: true,
  setAutoScroll: (v) => set({ autoScroll: v }),

  indicators: [],
  addIndicator: (name) =>
    set((s) =>
      s.indicators.includes(name) ? s : { indicators: [...s.indicators, name] },
    ),
  removeIndicator: (name) =>
    set((s) => ({ indicators: s.indicators.filter((i) => i !== name) })),

  isDateRangeMode: false,
  dateRangeFrom:   null,
  dateRangeTo:     null,
  setDateRange: (from, to) => set({ isDateRangeMode: true, dateRangeFrom: from, dateRangeTo: to }),
  clearDateRange: ()        => set({ isDateRangeMode: false, dateRangeFrom: null, dateRangeTo: null }),

  sidebarPanel: null,
  setSidebarPanel: (panel) => set({ sidebarPanel: panel }),
  toggleSidebarPanel: (panel) =>
    set((s) => ({ sidebarPanel: s.sidebarPanel === panel ? null : panel })),

  pendingNavigation: null,
  setPendingNavigation: (nav) => set({ pendingNavigation: nav }),
}));
