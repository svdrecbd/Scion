from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Cell Anatomy API"
    environment: str = Field(default="development", alias="SCION_ENV")
    log_level: str = Field(default="INFO", alias="SCION_LOG_LEVEL")
    slow_operation_ms: int = Field(default=250, alias="SCION_SLOW_OPERATION_MS")
    export_max_rows: int = Field(default=500, alias="SCION_EXPORT_MAX_ROWS")
    busy_retry_after_seconds: int = Field(default=5, alias="SCION_BUSY_RETRY_AFTER_SECONDS")
    export_slot_limit: int = Field(default=1, alias="SCION_EXPORT_SLOT_LIMIT")
    analytics_slot_limit: int = Field(default=4, alias="SCION_ANALYTICS_SLOT_LIMIT")
    beta_signup_csv_path: str = Field(
        default=".run/beta-signups.csv",
        alias="SCION_BETA_SIGNUP_CSV_PATH",
    )
    beta_signup_rate_limit_per_hour: int = Field(
        default=10,
        alias="SCION_BETA_SIGNUP_RATE_LIMIT_PER_HOUR",
    )
    api_prefix: str = Field(default="/api", alias="SCION_API_PREFIX")
    host: str = Field(default="0.0.0.0", alias="SCION_API_HOST")
    port: int = Field(default=8000, alias="SCION_API_PORT")
    cors_origins: str = Field(default="http://localhost:3000", alias="SCION_CORS_ORIGINS")
    database_url: str = Field(
        default="postgresql://postgres:postgres@localhost:5432/scion",
        alias="SCION_DATABASE_URL",
    )
    skip_startup_checks: bool = Field(default=False, alias="SCION_SKIP_STARTUP_CHECKS")

    model_config = SettingsConfigDict(env_file="../../.env", extra="ignore")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
