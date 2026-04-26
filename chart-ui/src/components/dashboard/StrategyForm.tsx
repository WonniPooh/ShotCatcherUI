import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { StrategyConfig } from '../../types/dashboard';
import { useFuturesSymbols } from '../../hooks/useFuturesSymbols';

const DEFAULT_CONFIG: StrategyConfig = {
  symbol: '',
  direction: 'LONG',
  leverage: 10,
  leverage_limit: null,
  min_allowed_leverage: null,
  quantity_usdt: 50,
  entry_distance_pct: 1.5,
  buffer_pct: 0.25,
  replace_delay_up_ms: 500,
  replace_delay_down_ms: 15,
  max_order_age_ms: null,
  max_order_modifications: 150,
  tp_pct: 0.5,
  tp_delay_ms: 0,
  sl_stop_pct: 0.5,
  sl_limit_pct: 1.8,
  sl_delay_ms: 0,
  position_max_age_ms: null,
  pause_after_close_ms: 1000,
  partial_fill_wait_ms: 2000,
  tp_adjust_enabled: false,
  tp_adjust_step_pct: 0.03,
  tp_adjust_timeout_ms: 10000,
  tp_adjust_steps_limit: 3,
  max_consecutive_losses: null,
  max_net_loss_usd: null,
  net_loss_window_hours: 4,
};

type SizingMode = 'quantity' | 'quantity_usdt' | 'quantity_margin_usdt';

const SIZING_LABELS: Record<SizingMode, string> = {
  quantity_usdt: 'USDT Notional',
  quantity_margin_usdt: 'USDT Margin',
  quantity: 'Fixed Units',
};

function validateConfig(config: StrategyConfig, sizingMode: SizingMode): string | null {
  const symbol = config.symbol.trim().toUpperCase();
  if (!symbol) return 'Symbol is required';
  if (!symbol.endsWith('USDT')) return 'Symbol must end with USDT';
  if (config.leverage !== 'max') {
    if (typeof config.leverage !== 'number' || config.leverage < 1 || config.leverage > 125)
      return 'Leverage must be 1-125';
  }
  if (config.leverage === 'max' && config.leverage_limit != null && config.leverage_limit > 0) {
    if (config.leverage_limit < 1 || config.leverage_limit > 125) return 'Leverage limit must be 1-125';
  }
  if (config.min_allowed_leverage != null && config.min_allowed_leverage > 0) {
    if (config.min_allowed_leverage < 1 || config.min_allowed_leverage > 125)
      return 'Min allowed leverage must be 1-125';
  }

  const sizeVal = config[sizingMode];
  if (sizeVal == null || sizeVal <= 0) return 'Size must be > 0';

  if (config.entry_distance_pct <= 0) return 'Entry % must be > 0';
  if (config.tp_pct <= 0) return 'TP % must be > 0';
  if (config.sl_stop_pct <= 0) return 'SL Stop % must be > 0';
  if (config.sl_limit_pct <= 0) return 'SL Limit % must be > 0';

  return null;
}

interface StrategyFormProps {
  initialConfig?: StrategyConfig;
  isModify?: boolean;
  onSubmit: (config: StrategyConfig) => void;
  onClear?: () => void;
  onClone?: () => void;
}

