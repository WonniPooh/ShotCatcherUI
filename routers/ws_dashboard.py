"""
WebSocket endpoint /ws/dashboard — browser connections for live strategy management.

Protocol (all messages are JSON):

  Browser → Server:
    { "type": "start_engine" }
    { "type": "stop_engine" }
    { "type": "emergency_stop" }
    { "type": "start_strat", "strategies": { "strategies": [...] } }
    { "type": "stop_strat", "symbols": ["ADAUSDT"] }
    { "type": "kill_strat", "symbols": ["ADAUSDT"] }
    { "type": "start_all" }
    { "type": "stop_all" }
    { "type": "loss_status" }
    { "type": "save_config", "filename": "my_config.json", "strategies": [...] }
    { "type": "load_config", "filename": "my_config.json" }
    { "type": "list_configs" }
    { "type": "delete_config", "filename": "old.json" }
    { "type": "rename_config", "filename": "old.json", "new_filename": "new.json" }

  Server → Browser (push, forwarded from worker):
    { "type": "hello", "server": "shotcatcher" }
    { "type": "engine_ready" }
    { "type": "engine_stopped" }
    { "type": "strategy_ready", "symbol": "..." }
    { "type": "strategy_stopped", "symbol": "..." }
    { "type": "strategy_error", "symbol": "...", "msg": "..." }
    { "type": "error", "msg": "..." }
    { "type": "worker_connected" }
    { "type": "worker_disconnected" }
    { "type": "loss_status", ... }
    { "type": "config_list", "files": [...] }
    { "type": "config_saved", "filename": "...", "count": N }
    { "type": "config_loaded", "filename": "...", "count": N }
    { "type": "config_deleted", "filename": "..." }
    { "type": "config_renamed", "filename": "...", "new_filename": "..." }
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import importlib
_auth_middleware = importlib.import_module("auth.middleware")

logger = logging.getLogger("chart_ui_server.ws_dashboard")

router = APIRouter(tags=["ws-dashboard"])

_subscribers: dict[WebSocket, bool] = {}

# Commands that are forwarded directly to the worker
_FORWARD_COMMANDS = {
    "start_engine", "stop_engine", "emergency_stop",
    "stop_strat", "kill_strat", "remove_strat",
    "loss_status", "list_strats", "ping",
}

_CONFIGS_DIR = Path(__file__).resolve().parent.parent / "config" / "strategies"


def _safe_filename(name: str) -> str | None:
    """Validate and sanitize a config filename. Returns None if invalid."""
    name = name.strip()
    if not name:
        return None
    # Must end with .json, no path separators, no dotfiles
    if not name.endswith(".json"):
        name += ".json"
    if "/" in name or "\\" in name or name.startswith("."):
        return None
    if ".." in name:
        return None
    return name


async def broadcast_to_dashboard(msg: dict) -> None:
    """Called by WorkerClient to forward worker events to all dashboard browsers."""
    if not _subscribers:
        return
    data = json.dumps(msg)
    dead: set[WebSocket] = set()
    for ws in list(_subscribers):
        try:
            await ws.send_text(data)
        except Exception:
            dead.add(ws)
    for ws in dead:
        _subscribers.pop(ws, None)


def _validate_strategy(config: dict) -> str | None:
    """Basic validation before forwarding to worker. Returns error message or None."""
    symbol = config.get("symbol", "")
    if not symbol or not isinstance(symbol, str):
        return "symbol is required"
    if not symbol.endswith("USDT"):
        return f"symbol must end with USDT, got {symbol}"

    direction = config.get("direction", "")
    if direction not in ("LONG", "SHORT"):
        return f"direction must be LONG or SHORT, got {direction}"

    leverage = config.get("leverage", 0)
    if not isinstance(leverage, (int, float)) or leverage < 1 or leverage > 125:
        return f"leverage must be 1-125, got {leverage}"

    # Exactly one sizing field must be set
    sizing_fields = ["quantity", "quantity_usdt", "quantity_margin_usdt"]
    set_fields = [f for f in sizing_fields if config.get(f) is not None and config.get(f, 0) > 0]
    if len(set_fields) != 1:
        return f"exactly one sizing field required ({', '.join(sizing_fields)}), got {len(set_fields)}"

    entry_dist = config.get("entry_distance_pct", 0)
    if not isinstance(entry_dist, (int, float)) or entry_dist <= 0:
        return "entry_distance_pct must be > 0"

    tp = config.get("tp_pct", 0)
    if not isinstance(tp, (int, float)) or tp <= 0:
        return "tp_pct must be > 0"

    sl_stop = config.get("sl_stop_pct", 0)
    if not isinstance(sl_stop, (int, float)) or sl_stop <= 0:
        return "sl_stop_pct must be > 0"

    return None


async def _handle_save_config(ws: WebSocket, filename: str, strategies: list[dict]) -> None:
    """Save current strategies to a named file."""
    safe = _safe_filename(filename)
    if not safe:
        await ws.send_text(json.dumps({"type": "error", "msg": "Invalid filename"}))
        return
    try:
        _CONFIGS_DIR.mkdir(parents=True, exist_ok=True)
        path = _CONFIGS_DIR / safe
        path.write_text(
            json.dumps({"strategies": strategies}, indent=2),
            encoding="utf-8",
        )
        await ws.send_text(json.dumps({
            "type": "config_saved",
            "filename": safe,
            "count": len(strategies),
        }))
        logger.info("Saved %d strategies to %s", len(strategies), path)
    except Exception as exc:
        await ws.send_text(json.dumps({
            "type": "error",
            "msg": f"Failed to save config: {exc}",
        }))


async def _handle_load_config(ws: WebSocket, worker_client: Any, filename: str) -> None:
    """Load strategies from a named file and send add_strat to worker."""
    safe = _safe_filename(filename)
    if not safe:
        await ws.send_text(json.dumps({"type": "error", "msg": "Invalid filename"}))
        return
    path = _CONFIGS_DIR / safe
    if not path.exists():
        await ws.send_text(json.dumps({
            "type": "error",
            "msg": f"Config file not found: {safe}",
        }))
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        strategies = data.get("strategies", [])
        if not strategies:
            await ws.send_text(json.dumps({
                "type": "error",
                "msg": "Config file has no strategies",
            }))
            return

        # Transform UI format → worker format:
        # UI stores { symbol: "XYZUSDT", ... }
        # Worker expects { symbols: ["XYZUSDT"], active: true, ... }
        worker_strategies = []
        for s in strategies:
            w = dict(s)
            if "symbol" in w and "symbols" not in w:
                w["symbols"] = [w.pop("symbol")]
            if "active" not in w:
                w["active"] = True
            worker_strategies.append(w)

        fwd = {
            "type": "start_strat",
            "strategies": {"strategies": worker_strategies},
        }
        worker_client.track_outgoing(fwd)
        await worker_client.send(fwd)
        await ws.send_text(json.dumps({
            "type": "config_loaded",
            "filename": safe,
            "count": len(strategies),
            "strategies": strategies,
        }))
        logger.info("Loaded %d strategies from %s", len(strategies), path)
    except Exception as exc:
        await ws.send_text(json.dumps({
            "type": "error",
            "msg": f"Failed to load config: {exc}",
        }))


async def _handle_list_configs(ws: WebSocket) -> None:
    """List all saved config files with metadata."""
    files: list[dict] = []
    if _CONFIGS_DIR.is_dir():
        for p in sorted(_CONFIGS_DIR.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                count = len(data.get("strategies", []))
            except Exception:
                count = 0
            files.append({
                "filename": p.name,
                "size_bytes": p.stat().st_size,
                "modified": p.stat().st_mtime,
                "strategy_count": count,
            })
    await ws.send_text(json.dumps({"type": "config_list", "files": files}))


async def _handle_delete_config(ws: WebSocket, filename: str) -> None:
    """Delete a saved config file."""
    safe = _safe_filename(filename)
    if not safe:
        await ws.send_text(json.dumps({"type": "error", "msg": "Invalid filename"}))
        return
    path = _CONFIGS_DIR / safe
    if not path.exists():
        await ws.send_text(json.dumps({"type": "error", "msg": f"File not found: {safe}"}))
        return
    try:
        path.unlink()
        await ws.send_text(json.dumps({"type": "config_deleted", "filename": safe}))
        logger.info("Deleted config file: %s", path)
    except Exception as exc:
        await ws.send_text(json.dumps({"type": "error", "msg": f"Delete failed: {exc}"}))


async def _handle_rename_config(ws: WebSocket, filename: str, new_filename: str) -> None:
    """Rename a saved config file."""
    safe_old = _safe_filename(filename)
    safe_new = _safe_filename(new_filename)
    if not safe_old or not safe_new:
        await ws.send_text(json.dumps({"type": "error", "msg": "Invalid filename"}))
        return
    old_path = _CONFIGS_DIR / safe_old
    new_path = _CONFIGS_DIR / safe_new
    if not old_path.exists():
        await ws.send_text(json.dumps({"type": "error", "msg": f"File not found: {safe_old}"}))
        return
    if new_path.exists():
        await ws.send_text(json.dumps({"type": "error", "msg": f"File already exists: {safe_new}"}))
        return
    try:
        old_path.rename(new_path)
        await ws.send_text(json.dumps({
            "type": "config_renamed",
            "filename": safe_old,
            "new_filename": safe_new,
        }))
        logger.info("Renamed config: %s → %s", safe_old, safe_new)
    except Exception as exc:
        await ws.send_text(json.dumps({"type": "error", "msg": f"Rename failed: {exc}"}))


@router.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket) -> None:
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
    _subscribers[ws] = True
    logger.info("Dashboard browser connected (%d total)", len(_subscribers))

    worker_client = getattr(ws.app.state, "worker_client", None)

    # Send current worker connection status
    if worker_client and worker_client.connected:
        await ws.send_text(json.dumps({"type": "worker_connected"}))
        # Send current engine state so the browser doesn't start at idle
        engine_state = worker_client.engine_state
        if engine_state in ("ready", "trading"):
            await ws.send_text(json.dumps({"type": "engine_ready"}))
        # Send snapshot of known strategies so page refresh doesn't lose them
        if worker_client.strategies:
            snapshot = []
            for sym, data in worker_client.strategies.items():
                cfg = dict(data["config"])
                cfg["symbol"] = sym
                snapshot.append({
                    "symbol": sym,
                    "status": data["status"],
                    "config": cfg,
                    "error": data.get("error"),
                })
            await ws.send_text(json.dumps({
                "type": "strategies_snapshot",
                "strategies": snapshot,
            }))
    else:
        await ws.send_text(json.dumps({"type": "worker_disconnected"}))

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")

            if not worker_client:
                await ws.send_text(json.dumps({
                    "type": "error",
                    "msg": "Dashboard backend not configured (no worker_client)",
                }))
                continue

            # Save/Load/List/Delete/Rename config — handled locally, not forwarded to worker
            if msg_type == "save_config":
                strategies = msg.get("strategies", [])
                filename = msg.get("filename", "strategies.json")
                await _handle_save_config(ws, filename, strategies)
                continue

            if msg_type == "load_config":
                filename = msg.get("filename", "")
                await _handle_load_config(ws, worker_client, filename)
                continue

            if msg_type == "list_configs":
                await _handle_list_configs(ws)
                continue

            if msg_type == "delete_config":
                filename = msg.get("filename", "")
                await _handle_delete_config(ws, filename)
                continue

            if msg_type == "rename_config":
                filename = msg.get("filename", "")
                new_filename = msg.get("new_filename", "")
                await _handle_rename_config(ws, filename, new_filename)
                continue

            # start_all / stop_all — expand to individual commands
            if msg_type == "start_all":
                strategies = msg.get("strategies", [])
                if strategies:
                    fwd = {
                        "type": "start_strat",
                        "strategies": {"strategies": strategies},
                    }
                    worker_client.track_outgoing(fwd)
                    await worker_client.send(fwd)
                continue

            if msg_type == "stop_all":
                symbols = msg.get("symbols", [])
                if symbols:
                    await worker_client.send({
                        "type": "stop_strat",
                        "symbols": symbols,
                    })
                continue

            # cache_strat / uncache_strat — legacy, no longer used (worker handles it)

            # Validate strategies in add_strat / start_strat before forwarding
            if msg_type in ("add_strat", "start_strat"):
                strats = msg.get("strategies", {}).get("strategies", [])
                if strats:
                    # Has full configs — validate before forwarding
                    for s in strats:
                        err = _validate_strategy(s)
                        if err:
                            await ws.send_text(json.dumps({
                                "type": "error",
                                "msg": f"Validation failed for {s.get('symbol', '?')}: {err}",
                            }))
                            break
                    else:
                        worker_client.track_outgoing(msg)
                        await worker_client.send(msg)
                elif msg_type == "start_strat" and msg.get("symbols"):
                    # symbols-only start_strat — pull from pending on worker
                    await worker_client.send(msg)
                else:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "msg": f"{msg_type}: no strategies or symbols provided",
                    }))
                continue

            # Direct forward commands
            if msg_type in _FORWARD_COMMANDS:
                await worker_client.send(msg)
                continue

            logger.warning("Dashboard: unknown message type: %s", msg_type)

    except WebSocketDisconnect:
        pass
    finally:
        _subscribers.pop(ws, None)
        if rate_limiter:
            rate_limiter.ws_disconnected(ip)
        logger.info("Dashboard browser disconnected (%d remaining)", len(_subscribers))
