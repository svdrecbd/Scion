from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from psycopg import Connection, OperationalError, connect
from psycopg.rows import dict_row

from app.config import get_settings
from app.errors import DatabaseUnavailableError


@contextmanager
def get_connection() -> Iterator[Connection]:
    settings = get_settings()
    try:
        with connect(settings.database_url, row_factory=dict_row) as connection:
            yield connection
    except OperationalError as exc:
        raise DatabaseUnavailableError("Scion database is unavailable.") from exc
