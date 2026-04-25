---
name: add-dashboard-feature
description: End-to-end guide for adding a new feature to the strategy dashboard. Covers the full stack from React component through Zustand store, WS hook, Python backend router, to worker protocol integration. Use when implementing any dashboard functionality.
argument-hint: "Implement the Add Strategy flow — form, validation, WS send, worker response handling"
---

# Add Dashboard Feature

## When to Use

- Adding a new dashboard capability (e.g. strategy form, global controls, status display)
- Adding a new WS message type (browser ↔ backend ↔ worker)
- Extending the dashboard with a new panel or control

## Architecture Overview

```
Browser                    ui-server (Python)              Worker (C++)
───────                    ──────────────────              ────────────
React component            /ws/dashboard router            ControlServer
  ↓ user action            worker_client.py                  ↓
Zustand store action         ↓                            CommandDispatcher
  ↓                        forward to worker WS              ↓
useWorkerStream.send()       ↓                            process command
  ↓ WS message             forward response to browser       ↓
/ws/dashboard                ↓                            send response
  ↓                        broadcast to subscribers          ↓
useWorkerStream.onmessage    ↑                            WS push event
  ↓                                                         ↑
store.applyWorkerEvent()
  ↓
component re-renders
```

## Checklist

- [ ] 1. **Types** — define message types in `src/types/dashboard.ts`
- [ ] 2. **Store** — add state fields + actions in `src/store/dashboardStore.ts`
- [ ] 3. **WS routing** — handle new message type in `applyWorkerEvent`
- [ ] 4. **Component** — build the UI in `src/components/dashboard/`
- [ ] 5. **WS send** — add send call in component via `useWorkerStream().send()`
- [ ] 6. **Backend router** — ensure `/ws/dashboard` forwards the message type
- [ ] 7. **Backend worker_client** — ensure response type is forwarded to subscribers
- [ ] 8. **Tests** — store tests + component tests
- [ ] 9. **Type check** — `tsc -b` from `chart-ui/`
- [ ] 10. **Manual test** — verify full round-trip with running worker

## Step 1 — Types

Define in `src/types/dashboard.ts`:

```ts
// Strategy config as sent to worker (matches strategies.json format minus comments)
export interface StrategyConfig {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  leverage: number;

  // Sizing (exactly one should be set)
  quantity?: number;
  quantity_usdt?: number;
  quantity_margin_usdt?: number;

  // Entry
  entry_distance_pct: number;
  buffer_pct: number;
  replace_delay_up_ms: number;
  replace_delay_down_ms: number;
  max_order_age_ms: number | null;
  max_order_modifications: number | null;

  // Exit
  tp_pct: number;
  tp_delay_ms: number;
  sl_stop_pct: number;
  sl_limit_pct: number;
  sl_delay_ms: number;

  // Position
  position_max_age_ms: number | null;
  pause_after_close_ms: number;
  partial_fill_wait_ms: number;

  // TP step-down
  tp_adjust_enabled: boolean;
  tp_adjust_step_pct: number;
  tp_adjust_timeout_ms: number;
  tp_adjust_steps_limit: number;

  // Loss limits
  max_consecutive_losses: number | null;
  max_net_loss_usd: number | null;
  net_loss_window_hours: number;
}

export type StrategyStatus = 'on' | 'off' | 'paused' | 'stopped' | 'removed' | 'error';
export type EngineState = 'idle' | 'ready' | 'trading';

export interface Strategy {
  symbol: string;
  status: StrategyStatus;
  config: StrategyConfig;
  error?: string;
  pauseReason?: string;
}

// Worker → browser events
export interface StrategyUpdateEvent {
  type: 'strategy_update';
  symbol: string;
  status: StrategyStatus;
  reason?: string;
  msg?: string;
}

export interface EngineEvent {
  type: 'engine_ready' | 'engine_stopped';
  reason?: string;
}

export type WorkerEvent = StrategyUpdateEvent | EngineEvent | { type: string; [key: string]: unknown };
```

## Step 2 — Store

See `zustand-store` skill for patterns. Key actions for dashboard:

```ts
addStrategy: (config) => void;           // optimistic add, status 'off'
removeStrategy: (symbol) => void;        // remove from list
applyWorkerEvent: (msg) => void;         // route incoming WS events
setEngineState: (state) => void;
setWorkerConnected: (connected) => void;
```

## Step 3 — WS Routing

In the store's `applyWorkerEvent`:

```ts
applyWorkerEvent: (msg: WorkerEvent) => {
  const { type } = msg;
  if (type === 'strategy_update') {
    // Update strategy status
  } else if (type === 'engine_ready') {
    set({ engineState: 'ready' });
  } else if (type === 'engine_stopped') {
    set({ engineState: 'idle', strategies: markAllOff(get().strategies) });
  } else if (type === 'hello') {
    // Worker connection confirmed
  } else if (type === 'error') {
    // Show error notification
  }
},
```

## Step 4 — Component

Follow `react-component` skill. Dashboard-specific layout:

```
DashboardPage
├── WorkerStatus          (connection indicator, engine state)
├── GlobalControls        (start/stop engine, start/stop all, emergency, save/load)
├── StrategyForm          (config form, Add button)
└── StrategyGrid
    └── StrategyCard[]    (one per symbol, status badge, start/stop/remove)
```

## Step 5 — WS Send

```tsx
// In component
const { send } = useWorkerStream();

const handleAddStrategy = (config: StrategyConfig) => {
  dashboardStore.addStrategy(config);  // optimistic UI
  send({
    type: 'add_strat',
    strategies: { strategies: [{ ...config, active: false }] },
  });
};
```

## Step 6 — Backend Router

Python `/ws/dashboard` in `ui-server/routers/ws_dashboard.py`:

- Accept WS with ticket auth (same as `/ws/ui`)
- Forward browser messages to `worker_client.send()`
- Forward worker events to all dashboard subscribers
- Handle `save_config` / `load_config` locally (file I/O, not forwarded to worker)

## Step 7 — Validation

Validate on ui-server before forwarding to worker:

| Field | Rule |
|-------|------|
| `symbol` | non-empty, uppercase, alphanumeric + ends with USDT |
| `direction` | `LONG` or `SHORT` |
| `leverage` | 1–125 integer |
| `entry_distance_pct` | > 0, < 50 |
| `tp_pct` | > 0, < 100 |
| `sl_stop_pct` | > 0, < 100 |
| Sizing | exactly one of `quantity`, `quantity_usdt`, `quantity_margin_usdt` set and > 0 |

Worker will also reject invalid configs via `strategy_error` — surface as error on the card.

## Common Pitfalls

1. **Don't forget to add the Vite proxy** — new WS endpoints need proxy config in `vite.config.ts`.
2. **Don't duplicate state** — worker is source of truth for status. Dashboard only has optimistic adds.
3. **Don't block on worker response** — UI updates optimistically, then corrects if worker rejects.
4. **Don't forget cleanup** — if dashboard page unmounts, unsubscribe from WS events.

## Reference Files

| What | Where |
|------|-------|
| System architecture | `docs/system-architecture.md` |
| Control WS protocol | `controller/docs/control-ws-protocol.md` |
| Strategy config example | `worker/config/strategies.example.json` |
| Existing WS router | `ui-server/routers/ws_ui.py` |
| Collector client pattern | `ui-server/collector_client.py` |
| React component skill | `.github/skills/react-component/` |
| Zustand store skill | `.github/skills/zustand-store/` |
| WebSocket hook skill | `.github/skills/websocket-hook/` |
| Testing skill | `.github/skills/vitest-testing/` |
