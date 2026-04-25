"""
REST endpoint for closed positions.

GET /api/positions?symbol=BTCUSDT&since_ms=<ms>&limit=100

Reconstructs positions on-the-fly from user_trades.db via FIFO matching.
Results are cached per-symbol until a new trade arrives (TTL fallback: 60s).
"""
from __future__ import annotations

import logging
import sqlite3
import sys
import time
from pathlib import Path

from fastapi import APIRouter, Request

# Position manager access
_PM_PATH = Path(__file__).resolve().parent.parent.parent / "data_manager" / "position_manager"
if str(_PM_PATH) not in sys.path:
    sys.path.insert(0, str(_PM_PATH))

_UT_PATH = Path(__file__).resolve().parent.parent.parent / "data_manager" / "user_trades_manager"
if str(_UT_PATH) not in sys.path:
    sys.path.insert(0, str(_UT_PATH))

from position_tracker import reconstruct_positions  # type: ignore[import]

logger = logging.getLogger("chart_ui_server.positions")

router = APIRouter(tags=["positions"])

# Cache: symbol → (positions_list, timestamp)
_position_cache: dict[str, tuple[list[dict], float]] = {}
_CACHE_TTL = 60.0  # seconds


def _get_user_trades(db_root: str, symbol: str) -> list[dict]:
    """Read all user_trade rows for a symbol, sorted by trade_time_ms."""
    ut_path = Path(db_root) / symbol / "user_trades.db"
    if not ut_path.exists() or ut_path.stat().st_size == 0:
        return []
    conn = sqlite3.connect(str(ut_path))
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.execute(
            "SELECT * FROM user_trade WHERE symbol = ? ORDER BY trade_time_ms",
            (symbol,),
        )
        return [dict(row) for row in cur.fetchall()]
    except Exception:
        return []
    finally:
        conn.close()


def _reconstruct_for_symbol(db_root: str, symbol: str) -> list[dict]:
    """Reconstruct closed positions from user_trades, with caching."""
    now = time.monotonic()
    cached = _position_cache.get(symbol)
    if cached and (now - cached[1]) < _CACHE_TTL:
        return cached[0]

    trades = _get_user_trades(db_root, symbol)
    positions = reconstruct_positions(trades)
    # Add synthetic id (frontend needs it for React keys and dedup)
    for i, pos in enumerate(positions):
        pos["id"] = hash((symbol, pos.get("entry_time_ms", 0), pos.get("exit_time_ms", 0), i)) & 0x7FFFFFFF
    _position_cache[symbol] = (positions, now)
    return positions


@router.get("/positions")
async def get_positions(
    request: Request,
    symbol: str,
    since_ms: int | None = None,
    limit: int = 500,
) -> list[dict]:
    """Fetch closed positions for a symbol."""
    db_root = getattr(request.app.state, "db_root", "")
    if not db_root:
        return []
    symbol = symbol.strip().upper()
    positions = _reconstruct_for_symbol(db_root, symbol)
    # Filter by time and limit
    if since_ms is not None:
        positions = [p for p in positions if p["exit_time_ms"] >= since_ms]
    # Sort by exit_time descending (most recent first)
    positions.sort(key=lambda p: p["exit_time_ms"], reverse=True)
    return positions[:limit]


@router.get("/positions/all")
async def get_all_positions(
    request: Request,
    since_ms: int | None = None,
    limit: int = 500,
) -> list[dict]:
    """Fetch closed positions across all symbols."""
    db_root = getattr(request.app.state, "db_root", "")
    if not db_root:
        return []
    db_path = Path(db_root)
    if not db_path.is_dir():
        return []

    all_positions = []
    for sym_dir in sorted(db_path.iterdir()):
        if not sym_dir.is_dir():
            continue
        ut_path = sym_dir / "user_trades.db"
        if not ut_path.exists() or ut_path.stat().st_size == 0:
            continue
        symbol = sym_dir.name
        positions = _reconstruct_for_symbol(db_root, symbol)
        if since_ms is not None:
            positions = [p for p in positions if p["exit_time_ms"] >= since_ms]
        all_positions.extend(positions)

    # Sort all by exit_time_ms descending and limit
    all_positions.sort(key=lambda p: p["exit_time_ms"], reverse=True)
    return all_positions[:limit]
