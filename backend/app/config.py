"""Application settings, loaded from environment / .env file."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Anthropic -------------------------------------------------------
    anthropic_api_key: str = ""
    anthropic_model: str = "auto"
    anthropic_model_preference: str = "sonnet,opus,haiku"
    anthropic_max_tokens: int = 8000

    # --- Storage ---------------------------------------------------------
    database_url: str = f"sqlite:///{(BACKEND_DIR / 'taskmanager.db').as_posix()}"

    # --- HTTP ------------------------------------------------------------
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def model_preference_list(self) -> list[str]:
        return [p.strip().lower() for p in self.anthropic_model_preference.split(",") if p.strip()]

    @property
    def ai_enabled(self) -> bool:
        """True when a key is present. Everything AI-shaped checks this first."""
        return bool(self.anthropic_api_key.strip())

    @property
    def generated_dir(self) -> Path:
        return BACKEND_DIR / "generated"


@lru_cache
def get_settings() -> Settings:
    return Settings()
