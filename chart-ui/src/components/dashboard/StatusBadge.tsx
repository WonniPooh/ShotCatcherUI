import type { StrategyStatus } from '../../types/dashboard';

const STATUS_COLORS: Record<StrategyStatus, string> = {
  on: 'bg-green-500/20 text-green-400 border-green-500/40',
  off: 'bg-gray-500/20 text-gray-400 border-gray-500/40',
  paused: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
  stopped: 'bg-red-500/20 text-red-400 border-red-500/40',
  removed: 'bg-gray-600/20 text-gray-500 border-gray-600/40',
  error: 'bg-red-600/20 text-red-500 border-red-600/40',
};

const STATUS_LABELS: Record<StrategyStatus, string> = {
  on: 'ON',
  off: 'OFF',
  paused: 'PAUSED',
  stopped: 'STOPPED',
  removed: 'REMOVED',
  error: 'ERROR',
};

interface StatusBadgeProps {
  status: StrategyStatus;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${STATUS_COLORS[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
