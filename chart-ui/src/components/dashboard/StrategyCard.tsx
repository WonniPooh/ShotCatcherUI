import type { Strategy } from '../../types/dashboard';
import StatusBadge from './StatusBadge';

interface StrategyCardProps {
  strategy: Strategy;
  onStart: (symbol: string) => void;
  onStop: (symbol: string) => void;
  onKill: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onSelect: (strategy: Strategy) => void;
  engineReady: boolean;
}

export default function StrategyCard({
  strategy,
  onStart,
  onStop,
  onKill,
  onRemove,
  onSelect,
  engineReady,
}: StrategyCardProps) {
  const { symbol, status, config, error } = strategy;
  const isOn = status === 'on';
  const isOff = status === 'off' || status === 'stopped';
  const isPaused = status === 'paused';
  const canModify = isOff || status === 'error';

  // Sizing display
  let sizing = '';
  if (config.quantity != null) sizing = `${config.quantity} units`;
  else if (config.quantity_usdt != null) sizing = `${config.quantity_usdt} USDT`;
  else if (config.quantity_margin_usdt != null) sizing = `${config.quantity_margin_usdt} USDT margin`;

  return (
    <div
      className={`bg-gray-800 rounded-lg border border-gray-700 p-4 transition-colors ${
        canModify ? 'hover:border-gray-600 cursor-pointer' : 'cursor-default'
      }`}
      onClick={() => canModify && onSelect(strategy)}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-white font-semibold text-lg">{symbol || '—'}</span>
          <span
            className={`text-xs font-medium px-1.5 py-0.5 rounded ${
              config.direction === 'LONG'
                ? 'bg-green-500/20 text-green-400'
                : 'bg-red-500/20 text-red-400'
            }`}
          >
            {config.direction}
          </span>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Key params */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-3">
        <div className="text-gray-400">
          Leverage: <span className="text-gray-200">{config.leverage ?? '—'}x</span>
        </div>
        <div className="text-gray-400">
          Entry: <span className="text-gray-200">{config.entry_distance_pct ?? '—'}%</span>
        </div>
        <div className="text-gray-400">
          TP: <span className="text-gray-200">{config.tp_pct ?? '—'}%</span>
        </div>
        <div className="text-gray-400">
          SL: <span className="text-gray-200">{config.sl_stop_pct ?? '—'}%</span>
        </div>
        <div className="text-gray-400 col-span-2">
          Size: <span className="text-gray-200">{sizing || '—'}</span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 rounded px-2 py-1 mb-3 truncate">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        {isOff && engineReady && (
          <button
            type="button"
            className="px-3 py-1 text-xs rounded bg-green-600 hover:bg-green-500 text-white transition-colors"
            onClick={() => onStart(symbol)}
          >
            Start
          </button>
        )}
        {(isOn || isPaused) && (
          <>
            <button
              type="button"
              className="px-3 py-1 text-xs rounded bg-yellow-600 hover:bg-yellow-500 text-white transition-colors"
              onClick={() => onStop(symbol)}
            >
              Stop
            </button>
            <button
              type="button"
              className="px-3 py-1 text-xs rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
              onClick={() => onKill(symbol)}
            >
              Kill
            </button>
          </>
        )}
        {canModify && (
          <button
            type="button"
            className="px-3 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors"
            onClick={() => onRemove(symbol)}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
