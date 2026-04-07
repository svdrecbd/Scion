from __future__ import annotations

from app.db import get_connection
from app.errors import StartupCheckError


def readiness_snapshot() -> dict[str, int | str]:
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT to_regclass('public.schema_migrations') AS value")
            if cursor.fetchone()["value"] is None:
                raise StartupCheckError("schema_migrations table is missing. Run make db-migrate.")

            cursor.execute("SELECT to_regclass('public.dataset_records') AS value")
            if cursor.fetchone()["value"] is None:
                raise StartupCheckError("dataset_records table is missing. Run make db-migrate.")

            cursor.execute("SELECT COUNT(*) AS count FROM dataset_records")
            dataset_count = int(cursor.fetchone()["count"])
            if dataset_count <= 0:
                raise StartupCheckError("dataset_records is empty. Run make db-seed.")

            cursor.execute("SELECT COUNT(*) AS count FROM schema_migrations")
            migration_count = int(cursor.fetchone()["count"])

    return {
        "status": "ready",
        "dataset_records": dataset_count,
        "applied_migrations": migration_count,
    }
