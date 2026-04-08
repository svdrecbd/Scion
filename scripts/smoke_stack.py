#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import urlopen

from psycopg import OperationalError, connect, sql


ROOT = Path(__file__).resolve().parent.parent
API_DIR = ROOT / "apps" / "api"
WEB_DIR = ROOT / "apps" / "web"
DEFAULT_API_PYTHON = API_DIR / ".venv" / "bin" / "python"
API_PYTHON = Path(
    os.environ.get("SCION_API_PYTHON")
    or (str(DEFAULT_API_PYTHON) if DEFAULT_API_PYTHON.exists() else sys.executable)
)
MIGRATE_SCRIPT = ROOT / "scripts" / "db_migrate.py"
SEED_SCRIPT = ROOT / "scripts" / "db_seed.py"
DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/scion"
GRACEFUL_EXIT_CODES = {0, None, -2, 130}


def with_database_name(database_url: str, database_name: str) -> str:
    parsed = urlparse(database_url)
    return urlunparse(parsed._replace(path=f"/{database_name}"))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run_script(script: Path, database_url: str) -> None:
    env = os.environ.copy()
    env["SCION_DATABASE_URL"] = database_url
    subprocess.run([str(API_PYTHON), str(script)], cwd=ROOT, env=env, check=True)


def wait_for_json(url: str, *, timeout_seconds: float = 30.0) -> object:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None

    while time.time() < deadline:
        try:
            with urlopen(url, timeout=2) as response:
                return json.load(response)
        except (URLError, HTTPError, json.JSONDecodeError) as exc:
            last_error = exc
            time.sleep(0.25)

    raise RuntimeError(f"Timed out waiting for {url}: {last_error}")


def wait_for_status(url: str, *, timeout_seconds: float = 30.0) -> int:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None

    while time.time() < deadline:
        try:
            with urlopen(url, timeout=2) as response:
                return int(response.status)
        except (URLError, HTTPError) as exc:
            last_error = exc
            time.sleep(0.25)

    raise RuntimeError(f"Timed out waiting for {url}: {last_error}")


@contextmanager
def temp_database() -> str:
    base_database_url = os.environ.get("SCION_DATABASE_URL", DEFAULT_DATABASE_URL)
    admin_database_url = with_database_name(base_database_url, "postgres")
    database_name = f"scion_smoke_{uuid.uuid4().hex[:12]}"
    test_database_url = with_database_name(base_database_url, database_name)

    try:
        with connect(admin_database_url, autocommit=True) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name)))
    except OperationalError as exc:
        raise RuntimeError(f"Postgres is unavailable for smoke test: {exc}") from exc

    try:
        run_script(MIGRATE_SCRIPT, test_database_url)
        run_script(SEED_SCRIPT, test_database_url)
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


@contextmanager
def managed_process(command: list[str], *, cwd: Path, env: dict[str, str], name: str):
    with tempfile.NamedTemporaryFile(mode="w+", encoding="utf-8") as log_file:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            yield process
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if process.returncode not in GRACEFUL_EXIT_CODES:
                log_file.flush()
                log_file.seek(0)
                output = log_file.read()
                raise RuntimeError(f"{name} exited unexpectedly:\n{output}")


def main() -> None:
    api_port = free_port()
    web_port = free_port()
    print(f"smoke: api_port={api_port} web_port={web_port}", flush=True)

    with temp_database() as database_url:
        api_env = os.environ.copy()
        api_env["SCION_DATABASE_URL"] = database_url
        api_base_url = f"http://127.0.0.1:{api_port}/api"

        web_env = os.environ.copy()
        web_env["SCION_API_BASE_URL"] = api_base_url
        web_env["NEXT_PUBLIC_SCION_API_BASE_URL"] = api_base_url

        with managed_process(
            [str(API_PYTHON), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(api_port)],
            cwd=API_DIR,
            env=api_env,
            name="api",
        ):
            print("smoke: waiting for API health", flush=True)
            health = wait_for_json(f"http://127.0.0.1:{api_port}/api/health")
            if health != {"status": "ok"}:
                raise RuntimeError(f"Unexpected API health payload: {health}")

            print("smoke: fetching dataset seed slice", flush=True)
            datasets = wait_for_json(f"http://127.0.0.1:{api_port}/api/datasets")
            if not isinstance(datasets, dict) or not datasets.get("results"):
                raise RuntimeError("Seeded API returned no datasets during smoke test.")

            dataset_ids = [item["dataset_id"] for item in datasets["results"][:2]]
            if len(dataset_ids) < 2:
                raise RuntimeError("Need at least two dataset ids for compare smoke test.")

            with managed_process(
                ["npm", "run", "start", "--", "--hostname", "127.0.0.1", "--port", str(web_port)],
                cwd=WEB_DIR,
                env=web_env,
                name="web",
            ):
                urls = [
                    f"http://127.0.0.1:{web_port}/",
                    f"http://127.0.0.1:{web_port}/guide",
                    f"http://127.0.0.1:{web_port}/analytics",
                    f"http://127.0.0.1:{web_port}/plan",
                    f"http://127.0.0.1:{web_port}/datasets/{dataset_ids[0]}",
                    f"http://127.0.0.1:{web_port}/compare?ids={dataset_ids[0]},{dataset_ids[1]}",
                ]

                for url in urls:
                    print(f"smoke: checking {url}", flush=True)
                    status = wait_for_status(url)
                    if status != 200:
                        raise RuntimeError(f"Unexpected status {status} for {url}")

    print("smoke test passed")


if __name__ == "__main__":
    main()
