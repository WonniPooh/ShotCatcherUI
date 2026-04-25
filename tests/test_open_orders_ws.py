"""
Tests for ws_ui open orders functionality — _collect_all_open_orders helper.

Run: cd chart-ui-server && python -m pytest tests/test_open_orders_ws.py -v
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# We need data_manager on path for OrderEventDB import
_DM_PATH = Path(__file__).resolve().parent.parent.parent / "data_manager"
sys.path.insert(0, str(_DM_PATH))
sys.path.insert(0, str(_DM_PATH / "order_data_manager"))

from routers.ws_ui import _collect_all_open_orders, _get_order_db, _order_dbs

TEST_DIR = "logs/test_open_orders"


def _setup_db_root() -> str:
    """Create a fresh db_root with symbol directories and order_events.db."""
    if os.path.exists(TEST_DIR):
        shutil.rmtree(TEST_DIR)
    return TEST_DIR


def _create_symbol_db(db_root: str, symbol: str, orders: list[dict]) -> None:
    """Create a minimal order_events.db for a symbol with given orders."""
    sym_dir = Path(db_root) / symbol
    sym_dir.mkdir(parents=True, exist_ok=True)
    db_path = sym_dir / "order_events.db"

    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS order_event (
            order_id INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            client_order_id TEXT NOT NULL DEFAULT '',
            side TEXT NOT NULL,
            order_type TEXT NOT NULL,
            execution_type TEXT NOT NULL,
            order_status TEXT NOT NULL,
            order_price REAL NOT NULL DEFAULT 0,
            stop_price REAL NOT NULL DEFAULT 0,
            order_qty REAL NOT NULL DEFAULT 0,
            last_fill_price REAL NOT NULL DEFAULT 0,
            last_fill_qty REAL NOT NULL DEFAULT 0,
            filled_qty_accumulated REAL NOT NULL DEFAULT 0,
            avg_price REAL NOT NULL DEFAULT 0,
            commission REAL NOT NULL DEFAULT 0,
            commission_asset TEXT NOT NULL DEFAULT '',
            realized_pnl REAL NOT NULL DEFAULT 0,
            trade_id INTEGER NOT NULL DEFAULT 0,
            event_time_ms INTEGER NOT NULL,
            transaction_time_ms INTEGER NOT NULL,
            position_side TEXT NOT NULL DEFAULT 'BOTH',
            is_maker INTEGER NOT NULL DEFAULT 0,
            is_reduce_only INTEGER NOT NULL DEFAULT 0,
            time_in_force TEXT NOT NULL DEFAULT 'GTC',
            UNIQUE(order_id, execution_type, transaction_time_ms)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS order_amendment (
            amendment_id INTEGER PRIMARY KEY,
            order_id INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            client_order_id TEXT NOT NULL DEFAULT '',
            time_ms INTEGER NOT NULL,
            price_before REAL NOT NULL DEFAULT 0,
            price_after REAL NOT NULL DEFAULT 0,
            qty_before REAL NOT NULL DEFAULT 0,
            qty_after REAL NOT NULL DEFAULT 0,
            amendment_count INTEGER NOT NULL DEFAULT 0,
            UNIQUE(order_id, time_ms)
        )
    """)
    for o in orders:
        conn.execute(
            """INSERT INTO order_event (
                order_id, symbol, client_order_id, side, order_type,
                execution_type, order_status, order_price, stop_price,
                order_qty, event_time_ms, transaction_time_ms
            ) VALUES (
                :order_id, :symbol, :client_order_id, :side, :order_type,
                :execution_type, :order_status, :order_price, :stop_price,
                :order_qty, :event_time_ms, :transaction_time_ms
            )""",
            {
                "order_id": o.get("order_id", 1),
                "symbol": symbol,
                "client_order_id": o.get("client_order_id", "test"),
                "side": o.get("side", "BUY"),
                "order_type": o.get("order_type", "LIMIT"),
                "execution_type": o.get("execution_type", "NEW"),
                "order_status": o.get("order_status", "NEW"),
                "order_price": o.get("order_price", 50000),
                "stop_price": o.get("stop_price", 0),
                "order_qty": o.get("order_qty", 0.001),
                "event_time_ms": o.get("event_time_ms", 1000000),
                "transaction_time_ms": o.get("transaction_time_ms", 1000000),
            },
        )
    conn.commit()
    conn.close()


def _clear_db_cache() -> None:
    """Clear cached DB handles so tests are isolated."""
    _order_dbs.clear()


# ── Tests ─────────────────────────────────────────────────────────────────────


