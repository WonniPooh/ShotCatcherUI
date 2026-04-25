"""
Rate limiter — in-memory per-IP rate limiting for login attempts and WS connections.

Tracks:
  - Login attempts: max N attempts per IP per window → lockout
  - WS connections: max M concurrent connections per IP
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict

logger = logging.getLogger("chart_ui_server.auth.rate_limiter")


class RateLimiter:
    """In-memory rate limiter for login attempts and IP blocking."""

    def __init__(
        self,
        max_login_attempts: int = 5,
        login_window_seconds: int = 300,
        lockout_seconds: int = 900,
        block_threshold: int = 20,
        block_window_seconds: int = 3600,
        block_duration_seconds: int = 3600,
        max_ws_per_ip: int = 10,
    ) -> None:
        self.max_login_attempts = max_login_attempts
        self.login_window_seconds = login_window_seconds
        self.lockout_seconds = lockout_seconds
        self.block_threshold = block_threshold
        self.block_window_seconds = block_window_seconds
        self.block_duration_seconds = block_duration_seconds
        self.max_ws_per_ip = max_ws_per_ip

        # IP → list of failed-attempt timestamps
        self._login_attempts: dict[str, list[float]] = defaultdict(list)
        # IP → lockout-expires timestamp
        self._lockouts: dict[str, float] = {}
        # IP → block-expires timestamp
        self._blocks: dict[str, float] = {}
        # IP → count of active WS connections
        self._ws_connections: dict[str, int] = defaultdict(int)

    def is_blocked(self, ip: str) -> bool:
        """Check if an IP is blocked (too many failures)."""
        expires = self._blocks.get(ip)
        if expires is None:
            return False
        if time.monotonic() > expires:
            del self._blocks[ip]
            return False
        return True

    def is_locked_out(self, ip: str) -> bool:
        """Check if an IP is temporarily locked out (recent failures)."""
        expires = self._lockouts.get(ip)
        if expires is None:
            return False
        if time.monotonic() > expires:
            del self._lockouts[ip]
            return False
        return True

    def check_login_allowed(self, ip: str) -> tuple[bool, str]:
        """Check if a login attempt from this IP is allowed.
        Returns (allowed, reason).
        """
        if self.is_blocked(ip):
            return False, "IP blocked due to too many failed attempts"
        if self.is_locked_out(ip):
            return False, "Too many login attempts, try again later"
        return True, ""

    def record_login_failure(self, ip: str) -> None:
        """Record a failed login attempt. May trigger lockout or block."""
        now = time.monotonic()

        # Add to recent attempts
        attempts = self._login_attempts[ip]
        attempts.append(now)

        # Prune old attempts outside block window (use larger window)
        cutoff = now - self.block_window_seconds
        self._login_attempts[ip] = [t for t in attempts if t > cutoff]
        attempts = self._login_attempts[ip]

        # Check for IP block (too many in block window)
        if len(attempts) >= self.block_threshold:
            self._blocks[ip] = now + self.block_duration_seconds
            logger.warning("BLOCKED IP %s — %d failed logins in %ds",
                           ip, len(attempts), self.block_window_seconds)
            return

        # Check for temporary lockout (too many in login window)
        recent_cutoff = now - self.login_window_seconds
        recent = [t for t in attempts if t > recent_cutoff]
        if len(recent) >= self.max_login_attempts:
            self._lockouts[ip] = now + self.lockout_seconds
            logger.warning("Locked out IP %s — %d failed logins in %ds",
                           ip, len(recent), self.login_window_seconds)

    def record_login_success(self, ip: str) -> None:
        """Clear recent login attempts on successful login."""
        self._login_attempts.pop(ip, None)
        self._lockouts.pop(ip, None)

    def ws_connect_allowed(self, ip: str) -> bool:
        """Check if a new WS connection from this IP is allowed."""
        if self.is_blocked(ip):
            return False
        return self._ws_connections[ip] < self.max_ws_per_ip

    def ws_connected(self, ip: str) -> None:
        """Track a new WS connection."""
        self._ws_connections[ip] += 1

    def ws_disconnected(self, ip: str) -> None:
        """Track a WS disconnection."""
        count = self._ws_connections[ip]
        if count <= 1:
            self._ws_connections.pop(ip, None)
        else:
            self._ws_connections[ip] = count - 1

    def cleanup(self) -> None:
        """Periodic cleanup of stale entries."""
        now = time.monotonic()
        # Clean expired blocks
        expired_blocks = [ip for ip, exp in self._blocks.items() if now > exp]
        for ip in expired_blocks:
            del self._blocks[ip]
        # Clean expired lockouts
        expired_lockouts = [ip for ip, exp in self._lockouts.items() if now > exp]
        for ip in expired_lockouts:
            del self._lockouts[ip]
        # Clean stale attempt lists (no attempts in block_window)
        stale = [ip for ip, attempts in self._login_attempts.items()
                 if not attempts or (now - attempts[-1]) > self.block_window_seconds]
        for ip in stale:
            del self._login_attempts[ip]
