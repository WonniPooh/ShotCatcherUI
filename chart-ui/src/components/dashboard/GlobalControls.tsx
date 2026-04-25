interface GlobalControlsProps {
  engineState: 'idle' | 'ready' | 'trading';
  workerConnected: boolean;
  hasStartable: boolean;
  hasRunning: boolean;
  onEmergencyStop: () => void;
  onStartAll: () => void;
  onStopAll: () => void;
  onSaveConfig: () => void;
  onLoadConfig: () => void;
}

export default function GlobalControls({
  engineState,
  workerConnected,
  hasStartable,
  hasRunning,
  onEmergencyStop,
  onStartAll,
  onStopAll,
  onSaveConfig,
  onLoadConfig,
}: GlobalControlsProps) {
  const canStartAll = engineState !== 'idle' && hasStartable;
  const canStopAll = hasRunning;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Batch strategy controls */}
      <div className="flex items-center gap-2 border-r border-gray-700 pr-3 mr-1">
        <button
          type="button"
          disabled={!canStartAll}
          className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white transition-colors"
          onClick={onStartAll}
        >
          Start All
        </button>
        <button
          type="button"
          disabled={!canStopAll}
          className="px-3 py-1.5 text-sm rounded bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-700 disabled:text-gray-500 text-white transition-colors"
          onClick={onStopAll}
        >
          Stop All
        </button>
      </div>

      {/* Emergency */}
      <button
        type="button"
        disabled={!workerConnected || engineState === 'idle'}
        className="px-3 py-1.5 text-sm rounded bg-red-700 hover:bg-red-600 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold transition-colors"
        onClick={onEmergencyStop}
      >
        EMERGENCY STOP
      </button>

      {/* Config save/load */}
      <div className="flex items-center gap-2 ml-auto">
        <button
          type="button"
          className="px-3 py-1.5 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
          onClick={onSaveConfig}
        >
          Save
        </button>
        <button
          type="button"
          className="px-3 py-1.5 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
          onClick={onLoadConfig}
        >
          Load
        </button>
      </div>
    </div>
  );
}
