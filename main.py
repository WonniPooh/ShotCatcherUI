"""
Chart UI Server — entry point.

Serves the React chart frontend and provides read-only market data API.
Maintains a persistent WS connection to the Collector for data loading.
Supports optional TLS, session-based auth, and rate limiting.
"""
from __future__ import annotations

import asyncio
import logging
import logging.handlers
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.security import APIKeyHeader
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from config import Settings
from collector_client import CollectorClient
from worker_client import WorkerClient
from auth.user_db import UserDB
from auth.rate_limiter import RateLimiter
from auth.middleware import require_session
from auth import routes as auth_routes
from routers import market_data, ws_ui, data_stream
from routers import positions as positions_router
from routers import ws_dashboard
from routers.ws_ui import broadcast_to_browsers
from routers.ws_dashboard import broadcast_to_dashboard


_HERE = Path(__file__).resolve().parent


def _setup_logging(log_dir: str = "logs") -> None:
    root = logging.getLogger()
    if root.handlers:
        return  # already configured (module imported twice by uvicorn)
    os.makedirs(log_dir, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    console = logging.StreamHandler()
    console.setFormatter(fmt)

    file_handler = logging.handlers.RotatingFileHandler(
        f"{log_dir}/chart_ui_server.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(console)
    root.addHandler(file_handler)


_setup_logging()
logger = logging.getLogger("chart_ui_server")

settings = Settings()

# ── Auth ──────────────────────────────────────────────────────────────────────

_api_key_header = APIKeyHeader(name="X-Api-Key", auto_error=False)


async def verify_api_key(
    request: Request,
    key: str | None = Security(_api_key_header),
) -> None:
    expected = request.app.state.settings.api_key
    if not expected:
        return
    if key != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Auth setup
    user_db = UserDB(_app.state.settings.users_db_path)
    _app.state.user_db = user_db
    rate_limiter = RateLimiter()
    _app.state.rate_limiter = rate_limiter

    # Periodic cleanup task for expired sessions/tickets
    async def _cleanup_loop():
        while True:
            await asyncio.sleep(300)  # every 5 minutes
            try:
                user_db.cleanup_expired_sessions()
                user_db.cleanup_expired_tickets()
                rate_limiter.cleanup()
            except Exception:
                logger.exception("Cleanup task error")

    cleanup_task = asyncio.create_task(_cleanup_loop())

    # Collector client (chart data) — only if chart is enabled
    collector = None
    if settings.enable_chart:
        collector = CollectorClient(
            url=settings.collector_ws_url,
            broadcast_fn=broadcast_to_browsers,
            reconnect_interval=settings.collector_reconnect_interval,
        )
        collector.start()
    _app.state.collector_client = collector

    # Worker client (dashboard) — only if dashboard is enabled
    worker = None
    if settings.enable_dashboard:
        worker = WorkerClient(
            url=settings.worker_ws_url,
            broadcast_fn=broadcast_to_dashboard,
            reconnect_interval=settings.worker_reconnect_interval,
        )
        worker.start()
    _app.state.worker_client = worker

    logger.info("Chart UI Server started (chart=%s, dashboard=%s, auth=%s, tls=%s)",
                "enabled" if settings.enable_chart else "disabled",
                "enabled" if settings.enable_dashboard else "disabled",
                "enabled" if settings.auth_enabled else "disabled",
                "enabled" if settings.ssl_certfile else "disabled")

    yield

    cleanup_task.cancel()
    if collector:
        await collector.stop()
    if worker:
        await worker.stop()
    user_db.close()
    logger.info("Chart UI Server stopped")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="ShotCatcher Chart UI Server", lifespan=lifespan)
app.state.settings = settings
app.state.db_root = settings.db_root

# Auth routes (login, logout, register, ws-ticket) — no session check
app.include_router(auth_routes.router)

# API routes — protected by session auth (if enabled) + legacy API key
_api_deps = [Depends(verify_api_key), Depends(require_session)]
app.include_router(market_data.router, prefix="/api", dependencies=_api_deps)
app.include_router(positions_router.router, prefix="/api", dependencies=_api_deps)

# WS routes — ticket auth is handled inside each WS handler
app.include_router(ws_ui.router)
app.include_router(data_stream.router)
app.include_router(ws_dashboard.router)

# Serve built React app from chart-ui/dist/
_DIST_DIR = _HERE / "chart-ui" / "dist"
if _DIST_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_DIST_DIR / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        return FileResponse(str(_DIST_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn

    uv_kwargs: dict = dict(
        host=settings.host,
        port=settings.port,
        reload=False,
    )
    if settings.ssl_certfile and settings.ssl_keyfile:
        uv_kwargs["ssl_certfile"] = settings.ssl_certfile
        uv_kwargs["ssl_keyfile"] = settings.ssl_keyfile
    uvicorn.run("main:app", **uv_kwargs)
