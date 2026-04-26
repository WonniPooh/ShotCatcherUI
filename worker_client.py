"""
WorkerClient — persistent outbound WebSocket connection to the Worker ControlServer.

Responsibilities:
  - Reconnects automatically when the Worker is unavailable
  - Forwards dashboard commands from the browser to the worker
  - Broadcasts worker events to all /ws/dashboard subscribers
  - Sends application-level pings to detect dead connections

Usage:
    client = WorkerClient(url="ws://localhost:9090", broadcast_fn=...)
    client.start()
    await client.send({"type": "start_engine"})
    await client.stop()
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable, Coroutine

import websockets
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger("chart_ui_server.worker_client")


class WorkerClient:
    def __init__(
        self,
        url: str,
        broadcast_fn: Callable[[dict], Coroutine[Any, Any, None]],
        reconnect_interval: float = 5.0,
    ):
        self._url = url
        self._broadcast = broadcast_fn
        self._reconnect_interval = reconnect_interval

        self._ws: Any = None
        self._task: asyncio.Task | None = None
        self._ping_task: asyncio.Task | None = None
        self._connected = False
        self._engine_state: str = "idle"  # idle | ready | trading

        # Strategy cache: symbol → {"config": {...}, "status": "off"|"on"|"stopped"|"error", "error": str|None}
        self._strategies: dict[str, dict[str, Any]] = {}

        # Outbound queue — messages buffered while disconnected, flushed on reconnect
        self._send_queue: asyncio.Queue[dict] = asyncio.Queue()

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def engine_state(self) -> str:
        return self._engine_state

    @property
    def strategies(self) -> dict[str, dict[str, Any]]:
        return self._strategies

    def track_outgoing(self, msg: dict) -> None:
        """Track strategy configs from outgoing commands."""
        msg_type = msg.get("type", "")
        if msg_type in ("start_strat", "add_strat"):
            strats = msg.get("strategies", {}).get("strategies", [])
            for s in strats:
                symbols = s.get("symbols", [s.get("symbol", "")])
                for sym in symbols:
                    if sym:
                        self._strategies[sym] = {
                            "config": s,
                            "status": self._strategies.get(sym, {}).get("status", "off"),
                            "error": None,
                        }

    def start(self) -> None:
        self._task = asyncio.create_task(self._connect_loop(), name="worker-client")

    async def stop(self) -> None:
        if self._ping_task:
            self._ping_task.cancel()
            try:
                await self._ping_task
            except asyncio.CancelledError:
                pass
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._ws:
            await self._ws.close()

    async def send(self, msg: dict) -> None:
        """Send a command to the worker. Queues if not connected — flushed on reconnect."""
        if self._ws and self._connected:
            try:
                await self._ws.send(json.dumps(msg))
                logger.info("→ Worker: %s", msg.get("type"))
            except Exception as exc:
                logger.warning("Send to Worker failed, queuing: %s  msg=%s", exc, msg.get("type"))
                await self._send_queue.put(msg)
        else:
            logger.info("Worker not connected, queued: %s", msg.get("type"))
            await self._send_queue.put(msg)

    async def _flush_queue(self) -> None:
        """Drain buffered commands after (re)connect."""
        flushed = 0
        while not self._send_queue.empty():
            msg = self._send_queue.get_nowait()
            try:
                await self._ws.send(json.dumps(msg))
                flushed += 1
                logger.info("→ Worker (queued): %s", msg.get("type"))
            except Exception as exc:
                logger.warning("Flush failed, re-queuing: %s", exc)
                await self._send_queue.put(msg)
                break
        if flushed:
            logger.info("Flushed %d queued command(s) to Worker", flushed)

    # ── Private ───────────────────────────────────────────────────────────────

    async def _ping_loop(self) -> None:
        """Send application-level pings every 30s, detect dead connections."""
        missed = 0
        while True:
            await asyncio.sleep(30)
            if not self._ws or not self._connected:
                continue
            try:
                await self._ws.send(json.dumps({"type": "ping", "ts": time.monotonic()}))
                missed = 0
            except Exception:
                missed += 1
                if missed >= 3:
                    logger.warning("Worker: 3 consecutive ping failures, closing")
                    try:
                        await self._ws.close()
                    except Exception:
                        pass
                    break

    async def _connect_loop(self) -> None:
        while True:
            try:
                async with websockets.connect(
                    self._url,
                    ping_interval=None,
                ) as ws:
                    self._ws = ws
                    self._connected = True
                    self._ping_task = asyncio.create_task(
                        self._ping_loop(), name="worker-ping"
                    )

                    # Notify browsers that worker connection is up
                    await self._broadcast({"type": "worker_connected"})
                    logger.info("Connected to Worker at %s", self._url)

                    # Request current strategy list from worker to sync cache
                    try:
                        await ws.send(json.dumps({"type": "list_strats"}))
                        logger.info("→ Worker: list_strats (sync)")
                    except Exception:
                        pass

                    # Flush any commands that were queued while disconnected
                    await self._flush_queue()

                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            logger.warning("← Worker: invalid JSON: %r", raw[:200])
                            continue

                        msg_type = msg.get("type", "")

                        # Pong — don't forward to browsers
                        if msg_type == "pong":
                            continue

                        # Track engine state
                        if msg_type == "engine_ready":
                            self._engine_state = "ready"
                        elif msg_type == "engine_stopped":
                            self._engine_state = "idle"
                            # Mark all strategies as off
                            for sym in self._strategies:
                                self._strategies[sym]["status"] = "off"
                        elif msg_type == "strategy_ready":
                            self._engine_state = "trading"
                            sym = msg.get("symbol", "")
                            if sym in self._strategies:
                                self._strategies[sym]["status"] = "on"
                                self._strategies[sym]["error"] = None
                        elif msg_type == "strategy_stopped":
                            sym = msg.get("symbol", "")
                            if sym in self._strategies:
                                self._strategies[sym]["status"] = "stopped"
                                self._strategies[sym]["error"] = msg.get("reason")
                        elif msg_type == "strategy_paused":
                            sym = msg.get("symbol", "")
                            if sym in self._strategies:
                                self._strategies[sym]["status"] = "paused"
                        elif msg_type == "strategy_resumed":
                            sym = msg.get("symbol", "")
                            if sym in self._strategies:
                                self._strategies[sym]["status"] = "on"
                        elif msg_type == "emergency_stop_complete":
                            pass  # all strategies already moved to pending via strategy_stopped events
                        elif msg_type == "strategy_added":
                            sym = msg.get("symbol", "")
                            if sym and sym not in self._strategies:
                                self._strategies[sym] = {
                                    "config": {"symbol": sym},
                                    "status": "off",
                                    "error": None,
                                }
                        elif msg_type == "strategy_removed":
                            sym = msg.get("symbol", "")
                            self._strategies.pop(sym, None)
                        elif msg_type == "strategy_error":
                            sym = msg.get("symbol", "")
                            if sym in self._strategies:
                                self._strategies[sym]["status"] = "error"
                                self._strategies[sym]["error"] = msg.get("msg")
                        elif msg_type == "list_strats":
                            # Merge worker's ground truth with local cache.
                            # Worker strategies override cache; cached-only (off/stopped) are kept.
                            worker_syms: set[str] = set()
                            for s in msg.get("strategies", []):
                                sym = s.get("symbol", "")
                                if not sym:
                                    continue
                                worker_syms.add(sym)
                                active = s.get("active", False)
                                self._strategies[sym] = {
                                    "config": s,
                                    "status": "on" if active else "off",
                                    "error": None,
                                }
                            # Keep cached strategies that worker doesn't know about
                            # (added via form but not yet started)
                            if self._engine_state == "idle" and (worker_syms or self._strategies):
                                self._engine_state = "ready"
                            logger.info("Synced %d from worker, %d total cached",
                                        len(worker_syms), len(self._strategies))
                            # Build snapshot from full cache
                            snapshot = []
                            for sym, data in self._strategies.items():
                                cfg = dict(data["config"])
                                cfg["symbol"] = sym
                                snapshot.append({
                                    "symbol": sym,
                                    "status": data["status"],
                                    "config": cfg,
                                    "error": data.get("error"),
                                })
                            asyncio.create_task(self._broadcast({
                                "type": "strategies_snapshot",
                                "strategies": snapshot,
                            }))
                            continue  # Don't forward raw list_strats to browsers

                        logger.info("← Worker: %s", msg_type)

                        # Forward everything else to dashboard subscribers
                        asyncio.create_task(self._broadcast(msg))

            except ConnectionClosed:
                logger.info("Worker connection closed")
            except OSError:
                logger.debug("Worker not reachable at %s, retrying in %.0fs",
                             self._url, self._reconnect_interval)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.warning("Worker connection error: %s", exc)
            finally:
                was_connected = self._connected
                self._connected = False
                self._ws = None
                if self._ping_task:
                    self._ping_task.cancel()
                    self._ping_task = None
                if was_connected:
                    asyncio.create_task(
                        self._broadcast({"type": "worker_disconnected"})
                    )

            await asyncio.sleep(self._reconnect_interval)
