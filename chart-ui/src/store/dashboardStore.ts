import { create } from 'zustand';
import type { Strategy, StrategyConfig, StrategyStatus, EngineState, WorkerEvent } from '../types/dashboard';

export interface ConfigFile {
  filename: string;
  strategy_count: number;
  modified: number;
}

interface DashboardState {
  // State
  strategies: Strategy[];
  engineState: EngineState;
  workerConnected: boolean;
  lastError: string | null;
  configFiles: ConfigFile[];

  // Actions
  addStrategy: (config: StrategyConfig) => void;
  modifyStrategy: (symbol: string, config: StrategyConfig) => void;
  removeStrategy: (symbol: string) => void;
  updateStrategyStatus: (symbol: string, status: StrategyStatus, error?: string) => void;
  setEngineState: (state: EngineState) => void;
  setWorkerConnected: (connected: boolean) => void;
  clearError: () => void;
  applyWorkerEvent: (msg: WorkerEvent) => void;
  setStrategies: (strategies: Strategy[]) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  strategies: [],
  engineState: 'idle',
  workerConnected: false,
  lastError: null,
  configFiles: [],

  addStrategy: (config) =>
    set((s) => {
      if (s.strategies.some((st) => st.symbol === config.symbol)) return s;
      return {
        strategies: [...s.strategies, { symbol: config.symbol, status: 'off', config }],
      };
    }),

  removeStrategy: (symbol) =>
    set((s) => ({
      strategies: s.strategies.filter((st) => st.symbol !== symbol),
    })),

  modifyStrategy: (symbol, config) =>
    set((s) => ({
      strategies: s.strategies.map((st) =>
        st.symbol === symbol ? { ...st, config } : st,
      ),
    })),

  updateStrategyStatus: (symbol, status, error) =>
    set((s) => ({
      strategies: s.strategies.map((st) =>
        st.symbol === symbol ? { ...st, status, error: error ?? st.error } : st,
      ),
    })),

  setEngineState: (engineState) => set({ engineState }),
  setWorkerConnected: (workerConnected) => set({ workerConnected }),
  clearError: () => set({ lastError: null }),

  setStrategies: (strategies) => set({ strategies }),

