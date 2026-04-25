# Security & Authentication

**Status:** ✅ IMPLEMENTED  
**Date:** 2026-04-21  
**Last Updated:** 2026-04-21  

---

## Overview

Session-based authentication system for the Chart UI Server with bcrypt password hashing, SQLite user storage, WS ticket-based WebSocket auth, rate limiting with IP blocking, and optional TLS support via self-signed certificates.

Auth is **opt-in** — disabled by default (`CHART_UI_AUTH_ENABLED=false`). When disabled, all endpoints are accessible without login and `/api/auth/me` returns `anonymous`.

## Architecture

```
Browser                          Chart UI Server
  │                                   │
  ├─ POST /api/auth/login ──────────► │ ─── bcrypt verify ─── users.db
  │◄──── Set-Cookie: session_token ── │ ─── create session ── sessions table
  │                                   │
  ├─ GET /api/auth/ws-ticket ───────► │ ─── validate session
  │◄──── { ticket: "abc..." } ─────── │ ─── create ticket ── ws_tickets table
  │                                   │
  ├─ WSS /ws/ui?ticket=abc... ──────► │ ─── validate+delete ticket (single-use)
  │                                   │
  ├─ GET /api/* (with cookie) ──────► │ ─── validate session (middleware)
  │                                   │
  └─ POST /api/auth/logout ────────► │ ─── delete session
```

## Components

### User DB (`auth/user_db.py`)

SQLite database at `config/users.db` with three tables:

| Table | Purpose |
|-------|---------|
| `users` | User accounts (username, bcrypt hash, role, active flag) |
| `sessions` | Session tokens (32-byte hex, TTL, IP address) |
| `ws_tickets` | Single-use WS connection tickets (32-byte hex, 60s TTL) |

Features:
- bcrypt password hashing (auto-salted)
- PRAGMA WAL mode + busy_timeout for concurrent access
- `is_active` flag — deactivated users can't login or use sessions
- Session validation checks both expiry and user active status

### Auth Routes (`auth/routes.py`)

| Endpoint | Method | Auth Required | Description |
|----------|--------|---------------|-------------|
| `/api/auth/login` | POST | No | Authenticate, set session cookie |
| `/api/auth/logout` | POST | No | Delete session, clear cookie |
| `/api/auth/me` | GET | Yes* | Current user info |
| `/api/auth/ws-ticket` | GET | Yes | Issue single-use WS ticket |
| `/api/auth/register` | POST | No | Register new user (if enabled) |

*When auth is disabled, `/api/auth/me` returns `{authenticated: true, username: "anonymous"}`.

**Session cookie properties:** `HttpOnly`, `Secure` (when TLS enabled), `SameSite=Strict`, 7-day default TTL.

### Auth Middleware (`auth/middleware.py`)

- `require_session` — FastAPI dependency for REST routes. Returns user dict or raises 401.
- `validate_ws_ticket` — Validates WS ticket from `?ticket=` query parameter. Closes WS with code 4001 if invalid.
- Both are no-ops when `auth_enabled = false`.

### Rate Limiter (`auth/rate_limiter.py`)

In-memory rate limiting (no external dependencies):

| Protection | Threshold | Window | Action |
|-----------|-----------|--------|--------|
| Login attempts | 5 failures | 5 minutes | 15-minute lockout |
| IP block | 20 failures | 1 hour | 1-hour block + WARNING log |
| WS connections | 10 per IP | Concurrent | Reject with code 4029 |

- Successful login clears attempt history for that IP
- Periodic cleanup task runs every 5 minutes (removes expired entries)
- Blocked IPs logged at WARNING level for fail2ban integration

### WS Ticket Auth

WebSocket connections cannot reliably send cookies during handshake across all browsers. Solution:

1. Frontend calls `GET /api/auth/ws-ticket` → receives short-lived token (60s)
2. Frontend connects `wss://host/ws/ui?ticket=<token>`
3. Server validates ticket on handshake — single-use (deleted after validation)
4. If invalid/expired → WS closed with code 4001

This avoids localStorage tokens (XSS-safe) while working with browser WebSocket API.

## Configuration

| Field | Env Var | Type | Default | Description |
|-------|---------|------|---------|-------------|
| `auth_enabled` | `CHART_UI_AUTH_ENABLED` | bool | `false` | Enable session-based auth |
| `users_db_path` | `CHART_UI_USERS_DB_PATH` | str | `config/users.db` | Path to SQLite user database |
| `session_ttl_days` | `CHART_UI_SESSION_TTL_DAYS` | int | `7` | Session cookie lifetime |
| `allow_registration` | `CHART_UI_ALLOW_REGISTRATION` | bool | `false` | Enable `/api/auth/register` |
| `ssl_certfile` | `CHART_UI_SSL_CERTFILE` | str | `""` | TLS certificate path (empty = HTTP) |
| `ssl_keyfile` | `CHART_UI_SSL_KEYFILE` | str | `""` | TLS private key path |

