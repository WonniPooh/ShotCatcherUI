"""
Tests for auth module — UserDB, rate limiter, auth routes, WS ticket auth.

Run: cd chart-ui-server && python -m pytest tests/test_auth.py -v
"""
from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, WebSocket, Depends
from fastapi.testclient import TestClient

from auth.user_db import UserDB
from auth.rate_limiter import RateLimiter
from auth.middleware import require_session
from auth import routes as auth_routes
from config import Settings

TEST_DIR = "logs/test_auth"
TEST_DB = f"{TEST_DIR}/test_users.db"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fresh_db() -> UserDB:
    if os.path.exists(TEST_DIR):
        shutil.rmtree(TEST_DIR)
    os.makedirs(TEST_DIR, exist_ok=True)
    return UserDB(TEST_DB)


def _create_app(auth_enabled: bool = True, allow_registration: bool = False) -> FastAPI:
    settings = Settings(
        auth_enabled=auth_enabled,
        users_db_path=TEST_DB,
        session_ttl_days=1,
        allow_registration=allow_registration,
    )
    app = FastAPI()
    app.state.settings = settings
    app.state.user_db = UserDB(TEST_DB)
    app.state.rate_limiter = RateLimiter()
    app.include_router(auth_routes.router)

    # A protected test endpoint
    @app.get("/api/test-protected")
    async def protected(user=Depends(require_session)):
        return {"ok": True, "user": user}

    return app


def _cleanup():
    if os.path.exists(TEST_DIR):
        shutil.rmtree(TEST_DIR)


# ═══════════════════════════════════════════════════════════════════════════════
# UserDB tests
# ═══════════════════════════════════════════════════════════════════════════════

def test_create_user():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        assert uid > 0
        users = db.list_users()
        assert len(users) == 1
        assert users[0]["username"] == "alice"
        assert users[0]["role"] == "user"
        assert users[0]["is_active"] == 1
        print("PASS: test_create_user")
    finally:
        db.close()
        _cleanup()


def test_create_admin():
    db = _fresh_db()
    try:
        uid = db.create_user("admin", "adminpass1", role="admin")
        users = db.list_users()
        assert users[0]["role"] == "admin"
        print("PASS: test_create_admin")
    finally:
        db.close()
        _cleanup()


def test_create_duplicate_user():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        try:
            db.create_user("alice", "different")
            assert False, "Should have raised ValueError"
        except ValueError as e:
            assert "already exists" in str(e)
        print("PASS: test_create_duplicate_user")
    finally:
        db.close()
        _cleanup()


def test_verify_password_correct():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        user = db.verify_password("alice", "password123")
        assert user is not None
        assert user["username"] == "alice"
        print("PASS: test_verify_password_correct")
    finally:
        db.close()
        _cleanup()


def test_verify_password_wrong():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        user = db.verify_password("alice", "wrongpass")
        assert user is None
        print("PASS: test_verify_password_wrong")
    finally:
        db.close()
        _cleanup()


def test_verify_password_nonexistent():
    db = _fresh_db()
    try:
        user = db.verify_password("nobody", "password123")
        assert user is None
        print("PASS: test_verify_password_nonexistent")
    finally:
        db.close()
        _cleanup()


def test_delete_user():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        assert db.delete_user("alice") is True
        assert db.delete_user("alice") is False
        assert db.user_count() == 0
        print("PASS: test_delete_user")
    finally:
        db.close()
        _cleanup()


def test_set_password():
    db = _fresh_db()
    try:
        db.create_user("alice", "oldpass12")
        assert db.set_password("alice", "newpass12")
        assert db.verify_password("alice", "oldpass12") is None
        assert db.verify_password("alice", "newpass12") is not None
        print("PASS: test_set_password")
    finally:
        db.close()
        _cleanup()


def test_user_count():
    db = _fresh_db()
    try:
        assert db.user_count() == 0
        db.create_user("alice", "password123")
        assert db.user_count() == 1
        db.create_user("bob", "password456")
        assert db.user_count() == 2
        print("PASS: test_user_count")
    finally:
        db.close()
        _cleanup()


# ── Session tests ─────────────────────────────────────────────────────────────

def test_create_and_validate_session():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        token = db.create_session(uid, ip_address="127.0.0.1")
        assert len(token) == 64  # 32 bytes hex
        user = db.validate_session(token)
        assert user is not None
        assert user["username"] == "alice"
        print("PASS: test_create_and_validate_session")
    finally:
        db.close()
        _cleanup()


