"""
REST API endpoints for candle (kline) and aggregate trade data.

Serves historical market data from per-symbol SQLite databases.
Auto-downloads 1 week of 1m candles from Binance on first symbol access.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Query, Request

# data_manager lives at project root (two levels above this file's routers/ dir)
_DM_PATH = Path(__file__).resolve().parent.parent.parent / "data_manager"
for _p in (_DM_PATH / "klines_manager", _DM_PATH / "trades_manager"):
    _s = str(_p)
    if _s not in sys.path:
        sys.path.insert(0, _s)
from klines_db_manager import CandleDB

router = APIRouter(tags=["market-data"])

# Per-symbol DB cache (opened lazily, never closed during app lifetime)
_candle_dbs: dict[str, CandleDB] = {}

_INTERVAL = "1m"

# Resolve db_root relative to project root (one level above controller/)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_DB_ROOT = str(_PROJECT_ROOT / "db_files")


def _db_root(request: Request) -> str:
    return getattr(request.app.state, "db_root", _DEFAULT_DB_ROOT)


def _get_candle_db(request: Request, symbol: str) -> CandleDB | None:
    """Get CandleDB for symbol. Returns None if DB file doesn't exist or is empty."""
    if symbol not in _candle_dbs:
        db_path = Path(_db_root(request)) / symbol / f"{symbol}_{_INTERVAL}.db"
        if not db_path.exists() or db_path.stat().st_size == 0:
            return None
        _candle_dbs[symbol] = CandleDB(str(db_path))
    return _candle_dbs[symbol]



def _request_collector_load(request: Request, symbol: str) -> None:
    """Ask the Collector to load/refresh data for this symbol (fire-and-forget)."""
    client = getattr(request.app.state, "collector_client", None)
    if client:
        client.request_load(symbol)



def _invalidate_candle_cache(symbol: str) -> None:
    """Close and remove cached DB handle so it reopens with new data."""
    db = _candle_dbs.pop(symbol, None)
    if db:
        db.close()


@router.get("/candles")
async def get_candles(
    request: Request,
    symbol: str = Query(..., description="Trading pair, e.g. BTCUSDT"),
    start_time: Optional[int] = Query(None, alias="startTime", description="Start time (ms inclusive)"),
    end_time: Optional[int] = Query(None, alias="endTime", description="End time (ms exclusive)"),
    limit: int = Query(500, le=5000),
) -> list[dict[str, Any]]:
    """Historical 1m candles from local DB. Returns [] if not available yet."""
    db = _get_candle_db(request, symbol)
    if db is None:
        # No local data — request Collector to download, return empty for now
        _request_collector_load(request, symbol)
        return []

    result = db.get_candles(
        start_time_ms=start_time,
        end_time_ms=end_time,
        limit=limit,
    )

    # Trigger incremental refresh via Collector if data is stale
    if result:
        _request_collector_load(request, symbol)

    return result



