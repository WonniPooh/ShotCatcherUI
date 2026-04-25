"""
Auth routes — login, logout, register, WS ticket issuance.
"""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

logger = logging.getLogger("chart_ui_server.auth.routes")

router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_COOKIE = "session_token"


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_]+$")
    password: str = Field(min_length=8, max_length=200)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post("/login")
async def login(body: LoginRequest, request: Request, response: Response) -> dict:
    user_db = request.app.state.user_db
    rate_limiter = request.app.state.rate_limiter
    ip = _client_ip(request)

    allowed, reason = rate_limiter.check_login_allowed(ip)
    if not allowed:
        raise HTTPException(status_code=429, detail=reason)

    user = user_db.verify_password(body.username, body.password)
    if user is None:
        rate_limiter.record_login_failure(ip)
        raise HTTPException(status_code=401, detail="Invalid username or password")

    rate_limiter.record_login_success(ip)
    session_ttl = request.app.state.settings.session_ttl_days
    token = user_db.create_session(user["id"], ip_address=ip, ttl_days=session_ttl)

    is_https = request.app.state.settings.ssl_certfile != ""
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=is_https,
        samesite="strict",
        max_age=session_ttl * 86400,
        path="/",
    )
    return {"status": "ok", "username": user["username"], "role": user["role"]}


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    session_token: Annotated[str | None, Cookie()] = None,
) -> dict:
    if session_token:
        request.app.state.user_db.delete_session(session_token)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"status": "ok"}


@router.get("/me")
async def me(request: Request, session_token: Annotated[str | None, Cookie()] = None) -> dict:
    """Return current user info (for frontend to check login state)."""
    if not request.app.state.settings.auth_enabled:
        return {"authenticated": True, "username": "anonymous", "role": "admin"}
    if not session_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = request.app.state.user_db.validate_session(session_token)
    if user is None:
        raise HTTPException(status_code=401, detail="Session expired")
    return {"authenticated": True, "username": user["username"], "role": user["role"]}


@router.get("/ws-ticket")
async def ws_ticket(
    request: Request,
    session_token: Annotated[str | None, Cookie()] = None,
) -> dict:
    """Issue a single-use WS ticket for authenticated WS connections."""
    if not request.app.state.settings.auth_enabled:
        return {"ticket": "__noauth__"}
    if not session_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = request.app.state.user_db.validate_session(session_token)
    if user is None:
        raise HTTPException(status_code=401, detail="Session expired")
    ticket = request.app.state.user_db.create_ws_ticket(user["user_id"])
    return {"ticket": ticket}


@router.post("/register")
async def register(body: RegisterRequest, request: Request) -> dict:
    """Register a new user. Disabled by default (config: allow_registration)."""
    if not request.app.state.settings.allow_registration:
        raise HTTPException(status_code=403, detail="Registration is disabled")
    try:
        user_id = request.app.state.user_db.create_user(body.username, body.password)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    logger.info("New user registered: %s (id=%d)", body.username, user_id)
    return {"status": "ok", "username": body.username}
