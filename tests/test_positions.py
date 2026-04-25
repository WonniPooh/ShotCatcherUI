"""
Tests for position tracking — reconstruction algorithm, DB operations, and API.

Run: python tests/test_positions.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

# Add paths
_BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BASE))
_PM = _BASE.parent / "BinanceDataManagers" / "position_manager"
sys.path.insert(0, str(_PM))

from position_tracker import reconstruct_positions
from position_db_manager import PositionDB

TEST_DIR = "logs/test_positions"
TEST_DB = f"{TEST_DIR}/TESTUSDT/positions.db"


def _fresh_db() -> PositionDB:
    if os.path.exists(TEST_DIR):
        shutil.rmtree(TEST_DIR)
    os.makedirs(f"{TEST_DIR}/TESTUSDT", exist_ok=True)
    return PositionDB(TEST_DB)


def _cleanup():
    if os.path.exists(TEST_DIR):
        shutil.rmtree(TEST_DIR)


def _trade(
    trade_id: int,
    order_id: int,
    side: str,
    price: float,
    qty: float,
    time_ms: int,
    commission: float = 0.01,
    realized_pnl: float = 0.0,
) -> dict:
    return {
        "trade_id": trade_id,
        "order_id": order_id,
        "symbol": "TESTUSDT",
        "side": side,
        "price": price,
        "qty": qty,
        "commission": commission,
        "commission_asset": "USDT",
        "realized_pnl": realized_pnl,
        "is_maker": 0,
        "is_buyer": 1 if side == "BUY" else 0,
        "position_side": "BOTH",
        "trade_time_ms": time_ms,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Position Reconstruction Tests
# ═══════════════════════════════════════════════════════════════════════════════

def test_simple_long():
    """BUY then SELL at higher price → 1 closed LONG position."""
    trades = [
        _trade(1, 100, "BUY",  50000, 0.1, 1000, commission=0.5),
        _trade(2, 101, "SELL", 51000, 0.1, 2000, commission=0.5, realized_pnl=10.0),
    ]
    positions = reconstruct_positions(trades)
    assert len(positions) == 1
    p = positions[0]
    assert p["side"] == "LONG"
    assert p["entry_price"] == 50000
    assert p["exit_price"] == 51000
    assert abs(p["quantity"] - 0.1) < 1e-8
    assert p["realized_pnl"] == 10.0
    assert p["fee_total"] == 1.0
    assert p["entry_time_ms"] == 1000
    assert p["exit_time_ms"] == 2000
    assert p["duration_ms"] == 1000
    assert json.loads(p["entry_order_ids"]) == [100]
    assert json.loads(p["exit_order_ids"]) == [101]
    print("PASS: test_simple_long")


def test_simple_short():
    """SELL then BUY at lower price → 1 closed SHORT position."""
    trades = [
        _trade(1, 100, "SELL", 50000, 0.1, 1000, commission=0.5),
        _trade(2, 101, "BUY",  49000, 0.1, 2000, commission=0.5, realized_pnl=10.0),
    ]
    positions = reconstruct_positions(trades)
    assert len(positions) == 1
    p = positions[0]
    assert p["side"] == "SHORT"
    assert p["entry_price"] == 50000
    assert p["exit_price"] == 49000
    assert p["realized_pnl"] == 10.0
    print("PASS: test_simple_short")


def test_multiple_entry_fills():
    """Two BUY fills then one SELL → avg entry price."""
    trades = [
        _trade(1, 100, "BUY",  50000, 0.05, 1000, commission=0.25),
        _trade(2, 100, "BUY",  50200, 0.05, 1500, commission=0.25),
        _trade(3, 101, "SELL", 51000, 0.10, 2000, commission=0.50, realized_pnl=9.0),
    ]
    positions = reconstruct_positions(trades)
    assert len(positions) == 1
    p = positions[0]
    assert p["side"] == "LONG"
    assert abs(p["entry_price"] - 50100) < 0.01  # avg of 50000 and 50200
    assert p["exit_price"] == 51000
    assert abs(p["quantity"] - 0.1) < 1e-8
    assert p["fee_total"] == 1.0
    print("PASS: test_multiple_entry_fills")


def test_multiple_exit_fills():
    """One BUY then two SELL fills → single position, avg exit price."""
    trades = [
        _trade(1, 100, "BUY",  50000, 0.10, 1000, commission=0.5),
        _trade(2, 101, "SELL", 51000, 0.05, 2000, commission=0.25, realized_pnl=5.0),
        _trade(3, 102, "SELL", 51200, 0.05, 3000, commission=0.25, realized_pnl=6.0),
    ]
    positions = reconstruct_positions(trades)
    assert len(positions) == 1
    p = positions[0]
    assert p["side"] == "LONG"
    assert abs(p["exit_price"] - 51100) < 0.01  # avg of 51000 and 51200
    assert abs(p["quantity"] - 0.1) < 1e-8
    assert p["realized_pnl"] == 11.0  # 5 + 6
    assert p["exit_time_ms"] == 3000
    assert json.loads(p["exit_order_ids"]) == [101, 102]
    print("PASS: test_multiple_exit_fills")


def test_two_consecutive_positions():
    """Two full round trips → 2 closed positions."""
    trades = [
        _trade(1, 100, "BUY",  50000, 0.1, 1000, realized_pnl=0),
        _trade(2, 101, "SELL", 51000, 0.1, 2000, realized_pnl=10.0),
        _trade(3, 200, "SELL", 52000, 0.2, 3000, realized_pnl=0),
        _trade(4, 201, "BUY",  51000, 0.2, 4000, realized_pnl=20.0),
    ]
    positions = reconstruct_positions(trades)
    assert len(positions) == 2
    assert positions[0]["side"] == "LONG"
    assert positions[0]["realized_pnl"] == 10.0
    assert positions[1]["side"] == "SHORT"
    assert positions[1]["realized_pnl"] == 20.0
    print("PASS: test_two_consecutive_positions")


def test_position_flip():
    """BUY 0.1, then SELL 0.15 → close LONG 0.1, open SHORT 0.05."""
    trades = [
        _trade(1, 100, "BUY",  50000, 0.1,  1000, realized_pnl=0),
        _trade(2, 101, "SELL", 51000, 0.15, 2000, realized_pnl=10.0),
        # Close the short
        _trade(3, 102, "BUY",  50500, 0.05, 3000, realized_pnl=2.5),
    ]
    positions = reconstruct_positions(trades)
    assert len(positions) == 2
    # First: closed LONG
    assert positions[0]["side"] == "LONG"
    assert abs(positions[0]["quantity"] - 0.1) < 1e-8
    assert positions[0]["realized_pnl"] == 10.0
    # Second: closed SHORT (the flip remainder)
    assert positions[1]["side"] == "SHORT"
    assert abs(positions[1]["quantity"] - 0.05) < 1e-8
    assert positions[1]["realized_pnl"] == 2.5
    print("PASS: test_position_flip")


def test_empty_trades():
    """No trades → no positions."""
    positions = reconstruct_positions([])
    assert len(positions) == 0
    print("PASS: test_empty_trades")


def test_open_position_not_emitted():
    """BUY without SELL → no closed position."""
    trades = [
        _trade(1, 100, "BUY", 50000, 0.1, 1000),
    ]
    positions = reconstruct_positions(trades)
    assert len(positions) == 0
    print("PASS: test_open_position_not_emitted")


def test_partial_close_then_full_close():
    """BUY 0.1, SELL 0.03, SELL 0.07 → 1 closed position."""
    trades = [
        _trade(1, 100, "BUY",  50000, 0.1,  1000),
        _trade(2, 101, "SELL", 51000, 0.03, 2000, realized_pnl=3.0),
        _trade(3, 102, "SELL", 51500, 0.07, 3000, realized_pnl=10.5),
    ]
    positions = reconstruct_positions(trades)
    assert len(positions) == 1
    p = positions[0]
    assert abs(p["quantity"] - 0.1) < 1e-8
    assert p["realized_pnl"] == 13.5
    print("PASS: test_partial_close_then_full_close")


def test_pnl_percent_long():
    """PnL % for LONG: (pnl / entry_notional) * 100."""
    trades = [
        _trade(1, 100, "BUY",  50000, 0.1, 1000),
        _trade(2, 101, "SELL", 55000, 0.1, 2000, realized_pnl=500.0),
    ]
    positions = reconstruct_positions(trades)
    p = positions[0]
    # entry_notional = 50000 * 0.1 = 5000, pnl = 500 → pnl_pct = 10.0%
    assert abs(p["pnl_pct"] - 10.0) < 0.01
    print("PASS: test_pnl_percent_long")


def test_pnl_percent_short():
    """PnL % for SHORT: uses Binance-reported PnL."""
    trades = [
        _trade(1, 100, "SELL", 50000, 0.1, 1000),
        _trade(2, 101, "BUY",  45000, 0.1, 2000, realized_pnl=500.0),
    ]
    positions = reconstruct_positions(trades)
    p = positions[0]
    assert abs(p["pnl_pct"] - 10.0) < 0.01
    print("PASS: test_pnl_percent_short")


def test_losing_long():
    """LONG with loss → negative PnL."""
    trades = [
        _trade(1, 100, "BUY",  50000, 0.1, 1000),
        _trade(2, 101, "SELL", 48000, 0.1, 2000, realized_pnl=-200.0),
    ]
    positions = reconstruct_positions(trades)
    p = positions[0]
    assert p["realized_pnl"] == -200.0
    assert p["pnl_pct"] < 0
    print("PASS: test_losing_long")


def test_many_fills_same_order():
    """Multiple fills on the same order → single entry/exit order ID."""
    trades = [
        _trade(1, 100, "BUY",  50000, 0.03, 1000, commission=0.15),
        _trade(2, 100, "BUY",  50010, 0.03, 1001, commission=0.15),
        _trade(3, 100, "BUY",  50020, 0.04, 1002, commission=0.20),
        _trade(4, 101, "SELL", 51000, 0.10, 2000, commission=0.50, realized_pnl=9.7),
    ]
    positions = reconstruct_positions(trades)
    assert len(positions) == 1
    p = positions[0]
    assert json.loads(p["entry_order_ids"]) == [100]
    assert json.loads(p["exit_order_ids"]) == [101]
    assert p["fee_total"] == 1.0
    print("PASS: test_many_fills_same_order")


def test_add_to_position_then_close():
    """BUY 0.1, add BUY 0.05 via different order, then SELL 0.15."""
    trades = [
        _trade(1, 100, "BUY",  50000, 0.10, 1000),
        _trade(2, 200, "BUY",  50500, 0.05, 1500),
        _trade(3, 300, "SELL", 52000, 0.15, 2000, realized_pnl=27.5),
    ]
    positions = reconstruct_positions(trades)
    assert len(positions) == 1
    p = positions[0]
    # Avg entry: (50000*0.1 + 50500*0.05) / 0.15 = 50166.67
    assert abs(p["entry_price"] - 50166.667) < 1
    assert json.loads(p["entry_order_ids"]) == [100, 200]
    print("PASS: test_add_to_position_then_close")


# ═══════════════════════════════════════════════════════════════════════════════
# Position DB Tests
# ═══════════════════════════════════════════════════════════════════════════════

def test_db_insert_and_query():
    db = _fresh_db()
    try:
        pos = {
            "symbol": "TESTUSDT", "side": "LONG",
            "entry_price": 50000, "exit_price": 51000,
            "quantity": 0.1, "realized_pnl": 10.0, "pnl_pct": 2.0,
            "fee_total": 1.0,
            "entry_time_ms": 1000, "exit_time_ms": 2000,
            "entry_order_ids": "[100]", "exit_order_ids": "[101]",
            "duration_ms": 1000,
        }
        row_id = db.insert_position(pos)
        assert row_id > 0

        results = db.get_positions(symbol="TESTUSDT")
        assert len(results) == 1
        assert results[0]["side"] == "LONG"
        assert results[0]["realized_pnl"] == 10.0
        print("PASS: test_db_insert_and_query")
    finally:
        db.close()
        _cleanup()


def test_db_get_last_exit_time():
    db = _fresh_db()
    try:
        assert db.get_last_exit_time("TESTUSDT") is None
        for i, t in enumerate([5000, 3000, 8000]):
            db.insert_position({
                "symbol": "TESTUSDT", "side": "LONG",
                "entry_price": 50000, "exit_price": 51000,
                "quantity": 0.1, "realized_pnl": 10.0, "pnl_pct": 2.0,
                "fee_total": 1.0,
                "entry_time_ms": t - 1000, "exit_time_ms": t,
                "entry_order_ids": f"[{100+i}]", "exit_order_ids": f"[{200+i}]",
                "duration_ms": 1000,
            })
        assert db.get_last_exit_time("TESTUSDT") == 8000
        print("PASS: test_db_get_last_exit_time")
    finally:
        db.close()
        _cleanup()


def test_db_since_ms_filter():
    db = _fresh_db()
    try:
        for i in range(5):
            t = 1000 * (i + 1)
            db.insert_position({
                "symbol": "TESTUSDT", "side": "LONG",
                "entry_price": 50000, "exit_price": 51000,
                "quantity": 0.1, "realized_pnl": 10.0, "pnl_pct": 2.0,
                "fee_total": 1.0,
                "entry_time_ms": t - 500, "exit_time_ms": t,
                "entry_order_ids": f"[{i}]", "exit_order_ids": f"[{i+10}]",
                "duration_ms": 500,
            })
        results = db.get_positions(symbol="TESTUSDT", since_ms=3000)
        assert len(results) == 3  # 3000, 4000, 5000
        print("PASS: test_db_since_ms_filter")
    finally:
        db.close()
        _cleanup()


def test_db_count():
    db = _fresh_db()
    try:
        assert db.count() == 0
        assert db.count("TESTUSDT") == 0
        db.insert_position({
            "symbol": "TESTUSDT", "side": "LONG",
            "entry_price": 50000, "exit_price": 51000,
            "quantity": 0.1, "realized_pnl": 10.0, "pnl_pct": 2.0,
            "fee_total": 1.0,
            "entry_time_ms": 1000, "exit_time_ms": 2000,
            "entry_order_ids": "[1]", "exit_order_ids": "[2]",
            "duration_ms": 1000,
        })
        assert db.count() == 1
        assert db.count("TESTUSDT") == 1
        assert db.count("OTHERUSDT") == 0
        print("PASS: test_db_count")
    finally:
        db.close()
        _cleanup()


def test_db_limit():
    db = _fresh_db()
    try:
        for i in range(10):
            db.insert_position({
                "symbol": "TESTUSDT", "side": "LONG",
                "entry_price": 50000, "exit_price": 51000,
                "quantity": 0.1, "realized_pnl": 10.0, "pnl_pct": 2.0,
                "fee_total": 1.0,
                "entry_time_ms": i * 1000, "exit_time_ms": i * 1000 + 500,
                "entry_order_ids": f"[{i}]", "exit_order_ids": f"[{i+10}]",
                "duration_ms": 500,
            })
        results = db.get_positions(symbol="TESTUSDT", limit=3)
        assert len(results) == 3
        # Should be ordered by exit_time_ms desc
        assert results[0]["exit_time_ms"] > results[1]["exit_time_ms"]
        print("PASS: test_db_limit")
    finally:
        db.close()
        _cleanup()


# ═══════════════════════════════════════════════════════════════════════════════
# Integration: reconstruct → DB → query
# ═══════════════════════════════════════════════════════════════════════════════

def test_reconstruct_and_persist():
    """Full flow: reconstruct positions from trades, persist, query."""
    db = _fresh_db()
    try:
        trades = [
            _trade(1, 100, "BUY",  50000, 0.1, 1000),
            _trade(2, 101, "SELL", 51000, 0.1, 2000, realized_pnl=10.0),
            _trade(3, 200, "SELL", 52000, 0.2, 3000),
            _trade(4, 201, "BUY",  51500, 0.2, 4000, realized_pnl=10.0),
        ]
        positions = reconstruct_positions(trades)
        assert len(positions) == 2

        for p in positions:
            db.insert_position(p)

        assert db.count("TESTUSDT") == 2
        results = db.get_positions(symbol="TESTUSDT")
        assert len(results) == 2
        # Most recent first
        assert results[0]["exit_time_ms"] == 4000
        assert results[1]["exit_time_ms"] == 2000
        print("PASS: test_reconstruct_and_persist")
    finally:
        db.close()
        _cleanup()


# ═══════════════════════════════════════════════════════════════════════════════
# Positions API Tests
# ═══════════════════════════════════════════════════════════════════════════════

def test_positions_api():
    """Test the positions REST endpoint via TestClient (reconstructs from user_trades)."""
    _cleanup()
    os.makedirs(f"{TEST_DIR}/TESTUSDT", exist_ok=True)
    try:
        # Create a user_trades.db with trades that form one closed position
        import sqlite3
        conn = sqlite3.connect(f"{TEST_DIR}/TESTUSDT/user_trades.db")
        conn.execute("""
            CREATE TABLE user_trade (
                trade_id INTEGER PRIMARY KEY,
                order_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                price REAL NOT NULL,
                qty REAL NOT NULL,
                quote_qty REAL NOT NULL DEFAULT 0,
                commission REAL NOT NULL DEFAULT 0,
                commission_asset TEXT NOT NULL DEFAULT '',
                realized_pnl REAL NOT NULL DEFAULT 0,
                is_maker INTEGER NOT NULL DEFAULT 0,
                is_buyer INTEGER NOT NULL DEFAULT 0,
                position_side TEXT NOT NULL DEFAULT 'BOTH',
                trade_time_ms INTEGER NOT NULL
            )
        """)
        # BUY then SELL → 1 closed LONG position
        conn.execute(
            "INSERT INTO user_trade VALUES (1, 100, 'TESTUSDT', 'BUY', 50000, 0.1, 5000, 1.0, 'USDT', 0, 1, 1, 'BOTH', 1000)"
        )
        conn.execute(
            "INSERT INTO user_trade VALUES (2, 101, 'TESTUSDT', 'SELL', 51000, 0.1, 5100, 1.0, 'USDT', 10.0, 1, 0, 'BOTH', 2000)"
        )
        conn.commit()
        conn.close()

        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from routers.positions import router, _position_cache

        app = FastAPI()
        app.state.db_root = TEST_DIR
        app.include_router(router, prefix="/api")
        _position_cache.clear()

        client = TestClient(app)
        resp = client.get("/api/positions", params={"symbol": "TESTUSDT"})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["side"] == "LONG"
        assert data[0]["realized_pnl"] == 10.0
        assert "id" in data[0]

        # Test missing symbol
        resp = client.get("/api/positions", params={"symbol": "NOSYMBOL"})
        assert resp.status_code == 200
        assert resp.json() == []

        _position_cache.clear()
        print("PASS: test_positions_api")
    finally:
        _cleanup()


def test_positions_all_api():
    """Test the /api/positions/all endpoint (reconstructs from user_trades)."""
    _cleanup()
    os.makedirs(f"{TEST_DIR}/SYM1", exist_ok=True)
    os.makedirs(f"{TEST_DIR}/SYM2", exist_ok=True)
    try:
        import sqlite3
        _UT_SCHEMA = """
            CREATE TABLE user_trade (
                trade_id INTEGER PRIMARY KEY,
                order_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                price REAL NOT NULL,
                qty REAL NOT NULL,
                quote_qty REAL NOT NULL DEFAULT 0,
                commission REAL NOT NULL DEFAULT 0,
                commission_asset TEXT NOT NULL DEFAULT '',
                realized_pnl REAL NOT NULL DEFAULT 0,
                is_maker INTEGER NOT NULL DEFAULT 0,
                is_buyer INTEGER NOT NULL DEFAULT 0,
                position_side TEXT NOT NULL DEFAULT 'BOTH',
                trade_time_ms INTEGER NOT NULL
            )
        """
        # SYM1: one closed position (exit_time=2000)
        conn1 = sqlite3.connect(f"{TEST_DIR}/SYM1/user_trades.db")
        conn1.execute(_UT_SCHEMA)
        conn1.execute("INSERT INTO user_trade VALUES (1, 1, 'SYM1', 'BUY', 50000, 0.1, 5000, 1.0, 'USDT', 0, 1, 1, 'BOTH', 1000)")
        conn1.execute("INSERT INTO user_trade VALUES (2, 2, 'SYM1', 'SELL', 51000, 0.1, 5100, 1.0, 'USDT', 10.0, 1, 0, 'BOTH', 2000)")
        conn1.commit()
        conn1.close()

        # SYM2: one closed position (exit_time=5000)
        conn2 = sqlite3.connect(f"{TEST_DIR}/SYM2/user_trades.db")
        conn2.execute(_UT_SCHEMA)
        conn2.execute("INSERT INTO user_trade VALUES (3, 3, 'SYM2', 'SELL', 3000, 1.0, 3000, 2.0, 'USDT', 0, 1, 0, 'BOTH', 3000)")
        conn2.execute("INSERT INTO user_trade VALUES (4, 4, 'SYM2', 'BUY', 2900, 1.0, 2900, 2.0, 'USDT', 100.0, 1, 1, 'BOTH', 5000)")
        conn2.commit()
        conn2.close()

        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from routers.positions import router, _position_cache

        app = FastAPI()
        app.state.db_root = TEST_DIR
        app.include_router(router, prefix="/api")
        _position_cache.clear()

        client = TestClient(app)
        resp = client.get("/api/positions/all")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        # Should be ordered by exit_time_ms desc
        assert data[0]["symbol"] == "SYM2"
        assert data[1]["symbol"] == "SYM1"

        _position_cache.clear()
        print("PASS: test_positions_all_api")
    finally:
        _cleanup()


# ═══════════════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    tests = [fn for name, fn in sorted(globals().items()) if name.startswith("test_")]
    passed = 0
    failed = 0
    for fn in tests:
        try:
            fn()
            passed += 1
        except Exception as e:
            print(f"FAIL: {fn.__name__} — {e}")
            import traceback; traceback.print_exc()
            failed += 1
    print(f"\n{'='*40}\n{passed} passed, {failed} failed out of {len(tests)}")
    if failed:
        sys.exit(1)
