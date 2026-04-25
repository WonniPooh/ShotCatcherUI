---
name: zustand-store
description: Guidelines for creating and extending Zustand stores. Covers store structure, TypeScript typing, selectors, WS integration, and testing patterns. Use when adding new shared state or modifying existing stores.
argument-hint: "Add a dashboardStore with strategy list, worker connection status, and engine state"
---

# Zustand Store

## When to Use

- Adding new shared state that multiple components need
- Adding WS-driven state that updates in real-time
- Extending an existing store with new fields or actions

## Key Principles

- **Zustand 5 with `create()`** — no class-based stores. Vanilla Zustand, no middleware unless justified.
- **One store per domain** — `chartStore`, `orderStore`, `authStore`, etc. Don't cram unrelated state together.
- **Actions inside the store** — mutations are store methods, not external functions. Components call `store.doThing()`.
- **Narrow selectors in components** — `useStore((s) => s.field)` not `useStore()`. Prevents unnecessary re-renders.
- **Immutable updates** — always spread/copy, never mutate. `set({ strategies: [...prev, newItem] })` not `prev.push(newItem)`.
- **No side effects in `set()`** — WS sends, fetch calls go in async action methods, not inside the setter callback.

## Checklist

- [ ] 1. Define state interface and action methods
- [ ] 2. Create store file in `src/store/`
- [ ] 3. Export the hook (`useXxxStore`) as named export
- [ ] 4. Type the store with `interface` — state + actions in one type
- [ ] 5. Wire into components with narrow selectors
- [ ] 6. Add tests if store has non-trivial logic

## Store Template

```ts
import { create } from 'zustand';

interface Strategy {
  symbol: string;
  status: 'on' | 'off' | 'paused';
  config: StrategyConfig;
}

interface DashboardState {
  // State
  strategies: Strategy[];
  engineState: 'idle' | 'ready' | 'trading';
  workerConnected: boolean;

  // Actions
  addStrategy: (config: StrategyConfig) => void;
  removeStrategy: (symbol: string) => void;
  updateStrategyStatus: (symbol: string, status: Strategy['status']) => void;
  setEngineState: (state: DashboardState['engineState']) => void;
  setWorkerConnected: (connected: boolean) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  strategies: [],
  engineState: 'idle',
  workerConnected: false,

  addStrategy: (config) =>
    set((s) => ({
      strategies: [...s.strategies, { symbol: config.symbol, status: 'off', config }],
    })),

  removeStrategy: (symbol) =>
    set((s) => ({
      strategies: s.strategies.filter((st) => st.symbol !== symbol),
    })),

  updateStrategyStatus: (symbol, status) =>
    set((s) => ({
      strategies: s.strategies.map((st) =>
        st.symbol === symbol ? { ...st, status } : st
      ),
    })),

  setEngineState: (engineState) => set({ engineState }),
  setWorkerConnected: (workerConnected) => set({ workerConnected }),
}));
```

## WS-Driven Store Pattern

For stores that receive live WebSocket events (existing pattern from `orderStore`):

```ts
// Action that processes incoming WS messages
applyWorkerEvent: (msg: WorkerEvent) => {
  switch (msg.type) {
    case 'strategy_update':
      set((s) => ({
        strategies: s.strategies.map((st) =>
          st.symbol === msg.symbol ? { ...st, status: msg.status } : st
        ),
      }));
      break;
    case 'engine_ready':
      set({ engineState: 'ready' });
      break;
    case 'engine_stopped':
      set({ engineState: 'idle' });
      break;
  }
},
```

## Selector Patterns

```tsx
// GOOD: narrow — re-renders only when strategies change
const strategies = useDashboardStore((s) => s.strategies);

// GOOD: derived value — compute in selector
const runningCount = useDashboardStore((s) =>
  s.strategies.filter((st) => st.status === 'on').length
);

// GOOD: multiple fields — use shallow compare
import { useShallow } from 'zustand/shallow';
const { engineState, workerConnected } = useDashboardStore(
  useShallow((s) => ({ engineState: s.engineState, workerConnected: s.workerConnected }))
);

// BAD: subscribes to everything
const store = useDashboardStore();
```

## Common Pitfalls

1. **Don't call `set()` in a loop** — batch updates into one `set()` call.
2. **Don't store derived data** — compute it in selectors. E.g., don't store `runningStrategies` separately.
3. **Don't put component-local state in stores** — form input values, hover states stay in `useState`.
4. **Don't forget `type` imports** — `import type { Strategy } from '../types/dashboard'`.

## Reference Files

| What | Where |
|------|-------|
| Existing stores | `chart-ui/src/store/` |
| chartStore (most complex) | `chart-ui/src/store/chartStore.ts` |
| orderStore (WS pattern) | `chart-ui/src/store/orderStore.ts` |
| authStore (async actions) | `chart-ui/src/store/authStore.ts` |
