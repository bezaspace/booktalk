"""Application configuration loaded from environment variables."""
from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings sourced from the environment / .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    gemini_api_key: str = ""
    allowed_origins: str = "http://localhost:5173"
    # Live API model — low-latency native audio
    live_model: str = "gemini-3.1-flash-live-preview"
    # How long an ephemeral token may be used to start a new session
    new_session_ttl_seconds: int = 60
    # How long an issued token remains valid for sending messages
    expire_ttl_seconds: int = 1800

    @field_validator("gemini_api_key")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        # Empty key is allowed at import time (e.g. for `--help`), but the
        # /token endpoint will refuse to mint tokens without it.
        return v.strip()

    @property
    def cors_origins(self) -> List[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
