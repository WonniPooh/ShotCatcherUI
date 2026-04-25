import { useEffect, useCallback } from 'react';

/**
 * Tracks Shift key state for measurement mode.
 * Calls onShiftChange(true/false) on keydown/keyup.
 */
export function useShiftKey(onShiftChange: (pressed: boolean) => void) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Shift') onShiftChange(true);
    },
    [onShiftChange],
  );

  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Shift') onShiftChange(false);
    },
    [onShiftChange],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);
}

/**
 * Handles Delete key for removing selected drawing.
 */
export function useDeleteKey(onDelete: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Delete') onDelete();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onDelete]);
}

/**
 * Handles Alt+R for auto-fit chart scale, Escape for dismiss.
 */
export function useChartKeys(onFitContent: () => void, onEscape: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        onFitContent();
      }
      if (e.key === 'Escape') {
        onEscape();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onFitContent, onEscape]);
}
