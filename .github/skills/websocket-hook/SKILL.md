---
name: websocket-hook
description: Guidelines for creating WebSocket hooks and client modules. Covers connection lifecycle, reconnection, auth tickets, message routing, and integration with Zustand stores. Use when adding a new WS endpoint or modifying existing WS connections.
argument-hint: "Add a useWorkerStream hook that connects to /ws/dashboard and routes events to dashboardStore"
---

# WebSocket Hook

## When to Use

- Connecting to a new backend WS endpoint
- Adding message types to an existing WS connection
- Implementing reconnection, auth, or heartbeat logic

## Key Principles

- **One hook per WS endpoint** — `useBinanceStream` for Binance, `useWorkerStream` for dashboard, etc.
- **Auth via WS ticket** — get ticket from `authStore.getWsTicket()`, pass as `?ticket=` query param. Ticket is one-time-use.
- **Auto-reconnect with backoff** — reconnect on close/error. Use increasing delay (1s, 2s, 4s... capped at 30s). Reset on successful connect.
- **Route messages to stores** — the hook parses JSON and calls store actions. Components don't parse WS messages.
- **Cleanup on unmount** — close WS in useEffect return. No leaked connections.
- **Send via ref, not state** — store the WebSocket instance in a `useRef`, not `useState`. Avoids re-renders on WS state changes.

## Checklist

- [ ] 1. Create hook file in `src/hooks/`
- [ ] 2. Build WS URL with auth ticket
- [ ] 3. Handle `onopen`, `onmessage`, `onclose`, `onerror`
- [ ] 4. Parse messages and route to store actions
- [ ] 5. Implement reconnect with backoff
- [ ] 6. Clean up on unmount
- [ ] 7. Wire into the page component via `useEffect`

## Hook Template

```tsx
import { useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '../store/authStore';
import { useDashboardStore } from '../store/dashboardStore';

export function useWorkerStream() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const backoff = useRef(1000);

  const connect = useCallback(async () => {
    // Get one-time ticket for WS auth
    const ticket = await useAuthStore.getState().getWsTicket();
    if (!ticket) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/dashboard?ticket=${ticket}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      backoff.current = 1000; // reset on success
      useDashboardStore.getState().setWorkerConnected(true);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        useDashboardStore.getState().applyWorkerEvent(msg);
      } catch { /* ignore malformed */ }
    };

    ws.onclose = (ev) => {
      useDashboardStore.getState().setWorkerConnected(false);
      // Don't reconnect on intentional close (code 1000) or auth rejection (4001)
      if (ev.code !== 1000 && ev.code !== 4001) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      ws.close(); // triggers onclose → reconnect
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
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // Send command to worker via backend
  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send };
}
```

## Message Send Patterns

```tsx
// From component — use the send function returned by the hook
const { send } = useWorkerStream();

// Start engine
send({ type: 'start_engine' });

// Add strategy (inactive)
send({ type: 'add_strat', strategies: { strategies: [config] } });

// Start specific strategy
send({ type: 'start_strat', strategies: { strategies: [{ ...config, active: true }] } });

// Stop strategy
send({ type: 'stop_strat', symbols: ['ADAUSDT'] });

// Emergency stop
send({ type: 'emergency_stop' });
```

## Backend WS Proxy Pattern (Python side)

The ui-server backend acts as a pass-through. Browser → ui-server `/ws/dashboard` → worker:

```python
# In ws_dashboard router
@router.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    await ws.accept()
    worker_client = ws.app.state.worker_client

    async def forward_to_browser(msg: dict):
        await ws.send_json(msg)

    worker_client.add_subscriber(forward_to_browser)
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            # Forward command to worker
            await worker_client.send(msg)
    except WebSocketDisconnect:
        worker_client.remove_subscriber(forward_to_browser)
```

## Common Pitfalls

1. **Don't store WS in useState** — causes re-renders. Use `useRef`.
2. **Don't forget ticket auth** — unauthenticated WS gets closed with 4001 by the backend.
3. **Don't reconnect on intentional close** — check close code. `1000` (normal) should not trigger reconnect.
4. **Don't parse messages in components** — route everything through store actions.
5. **Don't send before OPEN** — always check `readyState === WebSocket.OPEN`.

## Reference Files

| What | Where |
|------|-------|
| Existing WS hook | `chart-ui/src/hooks/useBinanceStream.ts` |
| Auth store (ticket) | `chart-ui/src/store/authStore.ts` |
| Backend WS handler | `ui-server/routers/ws_ui.py` |
| Backend collector client | `ui-server/collector_client.py` |
| Vite proxy config | `chart-ui/vite.config.ts` |