def test_validate_invalid_session():
    db = _fresh_db()
    try:
        user = db.validate_session("nonexistent_token")
        assert user is None
        print("PASS: test_validate_invalid_session")
    finally:
        db.close()
        _cleanup()


def test_delete_session():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        token = db.create_session(uid)
        db.delete_session(token)
        assert db.validate_session(token) is None
        print("PASS: test_delete_session")
    finally:
        db.close()
        _cleanup()


def test_expired_session():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        # Create session with 0 days TTL (already expired)
        token = db.create_session(uid, ttl_days=0)
        # Should be expired immediately
        user = db.validate_session(token)
        assert user is None
        print("PASS: test_expired_session")
    finally:
        db.close()
        _cleanup()


def test_cleanup_expired_sessions():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        db.create_session(uid, ttl_days=0)  # expired
        db.create_session(uid, ttl_days=7)  # valid
        count = db.cleanup_expired_sessions()
        assert count == 1
        print("PASS: test_cleanup_expired_sessions")
    finally:
        db.close()
        _cleanup()


def test_delete_user_cascades_sessions():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        token = db.create_session(uid)
        db.delete_user("alice")
        assert db.validate_session(token) is None
        print("PASS: test_delete_user_cascades_sessions")
    finally:
        db.close()
        _cleanup()


# ── WS Ticket tests ──────────────────────────────────────────────────────────

def test_create_and_validate_ws_ticket():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        ticket = db.create_ws_ticket(uid, ttl_seconds=60)
        assert len(ticket) == 64
        user = db.validate_ws_ticket(ticket)
        assert user is not None
        assert user["username"] == "alice"
        print("PASS: test_create_and_validate_ws_ticket")
    finally:
        db.close()
        _cleanup()


def test_ws_ticket_single_use():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        ticket = db.create_ws_ticket(uid, ttl_seconds=60)
        assert db.validate_ws_ticket(ticket) is not None
        # Second use should fail
        assert db.validate_ws_ticket(ticket) is None
        print("PASS: test_ws_ticket_single_use")
    finally:
        db.close()
        _cleanup()


def test_ws_ticket_expired():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        ticket = db.create_ws_ticket(uid, ttl_seconds=0)
        assert db.validate_ws_ticket(ticket) is None
        print("PASS: test_ws_ticket_expired")
    finally:
        db.close()
        _cleanup()


def test_cleanup_expired_tickets():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        db.create_ws_ticket(uid, ttl_seconds=0)  # expired
        db.create_ws_ticket(uid, ttl_seconds=3600)  # valid
        count = db.cleanup_expired_tickets()
        assert count == 1
        print("PASS: test_cleanup_expired_tickets")
    finally:
        db.close()
        _cleanup()


# ═══════════════════════════════════════════════════════════════════════════════
# RateLimiter tests
# ═══════════════════════════════════════════════════════════════════════════════

def test_rate_limiter_allows_initial():
    rl = RateLimiter(max_login_attempts=3, login_window_seconds=60)
    allowed, reason = rl.check_login_allowed("1.2.3.4")
    assert allowed is True
    assert reason == ""
    print("PASS: test_rate_limiter_allows_initial")


def test_rate_limiter_lockout():
    rl = RateLimiter(max_login_attempts=3, login_window_seconds=300, lockout_seconds=60)
    ip = "1.2.3.4"
    for _ in range(3):
        rl.record_login_failure(ip)
    allowed, reason = rl.check_login_allowed(ip)
    assert allowed is False
    assert "Too many" in reason
    print("PASS: test_rate_limiter_lockout")


def test_rate_limiter_block():
    rl = RateLimiter(
        max_login_attempts=3, login_window_seconds=300,
        block_threshold=5, block_window_seconds=3600, block_duration_seconds=60,
    )
    ip = "1.2.3.4"
    for _ in range(5):
        rl.record_login_failure(ip)
    assert rl.is_blocked(ip) is True
    allowed, _ = rl.check_login_allowed(ip)
    assert allowed is False
    print("PASS: test_rate_limiter_block")


def test_rate_limiter_success_clears():
    rl = RateLimiter(max_login_attempts=3, login_window_seconds=300)
    ip = "1.2.3.4"
    rl.record_login_failure(ip)
    rl.record_login_failure(ip)
    rl.record_login_success(ip)
    allowed, _ = rl.check_login_allowed(ip)
    assert allowed is True
    print("PASS: test_rate_limiter_success_clears")


