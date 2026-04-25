import type { EngineState } from '../../types/dashboard';

interface WorkerStatusProps {
  workerConnected: boolean;
  engineState: EngineState;
}

export default function WorkerStatus({ workerConnected, engineState }: WorkerStatusProps) {
  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-gray-800/50 rounded-lg border border-gray-700">
      <div className="flex items-center gap-2">
        <div
          className={`w-2.5 h-2.5 rounded-full ${
            workerConnected ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' : 'bg-red-500'
          }`}
        />
        <span className="text-sm text-gray-300">
          Worker: {workerConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      <div className="w-px h-4 bg-gray-600" />
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-400">Engine:</span>
        <span
          className={`text-sm font-medium ${
            engineState === 'trading'
              ? 'text-green-400'
              : engineState === 'ready'
                ? 'text-blue-400'
                : 'text-gray-500'
          }`}
        >
          {engineState.toUpperCase()}
        </span>
      </div>
    </div>
  );
}
