import { useState, useEffect, useCallback } from 'react';

interface ConfigFile {
  filename: string;
  strategy_count: number;
  modified: number;
}

interface ConfigDialogProps {
  mode: 'save' | 'load';
  files: ConfigFile[];
  defaultFilename?: string;
  onSave?: (filename: string) => void;
  onLoad?: (filename: string) => void;
  onDelete?: (filename: string) => void;
  onRename?: (oldName: string, newName: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}

export default function ConfigDialog({
  mode,
  files,
  defaultFilename,
  onSave,
  onLoad,
  onDelete,
  onRename,
  onRefresh,
  onClose,
}: ConfigDialogProps) {
  const [filename, setFilename] = useState(defaultFilename ?? '');
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const handleSave = useCallback(() => {
    const name = filename.trim();
    if (!name) return;
    onSave?.(name.endsWith('.json') ? name : name + '.json');
    onClose();
  }, [filename, onSave, onClose]);

  const handleLoad = useCallback(
    (file: string) => {
      onLoad?.(file);
      onClose();
    },
    [onLoad, onClose],
  );

  const handleDelete = useCallback(
    (file: string) => {
      onDelete?.(file);
      setDeleteConfirm(null);
    },
    [onDelete],
  );

  const handleRename = useCallback(
    (oldName: string) => {
      const newName = renameValue.trim();
      if (!newName) return;
      onRename?.(oldName, newName.endsWith('.json') ? newName : newName + '.json');
      setRenamingFile(null);
      setRenameValue('');
    },
    [renameValue, onRename],
  );

  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-600 rounded-lg shadow-2xl w-[480px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h3 className="text-white font-semibold">
            {mode === 'save' ? 'Save Config' : 'Load Config'}
          </h3>
          <button
            type="button"
            className="text-gray-400 hover:text-gray-200 text-lg leading-none"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* Save: filename input */}
        {mode === 'save' && (
          <div className="px-4 pt-3 pb-2">
            <label className="block text-xs text-gray-400 mb-1">Filename</label>
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 bg-gray-900 text-white border border-gray-600 rounded px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="strategies.json"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                autoFocus
              />
              <button
                type="button"
                disabled={!filename.trim()}
                className="px-4 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white transition-colors"
                onClick={handleSave}
              >
                Save
              </button>
            </div>
          </div>
        )}

        {/* File list */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {files.length === 0 ? (
            <div className="text-gray-500 text-sm text-center py-8">
              No saved config files
            </div>
          ) : (
            <div className="space-y-1">
              {files.map((f) => (
                <div
                  key={f.filename}
                  className={`flex items-center justify-between rounded px-3 py-2 ${
                    mode === 'load' ? 'hover:bg-gray-700/50 cursor-pointer' : 'bg-gray-900/30'
                  } group`}
                >
                  {/* File info */}
                  <div
                    className="flex-1 min-w-0"
                    onClick={() => mode === 'load' && handleLoad(f.filename)}
                  >
                    {renamingFile === f.filename ? (
                      <div className="flex gap-2 items-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          className="flex-1 bg-gray-900 text-white border border-gray-600 rounded px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRename(f.filename);
                            if (e.key === 'Escape') setRenamingFile(null);
                          }}
                          autoFocus
                        />
                        <button
                          type="button"
                          className="text-xs text-blue-400 hover:text-blue-300"
                          onClick={() => handleRename(f.filename)}
                        >
                          OK
                        </button>
                        <button
                          type="button"
                          className="text-xs text-gray-400 hover:text-gray-300"
                          onClick={() => setRenamingFile(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="text-sm text-white truncate">{f.filename}</div>
                        <div className="text-xs text-gray-500">
                          {f.strategy_count} strategies · {formatDate(f.modified)}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Actions */}
                  {renamingFile !== f.filename && (
                    <div
                      className="flex items-center gap-1 ml-2 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {mode === 'save' && (
                        <button
                          type="button"
                          className="text-xs text-blue-400 hover:text-blue-300 px-1.5 py-0.5"
                          onClick={() => setFilename(f.filename)}
                        >
                          Use
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-gray-300 px-1.5 py-0.5"
                        onClick={() => {
                          setRenamingFile(f.filename);
                          setRenameValue(f.filename.replace(/\.json$/, ''));
                        }}
                      >
                        Rename
                      </button>
                      {deleteConfirm === f.filename ? (
                        <>
                          <button
                            type="button"
                            className="text-xs text-red-400 hover:text-red-300 px-1.5 py-0.5"
                            onClick={() => handleDelete(f.filename)}
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            className="text-xs text-gray-400 hover:text-gray-300 px-1.5 py-0.5"
                            onClick={() => setDeleteConfirm(null)}
                          >
                            No
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="text-xs text-red-400 hover:text-red-300 px-1.5 py-0.5"
                          onClick={() => setDeleteConfirm(f.filename)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-4 py-3 border-t border-gray-700">
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
