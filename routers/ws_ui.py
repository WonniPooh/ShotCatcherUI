"""
WebSocket endpoint /ws/ui — browser connections for live order events and initial
order data loading.

Protocol (all messages are JSON):

  Browser → Server:
    { "type": "get_orders", "symbol": "BTCUSDT" }
      → Server responds with { "type": "order_data", "symbol": "BTCUSDT",
          "events": [...], "amendments": [...], "open_orders": [...] }
    { "type": "get_all_open_orders" }
      → Server responds with { "type": "all_open_orders", "orders": [...] }
    { "type": "load",   "symbol": "BTCUSDT" }  — forward to Collector
    { "type": "cancel", "symbol": "BTCUSDT" }  — forward to Collector

  Server → Browser (push):
    { "type": "order_event", "event": "<name>", ...fields }
    { "type": "watching",    "symbols": [...] }
    { "type": "auto_loaded", "symbol": "...", "reason": "..." }
    { "type": "position_closed", ...fields }
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from pathlib import Path
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

# ── Auth ──────────────────────────────────────────────────────────────────────
import importlib
_auth_middleware = importlib.import_module("auth.middleware")

# ── Order DB access ───────────────────────────────────────────────────────────
_DM_PATH = Path(__file__).resolve().parent.parent.parent / "BinanceDataManagers"
if str(_DM_PATH) not in sys.path:
    sys.path.insert(0, str(_DM_PATH))
if str(_DM_PATH / "order_BinanceDataManagers") not in sys.path:
    sys.path.insert(0, str(_DM_PATH / "order_BinanceDataManagers"))

from order_events_db_manager import OrderEventDB  # type: ignore[import]

_DEFAULT_DB_ROOT = str(_DM_PATH.parent / "db_files")
_order_dbs: dict[str, OrderEventDB] = {}

logger = logging.getLogger("chart_ui_server.ws_ui")

router = APIRouter(tags=["ws-ui"])

# Maps each active browser WebSocket to the symbol it is currently viewing.
# Used to filter symbol-specific broadcast events (order_event, progress)
# so only relevant data reaches each browser tab.
_subscribers: dict[WebSocket, str | None] = {}


def _get_order_db(db_root: str, symbol: str) -> OrderEventDB | None:
    key = f"{db_root}:{symbol}"
    if key not in _order_dbs:
        p = Path(db_root) / symbol / "order_events.db"
        if not p.exists() or p.stat().st_size == 0:
            return None
        _order_dbs[key] = OrderEventDB(str(p))
    return _order_dbs[key]


def _normalize_exchange_order(o: dict) -> dict:
    """Convert Binance REST /fapi/v1/openOrders response to our DB-style schema."""
    return {
        "order_id": o.get("orderId", 0),
        "symbol": o.get("symbol", ""),
        "client_order_id": o.get("clientOrderId", ""),
        "side": o.get("side", ""),
        "order_type": o.get("type", ""),
        "execution_type": "NEW",
        "order_status": o.get("status", ""),
        "order_price": float(o.get("price", 0)),
        "stop_price": float(o.get("stopPrice", 0)),
        "order_qty": float(o.get("origQty", 0)),
        "filled_qty_accumulated": float(o.get("executedQty", 0)),
        "avg_price": float(o.get("avgPrice", 0)),
        "event_time_ms": o.get("updateTime", 0),
        "transaction_time_ms": o.get("updateTime", 0),
        "time_in_force": o.get("timeInForce", "GTC"),
        "is_reduce_only": 1 if o.get("reduceOnly") else 0,
        "position_side": o.get("positionSide", "BOTH"),
    }


def _collect_all_open_orders(db_root: str) -> list[dict]:
    """Scan all symbol directories for open orders, return deduplicated list.

    For each order_id, returns only the latest event row (highest
    transaction_time_ms) to give the frontend a clean snapshot.
    """
    result: list[dict] = []
    root = Path(db_root)
    if not root.is_dir():
        return result
    for sym_dir in sorted(root.iterdir()):
        if not sym_dir.is_dir():
            continue
        symbol = sym_dir.name
        db = _get_order_db(db_root, symbol)
        if db is None:
            continue
        rows = db.get_open_orders(symbol)
        # Deduplicate: keep only the latest event per order_id
        by_oid: dict[int, dict] = {}
        for row in rows:
            oid = row.get("order_id", 0)
            prev = by_oid.get(oid)
            if prev is None or row.get("transaction_time_ms", 0) > prev.get("transaction_time_ms", 0):
                by_oid[oid] = row
        result.extend(by_oid.values())
    return result


async def broadcast_to_browsers(msg: dict) -> None:
    """Called by CollectorClient to forward Collector events to all browsers.

    Only `progress` is symbol-filtered (sent to the browser watching that symbol).
    Order events, position events, and everything else broadcast to ALL
    connections — the frontend filters per active symbol for chart rendering,
    while sidebar panels (open orders, closed trades) need cross-symbol data.
    """
    if not _subscribers:
        return
    symbol_specific = msg.get("type") == "progress"
    msg_symbol = str(msg.get("symbol", "")).upper() if symbol_specific else None
    data = json.dumps(msg)
    dead = set()
    for ws, active_symbol in list(_subscribers.items()):
        if symbol_specific and active_symbol != msg_symbol:
            continue  # skip — browser is watching a different symbol
        try:
            await ws.send_text(data)
        except Exception:
            dead.add(ws)
    for ws in dead:
        _subscribers.pop(ws, None)


async def _handle_browser_message(ws: WebSocket, msg: dict, collector_client) -> None:
    """Process a single browser message. Raises WebSocketDisconnect/RuntimeError on dead socket."""
    if msg.get("type") == "load" and msg.get("symbol"):
        if collector_client:
            collector_client.request_load(msg["symbol"])
    elif msg.get("type") == "cancel" and msg.get("symbol"):
        if collector_client:
            collector_client.request_cancel(msg["symbol"])
    elif msg.get("type") == "get_orders" and msg.get("symbol"):
        symbol = str(msg["symbol"]).strip().upper()
        _subscribers[ws] = symbol
        db_root = getattr(ws.app.state, "db_root", _DEFAULT_DB_ROOT)
        db = _get_order_db(db_root, symbol)
        if db is not None:
            since_ms = msg.get("since_ms", 0)
            events      = db.get_events_by_symbol(symbol, start_time_ms=since_ms)
            amendments  = db.get_amendments_by_symbol(symbol, start_time_ms=since_ms)
            open_orders = db.get_open_orders(symbol)
        else:
            events = amendments = open_orders = []
            logger.debug("[%s] no order_events.db found", symbol)
        logger.info("[%s] order_data: %d events, %d amendments, %d open",
                    symbol, len(events), len(amendments), len(open_orders))
        await ws.send_text(json.dumps({
            "type":        "order_data",
            "symbol":      symbol,
            "events":      events,
            "amendments":  amendments,
            "open_orders": open_orders,
        }))
    elif msg.get("type") == "get_all_open_orders":
        if collector_client:
            try:
                exchange_orders = await collector_client.request_open_orders()
                normalized = [_normalize_exchange_order(o) for o in exchange_orders]
            except Exception as exc:
                logger.error("Failed to get open orders via collector: %s", exc)
                normalized = []
            await ws.send_text(json.dumps({
                "type": "all_open_orders",
                "orders": normalized,
            }))
        else:
            db_root = getattr(ws.app.state, "db_root", _DEFAULT_DB_ROOT)
            all_orders = _collect_all_open_orders(db_root)
            await ws.send_text(json.dumps({
                "type": "all_open_orders",
                "orders": all_orders,
            }))


@router.websocket("/ws/ui")
async def ws_ui(ws: WebSocket) -> None:
    # Rate limit check
    ip = _auth_middleware.get_ws_client_ip(ws)
    rate_limiter = getattr(ws.app.state, "rate_limiter", None)
    if rate_limiter and not rate_limiter.ws_connect_allowed(ip):
        await ws.close(code=4029, reason="Too many connections")
        return

    # Ticket auth
    user = await _auth_middleware.validate_ws_ticket(ws)
    if ws.app.state.settings.auth_enabled and user is None:
        return  # ws already closed by validate_ws_ticket

    await ws.accept()
    if rate_limiter:
        rate_limiter.ws_connected(ip)
    _subscribers[ws] = None  # active symbol unknown until first get_orders
    logger.info("Browser connected (%d total)", len(_subscribers))

    collector_client = getattr(ws.app.state, "collector_client", None)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            try:
                await _handle_browser_message(ws, msg, collector_client)
            except (WebSocketDisconnect, RuntimeError):
                break

    except WebSocketDisconnect:
        pass
    finally:
        _subscribers.pop(ws, None)
        if rate_limiter:
            rate_limiter.ws_disconnected(ip)
        logger.info("Browser disconnected (%d remaining)", len(_subscribers))
