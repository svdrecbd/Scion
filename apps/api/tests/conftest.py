from __future__ import annotations

import os
import subprocess
import sys
import uuid
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import pytest
from fastapi.testclient import TestClient
from psycopg import OperationalError, connect, sql

from app.config import get_settings
from app.main import app


ROOT = Path(__file__).resolve().parents[3]
MIGRATE_SCRIPT = ROOT / "scripts" / "db_migrate.py"
SEED_SCRIPT = ROOT / "scripts" / "db_seed.py"
DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/scion"


def _with_database_name(database_url: str, database_name: str) -> str:
    parsed = urlparse(database_url)
    return urlunparse(parsed._replace(path=f"/{database_name}"))


def _run_script(script: Path, database_url: str) -> None:
    env = os.environ.copy()
    env["SCION_DATABASE_URL"] = database_url
    subprocess.run(
        [sys.executable, str(script)],
        check=True,
        cwd=ROOT,
        env=env,
    )


@pytest.fixture(scope="session")
def seeded_database_url() -> Iterator[str]:
    base_database_url = os.environ.get("SCION_DATABASE_URL", DEFAULT_DATABASE_URL)
    admin_database_url = _with_database_name(base_database_url, "postgres")
    database_name = f"scion_test_{uuid.uuid4().hex[:12]}"
    test_database_url = _with_database_name(base_database_url, database_name)

    try:
        with connect(admin_database_url, autocommit=True) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name))
                )
    except OperationalError as exc:
        pytest.skip(f"Postgres is unavailable for integration tests: {exc}")

    try:
        _run_script(MIGRATE_SCRIPT, test_database_url)
        _run_script(SEED_SCRIPT, test_database_url)
        yield test_database_url
    finally:
        with connect(admin_database_url, autocommit=True) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s",
                    (database_name,),
                )
                cursor.execute(
                    sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(database_name))
                )


@pytest.fixture
def integration_client(seeded_database_url: str) -> Iterator[TestClient]:
    previous_database_url = os.environ.get("SCION_DATABASE_URL")
    previous_skip_startup_checks = os.environ.get("SCION_SKIP_STARTUP_CHECKS")
    os.environ["SCION_DATABASE_URL"] = seeded_database_url
    os.environ.pop("SCION_SKIP_STARTUP_CHECKS", None)
    get_settings.cache_clear()
    app.dependency_overrides.clear()

    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        if previous_database_url is None:
            os.environ.pop("SCION_DATABASE_URL", None)
        else:
            os.environ["SCION_DATABASE_URL"] = previous_database_url
        if previous_skip_startup_checks is None:
            os.environ.pop("SCION_SKIP_STARTUP_CHECKS", None)
        else:
            os.environ["SCION_SKIP_STARTUP_CHECKS"] = previous_skip_startup_checks
        get_settings.cache_clear()
