from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from threading import BoundedSemaphore, Lock

from app.errors import PressureLimitError

_PRESSURE_LOCK = Lock()
_PRESSURE_LIMITS: dict[str, int] = {}
_PRESSURE_SEMAPHORES: dict[str, BoundedSemaphore] = {}


def get_pressure_semaphore(slot_name: str, limit: int) -> BoundedSemaphore:
    if limit <= 0:
        raise ValueError("Pressure semaphore limit must be greater than zero.")

    with _PRESSURE_LOCK:
        existing_limit = _PRESSURE_LIMITS.get(slot_name)
        semaphore = _PRESSURE_SEMAPHORES.get(slot_name)

        if semaphore is None or existing_limit != limit:
            semaphore = BoundedSemaphore(limit)
            _PRESSURE_SEMAPHORES[slot_name] = semaphore
            _PRESSURE_LIMITS[slot_name] = limit

        return semaphore


@contextmanager
def pressure_guard(
    slot_name: str,
    *,
    limit: int,
    detail: str,
    retry_after_seconds: int,
) -> Iterator[None]:
    if limit <= 0:
        yield
        return

    semaphore = get_pressure_semaphore(slot_name, limit)
    if not semaphore.acquire(blocking=False):
        raise PressureLimitError(detail, retry_after_seconds=retry_after_seconds)

    try:
        yield
    finally:
        semaphore.release()