export default function StrategyForm({ initialConfig, isModify, onSubmit, onClear, onClone }: StrategyFormProps) {
  const [config, setConfig] = useState<StrategyConfig>(initialConfig ?? DEFAULT_CONFIG);
  const [leverageMode, setLeverageMode] = useState<'fixed' | 'max'>(
    initialConfig?.leverage === 'max' ? 'max' : 'fixed',
  );
  const [sizingMode, setSizingMode] = useState<SizingMode>(
    initialConfig?.quantity != null
      ? 'quantity'
      : initialConfig?.quantity_margin_usdt != null
        ? 'quantity_margin_usdt'
        : 'quantity_usdt',
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Symbol autocomplete ──────────────────────────────────────────────────
  const allSymbols = useFuturesSymbols();
  const [symbolFocused, setSymbolFocused] = useState(false);
  const symbolRef = useRef<HTMLDivElement>(null);

  const symbolHints = useMemo(() => {
    if (!symbolFocused || isModify) return [];
    const q = config.symbol.trim().toUpperCase();
    if (!q) return allSymbols.slice(0, 20);
    const starts = allSymbols.filter((s) => s.startsWith(q));
    const contains = allSymbols.filter((s) => !s.startsWith(q) && s.includes(q));
    return [...starts, ...contains].slice(0, 20);
  }, [allSymbols, config.symbol, symbolFocused, isModify]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!symbolFocused) return;
    const handler = (e: MouseEvent) => {
      if (symbolRef.current && !symbolRef.current.contains(e.target as Node)) {
        setSymbolFocused(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [symbolFocused]);

  // ── Field helpers ────────────────────────────────────────────────────────
  const set = useCallback(
    <K extends keyof StrategyConfig>(key: K, value: StrategyConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
      setValidationError(null);
    },
    [],
  );

  const numField = useCallback(
    (key: keyof StrategyConfig, value: string) => {
      const n = value === '' ? 0 : Number(value);
      set(key, n as StrategyConfig[typeof key]);
    },
    [set],
  );

  const nullableNumField = useCallback(
    (key: keyof StrategyConfig, value: string) => {
      set(key, (value === '' ? null : Number(value)) as StrategyConfig[typeof key]);
    },
    [set],
  );

  const buildFinalConfig = (): StrategyConfig => {
    const final = { ...config };
    delete final.quantity;
    delete final.quantity_usdt;
    delete final.quantity_margin_usdt;
    if (sizingMode === 'quantity') final.quantity = config.quantity ?? config.quantity_usdt ?? 50;
    else if (sizingMode === 'quantity_usdt') final.quantity_usdt = config.quantity_usdt ?? 50;
    else final.quantity_margin_usdt = config.quantity_margin_usdt ?? 50;
    final.symbol = final.symbol.toUpperCase().trim();
    // Leverage
    if (leverageMode === 'max') {
      final.leverage = 'max';
    }
    if (leverageMode !== 'max' || !final.leverage_limit) delete final.leverage_limit;
    if (!final.min_allowed_leverage) delete final.min_allowed_leverage;
    return final;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateConfig(config, sizingMode);
    if (err) {
      setValidationError(err);
      return;
    }
    if (isModify && !showConfirm) {
      setShowConfirm(true);
      return;
    }
    setShowConfirm(false);
    onSubmit(buildFinalConfig());
  };

  const handleConfirmModify = () => {
    setShowConfirm(false);
    onSubmit(buildFinalConfig());
  };

  const handleReset = () => {
    setConfig(DEFAULT_CONFIG);
    setLeverageMode('fixed');
    setSizingMode('quantity_usdt');
    setValidationError(null);
    setShowConfirm(false);
    onClear?.();
  };

  const sizingValue =
    sizingMode === 'quantity'
      ? config.quantity
      : sizingMode === 'quantity_usdt'
        ? config.quantity_usdt
        : config.quantity_margin_usdt;

  const inputClass =
    'w-full bg-gray-900 text-white border border-gray-600 rounded px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none';
  const disabledInputClass =
    'w-full bg-gray-900/50 text-gray-500 border border-gray-700 rounded px-3 py-1.5 text-sm cursor-not-allowed';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800 rounded-lg border border-gray-700 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-white font-semibold">
          {isModify ? 'Modify Strategy' : 'Add Strategy'}
        </h3>
      </div>

      {validationError && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
          {validationError}
        </div>
      )}

      {/* ── Core: Symbol, Direction ── */}
      <div className="grid grid-cols-2 gap-3">
        <div className="relative" ref={symbolRef}>
          <label className={labelClass}>Symbol</label>
          <input
            type="text"
            className={isModify ? disabledInputClass : inputClass}
            placeholder="BTCUSDT"
            value={config.symbol}
            onChange={(e) => set('symbol', e.target.value)}
            onFocus={() => setSymbolFocused(true)}
            disabled={isModify}
            autoComplete="off"
          />
          {symbolHints.length > 0 && symbolFocused && !isModify && (
            <div className="absolute z-50 left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-gray-900 border border-gray-600 rounded shadow-lg">
              {symbolHints.map((sym) => (
                <button
                  key={sym}
                  type="button"
                  className="block w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    set('symbol', sym);
                    setSymbolFocused(false);
                  }}
                >
                  {sym}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className={labelClass}>Direction</label>
          <select
            className={isModify ? disabledInputClass : inputClass}
            value={config.direction}
            onChange={(e) => set('direction', e.target.value as 'LONG' | 'SHORT')}
            disabled={isModify}
          >
            <option value="LONG">LONG</option>
            <option value="SHORT">SHORT</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Sizing Mode</label>
          <select className={inputClass} value={sizingMode} onChange={(e) => setSizingMode(e.target.value as SizingMode)}>
            {Object.entries(SIZING_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Size</label>
          <input type="number" className={inputClass} min={0} step="any" value={sizingValue ?? ''} onChange={(e) => numField(sizingMode, e.target.value)} />
        </div>
      </div>

      {/* ── Leverage ── */}
      <fieldset className="border border-gray-700 rounded p-3">
        <legend className="text-xs text-gray-500 px-1">Leverage</legend>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Mode</label>
            <select
              className={inputClass}
              value={leverageMode}
              onChange={(e) => {
                const mode = e.target.value as 'fixed' | 'max';
                setLeverageMode(mode);
                if (mode === 'max') set('leverage', 'max' as unknown as StrategyConfig['leverage']);
                else set('leverage', 10);
              }}
            >
              <option value="fixed">Fixed</option>
              <option value="max">Max available</option>
            </select>
          </div>
          {leverageMode === 'fixed' ? (
            <div>
              <label className={labelClass}>Leverage</label>
              <input type="number" className={inputClass} min={1} max={125} value={typeof config.leverage === 'number' ? config.leverage : 10} onChange={(e) => numField('leverage', e.target.value)} />
            </div>
          ) : (
            <div>
              <label className={labelClass}>Limit (cap max)</label>
              <input type="number" className={inputClass} min={1} max={125} placeholder="e.g. 50" value={config.leverage_limit ?? ''} onChange={(e) => nullableNumField('leverage_limit', e.target.value)} title="Use min(exchange_max, this value)" />
            </div>
          )}
          {leverageMode === 'max' && (
            <div>
              <label className={labelClass}>Min allowed</label>
              <input type="number" className={inputClass} min={1} max={125} placeholder="disable if below" value={config.min_allowed_leverage ?? ''} onChange={(e) => nullableNumField('min_allowed_leverage', e.target.value)} title="Disable strategy if exchange max drops below this" />
            </div>
          )}
        </div>
      </fieldset>

      {/* ── Entry ── */}
      <fieldset className="border border-gray-700 rounded p-3">
        <legend className="text-xs text-gray-500 px-1">Entry</legend>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Entry Distance %</label>
            <input type="number" className={inputClass} step="any" value={config.entry_distance_pct} onChange={(e) => numField('entry_distance_pct', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Buffer %</label>
            <input type="number" className={inputClass} step="any" value={config.buffer_pct} onChange={(e) => numField('buffer_pct', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Replace Up ms</label>
            <input type="number" className={inputClass} value={config.replace_delay_up_ms} onChange={(e) => numField('replace_delay_up_ms', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Replace Down ms</label>
            <input type="number" className={inputClass} value={config.replace_delay_down_ms} onChange={(e) => numField('replace_delay_down_ms', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Max Order Age ms</label>
            <input type="number" className={inputClass} placeholder="∞" value={config.max_order_age_ms ?? ''} onChange={(e) => nullableNumField('max_order_age_ms', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Max Modifications</label>
            <input type="number" className={inputClass} placeholder="∞" value={config.max_order_modifications ?? ''} onChange={(e) => nullableNumField('max_order_modifications', e.target.value)} />
          </div>
        </div>
      </fieldset>

      {/* ── Exit (TP + SL + TP Step-down) ── */}
      <fieldset className="border border-gray-700 rounded p-3">
        <legend className="text-xs text-gray-500 px-1">Exit</legend>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>TP %</label>
            <input type="number" className={inputClass} step="any" value={config.tp_pct} onChange={(e) => numField('tp_pct', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>TP Delay ms</label>
            <input type="number" className={inputClass} value={config.tp_delay_ms} onChange={(e) => numField('tp_delay_ms', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>SL Stop %</label>
            <input type="number" className={inputClass} step="any" value={config.sl_stop_pct} onChange={(e) => numField('sl_stop_pct', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>SL Limit %</label>
            <input type="number" className={inputClass} step="any" value={config.sl_limit_pct} onChange={(e) => numField('sl_limit_pct', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>SL Delay ms</label>
            <input type="number" className={inputClass} value={config.sl_delay_ms} onChange={(e) => numField('sl_delay_ms', e.target.value)} />
          </div>
        </div>

        {/* TP Step-down sub-section */}
        <div className="mt-3 pt-3 border-t border-gray-700/50">
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer mb-3">
            <input type="checkbox" checked={config.tp_adjust_enabled} onChange={(e) => set('tp_adjust_enabled', e.target.checked)} className="rounded" />
            TP Step-down
          </label>
          {config.tp_adjust_enabled && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Step %</label>
                <input type="number" className={inputClass} step="any" value={config.tp_adjust_step_pct} onChange={(e) => numField('tp_adjust_step_pct', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Timeout ms</label>
                <input type="number" className={inputClass} value={config.tp_adjust_timeout_ms} onChange={(e) => numField('tp_adjust_timeout_ms', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Steps Limit</label>
                <input type="number" className={inputClass} value={config.tp_adjust_steps_limit} onChange={(e) => numField('tp_adjust_steps_limit', e.target.value)} />
              </div>
            </div>
          )}
        </div>
      </fieldset>

      {/* ── Advanced toggle ── */}
      <button
        type="button"
        className="text-xs text-blue-400 hover:text-blue-300"
        onClick={() => setShowAdvanced(!showAdvanced)}
      >
        {showAdvanced ? '▾ Hide advanced' : '▸ Show advanced'}
      </button>

      {showAdvanced && (
        <>
          {/* ── Timing & Behavior ── */}
          <fieldset className="border border-gray-700 rounded p-3">
            <legend className="text-xs text-gray-500 px-1">Timing &amp; Behavior</legend>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Position Max Age ms</label>
                <input type="number" className={inputClass} placeholder="∞" value={config.position_max_age_ms ?? ''} onChange={(e) => nullableNumField('position_max_age_ms', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Pause After Close ms</label>
                <input type="number" className={inputClass} value={config.pause_after_close_ms} onChange={(e) => numField('pause_after_close_ms', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Partial Fill Wait ms</label>
                <input type="number" className={inputClass} value={config.partial_fill_wait_ms} onChange={(e) => numField('partial_fill_wait_ms', e.target.value)} />
              </div>
            </div>
          </fieldset>

          {/* ── Loss Limits ── */}
          <fieldset className="border border-gray-700 rounded p-3">
            <legend className="text-xs text-gray-500 px-1">Loss Limits</legend>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Max Consec. Losses</label>
                <input type="number" className={inputClass} placeholder="∞" value={config.max_consecutive_losses ?? ''} onChange={(e) => nullableNumField('max_consecutive_losses', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Max Net Loss USD</label>
                <input type="number" className={inputClass} step="any" placeholder="∞" value={config.max_net_loss_usd ?? ''} onChange={(e) => nullableNumField('max_net_loss_usd', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Loss Window (hours)</label>
                <input type="number" className={inputClass} step="any" value={config.net_loss_window_hours} onChange={(e) => numField('net_loss_window_hours', e.target.value)} />
              </div>
            </div>
          </fieldset>
        </>
      )}

      {/* Modify confirmation */}
      {showConfirm && (
        <div className="p-3 bg-yellow-900/20 border border-yellow-700/40 rounded">
          <p className="text-sm text-yellow-300 mb-2">
            Are you sure? This will modify the <strong>{config.symbol}</strong> strategy.
          </p>
          <div className="flex gap-2">
            <button type="button" className="px-3 py-1 text-xs rounded bg-yellow-600 hover:bg-yellow-500 text-white transition-colors" onClick={handleConfirmModify}>
              Yes, Modify
            </button>
            <button type="button" className="px-3 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors" onClick={() => setShowConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Submit + Reset/Cancel */}
      {!showConfirm && (
        <div className="flex items-center justify-between">
          <button type="submit" className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors">
            {isModify ? 'Modify Strategy' : 'Add Strategy'}
          </button>
          {isModify && onClear ? (
            <div className="flex gap-2">
              {onClone && (
                <button
                  type="button"
                  className="px-4 py-2 text-sm rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                  onClick={onClone}
                >
                  Clone
                </button>
              )}
              <button
                type="button"
                className="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
                onClick={onClear}
              >
                Cancel Edit
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
              onClick={handleReset}
            >
              Reset
            </button>
          )}
        </div>
      )}
    </form>
  );
}
