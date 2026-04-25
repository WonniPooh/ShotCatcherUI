import { useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '../store/authStore';
import { useDashboardStore } from '../store/dashboardStore';
import type { WorkerEvent } from '../types/dashboard';

/**
 * Persistent WebSocket connection to /ws/dashboard.
 * Reconnects with exponential backoff.
 * Routes all incoming worker events to dashboardStore.
 *
 * @returns send — fire a command to the worker via the backend proxy
 */
export function useWorkerStream(): { send: (msg: Record<string, unknown>) => void } {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backoff = useRef(1000);
  const intentionalClose = useRef(false);

  const connect = useCallback(async () => {
    const ticket = await useAuthStore.getState().getWsTicket();
    if (!ticket) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/dashboard?ticket=${ticket}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      backoff.current = 1000;
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WorkerEvent;
        useDashboardStore.getState().applyWorkerEvent(msg);

        // Auto-start engine when worker connects (skip if already running)
        if (
          msg.type === 'worker_connected' &&
          useDashboardStore.getState().engineState === 'idle' &&
          ws.readyState === WebSocket.OPEN
        ) {
          ws.send(JSON.stringify({ type: 'start_engine' }));
        }
      } catch {
        // ignore malformed
      }
    };

    ws.onclose = (ev) => {
      // Don't reconnect on intentional close or auth rejection
      if (intentionalClose.current || ev.code === 1000 || ev.code === 4001) {
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  const scheduleReconnect = useCallback(() => {
    reconnectTimer.current = setTimeout(() => {
      backoff.current = Math.min(backoff.current * 2, 30_000);
      connect();
    }, backoff.current);
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      intentionalClose.current = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send };
}
