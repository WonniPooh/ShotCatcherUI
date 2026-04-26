/** Strategy config as sent to the worker (matches strategies.json format). */
export interface StrategyConfig {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  leverage: number | 'max';
  leverage_limit?: number | null;          // cap on "max" leverage: min(exchange_max, limit). 0/null = no cap
  min_allowed_leverage?: number | null;    // disable strategy if exchange max < this. 0/null = no minimum

  // Sizing — exactly one must be set
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
  resolved_leverage?: number;  // actual leverage set on the exchange (returned by worker)
  error?: string;
}

// ── Worker → browser events ──────────────────────────────────────────────

export interface StrategyReadyEvent {
  type: 'strategy_ready';
  symbol: string;
  leverage?: number;  // resolved leverage (e.g. 75 when config was "max")
}

export interface StrategyStoppedEvent {
  type: 'strategy_stopped';
  symbol: string;
  reason?: string;
}

export interface EmergencyStopCompleteEvent {
  type: 'emergency_stop_complete';
}

export interface StrategyErrorEvent {
  type: 'strategy_error';
  symbol: string;
  msg: string;
}

export interface EngineReadyEvent {
  type: 'engine_ready';
}

export interface EngineStoppedEvent {
  type: 'engine_stopped';
  reason?: string;
}

export interface ErrorEvent {
  type: 'error';
  msg: string;
}

export interface WorkerConnectedEvent {
  type: 'worker_connected';
}

export interface WorkerDisconnectedEvent {
  type: 'worker_disconnected';
}

export interface HelloEvent {
  type: 'hello';
  server: string;
}

export interface ConfigSavedEvent {
  type: 'config_saved';
  filename: string;
  count: number;
}

export interface ConfigLoadedEvent {
  type: 'config_loaded';
  filename: string;
  count: number;
  strategies?: StrategyConfig[];
}

export interface ConfigListEvent {
  type: 'config_list';
  files: Array<{
    filename: string;
    size_bytes: number;
    modified: number;
    strategy_count: number;
  }>;
}

export interface ConfigDeletedEvent {
  type: 'config_deleted';
  filename: string;
}

export interface ConfigRenamedEvent {
  type: 'config_renamed';
  filename: string;
  new_filename: string;
}

export interface LossStatusEvent {
  type: 'loss_status';
  global_rolling_pnl: number;
  max_global_rolling_loss_usd: number;
  global_rolling_window_hours: number;
  strategies: Array<{
    symbol: string;
    active: boolean;
    consecutive_losses: number;
    rolling_pnl: number;
    window_hours: number;
  }>;
}

export interface StrategiesSnapshotEvent {
  type: 'strategies_snapshot';
  strategies: Array<{
    symbol: string;
    status: StrategyStatus;
    config: StrategyConfig;
    error?: string | null;
  }>;
}

export interface StrategyAddedEvent {
  type: 'strategy_added';
  symbol: string;
}

export interface StrategyRemovedEvent {
  type: 'strategy_removed';
  symbol: string;
}

export interface StrategyPausedEvent {
  type: 'strategy_paused';
  symbol: string;
}

export interface StrategyResumedEvent {
  type: 'strategy_resumed';
  symbol: string;
}

export interface LeverageChangedEvent {
  type: 'leverage_changed';
  symbol: string;
  leverage: number;  // new actual leverage on the exchange
}

export type WorkerEvent =
  | StrategyReadyEvent
  | StrategyStoppedEvent
  | StrategyAddedEvent
  | StrategyRemovedEvent
  | StrategyPausedEvent
  | StrategyResumedEvent
  | StrategyErrorEvent
  | EngineReadyEvent
  | EngineStoppedEvent
  | EmergencyStopCompleteEvent
  | ErrorEvent
  | WorkerConnectedEvent
  | WorkerDisconnectedEvent
  | HelloEvent
  | ConfigSavedEvent
  | ConfigLoadedEvent
  | ConfigListEvent
  | ConfigDeletedEvent
  | ConfigRenamedEvent
  | LossStatusEvent
  | StrategiesSnapshotEvent
  | LeverageChangedEvent;