class TestCollectAllOpenOrders:
    def setup_method(self) -> None:
        self.db_root = _setup_db_root()
        _clear_db_cache()

    def teardown_method(self) -> None:
        _clear_db_cache()
        if os.path.exists(TEST_DIR):
            shutil.rmtree(TEST_DIR)

    def test_empty_db_root(self) -> None:
        os.makedirs(self.db_root, exist_ok=True)
        result = _collect_all_open_orders(self.db_root)
        assert result == []

    def test_nonexistent_db_root(self) -> None:
        result = _collect_all_open_orders("/nonexistent/path")
        assert result == []

    def test_single_symbol_single_open_order(self) -> None:
        _create_symbol_db(self.db_root, "BTCUSDT", [
            {"order_id": 100, "order_status": "NEW"},
        ])
        result = _collect_all_open_orders(self.db_root)
        assert len(result) == 1
        assert result[0]["order_id"] == 100
        assert result[0]["symbol"] == "BTCUSDT"

    def test_skips_filled_orders(self) -> None:
        _create_symbol_db(self.db_root, "BTCUSDT", [
            {"order_id": 100, "order_status": "NEW"},
            {"order_id": 200, "order_status": "FILLED", "execution_type": "TRADE"},
        ])
        result = _collect_all_open_orders(self.db_root)
        assert len(result) == 1
        assert result[0]["order_id"] == 100

    def test_skips_canceled_orders(self) -> None:
        _create_symbol_db(self.db_root, "BTCUSDT", [
            {"order_id": 100, "order_status": "CANCELED", "execution_type": "CANCELED"},
        ])
        result = _collect_all_open_orders(self.db_root)
        assert result == []

    def test_multiple_symbols(self) -> None:
        _create_symbol_db(self.db_root, "BTCUSDT", [
            {"order_id": 100, "order_status": "NEW"},
        ])
        _create_symbol_db(self.db_root, "ETHUSDT", [
            {"order_id": 200, "order_status": "NEW"},
            {"order_id": 300, "order_status": "PARTIALLY_FILLED"},
        ])
        result = _collect_all_open_orders(self.db_root)
        assert len(result) == 3
        order_ids = {r["order_id"] for r in result}
        assert order_ids == {100, 200, 300}

    def test_deduplicates_same_order_id(self) -> None:
        """If an order has multiple event rows (e.g. NEW + partial fill),
        only the latest row should be returned."""
        _create_symbol_db(self.db_root, "BTCUSDT", [
            {
                "order_id": 100,
                "order_status": "NEW",
                "execution_type": "NEW",
                "transaction_time_ms": 1000,
            },
            {
                "order_id": 100,
                "order_status": "PARTIALLY_FILLED",
                "execution_type": "TRADE",
                "transaction_time_ms": 2000,
            },
        ])
        result = _collect_all_open_orders(self.db_root)
        assert len(result) == 1
        assert result[0]["order_id"] == 100
        assert result[0]["order_status"] == "PARTIALLY_FILLED"
        assert result[0]["transaction_time_ms"] == 2000

    def test_symbol_dir_without_db(self) -> None:
        """Symbol directories without order_events.db should be skipped."""
        os.makedirs(f"{self.db_root}/BTCUSDT", exist_ok=True)
        _create_symbol_db(self.db_root, "ETHUSDT", [
            {"order_id": 100, "order_status": "NEW"},
        ])
        result = _collect_all_open_orders(self.db_root)
        assert len(result) == 1
        assert result[0]["symbol"] == "ETHUSDT"

    def test_partially_filled_order_is_open(self) -> None:
        _create_symbol_db(self.db_root, "BTCUSDT", [
            {"order_id": 100, "order_status": "PARTIALLY_FILLED"},
        ])
        result = _collect_all_open_orders(self.db_root)
        assert len(result) == 1

    def test_order_with_terminal_final_event_excluded(self) -> None:
        """An order that went NEW → PARTIALLY_FILLED → FILLED must NOT appear.
        This is the real-world scenario: intermediate non-terminal rows exist
        but the order's latest status is terminal."""
        _create_symbol_db(self.db_root, "BTCUSDT", [
            {
                "order_id": 100,
                "order_status": "NEW",
                "execution_type": "NEW",
                "transaction_time_ms": 1000,
            },
            {
                "order_id": 100,
                "order_status": "PARTIALLY_FILLED",
                "execution_type": "TRADE",
                "transaction_time_ms": 2000,
            },
            {
                "order_id": 100,
                "order_status": "FILLED",
                "execution_type": "TRADE",
                "transaction_time_ms": 3000,
            },
        ])
        result = _collect_all_open_orders(self.db_root)
        assert len(result) == 0, f"Expected 0 open orders, got {len(result)}: {result}"

    def test_mix_open_and_fully_closed_orders(self) -> None:
        """Multiple orders: some still open, some fully closed via terminal event."""
        _create_symbol_db(self.db_root, "BTCUSDT", [
            # Order 100: NEW → FILLED (closed)
            {"order_id": 100, "order_status": "NEW", "execution_type": "NEW", "transaction_time_ms": 1000},
            {"order_id": 100, "order_status": "FILLED", "execution_type": "TRADE", "transaction_time_ms": 2000},
            # Order 200: NEW → still open
            {"order_id": 200, "order_status": "NEW", "execution_type": "NEW", "transaction_time_ms": 1500},
            # Order 300: NEW → CANCELED (closed)
            {"order_id": 300, "order_status": "NEW", "execution_type": "NEW", "transaction_time_ms": 1000},
            {"order_id": 300, "order_status": "CANCELED", "execution_type": "CANCELED", "transaction_time_ms": 1800},
        ])
        result = _collect_all_open_orders(self.db_root)
        assert len(result) == 1
        assert result[0]["order_id"] == 200
