# test_market_data_api.py
"""
Unit tests for /api/candles, /api/agg-trades, /api/agg-trades/before endpoints.

Uses FastAPI TestClient with pre-populated CandleDB and AggTradeDB.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
_DM = Path(__file__).resolve().parent.parent.parent / "data_manager"
for _p in (_DM / "klines_manager", _DM / "trades_manager"):
    _s = str(_p)
    if _s not in sys.path:
        sys.path.insert(0, _s)

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.market_data import router, _candle_dbs, _trade_archive_dbs, _trade_daily_dbs
from klines_db_manager import CandleDB
from trades_db_manager import AggTradeDB

TEST_DB_DIR = "logs/test_market_data_api"

# Base timestamps: one candle per minute starting from a known epoch
_BASE_MS = 1_700_000_000_000  # ~2023-11-14
_1M = 60_000  # 1 minute in ms


def create_app() -> FastAPI:
    app = FastAPI()
    app.state.db_root = TEST_DB_DIR
    app.include_router(router, prefix="/api")
    return app


def seed_candles(symbol: str, count: int = 10) -> None:
    """Create a CandleDB with `count` 1-minute candles."""
    sym_dir = Path(TEST_DB_DIR) / symbol
    sym_dir.mkdir(parents=True, exist_ok=True)
    db_path = sym_dir / f"{symbol}_1m.db"
    db = CandleDB(str(db_path))
    rows = []
    for i in range(count):
        t = _BASE_MS + i * _1M
        price = 50000.0 + i * 10
        rows.append((
            t,            # open_time_ms
            price,        # open
            price + 5,    # high
            price - 3,    # low
            price + 2,    # close
            100.0 + i,    # volume
            5_000_000.0,  # quote_volume
            500 + i,      # trades_count
            60.0,         # taker_buy_volume
            3_000_000.0,  # taker_buy_quote_volume
        ))
    db.insert_rows(rows)
    db.close()


def seed_trades(symbol: str, count: int = 20) -> None:
    """Create an AggTradeDB with `count` trades."""
    sym_dir = Path(TEST_DB_DIR) / symbol
    sym_dir.mkdir(parents=True, exist_ok=True)
    db_path = sym_dir / "trades.db"
    db = AggTradeDB(str(db_path))
    rows = []
    for i in range(count):
        rows.append((
            100_000 + i,           # agg_trade_id
            _BASE_MS + i * 3000,   # trade_ts_ms (one every 3s)
            50000.0 + i * 0.5,     # price
            0.1 + i * 0.01,        # qty
            i % 2,                 # is_buyer_maker
            1,                     # trades_num
        ))
    db.insert_rows(rows)
    db.close()


def setup_test():
    if os.path.exists(TEST_DB_DIR):
        shutil.rmtree(TEST_DB_DIR)
    os.makedirs(TEST_DB_DIR, exist_ok=True)
    _candle_dbs.clear()
    _trade_archive_dbs.clear()
    _trade_daily_dbs.clear()
    seed_candles("BTCUSDT", 10)
    seed_trades("BTCUSDT", 20)


def teardown_test():
    # Close cached DB handles
    for db in _candle_dbs.values():
        db.close()
    for db in _trade_archive_dbs.values():
        db.close()
    for db in _trade_daily_dbs.values():
        db.close()
    _candle_dbs.clear()
    _trade_archive_dbs.clear()
    _trade_daily_dbs.clear()
    if os.path.exists(TEST_DB_DIR):
        shutil.rmtree(TEST_DB_DIR)


# ── Candle tests ────────────────────────────────────────────────────────

def test_get_candles_all():
    setup_test()
    try:
        client = TestClient(create_app())
        resp = client.get("/api/candles", params={"symbol": "BTCUSDT"})
        assert resp.status_code == 200
        candles = resp.json()
        assert len(candles) == 10
        assert candles[0]["open_time_ms"] == _BASE_MS
        assert candles[-1]["open_time_ms"] == _BASE_MS + 9 * _1M
        assert candles[0]["open"] == 50000.0
        assert candles[0]["high"] == 50005.0
        print("PASS: test_get_candles_all")
    finally:
        teardown_test()


def test_get_candles_with_time_range():
    setup_test()
    try:
        client = TestClient(create_app())
        start = _BASE_MS + 3 * _1M
        end = _BASE_MS + 7 * _1M
        resp = client.get("/api/candles", params={
            "symbol": "BTCUSDT",
            "startTime": start,
            "endTime": end,
        })
        assert resp.status_code == 200
        candles = resp.json()
        assert len(candles) == 4  # indices 3,4,5,6
        assert candles[0]["open_time_ms"] == start
        assert candles[-1]["open_time_ms"] == _BASE_MS + 6 * _1M
        print("PASS: test_get_candles_with_time_range")
    finally:
        teardown_test()


def test_get_candles_with_limit():
    setup_test()
    try:
        client = TestClient(create_app())
        resp = client.get("/api/candles", params={
            "symbol": "BTCUSDT",
            "limit": 3,
        })
        assert resp.status_code == 200
        candles = resp.json()
        assert len(candles) == 3
        print("PASS: test_get_candles_with_limit")
    finally:
        teardown_test()


def test_get_candles_missing_symbol():
    setup_test()
    try:
        client = TestClient(create_app())
        resp = client.get("/api/candles", params={"symbol": "NOSYMBOL"})
        assert resp.status_code == 200
        assert resp.json() == []  # empty, UI falls back to Binance
        print("PASS: test_get_candles_missing_symbol")
    finally:
        teardown_test()


def test_get_candles_end_time_only():
    setup_test()
    try:
        client = TestClient(create_app())
        end = _BASE_MS + 5 * _1M
        resp = client.get("/api/candles", params={
            "symbol": "BTCUSDT",
            "endTime": end,
        })
        assert resp.status_code == 200
        candles = resp.json()
        assert len(candles) == 5  # indices 0-4
        print("PASS: test_get_candles_end_time_only")
    finally:
        teardown_test()


# ── Agg-trade tests ────────────────────────────────────────────────────

def test_get_agg_trades_all():
    setup_test()
    try:
        client = TestClient(create_app())
        resp = client.get("/api/agg-trades", params={"symbol": "BTCUSDT"})
        assert resp.status_code == 200
        trades = resp.json()
        assert len(trades) == 20
        assert trades[0]["agg_trade_id"] == 100_000
        assert trades[0]["price"] == 50000.0
        assert isinstance(trades[0]["is_buyer_maker"], bool)
        print("PASS: test_get_agg_trades_all")
    finally:
        teardown_test()


def test_get_agg_trades_with_time_range():
    setup_test()
    try:
        client = TestClient(create_app())
        start = _BASE_MS + 5 * 3000  # trade index 5
        end = _BASE_MS + 10 * 3000   # trade index 10
        resp = client.get("/api/agg-trades", params={
            "symbol": "BTCUSDT",
            "startTime": start,
            "endTime": end,
        })
        assert resp.status_code == 200
        trades = resp.json()
        assert len(trades) == 5  # indices 5,6,7,8,9
        assert trades[0]["agg_trade_id"] == 100_005
        print("PASS: test_get_agg_trades_with_time_range")
    finally:
        teardown_test()


def test_get_agg_trades_with_limit():
    setup_test()
    try:
        client = TestClient(create_app())
        resp = client.get("/api/agg-trades", params={
            "symbol": "BTCUSDT",
            "limit": 5,
        })
        assert resp.status_code == 200
        trades = resp.json()
        assert len(trades) == 5
        print("PASS: test_get_agg_trades_with_limit")
    finally:
        teardown_test()


def test_get_agg_trades_missing_symbol():
    setup_test()
    try:
        client = TestClient(create_app())
        resp = client.get("/api/agg-trades", params={"symbol": "NOSYMBOL"})
        assert resp.status_code == 200
        assert resp.json() == []
        print("PASS: test_get_agg_trades_missing_symbol")
    finally:
        teardown_test()


# ── Agg-trades/before tests ────────────────────────────────────────────

def test_get_agg_trades_before():
    setup_test()
    try:
        client = TestClient(create_app())
        # Get 5 trades before trade index 10
        end = _BASE_MS + 10 * 3000
        resp = client.get("/api/agg-trades/before", params={
            "symbol": "BTCUSDT",
            "endTime": end,
            "limit": 5,
        })
        assert resp.status_code == 200
        trades = resp.json()
        assert len(trades) == 5
        # Should be trades 5-9 (last 5 before index 10), ascending
        assert trades[0]["agg_trade_id"] == 100_005
        assert trades[-1]["agg_trade_id"] == 100_009
        # Verify ascending order
        times = [t["trade_ts_ms"] for t in trades]
        assert times == sorted(times)
        print("PASS: test_get_agg_trades_before")
    finally:
        teardown_test()


def test_get_agg_trades_before_all():
    setup_test()
    try:
        client = TestClient(create_app())
        resp = client.get("/api/agg-trades/before", params={
            "symbol": "BTCUSDT",
            "endTime": _BASE_MS + 100 * 3000,  # well past last trade
            "limit": 1000,
        })
        assert resp.status_code == 200
        trades = resp.json()
        assert len(trades) == 20
        print("PASS: test_get_agg_trades_before_all")
    finally:
        teardown_test()


def test_get_agg_trades_before_missing_symbol():
    setup_test()
    try:
        client = TestClient(create_app())
        resp = client.get("/api/agg-trades/before", params={
            "symbol": "NOSYMBOL",
            "endTime": _BASE_MS,
        })
        assert resp.status_code == 200
        assert resp.json() == []
        print("PASS: test_get_agg_trades_before_missing_symbol")
    finally:
        teardown_test()


# ── DB query method direct tests ────────────────────────────────────────

def test_candle_db_row_to_dict():
    """Test CandleDB._row_to_dict static method."""
    row = (1700000000000, 50000.0, 50005.0, 49997.0, 50002.0,
           100.0, 5000000.0, 500, 60.0, 3000000.0)
    d = CandleDB._row_to_dict(row)
    assert d["open_time_ms"] == 1700000000000
    assert d["open"] == 50000.0
    assert d["high"] == 50005.0
    assert d["low"] == 49997.0
    assert d["close"] == 50002.0
    assert d["volume"] == 100.0
    assert d["trades_count"] == 500
    print("PASS: test_candle_db_row_to_dict")


def test_agg_trade_db_row_to_dict():
    """Test AggTradeDB._row_to_dict static method."""
    row = (12345, 1700000000000, 50000.5, 0.15, 1, 3)
    d = AggTradeDB._row_to_dict(row)
    assert d["agg_trade_id"] == 12345
    assert d["trade_ts_ms"] == 1700000000000
    assert d["price"] == 50000.5
    assert d["qty"] == 0.15
    assert d["is_buyer_maker"] is True
    assert d["trades_num"] == 3
    print("PASS: test_agg_trade_db_row_to_dict")


def test_candle_db_get_latest_time():
    setup_test()
    try:
        sym_dir = Path(TEST_DB_DIR) / "BTCUSDT"
        db = CandleDB(str(sym_dir / "BTCUSDT_1m.db"))
        latest = db.get_latest_candle_time()
        assert latest == _BASE_MS + 9 * _1M
        db.close()

        # Empty DB
        empty_dir = Path(TEST_DB_DIR) / "EMPTY"
        empty_dir.mkdir(parents=True, exist_ok=True)
        empty_db = CandleDB(str(empty_dir / "EMPTY_1m.db"))
        assert empty_db.get_latest_candle_time() is None
        empty_db.close()
        print("PASS: test_candle_db_get_latest_time")
    finally:
        teardown_test()


def test_agg_trade_db_get_trades_before_ascending():
    """Verify get_trades_before returns ascending order."""
    setup_test()
    try:
        sym_dir = Path(TEST_DB_DIR) / "BTCUSDT"
        db = AggTradeDB(str(sym_dir / "trades.db"))
        trades = db.get_trades_before(
            end_time_ms=_BASE_MS + 10 * 3000,
            limit=3,
        )
        assert len(trades) == 3
        # ascending by time
        assert trades[0]["trade_ts_ms"] < trades[1]["trade_ts_ms"] < trades[2]["trade_ts_ms"]
        # these should be trades 7, 8, 9
        assert trades[0]["agg_trade_id"] == 100_007
        db.close()
        print("PASS: test_agg_trade_db_get_trades_before_ascending")
    finally:
        teardown_test()


# ── Two-DB merge tests ──────────────────────────────────────────────────

def seed_daily_trades(symbol: str, count: int = 10, id_offset: int = 200_000) -> None:
    """Create a trades_daily.db with `count` trades."""
    sym_dir = Path(TEST_DB_DIR) / symbol
    sym_dir.mkdir(parents=True, exist_ok=True)
    db_path = sym_dir / "trades_daily.db"
    db = AggTradeDB(str(db_path))
    rows = []
    for i in range(count):
        rows.append((
            id_offset + i,                     # agg_trade_id
            _BASE_MS + 20 * 3000 + i * 3000,  # trade_ts_ms (after archive data)
            50010.0 + i * 0.5,                 # price
            0.2 + i * 0.01,                    # qty
            (i + 1) % 2,                       # is_buyer_maker
            1,                                 # trades_num
        ))
    db.insert_rows(rows)
    db.close()


def test_merge_archive_and_daily():
    """Archive + daily trades are merged and deduplicated."""
    setup_test()
    try:
        seed_daily_trades("BTCUSDT", 10)
        client = TestClient(create_app())
        resp = client.get("/api/agg-trades", params={
            "symbol": "BTCUSDT",
            "limit": 5000,
        })
        assert resp.status_code == 200
        trades = resp.json()
        # 20 archive + 10 daily = 30 (no overlap)
        assert len(trades) == 30
        # Verify ascending order
        times = [t["trade_ts_ms"] for t in trades]
        assert times == sorted(times)
        # First is from archive, last from daily
        assert trades[0]["agg_trade_id"] == 100_000
        assert trades[-1]["agg_trade_id"] == 200_009
        print("PASS: test_merge_archive_and_daily")
    finally:
        teardown_test()


def test_merge_deduplicates_overlapping():
    """When archive and daily have the same agg_trade_id, archive wins."""
    setup_test()
    try:
        # Insert daily trades that overlap with archive (same IDs)
        sym_dir = Path(TEST_DB_DIR) / "BTCUSDT"
        db_path = sym_dir / "trades_daily.db"
        db = AggTradeDB(str(db_path))
        rows = []
        for i in range(5):
            rows.append((
                100_000 + i,                   # same agg_trade_id as archive
                _BASE_MS + i * 3000,           # same time
                99999.0,                       # different price (should NOT appear)
                0.5,
                0,
                1,
            ))
        db.insert_rows(rows)
        db.close()

        client = TestClient(create_app())
        resp = client.get("/api/agg-trades", params={
            "symbol": "BTCUSDT",
            "limit": 5000,
        })
        assert resp.status_code == 200
        trades = resp.json()
        # Still 20 — duplicates removed
        assert len(trades) == 20
        # Archive price wins (not 99999)
        assert trades[0]["price"] == 50000.0
        print("PASS: test_merge_deduplicates_overlapping")
    finally:
        teardown_test()


def test_daily_only_no_archive():
    """Symbol with only daily data (no archive) still works."""
    setup_test()
    try:
        seed_daily_trades("NEWCOIN", 5)
        client = TestClient(create_app())
        resp = client.get("/api/agg-trades", params={"symbol": "NEWCOIN"})
        assert resp.status_code == 200
        trades = resp.json()
        assert len(trades) == 5
        print("PASS: test_daily_only_no_archive")
    finally:
        teardown_test()


def test_agg_trades_before_merged():
    """agg-trades/before queries both archive and daily."""
    setup_test()
    try:
        seed_daily_trades("BTCUSDT", 10)
        client = TestClient(create_app())
        # Get last 5 trades before very far future
        resp = client.get("/api/agg-trades/before", params={
            "symbol": "BTCUSDT",
            "endTime": _BASE_MS + 1_000_000,
            "limit": 5,
        })
        assert resp.status_code == 200
        trades = resp.json()
        assert len(trades) == 5
        # These should be the last 5 daily trades
        assert trades[-1]["agg_trade_id"] == 200_009
        print("PASS: test_agg_trades_before_merged")
    finally:
        teardown_test()


# ── Runner ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [
        test_get_candles_all,
        test_get_candles_with_time_range,
        test_get_candles_with_limit,
        test_get_candles_missing_symbol,
        test_get_candles_end_time_only,
        test_get_agg_trades_all,
        test_get_agg_trades_with_time_range,
        test_get_agg_trades_with_limit,
        test_get_agg_trades_missing_symbol,
        test_get_agg_trades_before,
        test_get_agg_trades_before_all,
        test_get_agg_trades_before_missing_symbol,
        test_candle_db_row_to_dict,
        test_agg_trade_db_row_to_dict,
        test_candle_db_get_latest_time,
        test_agg_trade_db_get_trades_before_ascending,
        test_merge_archive_and_daily,
        test_merge_deduplicates_overlapping,
        test_daily_only_no_archive,
        test_agg_trades_before_merged,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"FAIL: {t.__name__}: {e}")
            failed += 1
    print(f"\n{'='*40}")
    print(f"Results: {passed} passed, {failed} failed out of {len(tests)}")
    if failed > 0:
        sys.exit(1)
