"""
CollectorClient — persistent outbound WebSocket connection to the Collector process.

Responsibilities:
  - Reconnects automatically when the Collector is unavailable
  - Translates browser load requests into Collector WS messages
  - Forwards progress/done/error/auto_loaded events to all /ws/ui subscribers

Usage:
    client = CollectorClient(url="ws://localhost:8001/ws", broadcast_fn=...)
    client.start()
    client.request_load("ETHUSDT")
    await client.stop()
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Coroutine

import websockets
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger("chart_ui_server.collector_client")

# Events that get forwarded verbatim to the browser via /ws/ui
_FORWARD_TYPES = {"progress", "done", "error", "auto_loaded", "watching", "order_event", "position_closed"}


class CollectorClient:
    def __init__(
        self,
        url: str,
        broadcast_fn: Callable[[dict], Coroutine[Any, Any, None]],
        reconnect_interval: float = 5.0,
    ):
        self._url = url
        self._broadcast = broadcast_fn
        self._reconnect_interval = reconnect_interval

        self._ws = None
        self._task: asyncio.Task | None = None
        self._connected = False
        self._active_symbol: str | None = None  # only forward progress for this symbol
        self._progress_logged: dict[str, float] = {}  # pct throttle per symbol
        # Pending request/response futures (keyed by response type)
        self._pending: dict[str, asyncio.Future] = {}
        # Pending fill_gap futures keyed by (symbol, from_ms, to_ms)
        self._gap_futures: dict[tuple[str, int, int], asyncio.Future] = {}

    @property
    def connected(self) -> bool:
        return self._connected

    def start(self) -> None:
        self._task = asyncio.create_task(self._connect_loop(), name="collector-client")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._ws:
            await self._ws.close()

    def request_load(self, symbol: str) -> None:
        """Fire-and-forget: ask Collector to load data for symbol."""
        self._active_symbol = symbol.upper()
        self._progress_logged.pop(self._active_symbol, None)
        asyncio.create_task(self._send({"type": "load", "symbol": symbol}))

    def request_cancel(self, symbol: str) -> None:
        asyncio.create_task(self._send({"type": "cancel", "symbol": symbol}))

    def request_fill_gap(self, symbol: str, from_ms: int, to_ms: int) -> asyncio.Future:
        """Ask Collector to fill a specific trade gap via REST.

        Returns a Future that resolves when the collector reports fill_gap_done.
        """
        key = (symbol.upper(), from_ms, to_ms)
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._gap_futures[key] = fut
        asyncio.create_task(self._send({
            "type": "fill_gap", "symbol": symbol,
            "from_ms": from_ms, "to_ms": to_ms,
        }))
        return fut

    async def query_status(self, symbol: str) -> None:
        await self._send({"type": "status", "symbol": symbol})

    async def request_open_orders(self, timeout: float = 10.0) -> list[dict]:
        """Ask Collector to query exchange for open orders. Returns the list."""
        fut: asyncio.Future[list[dict]] = asyncio.get_event_loop().create_future()
        self._pending["open_orders_response"] = fut
        await self._send({"type": "get_open_orders"})
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning("request_open_orders timed out after %.0fs", timeout)
            return []
        finally:
            self._pending.pop("open_orders_response", None)

    # ── Private ───────────────────────────────────────────────────────────────

    async def _send(self, msg: dict) -> None:
        if self._ws and self._connected:
            try:
                await self._ws.send(json.dumps(msg))
                logger.info("→ Collector: %s  symbol=%s",
                            msg.get("type"), msg.get("symbol", ""))
            except Exception as exc:
                logger.warning("Send to Collector failed: %s  msg=%s", exc, msg)
        else:
            logger.warning("Collector not connected, DROPPED: %s  symbol=%s",
                           msg.get("type"), msg.get("symbol", ""))

    async def _connect_loop(self) -> None:
        while True:
            try:
                async with websockets.connect(
                    self._url,
                    ping_interval=None,  # localhost — no keepalive needed
                ) as ws:
                    self._ws = ws
                    self._connected = True
                    logger.info("Connected to Collector at %s", self._url)
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            logger.warning("← Collector: invalid JSON: %r", raw[:200])
                            continue
                        msg_type = msg.get("type", "")
                        # Resolve pending request/response futures
                        if msg_type in self._pending:
                            fut = self._pending.pop(msg_type)
                            if not fut.done():
                                fut.set_result(msg.get("orders", []))
                            continue
                        # Resolve fill_gap futures
                        if msg_type == "fill_gap_done":
                            key = (str(msg.get("symbol", "")).upper(),
                                   int(msg.get("from_ms", 0)),
                                   int(msg.get("to_ms", 0)))
                            fut = self._gap_futures.pop(key, None)
                            if fut and not fut.done():
                                fut.set_result(msg.get("inserted", 0))
                            logger.info("← Collector: fill_gap_done  symbol=%s  inserted=%s",
                                        msg.get("symbol"), msg.get("inserted"))
                            continue
                        if msg_type in _FORWARD_TYPES:
                            # Filter progress events to active symbol only
                            msg_sym = msg.get("symbol", "")
                            if msg_type == "progress" and msg_sym != self._active_symbol:
                                continue
                            # Only forward "done" for the trades phase — account-phase
                            # "done" is not meaningful to the browser and would make it
                            # think loading is complete before trade data is downloaded.
                            # Instead, re-type account "done" so the frontend can
                            # refresh order data without confusing the loading state.
                            if msg_type == "done" and msg.get("phase") != "trades":
                                if msg.get("phase") == "account":
                                    logger.info("← Collector: account sync done  symbol=%s  (forwarding as account_sync_done)",
                                                msg_sym)
                                    asyncio.create_task(self._broadcast({
                                        "type": "account_sync_done",
                                        "symbol": msg_sym,
                                    }))
                                else:
                                    logger.debug("← Collector: done  symbol=%s  phase=%s  (suppressed)",
                                                 msg_sym, msg.get("phase"))
                                continue
                            if msg_type == "progress":
                                pct = msg.get("pct", 0)
                                last_pct = self._progress_logged.get(msg_sym, -5)
                                if pct - last_pct >= 5 or pct >= 99.9:
                                    logger.info("← Collector: progress  symbol=%s  pct=%.1f%%",
                                                msg_sym, pct)
                                    self._progress_logged[msg_sym] = pct
                            else:
                                logger.info("← Collector: %s  symbol=%s  (forwarding to browsers)",
                                            msg_type, msg_sym)
                            asyncio.create_task(self._broadcast(msg))
                        else:
                            logger.debug("← Collector: unhandled type=%s", msg_type)
            except ConnectionClosed:
                logger.info("Collector connection closed")
            except OSError:
                logger.debug("Collector not reachable at %s, retrying in %.0fs",
                             self._url, self._reconnect_interval)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.warning("Collector connection error: %s", exc)
            finally:
                self._connected = False
                self._ws = None

            await asyncio.sleep(self._reconnect_interval)