def test_rate_limiter_ws_connections():
    rl = RateLimiter(max_ws_per_ip=2)
    ip = "1.2.3.4"
    assert rl.ws_connect_allowed(ip) is True
    rl.ws_connected(ip)
    assert rl.ws_connect_allowed(ip) is True
    rl.ws_connected(ip)
    assert rl.ws_connect_allowed(ip) is False
    rl.ws_disconnected(ip)
    assert rl.ws_connect_allowed(ip) is True
    print("PASS: test_rate_limiter_ws_connections")


def test_rate_limiter_cleanup():
    rl = RateLimiter(block_threshold=2, block_window_seconds=0, block_duration_seconds=0)
    ip = "1.2.3.4"
    rl.record_login_failure(ip)
    rl.record_login_failure(ip)
    # Block should have expired (0s duration)
    rl.cleanup()
    assert rl.is_blocked(ip) is False
    print("PASS: test_rate_limiter_cleanup")


# ═══════════════════════════════════════════════════════════════════════════════
# Auth routes integration tests (via TestClient)
# ═══════════════════════════════════════════════════════════════════════════════

def test_login_success():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        db.close()
        app = _create_app(auth_enabled=True)
        client = TestClient(app)
        resp = client.post("/api/auth/login", json={"username": "alice", "password": "password123"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["username"] == "alice"
        assert "session_token" in resp.cookies
        print("PASS: test_login_success")
    finally:
        _cleanup()


def test_login_wrong_password():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        db.close()
        app = _create_app(auth_enabled=True)
        client = TestClient(app)
        resp = client.post("/api/auth/login", json={"username": "alice", "password": "wrong"})
        assert resp.status_code == 401
        print("PASS: test_login_wrong_password")
    finally:
        _cleanup()


def test_login_rate_limited():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        db.close()
        app = _create_app(auth_enabled=True)
        # Use a small limit for testing
        app.state.rate_limiter = RateLimiter(max_login_attempts=2, login_window_seconds=300)
        client = TestClient(app)
        for _ in range(2):
            client.post("/api/auth/login", json={"username": "alice", "password": "wrong"})
        resp = client.post("/api/auth/login", json={"username": "alice", "password": "password123"})
        assert resp.status_code == 429
        print("PASS: test_login_rate_limited")
    finally:
        _cleanup()


def test_logout():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        db.close()
        app = _create_app(auth_enabled=True)
        client = TestClient(app)
        # Login
        resp = client.post("/api/auth/login", json={"username": "alice", "password": "password123"})
        assert resp.status_code == 200
        # Logout
        resp = client.post("/api/auth/logout")
        assert resp.status_code == 200
        # Session should be invalid now
        resp = client.get("/api/auth/me")
        assert resp.status_code == 401
        print("PASS: test_logout")
    finally:
        _cleanup()


def test_me_authenticated():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        db.close()
        app = _create_app(auth_enabled=True)
        client = TestClient(app)
        client.post("/api/auth/login", json={"username": "alice", "password": "password123"})
        resp = client.get("/api/auth/me")
        assert resp.status_code == 200
        data = resp.json()
        assert data["authenticated"] is True
        assert data["username"] == "alice"
        print("PASS: test_me_authenticated")
    finally:
        _cleanup()


def test_me_unauthenticated():
    db = _fresh_db()
    try:
        db.close()
        app = _create_app(auth_enabled=True)
        client = TestClient(app)
        resp = client.get("/api/auth/me")
        assert resp.status_code == 401
        print("PASS: test_me_unauthenticated")
    finally:
        _cleanup()


def test_me_auth_disabled():
    db = _fresh_db()
    try:
        db.close()
        app = _create_app(auth_enabled=False)
        client = TestClient(app)
        resp = client.get("/api/auth/me")
        assert resp.status_code == 200
        data = resp.json()
        assert data["authenticated"] is True
        assert data["username"] == "anonymous"
        print("PASS: test_me_auth_disabled")
    finally:
        _cleanup()


def test_ws_ticket_issue():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        db.close()
        app = _create_app(auth_enabled=True)
        client = TestClient(app)
        client.post("/api/auth/login", json={"username": "alice", "password": "password123"})
        resp = client.get("/api/auth/ws-ticket")
        assert resp.status_code == 200
        data = resp.json()
        assert "ticket" in data
        assert len(data["ticket"]) == 64
        print("PASS: test_ws_ticket_issue")
    finally:
        _cleanup()


def test_ws_ticket_no_auth():
    db = _fresh_db()
    try:
        db.close()
        app = _create_app(auth_enabled=False)
        client = TestClient(app)
        resp = client.get("/api/auth/ws-ticket")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ticket"] == "__noauth__"
        print("PASS: test_ws_ticket_no_auth")
    finally:
        _cleanup()


def test_ws_ticket_unauthenticated():
    db = _fresh_db()
    try:
        db.close()
        app = _create_app(auth_enabled=True)
        client = TestClient(app)
        resp = client.get("/api/auth/ws-ticket")
        assert resp.status_code == 401
        print("PASS: test_ws_ticket_unauthenticated")
    finally:
        _cleanup()


def test_protected_endpoint_auth_enabled():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        db.close()
        app = _create_app(auth_enabled=True)
        client = TestClient(app)
        # Without login
        resp = client.get("/api/test-protected")
        assert resp.status_code == 401
        # With login
        client.post("/api/auth/login", json={"username": "alice", "password": "password123"})
        resp = client.get("/api/test-protected")
        assert resp.status_code == 200
        print("PASS: test_protected_endpoint_auth_enabled")
    finally:
        _cleanup()


def test_protected_endpoint_auth_disabled():
    db = _fresh_db()
    try:
        db.close()
        app = _create_app(auth_enabled=False)
        client = TestClient(app)
        resp = client.get("/api/test-protected")
        assert resp.status_code == 200
        print("PASS: test_protected_endpoint_auth_disabled")
    finally:
        _cleanup()


def test_register_disabled():
    db = _fresh_db()
    try:
        db.close()
        app = _create_app(auth_enabled=True, allow_registration=False)
        client = TestClient(app)
        resp = client.post("/api/auth/register", json={"username": "newuser", "password": "longpass1"})
        assert resp.status_code == 403
        print("PASS: test_register_disabled")
    finally:
        _cleanup()


def test_register_enabled():
    db = _fresh_db()
    try:
        db.close()
        app = _create_app(auth_enabled=True, allow_registration=True)
        client = TestClient(app)
        resp = client.post("/api/auth/register", json={"username": "newuser", "password": "longpass1"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "newuser"
        # Should be able to login now
        resp = client.post("/api/auth/login", json={"username": "newuser", "password": "longpass1"})
        assert resp.status_code == 200
        print("PASS: test_register_enabled")
    finally:
        _cleanup()


def test_register_duplicate():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        db.close()
        app = _create_app(auth_enabled=True, allow_registration=True)
        client = TestClient(app)
        resp = client.post("/api/auth/register", json={"username": "alice", "password": "longpass1"})
        assert resp.status_code == 409
        print("PASS: test_register_duplicate")
    finally:
        _cleanup()


def test_register_validation():
    db = _fresh_db()
    try:
        db.close()
        app = _create_app(auth_enabled=True, allow_registration=True)
        client = TestClient(app)
        # Username too short
        resp = client.post("/api/auth/register", json={"username": "ab", "password": "longpass1"})
        assert resp.status_code == 422
        # Password too short
        resp = client.post("/api/auth/register", json={"username": "validuser", "password": "short"})
        assert resp.status_code == 422
        # Invalid characters in username
        resp = client.post("/api/auth/register", json={"username": "bad user!", "password": "longpass1"})
        assert resp.status_code == 422
        print("PASS: test_register_validation")
    finally:
        _cleanup()


def test_inactive_user_cannot_login():
    db = _fresh_db()
    try:
        db.create_user("alice", "password123")
        # Manually deactivate
        db._conn.execute("UPDATE users SET is_active = 0 WHERE username = 'alice'")
        db._conn.commit()
        db.close()
        app = _create_app(auth_enabled=True)
        client = TestClient(app)
        resp = client.post("/api/auth/login", json={"username": "alice", "password": "password123"})
        assert resp.status_code == 401
        print("PASS: test_inactive_user_cannot_login")
    finally:
        _cleanup()


def test_inactive_user_session_rejected():
    db = _fresh_db()
    try:
        uid = db.create_user("alice", "password123")
        token = db.create_session(uid)
        # Deactivate user
        db._conn.execute("UPDATE users SET is_active = 0 WHERE id = ?", (uid,))
        db._conn.commit()
        user = db.validate_session(token)
        assert user is None
        print("PASS: test_inactive_user_session_rejected")
    finally:
        db.close()
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
