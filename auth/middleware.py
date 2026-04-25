"""
Auth middleware — session-based auth for REST and WS-ticket auth for WebSockets.
"""
from __future__ import annotations

import logging

from fastapi import HTTPException, Request, WebSocket

logger = logging.getLogger("chart_ui_server.auth.middleware")

SESSION_COOKIE = "session_token"


async def require_session(request: Request) -> dict | None:
    """FastAPI dependency — validates session cookie.
    Returns user dict or None (if auth disabled).
    Raises 401 if auth enabled and session invalid.
    """
    if not request.app.state.settings.auth_enabled:
        return None
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = request.app.state.user_db.validate_session(token)
    if user is None:
        raise HTTPException(status_code=401, detail="Session expired")
    return user


async def validate_ws_ticket(ws: WebSocket) -> dict | None:
    """Validate WS ticket from query parameter. Returns user dict or None.
    Closes WS with 4001 if invalid.
    """
    if not ws.app.state.settings.auth_enabled:
        return None
    ticket = ws.query_params.get("ticket")
    if not ticket:
        await ws.close(code=4001, reason="Missing ticket")
        return None
    user = ws.app.state.user_db.validate_ws_ticket(ticket)
    if user is None:
        await ws.close(code=4001, reason="Invalid or expired ticket")
        return None
    return user


def get_ws_client_ip(ws: WebSocket) -> str:
    forwarded = ws.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return ws.client.host if ws.client else "unknown"
