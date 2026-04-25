import { useState, useCallback } from 'react';
import { useShallow } from 'zustand/shallow';
import { useDashboardStore } from '../../store/dashboardStore';
import { useWorkerStream } from '../../hooks/useWorkerStream';
import type { Strategy, StrategyConfig } from '../../types/dashboard';
import WorkerStatus from './WorkerStatus';
import GlobalControls from './GlobalControls';
import StrategyCard from './StrategyCard';
import StrategyForm from './StrategyForm';
import ConfigDialog from './ConfigDialog';

export default function DashboardPage() {
  const { send } = useWorkerStream();

  const { strategies, engineState, workerConnected, lastError, configFiles } = useDashboardStore(
    useShallow((s) => ({
      strategies: s.strategies,
      engineState: s.engineState,
      workerConnected: s.workerConnected,
      lastError: s.lastError,
      configFiles: s.configFiles,
    })),
  );
  const clearError = useDashboardStore((s) => s.clearError);
  const addStrategy = useDashboardStore((s) => s.addStrategy);
  const modifyStrategy = useDashboardStore((s) => s.modifyStrategy);
  const removeStrategy = useDashboardStore((s) => s.removeStrategy);

  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null);
  const [configDialog, setConfigDialog] = useState<'save' | 'load' | null>(null);

  const engineReady = engineState !== 'idle';

  // ── Strategy handlers ────────────────────────────────────────────────────

  const handleFormSubmit = useCallback(
    (config: StrategyConfig) => {
      if (selectedStrategy) {
        // Modify existing — update local store + re-register on worker
        modifyStrategy(selectedStrategy.symbol, config);
      } else {
        // Add new to local store
        addStrategy(config);
      }
      // Register on worker (pending, not started)
      send({
        type: 'add_strat',
        strategies: { strategies: [{ ...config, symbols: [config.symbol], active: true }] },
      });
      setSelectedStrategy(null);
    },
    [send, addStrategy, modifyStrategy, selectedStrategy],
  );

  const handleStartStrategy = useCallback(
    (symbol: string) => {
      send({ type: 'start_strat', symbols: [symbol] });
    },
    [send],
  );

  const handleStopStrategy = useCallback(
    (symbol: string) => {
      send({ type: 'stop_strat', symbols: [symbol] });
    },
    [send],
  );

  const handleKillStrategy = useCallback(
    (symbol: string) => {
      send({ type: 'kill_strat', symbols: [symbol] });
    },
    [send],
  );

  const handleRemoveStrategy = useCallback(
    (symbol: string) => {
      removeStrategy(symbol);
      send({ type: 'remove_strat', symbols: [symbol] });
      if (selectedStrategy?.symbol === symbol) {
        setSelectedStrategy(null);
      }
    },
    [send, removeStrategy, selectedStrategy],
  );

  // ── Engine handlers ──────────────────────────────────────────────────────

  const handleEmergencyStop = useCallback(() => {
    send({ type: 'emergency_stop' });
  }, [send]);

  const handleStartAll = useCallback(() => {
    const symbols = strategies
      .filter((s) => s.status === 'off' || s.status === 'stopped')
      .map((s) => s.symbol);
    if (symbols.length > 0) {
      send({ type: 'start_strat', symbols });
    }
  }, [send, strategies]);

  const handleStopAll = useCallback(() => {
    const symbols = strategies
      .filter((s) => s.status === 'on' || s.status === 'paused')
      .map((s) => s.symbol);
    if (symbols.length > 0) {
      send({ type: 'stop_all', symbols });
    }
  }, [send, strategies]);

  // ── Config dialog handlers ───────────────────────────────────────────────

  const handleOpenSave = useCallback(() => setConfigDialog('save'), []);
  const handleOpenLoad = useCallback(() => setConfigDialog('load'), []);
  const handleCloseDialog = useCallback(() => setConfigDialog(null), []);

  const handleRefreshConfigs = useCallback(() => {
    send({ type: 'list_configs' });
  }, [send]);

  const handleSaveConfig = useCallback(
    (filename: string) => {
      const configs = strategies.map((s) => s.config);
      send({ type: 'save_config', filename, strategies: configs });
    },
    [send, strategies],
  );

  const handleLoadConfig = useCallback(
    (filename: string) => {
      send({ type: 'load_config', filename });
    },
    [send],
  );

  const handleDeleteConfig = useCallback(
    (filename: string) => {
      send({ type: 'delete_config', filename });
    },
    [send],
  );

  const handleRenameConfig = useCallback(
    (oldName: string, newName: string) => {
      send({ type: 'rename_config', filename: oldName, new_filename: newName });
    },
    [send],
  );

  // Default filename suggestion for save dialog
  const defaultFilename = `strategies_${new Date().toISOString().slice(0, 10)}.json`;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full w-full bg-[#0f1117] text-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h1 className="text-xl font-bold text-white">Dashboard</h1>
        <WorkerStatus workerConnected={workerConnected} engineState={engineState} />
      </div>

      {/* Error banner */}
      {lastError && (
        <div className="flex items-center justify-between px-4 py-2 bg-red-900/30 border-b border-red-800/50">
          <span className="text-sm text-red-300">{lastError}</span>
          <button
            type="button"
            className="text-red-400 hover:text-red-300 text-sm"
            onClick={clearError}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Controls bar */}
      <div className="px-4 py-3 border-b border-gray-800">
        <GlobalControls
          engineState={engineState}
          workerConnected={workerConnected}
          hasStartable={strategies.some((s) => s.status === 'off' || s.status === 'stopped')}
          hasRunning={strategies.some((s) => s.status === 'on' || s.status === 'paused')}
          onEmergencyStop={handleEmergencyStop}
          onStartAll={handleStartAll}
          onStopAll={handleStopAll}
          onSaveConfig={handleOpenSave}
          onLoadConfig={handleOpenLoad}
        />
      </div>

      {/* Main content — 60/40 split */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Strategy cards grid — 60% */}
        <div className="w-[60%] overflow-y-auto p-4">
          {strategies.length === 0 ? (
            <div className="text-gray-500 text-center py-12">
              No strategies. Use the form to add one, or Load a saved config.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
              {strategies.map((s) => (
                <StrategyCard
                  key={s.symbol}
                  strategy={s}
                  onStart={handleStartStrategy}
                  onStop={handleStopStrategy}
                  onKill={handleKillStrategy}
                  onRemove={handleRemoveStrategy}
                  onSelect={setSelectedStrategy}
                  engineReady={engineReady}
                />
              ))}
            </div>
          )}
        </div>

        {/* Form sidebar — 40% */}
        <div className="w-[40%] border-l border-gray-800 overflow-y-auto p-4">
          <StrategyForm
            key={selectedStrategy?.symbol ?? '__new'}
            initialConfig={selectedStrategy?.config}
            isModify={selectedStrategy != null}
            onSubmit={handleFormSubmit}
            onClear={() => setSelectedStrategy(null)}
          />
        </div>
      </div>

      {/* Config dialog */}
      {configDialog && (
        <ConfigDialog
          mode={configDialog}
          files={configFiles}
          defaultFilename={configDialog === 'save' ? defaultFilename : undefined}
          onSave={handleSaveConfig}
          onLoad={handleLoadConfig}
          onDelete={handleDeleteConfig}
          onRename={handleRenameConfig}
          onRefresh={handleRefreshConfigs}
          onClose={handleCloseDialog}
        />
      )}
    </div>
  );
}
