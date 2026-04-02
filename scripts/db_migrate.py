#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path

from psycopg import connect


ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = ROOT / "db" / "migrations"
DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/scion"


def read_database_url() -> str:
    if os.getenv("SCION_DATABASE_URL"):
        return os.environ["SCION_DATABASE_URL"]

    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("SCION_DATABASE_URL="):
                return line.split("=", 1)[1].strip()

    return DEFAULT_DATABASE_URL


def ensure_migrations_table(connection) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    connection.commit()


def applied_versions(connection) -> set[str]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT version FROM schema_migrations")
        return {row[0] for row in cursor.fetchall()}


def apply_migration(connection, version: str, sql: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute(sql)
        cursor.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (version,))
    connection.commit()


def main() -> None:
    database_url = read_database_url()
    with connect(database_url) as connection:
        ensure_migrations_table(connection)
        already_applied = applied_versions(connection)

        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            version = path.name
            if version in already_applied:
                continue
            apply_migration(connection, version, path.read_text(encoding="utf-8"))
            print(f"applied {version}")


if __name__ == "__main__":
    main()
