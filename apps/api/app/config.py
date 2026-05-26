from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_CORS_ORIGINS = ",".join(
    [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "tauri://localhost",
        "http://tauri.localhost",
    ]
)


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
    auth_cookie_name: str = Field(default="cell_anatomy_session", alias="SCION_AUTH_COOKIE_NAME")
    auth_code_ttl_minutes: int = Field(default=10, alias="SCION_AUTH_CODE_TTL_MINUTES")
    auth_session_days: int = Field(default=30, alias="SCION_AUTH_SESSION_DAYS")
    auth_remember_days: int = Field(default=90, alias="SCION_AUTH_REMEMBER_DAYS")
    auth_device_days: int = Field(default=180, alias="SCION_AUTH_DEVICE_DAYS")
    auth_device_pairing_ttl_minutes: int = Field(default=10, alias="SCION_AUTH_DEVICE_PAIRING_TTL_MINUTES")
    auth_device_pairing_poll_interval_seconds: int = Field(default=3, alias="SCION_AUTH_DEVICE_PAIRING_POLL_INTERVAL_SECONDS")
    auth_code_rate_limit_per_hour: int = Field(default=5, alias="SCION_AUTH_CODE_RATE_LIMIT_PER_HOUR")
    auth_cookie_secure: bool = Field(default=False, alias="SCION_AUTH_COOKIE_SECURE")
    auth_email_from: str = Field(default="Cell Anatomy <no-reply@cell-anatomy.local>", alias="SCION_AUTH_EMAIL_FROM")
    auth_smtp_host: str | None = Field(default=None, alias="SCION_AUTH_SMTP_HOST")
    auth_smtp_port: int = Field(default=587, alias="SCION_AUTH_SMTP_PORT")
    auth_smtp_username: str | None = Field(default=None, alias="SCION_AUTH_SMTP_USERNAME")
    auth_smtp_password: str | None = Field(default=None, alias="SCION_AUTH_SMTP_PASSWORD")
    auth_smtp_starttls: bool = Field(default=True, alias="SCION_AUTH_SMTP_STARTTLS")
    auth_dev_outbox_path: str = Field(default=".run/auth-codes.log", alias="SCION_AUTH_DEV_OUTBOX_PATH")
    api_prefix: str = Field(default="/api", alias="SCION_API_PREFIX")
    host: str = Field(default="0.0.0.0", alias="SCION_API_HOST")
    port: int = Field(default=8000, alias="SCION_API_PORT")
    cors_origins: str = Field(
        default=DEFAULT_CORS_ORIGINS,
        alias="SCION_CORS_ORIGINS",
    )
    database_url: str = Field(
        default="postgresql://postgres:postgres@localhost:5432/scion",
        alias="SCION_DATABASE_URL",
    )
    skip_startup_checks: bool = Field(default=False, alias="SCION_SKIP_STARTUP_CHECKS")

    model_config = SettingsConfigDict(env_file="../../.env", extra="ignore")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
