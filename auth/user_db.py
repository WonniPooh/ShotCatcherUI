"""
User database — SQLite-backed user management with bcrypt password hashing.

Schema:
  users(id, username, password_hash, role, created_at, last_login, is_active)
  sessions(token, user_id, created_at, expires_at, ip_address)
  ws_tickets(ticket, user_id, created_at, expires_at)
"""
from __future__ import annotations

import logging
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt

logger = logging.getLogger("chart_ui_server.auth.user_db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL,
    last_login TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip_address TEXT
);

CREATE TABLE IF NOT EXISTS ws_tickets (
    ticket TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
"""


class UserDB:
    """Synchronous SQLite user/session store.  Thread-safe via check_same_thread=False."""

    def __init__(self, db_path: str) -> None:
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        self._conn.close()

    # ── User CRUD ─────────────────────────────────────────────────────────

    def create_user(self, username: str, password: str, role: str = "user") -> int:
        """Create a user. Returns user id. Raises ValueError if username exists."""
        pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        now = _utcnow_iso()
        try:
            cur = self._conn.execute(
                "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
                (username, pw_hash, role, now),
            )
            self._conn.commit()
            return cur.lastrowid  # type: ignore[return-value]
        except sqlite3.IntegrityError:
            raise ValueError(f"Username '{username}' already exists")

    def verify_password(self, username: str, password: str) -> dict | None:
        """Verify credentials. Returns user dict on success, None on failure."""
        row = self._conn.execute(
            "SELECT * FROM users WHERE username = ? AND is_active = 1", (username,)
        ).fetchone()
        if row is None:
            return None
        if not bcrypt.checkpw(password.encode(), row["password_hash"].encode()):
            return None
        self._conn.execute(
            "UPDATE users SET last_login = ? WHERE id = ?", (_utcnow_iso(), row["id"])
        )
        self._conn.commit()
        return dict(row)

    def list_users(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, username, role, created_at, last_login, is_active FROM users ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]

    def delete_user(self, username: str) -> bool:
        """Delete user and all their sessions. Returns True if user existed."""
        row = self._conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if row is None:
            return False
        uid = row["id"]
        self._conn.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
        self._conn.execute("DELETE FROM ws_tickets WHERE user_id = ?", (uid,))
        self._conn.execute("DELETE FROM users WHERE id = ?", (uid,))
        self._conn.commit()
        return True

    def set_password(self, username: str, new_password: str) -> bool:
        """Reset password for a user. Returns True if user existed."""
        pw_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
        cur = self._conn.execute(
            "UPDATE users SET password_hash = ? WHERE username = ?", (pw_hash, username)
        )
        self._conn.commit()
        return cur.rowcount > 0

    def user_count(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) FROM users").fetchone()
        return row[0]

    # ── Sessions ──────────────────────────────────────────────────────────

    def create_session(
        self, user_id: int, ip_address: str | None = None, ttl_days: int = 7
    ) -> str:
        """Create a session token. Returns the token string."""
        token = secrets.token_hex(32)
        now = _utcnow()
        expires = now + timedelta(days=ttl_days)
        self._conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at, ip_address) VALUES (?, ?, ?, ?, ?)",
            (token, user_id, now.isoformat(), expires.isoformat(), ip_address),
        )
        self._conn.commit()
        return token

    def validate_session(self, token: str) -> dict | None:
        """Validate a session token. Returns user dict if valid, None if expired/invalid."""
        row = self._conn.execute(
            """SELECT s.*, u.username, u.role, u.is_active
               FROM sessions s JOIN users u ON s.user_id = u.id
               WHERE s.token = ?""",
            (token,),
        ).fetchone()
        if row is None:
            return None
        if not row["is_active"]:
            return None
        expires = datetime.fromisoformat(row["expires_at"])
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if _utcnow() > expires:
            self._conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            self._conn.commit()
            return None
        return {"user_id": row["user_id"], "username": row["username"], "role": row["role"]}

    def delete_session(self, token: str) -> None:
        self._conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        self._conn.commit()

    def cleanup_expired_sessions(self) -> int:
        """Delete all expired sessions. Returns count deleted."""
        now = _utcnow_iso()
        cur = self._conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        self._conn.commit()
        return cur.rowcount

    # ── WS Tickets ────────────────────────────────────────────────────────

    def create_ws_ticket(self, user_id: int, ttl_seconds: int = 60) -> str:
        """Create a single-use WS ticket. Returns ticket string."""
        ticket = secrets.token_hex(32)
        now = _utcnow()
        expires = now + timedelta(seconds=ttl_seconds)
        self._conn.execute(
            "INSERT INTO ws_tickets (ticket, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (ticket, user_id, now.isoformat(), expires.isoformat()),
        )
        self._conn.commit()
        return ticket

    def validate_ws_ticket(self, ticket: str) -> dict | None:
        """Validate and consume a WS ticket (single-use). Returns user dict or None."""
        row = self._conn.execute(
            """SELECT t.*, u.username, u.role, u.is_active
               FROM ws_tickets t JOIN users u ON t.user_id = u.id
               WHERE t.ticket = ?""",
            (ticket,),
        ).fetchone()
        if row is None:
            return None
        # Always delete (single-use)
        self._conn.execute("DELETE FROM ws_tickets WHERE ticket = ?", (ticket,))
        self._conn.commit()
        if not row["is_active"]:
            return None
        expires = datetime.fromisoformat(row["expires_at"])
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if _utcnow() > expires:
            return None
        return {"user_id": row["user_id"], "username": row["username"], "role": row["role"]}

    def cleanup_expired_tickets(self) -> int:
        """Delete all expired WS tickets."""
        now = _utcnow_iso()
        cur = self._conn.execute("DELETE FROM ws_tickets WHERE expires_at < ?", (now,))
        self._conn.commit()
        return cur.rowcount


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat()
