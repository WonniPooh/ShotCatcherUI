"""
WebSocket endpoint /ws/data-stream — unified historical data streaming.

Protocol (all messages are JSON):

  Browser → Server:
    { "type": "load",   "symbol": "BTCUSDT", "from_ms": <int>, "to_ms": <int> }
    { "type": "cancel", "symbol": "BTCUSDT" }

  Server → Browser:
    { "type": "chunk", "symbol": "BTCUSDT", "trades": [...],
      "chunk_covered_from": <int>, "chunk_covered_to": <int>, "chunk_seq": <int> }
    { "type": "done",  "symbol": "BTCUSDT", "total": <int> }
    { "type": "error", "symbol": "BTCUSDT", "message": "..." }

Flow:
  - Browser sends a "load" request immediately on symbol selection (no waiting for live WS).
  - Backend streams available DB rows in chunks of up to CHUNK_SIZE trades,
    starting from to_ms and working backwards toward from_ms (newest first).
    Each chunk is sent with trades in ascending order within the chunk but
    the chunks themselves arrive newest-first.
  - remaining_to retreats with each chunk so only the unfilled older tail is polled.
  - If DB has no rows yet for (from_ms, remaining_to], backend polls every POLL_INTERVAL_S
    seconds (invalidating the DB handle each time) and requests the Collector to load the
    data (once). Streaming resumes automatically when rows appear.
  - Browser sends "cancel" (or disconnects) to stop the load.

Each WS connection handles exactly one in-flight load coroutine. A new "load"
message cancels any in-progress coroutine before starting the new one.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

# ── Auth ──────────────────────────────────────────────────────────────────────
import importlib
_auth_middleware = importlib.import_module("auth.middleware")

# BinanceDataManagers lives two levels above routers/ at project root
_DM_PATH = Path(__file__).resolve().parent.parent.parent / "BinanceDataManagers"
for _p in (_DM_PATH / "trades_manager",):
    _s = str(_p)
    if _s not in sys.path:
        sys.path.insert(0, _s)
from trades_db_manager import AggTradeDB  # type: ignore[import]

logger = logging.getLogger("chart_ui_server.data_stream")

router = APIRouter(tags=["data-stream"])

# ── Constants ─────────────────────────────────────────────────────────────────
CHUNK_SIZE      = 1000          # trades per chunk message
POLL_INTERVAL_S = 1.0           # seconds between DB re-polls when data is missing
MAX_STALL_S     = 30            # max seconds polling without new data → partial "done"
MAX_RANGE_MS    = 30 * 86_400_000  # 30 days — cap to prevent accidental huge loads
HEAD_GAP_MS        = 60_000   # 60s — head gap bigger than this triggers collector fill
HEAD_GAP_STALL_S   = 30       # give up if no new data arrives for this many seconds
MID_GAP_MS         = 60_000   # 60s — mid-range gap threshold for in-chunk detection
MID_GAP_STALL_S    = 30       # give up waiting for mid-range gap fill

# ── DB handle cache (opened lazily, never closed during app lifetime) ─────────
_trade_dbs: dict[str, AggTradeDB] = {}


def _get_db(db_root: str, symbol: str) -> AggTradeDB | None:
    if symbol not in _trade_dbs:
        p = Path(db_root) / symbol / "trades.db"
        if not p.exists():
            logger.debug("[%s] DB file does not exist: %s", symbol, p)
            return None
        if p.stat().st_size == 0:
            logger.debug("[%s] DB file is empty: %s", symbol, p)
            return None
        logger.info("[%s] Opening DB: %s  size=%d", symbol, p, p.stat().st_size)
        _trade_dbs[symbol] = AggTradeDB(str(p))
    return _trade_dbs[symbol]


def _db_max_ts(db: AggTradeDB) -> int | None:
    """Query the current MAX(trade_ts_ms) directly — sees collector writes via WAL."""
    row = db.conn.execute("SELECT MAX(trade_ts_ms) FROM agg_trade").fetchone()
    return row[0] if row and row[0] is not None else None



# ── Per-connection state ──────────────────────────────────────────────────────

class _ConnState:
    """Tracks the one in-flight load task per WebSocket connection."""
    __slots__ = ("task",)

    def __init__(self) -> None:
        self.task: asyncio.Task | None = None

    def cancel(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            self.task = None


# ── Load coroutine ────────────────────────────────────────────────────────────

def _fmt_ts(ms: int) -> str:
    """Format ms timestamp as compact ISO-ish string for log readability."""
    from datetime import datetime, timezone
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(ms)


async def _load_coroutine(
    ws: WebSocket,
    symbol: str,
    from_ms: int,
    to_ms: int,
    db: AggTradeDB | None,
    collector_client: object | None,
) -> None:
    """Stream (from_ms, to_ms] trade data for `symbol` to the browser in chunks, newest first.

    Each chunk contains trades in ascending order within itself, but chunks
    are emitted from the newest time boundary backwards so the browser gets
    the most recent data first and can render it immediately.
    """
    remaining_to = to_ms
    collector_requested = False
    total_sent = 0
    chunk_seq = 0
    poll_count = 0
    stall_start: float | None = None
    filled_gaps: set[tuple[int, int]] = set()  # gaps already sent to collector
    # Pre-check: if the DB has no open rest_gap rows, all data is verified —
    # skip mid-range gap detection entirely (the common case after a full load).
    skip_gap_detection = False
    if db is not None:
        open_gaps = db.list_gaps()
        if not open_gaps:
            skip_gap_detection = True
            logger.info("[%s] No open rest_gap rows — skipping mid-range gap detection", symbol)
        else:
            logger.info("[%s] %d open rest_gap rows — mid-range gap detection enabled", symbol, len(open_gaps))
    db_root: str = getattr(ws.app.state, "db_root", str(_DM_PATH.parent / "db_files"))

    range_h = (to_ms - from_ms) / 3_600_000
    logger.info(
        "[%s] load START  range=[%s → %s] (%.1fh)  db=%s",
        symbol, _fmt_ts(from_ms), _fmt_ts(to_ms), range_h,
        "open" if db is not None else "not-found",
    )

    try:
        # ── Head gap detection ────────────────────────────────────────────
        # Check if the DB's latest trade is significantly older than to_ms.
        # If so, request the collector to fill the gap and wait before streaming.
        # This prevents the browser from getting old data with a visible gap
        # at the recent end while the collector catches up.
        if db is not None:
            db_max = _db_max_ts(db)
            if db_max is not None and (to_ms - db_max) > HEAD_GAP_MS:
                head_gap_h = (to_ms - db_max) / 3_600_000
                logger.info(
                    "[%s] HEAD GAP detected: DB latest=%s  to_ms=%s  gap=%.1fh — requesting collector fill",
                    symbol, _fmt_ts(db_max), _fmt_ts(to_ms), head_gap_h,
                )
                if collector_client is not None:
                    collector_client.request_load(symbol)  # type: ignore[attr-defined]
                    collector_requested = True

                # Wait for the gap to close.  We don't cap total wait time because
                # the gap may be many hours of data.  Instead we use a progress-based
                # stall timeout: if no new trades land in HEAD_GAP_STALL_S seconds
                # the collector has stopped (or there's no collector), so we proceed.
                wait_start = time.monotonic()
                last_max = db_max
                last_progress = time.monotonic()
                last_log = 0.0
                while True:
                    await asyncio.sleep(POLL_INTERVAL_S)
                    new_max = _db_max_ts(db)
                    if new_max is None:
                        if time.monotonic() - last_progress > HEAD_GAP_STALL_S:
                            break
                        continue
                    gap = to_ms - new_max
                    if gap <= HEAD_GAP_MS:
                        logger.info(
                            "[%s] Head gap filled: DB latest=%s  gap=%dms  waited=%.1fs",
                            symbol, _fmt_ts(new_max), gap, time.monotonic() - wait_start,
                        )
                        break
                    if new_max > last_max:
                        last_progress = time.monotonic()
                        last_max = new_max
                        elapsed = time.monotonic() - wait_start
                        if elapsed - last_log >= 5.0:
                            logger.info(
                                "[%s] Head gap filling: latest=%s  gap=%.1fh  waited=%.1fs",
                                symbol, _fmt_ts(new_max), gap / 3_600_000, elapsed,
                            )
                            last_log = elapsed
                    elif time.monotonic() - last_progress > HEAD_GAP_STALL_S:
                        new_max2 = _db_max_ts(db) or db_max
                        logger.info(
                            "[%s] Head gap stalled (%.0fs no new data). DB latest=%s  remaining_gap=%.1fh — streaming what we have",
                            symbol, HEAD_GAP_STALL_S, _fmt_ts(new_max2),
                            (to_ms - new_max2) / 3_600_000,
                        )
                        break

        while remaining_to > from_ms:
            # Negligible remaining range — not worth polling for
            if total_sent > 0 and (remaining_to - from_ms) < 1000:
                logger.info("[%s] remaining range <1s (%dms), finishing with %d trades",
                            symbol, remaining_to - from_ms, total_sent)
                break

            if db is None:
                db = _get_db(db_root, symbol)
                if db is not None:
                    logger.info("[%s] DB opened on retry", symbol)
                else:
                    poll_count += 1
                    if poll_count == 1 or poll_count % 10 == 0:
                        logger.info(
                            "[%s] DB not found, polling... (attempt %d)  collector_requested=%s",
                            symbol, poll_count, collector_requested,
                        )
                    if not collector_requested and collector_client is not None:
                        collector_client.request_load(symbol)  # type: ignore[attr-defined]
                        collector_requested = True
                        logger.info("[%s] requested Collector load (no DB)", symbol)
                    await asyncio.sleep(POLL_INTERVAL_S)
                    continue

            # Fetch newest CHUNK_SIZE rows in (from_ms, remaining_to], desc order
            rows = db.get_trades_in_range_desc(from_ms, remaining_to, limit=CHUNK_SIZE)

            if rows:
                stall_start = None  # reset stall timer
                # rows are newest-first from DB; reverse to send ascending within chunk
                rows.reverse()

                # ── Mid-range gap detection ───────────────────────────
                # Skipped when the DB has no open rest_gap rows (data verified).
                # Otherwise scan consecutive trades for gaps > MID_GAP_MS.
                gaps_found: list[tuple[int, int]] = []
                if not skip_gap_detection:
                    for i in range(1, len(rows)):
                        delta = rows[i]["trade_ts_ms"] - rows[i - 1]["trade_ts_ms"]
                        if delta > MID_GAP_MS:
                            gap_key = (rows[i - 1]["trade_ts_ms"], rows[i]["trade_ts_ms"])
                            if gap_key not in filled_gaps:
                                gaps_found.append(gap_key)

                if gaps_found and db is not None:
                    for gap_start, gap_end in gaps_found:
                        gap_s = (gap_end - gap_start) / 1000
                        logger.info(
                            "[%s] MID-RANGE GAP detected in chunk: %s → %s (%.0fs) — recording rest_gap",
                            symbol, _fmt_ts(gap_start), _fmt_ts(gap_end), gap_s,
                        )
                        try:
                            db.open_gap(gap_start, gap_end)
                        except Exception:
                            logger.error("[%s] Failed to record mid-range gap", symbol, exc_info=True)

                    # Request collector to fill each gap via targeted REST.
                    # Await the fill_gap_done response instead of polling.
                    if collector_client is not None:
                        futs = [
                            collector_client.request_fill_gap(symbol, gap_start, gap_end)  # type: ignore[attr-defined]
                            for gap_start, gap_end in gaps_found
                        ]
                        try:
                            await asyncio.wait_for(
                                asyncio.gather(*futs, return_exceptions=True),
                                timeout=MID_GAP_STALL_S,
                            )
                            logger.info("[%s] All %d gap(s) filled", symbol, len(gaps_found))
                        except asyncio.TimeoutError:
                            logger.info(
                                "[%s] Gap fill timed out after %.0fs — streaming anyway",
                                symbol, MID_GAP_STALL_S,
                            )
                            for f in futs:
                                if not f.done():
                                    f.cancel()
                    # Mark all gaps as tracked so subsequent chunks don't re-detect them
                    for g in gaps_found:
                        filled_gaps.add(g)

                    # Re-fetch this chunk — release WAL snapshot first so we see fresh data
                    db.conn.rollback()
                    rows = db.get_trades_in_range_desc(from_ms, remaining_to, limit=CHUNK_SIZE)
                    if rows:
                        rows.reverse()
                    else:
                        continue  # no rows after refetch — loop will handle

                chunk_seq += 1
                chunk_from = rows[0]["trade_ts_ms"]
                chunk_to   = rows[-1]["trade_ts_ms"]
                pct = min(99, round(((to_ms - chunk_from) / (to_ms - from_ms)) * 100)) if to_ms > from_ms else 0
                logger.info(
                    "[%s] chunk #%d  %d trades  [%s → %s]  total_sent=%d  progress=%d%%  remaining_to=%s",
                    symbol, chunk_seq, len(rows),
                    _fmt_ts(chunk_from), _fmt_ts(chunk_to),
                    total_sent + len(rows), pct, _fmt_ts(chunk_from - 1),
                )
                await ws.send_text(json.dumps({
                    "type":               "chunk",
                    "symbol":             symbol,
                    "trades":             rows,
                    "chunk_covered_from": chunk_from,
                    "chunk_covered_to":   chunk_to,
                    "chunk_seq":          chunk_seq,
                }))
                total_sent   += len(rows)
                remaining_to  = chunk_from - 1  # move left
                continue  # immediately try for more

            # No rows for (from_ms, remaining_to] — poll
            # Stall check: if we already have data but nothing new for
            # MAX_STALL_S seconds, send partial "done" — archive data
            # will be available later via scroll-back.
            if stall_start is None:
                stall_start = time.monotonic()
            elif total_sent > 0 and time.monotonic() - stall_start > MAX_STALL_S:
                unsent_h = (remaining_to - from_ms) / 3_600_000
                logger.info("[%s] stall timeout (%.0fs no new data)  sent=%d  unsent_range=%.1fh",
                            symbol, time.monotonic() - stall_start, total_sent, unsent_h)
                break

            poll_count += 1
            if not collector_requested and collector_client is not None:
                collector_client.request_load(symbol)  # type: ignore[attr-defined]
                collector_requested = True
                logger.info(
                    "[%s] no rows in (%s, %s], requested Collector load",
                    symbol, _fmt_ts(from_ms), _fmt_ts(remaining_to),
                )
            if poll_count == 1 or poll_count % 10 == 0:
                logger.info(
                    "[%s] polling DB for data... attempt %d  remaining=(%s, %s]  sent=%d",
                    symbol, poll_count, _fmt_ts(from_ms), _fmt_ts(remaining_to), total_sent,
                )

            await asyncio.sleep(POLL_INTERVAL_S)

        await ws.send_text(json.dumps({
            "type":   "done",
            "symbol": symbol,
            "total":  total_sent,
        }))
        logger.info(
            "[%s] DONE  %d trades in %d chunks  range=[%s → %s]",
            symbol, total_sent, chunk_seq, _fmt_ts(from_ms), _fmt_ts(to_ms),
        )

    except asyncio.CancelledError:
        logger.info(
            "[%s] CANCELLED at remaining_to=%s  sent=%d in %d chunks",
            symbol, _fmt_ts(remaining_to), total_sent, chunk_seq,
        )
        raise
    except WebSocketDisconnect:
        logger.info(
            "[%s] client DISCONNECTED during load  sent=%d in %d chunks",
            symbol, total_sent, chunk_seq,
        )
    except Exception as exc:
        logger.error("[%s] load ERROR: %s  sent=%d", symbol, exc, total_sent, exc_info=True)
        try:
            await ws.send_text(json.dumps({
                "type":    "error",
                "symbol":  symbol,
                "message": str(exc),
            }))
        except Exception:
            pass


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@router.websocket("/ws/data-stream")
async def ws_data_stream(ws: WebSocket) -> None:
    # Rate limit check
    ip = _auth_middleware.get_ws_client_ip(ws)
    rate_limiter = getattr(ws.app.state, "rate_limiter", None)
    if rate_limiter and not rate_limiter.ws_connect_allowed(ip):
        await ws.close(code=4029, reason="Too many connections")
        return

    # Ticket auth
    user = await _auth_middleware.validate_ws_ticket(ws)
    if ws.app.state.settings.auth_enabled and user is None:
        return  # ws already closed by validate_ws_ticket

    await ws.accept()
    if rate_limiter:
        rate_limiter.ws_connected(ip)
    state = _ConnState()
    collector_client = getattr(ws.app.state, "collector_client", None)
    db_root: str = getattr(ws.app.state, "db_root",
                           str(_DM_PATH.parent / "db_files"))
    trades_enabled: bool = getattr(ws.app.state.settings, "trades_enabled", True)
    logger.info("data-stream client connected  db_root=%s  collector=%s",
                db_root, "connected" if collector_client and collector_client.connected else "disconnected")

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({
                    "type": "error", "symbol": "", "message": "invalid JSON",
                }))
                continue

            msg_type = msg.get("type", "")

            if msg_type == "load":
                symbol = str(msg.get("symbol", "")).strip().upper()
                try:
                    from_ms = int(msg["from_ms"])
                    to_ms   = int(msg["to_ms"])
                except (KeyError, ValueError):
                    logger.warning("[%s] invalid load request — missing from_ms/to_ms", symbol)
                    await ws.send_text(json.dumps({
                        "type": "error", "symbol": symbol,
                        "message": "load requires from_ms and to_ms integers",
                    }))
                    continue

                range_h = (to_ms - from_ms) / 3_600_000
                logger.info(
                    "[%s] ← load request  [%s → %s] (%.1fh)",
                    symbol, _fmt_ts(from_ms), _fmt_ts(to_ms), range_h,
                )

                if from_ms >= to_ms:
                    logger.warning("[%s] rejected: from_ms >= to_ms", symbol)
                    await ws.send_text(json.dumps({
                        "type": "error", "symbol": symbol,
                        "message": "from_ms must be less than to_ms",
                    }))
                    continue

                if to_ms - from_ms > MAX_RANGE_MS:
                    logger.warning("[%s] rejected: range %.0fd exceeds limit", symbol, range_h / 24)
                    await ws.send_text(json.dumps({
                        "type": "error", "symbol": symbol,
                        "message": f"requested range exceeds {MAX_RANGE_MS // 86_400_000} days",
                    }))
                    continue

                # Cancel any in-progress load for this connection
                if state.task and not state.task.done():
                    logger.info("[%s] cancelling previous in-flight load", symbol)
                state.cancel()

                if not trades_enabled:
                    await ws.send_text(json.dumps({
                        "type": "done", "symbol": symbol,
                        "total_sent": 0, "chunk_count": 0,
                    }))
                    continue

                db = _get_db(db_root, symbol)  # may be None — coroutine handles polling

                state.task = asyncio.create_task(
                    _load_coroutine(ws, symbol, from_ms, to_ms, db, collector_client),
                    name=f"data-stream-{symbol}",
                )

            elif msg_type == "cancel":
                symbol = str(msg.get("symbol", "")).strip().upper()
                logger.info("[%s] ← cancel request from browser", symbol)
                state.cancel()
                if collector_client is not None:
                    collector_client.request_cancel(symbol)

            else:
                logger.warning("unknown message type: %r", msg_type)
                await ws.send_text(json.dumps({
                    "type": "error", "symbol": "",
                    "message": f"unknown message type: {msg_type!r}",
                }))

    except WebSocketDisconnect:
        pass
    finally:
        state.cancel()
        if rate_limiter:
            rate_limiter.ws_disconnected(ip)
        logger.info("data-stream client disconnected")