  applyWorkerEvent: (msg) => {
    const { type } = msg;

    switch (type) {
      case 'worker_connected':
        set({ workerConnected: true });
        break;

      case 'worker_disconnected':
        set({ workerConnected: false });
        break;

      case 'hello':
        // Connection confirmed — worker is alive
        break;

      case 'engine_ready':
        set({ engineState: 'ready' });
        break;

      case 'strategies_snapshot':
        set({
          strategies: msg.strategies.map((s) => ({
            symbol: s.symbol,
            status: s.status,
            config: s.config,
            error: s.error ?? undefined,
          })),
        });
        break;

      case 'engine_stopped':
        // All strategies become off when engine stops
        set((s) => ({
          engineState: 'idle',
          strategies: s.strategies.map((st) => ({ ...st, status: 'off' as const })),
        }));
        break;

      case 'strategy_ready':
        set((s) => {
          const found = s.strategies.some((st) => st.symbol === msg.symbol);
          if (found) {
            return {
              engineState: 'trading',
              strategies: s.strategies.map((st) =>
                st.symbol === msg.symbol
                  ? {
                      ...st,
                      status: 'on' as const,
                      error: undefined,
                      resolved_leverage: msg.leverage ?? st.resolved_leverage,
                    }
                  : st,
              ),
            };
          }
          // Strategy started that we don't know about (e.g. reconnect) — skip, we lack config
          return { engineState: 'trading' };
        });
        break;

      case 'strategy_stopped':
        set((s) => ({
          strategies: s.strategies.map((st) =>
            st.symbol === msg.symbol ? { ...st, status: 'stopped' as const } : st,
          ),
        }));
        break;

      case 'strategy_paused':
        set((s) => ({
          strategies: s.strategies.map((st) =>
            st.symbol === msg.symbol ? { ...st, status: 'paused' as const } : st,
          ),
        }));
        break;

      case 'strategy_resumed':
        set((s) => ({
          strategies: s.strategies.map((st) =>
            st.symbol === msg.symbol ? { ...st, status: 'on' as const } : st,
          ),
        }));
        break;

      case 'emergency_stop_complete':
        // All strategies already moved to pending via strategy_stopped events.
        // No state change needed — just a signal that the operation is done.
        break;

      case 'strategy_added':
        // Worker confirms strategy registered (pending).
        // Don't create a new entry — the local addStrategy already added it with full config.
        // This just confirms the worker accepted it. If another session added it,
        // the next strategies_snapshot will sync it with full config.
        break;

      case 'strategy_removed':
        set((s) => ({
          strategies: s.strategies.filter((st) => st.symbol !== msg.symbol),
        }));
        break;

      case 'leverage_changed':
        set((s) => ({
          strategies: s.strategies.map((st) =>
            st.symbol === msg.symbol ? { ...st, resolved_leverage: msg.leverage } : st,
          ),
        }));
        break;

      case 'strategy_error':
        set((s) => ({
          lastError: `${msg.symbol}: ${msg.msg}`,
          strategies: s.strategies.map((st) =>
            st.symbol === msg.symbol ? { ...st, status: 'error' as const, error: msg.msg } : st,
          ),
        }));
        break;

      case 'error':
        // "engine already running" is not a real error — just means engine is ready
        if (msg.msg.toLowerCase().includes('already running') || msg.msg.toLowerCase().includes('already starting')) {
          set({ engineState: 'ready' });
        } else {
          set({ lastError: msg.msg });
        }
        break;

      case 'config_saved':
        set({ lastError: null });
        break;

      case 'config_loaded':
        // If backend returns the strategies, add them to the store
        if (msg.strategies && Array.isArray(msg.strategies)) {
          set((s) => {
            const newStrats: Strategy[] = msg.strategies!.flatMap((c) => {
              // Config files may use { symbol: "X" } (UI format) or { symbols: ["X","Y"] } (worker format)
              const rawSymbols: string[] = (c as unknown as { symbols?: string[] }).symbols
                ?? (c.symbol ? [c.symbol] : []);
              return rawSymbols.map((sym) => ({
                symbol: sym,
                status: 'off' as const,
                config: { ...c, symbol: sym },
              }));
            });
            // Merge — don't duplicate existing symbols
            const existingSymbols = new Set(s.strategies.map((st) => st.symbol));
            const toAdd = newStrats.filter((st) => st.symbol && !existingSymbols.has(st.symbol));
            return {
              lastError: null,
              strategies: [...s.strategies, ...toAdd],
            };
          });
        } else {
          set({ lastError: null });
        }
        break;

      case 'config_list':
        set({
          configFiles: msg.files.map((f) => ({
            filename: f.filename,
            strategy_count: f.strategy_count,
            modified: f.modified,
          })),
        });
        break;

      case 'config_deleted':
        set((s) => ({
          configFiles: s.configFiles.filter((f) => f.filename !== msg.filename),
        }));
        break;

      case 'config_renamed':
        set((s) => ({
          configFiles: s.configFiles.map((f) =>
            f.filename === msg.filename ? { ...f, filename: msg.new_filename } : f,
          ),
        }));
        break;

      case 'loss_status':
        // Update pause status from loss data
        set((s) => ({
          strategies: s.strategies.map((st) => {
            const ls = msg.strategies.find((l) => l.symbol === st.symbol);
            if (!ls) return st;
            // If strategy is active in loss_status but we have it as 'on', keep it
            // If not active and we have it as 'on', it may be paused
            if (!ls.active && st.status === 'on') {
              return { ...st, status: 'paused' as const };
            }
            return st;
          }),
        }));
        break;
    }
  },
}));