## TLS / WSS

Self-signed certificate support:

```bash
# Generate cert (one-time)
./chart-ui-server/scripts/gen_self_signed.sh

# Creates: config/server.crt + config/server.key
# Set env vars:
export CHART_UI_SSL_CERTFILE=/path/to/config/server.crt
export CHART_UI_SSL_KEYFILE=/path/to/config/server.key
```

When TLS is enabled:
- Uvicorn serves HTTPS on configured port
- Session cookies get `Secure` flag
- Frontend WS URLs auto-detect `wss://` from `location.protocol`
- Collector ↔ chart-ui-server stays plain `ws://localhost:8001` (loopback)

## CLI User Management

```bash
cd chart-ui-server

# Add user (password entered interactively)
python manage_users.py add alice
python manage_users.py add admin --admin

# List users
python manage_users.py list

# Reset password
python manage_users.py reset-password alice

# Remove user (cascades sessions + tickets)
python manage_users.py remove alice
```

Custom DB path: `python manage_users.py --db /path/to/users.db add alice`

## Frontend Integration

- `authStore.ts` — Zustand store tracking auth state (`authenticated`, `username`, `role`)
- `LoginPage.tsx` — Full-screen login form (dark theme matching app)
- `App.tsx` — Checks auth on mount via `GET /api/auth/me`, shows LoginPage if not authenticated
- WS hooks (`useOrderData.ts`, `useHistoryLoader.ts`) — Fetch ticket via `getWsTicket()` before each WS connection

## Corner Cases

| Scenario | Behavior |
|----------|----------|
| Auth disabled | All endpoints accessible, `/api/auth/me` returns anonymous, WS tickets return `__noauth__` |
| User deactivated while logged in | Next request/WS validation rejects the session |
| Session expires during use | Next API call returns 401, frontend redirects to login |
| WS ticket used twice | Second attempt gets 4001 close code |
| WS ticket expires (>60s) | 4001 close code, frontend re-fetches ticket on reconnect |
| Rate limit hit during valid login | 429 returned even with correct credentials |
| All 10 WS slots used | New WS connection rejected with 4029 |

## Testing

43 tests in `chart-ui-server/tests/test_auth.py`:

| Category | Count | Tests |
|----------|-------|-------|
| UserDB CRUD | 9 | create, duplicate, verify, delete, set_password, count |
| Sessions | 6 | create, validate, delete, expire, cleanup, cascade |
| WS Tickets | 4 | create, single-use, expired, cleanup |
| Rate Limiter | 6 | allow, lockout, block, success clears, ws_connections, cleanup |
| Auth Routes | 18 | login (success/fail/rate-limited), logout, me (auth/unauth/disabled), ws-ticket (success/noauth/unauth), protected endpoints, register (disabled/enabled/duplicate/validation), inactive user |

Run: `cd chart-ui-server && python -m pytest tests/test_auth.py -v`

## Files

| File | Purpose |
|------|---------|
| `chart-ui-server/auth/__init__.py` | Package marker |
| `chart-ui-server/auth/user_db.py` | SQLite user/session/ticket store |
| `chart-ui-server/auth/routes.py` | Auth API endpoints |
| `chart-ui-server/auth/middleware.py` | Session + WS ticket validation |
| `chart-ui-server/auth/rate_limiter.py` | In-memory rate limiter |
| `chart-ui-server/manage_users.py` | CLI user management tool |
| `chart-ui-server/scripts/gen_self_signed.sh` | TLS cert generation |
| `chart-ui-server/config.py` | Settings with auth/TLS fields |
| `chart-ui-server/main.py` | App with auth integration |
| `chart-ui-server/routers/ws_ui.py` | WS ticket + rate limit check |
| `chart-ui-server/routers/data_stream.py` | WS ticket + rate limit check |
| `chart-ui-server/chart-ui/src/store/authStore.ts` | Frontend auth state |
| `chart-ui-server/chart-ui/src/components/LoginPage.tsx` | Login form |
| `chart-ui-server/chart-ui/src/App.tsx` | Auth-gated routing |
| `chart-ui-server/tests/test_auth.py` | 43 tests |
