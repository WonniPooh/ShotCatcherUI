"""
Chart UI Server configuration.

Settings are loaded in priority order (highest first):
  1. Environment variables with prefix CHART_UI_  (e.g. CHART_UI_PORT=9090)
  2. chart-ui-server/config/ui_server.json         (create from ui_server.example.json)
  3. Built-in defaults listed below
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Tuple, Type

from pydantic_settings import BaseSettings, JsonConfigSettingsSource, PydanticBaseSettingsSource


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_CONFIG_FILE  = Path(__file__).resolve().parent / "config" / "ui_server.json"


class Settings(BaseSettings):
    # Server
    host: str = "0.0.0.0"
    port: int = 8080
    api_key: str = ""  # legacy X-Api-Key header; empty = disabled

    # TLS (empty = plain HTTP)
    ssl_certfile: str = ""
    ssl_keyfile: str = ""

    # Auth
    auth_enabled: bool = False
    users_db_path: str = str(_PROJECT_ROOT / "config" / "users.db")
    session_ttl_days: int = 7
    allow_registration: bool = False

    # Market data
    db_root: str = str(_PROJECT_ROOT / "db_files")

    # Collector internal WS
    collector_ws_url: str = "ws://localhost:8001/ws"
    collector_reconnect_interval: float = 5.0

    # Worker control WS
    worker_ws_url: str = "ws://localhost:9090"
    worker_reconnect_interval: float = 5.0

    # Feature toggles
    enable_chart: bool = True
    enable_dashboard: bool = True

    model_config = {
        "env_prefix": "CHART_UI_",
        "extra": "ignore",
        "json_file": str(_CONFIG_FILE) if _CONFIG_FILE.exists() else None,
    }

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: Type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> Tuple[PydanticBaseSettingsSource, ...]:
        sources: list[Any] = [init_settings, env_settings]
        if _CONFIG_FILE.exists():
            sources.append(JsonConfigSettingsSource(settings_cls))
        sources.append(file_secret_settings)
        return tuple(sources)
