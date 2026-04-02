from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Scion API"
    environment: str = Field(default="development", alias="SCION_ENV")
    api_prefix: str = Field(default="/api", alias="SCION_API_PREFIX")
    host: str = Field(default="0.0.0.0", alias="SCION_API_HOST")
    port: int = Field(default=8000, alias="SCION_API_PORT")
    cors_origins: str = Field(default="http://localhost:3000", alias="SCION_CORS_ORIGINS")
    database_url: str = Field(
        default="postgresql://postgres:postgres@localhost:5432/scion",
        alias="SCION_DATABASE_URL",
    )

    model_config = SettingsConfigDict(env_file="../../.env", extra="ignore")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
