from __future__ import annotations

import json
import logging
from contextvars import ContextVar, Token
from datetime import datetime, timezone
from time import perf_counter
from typing import Any
from urllib.parse import urlparse

from fastapi import Request

REQUEST_ID_HEADER = "X-Request-ID"
_CURRENT_REQUEST_ID: ContextVar[str | None] = ContextVar("scion_request_id", default=None)

_STANDARD_LOG_KEYS = {
    "args",
    "asctime",
    "color_message",
    "created",
    "exc_info",
    "exc_text",
    "filename",
    "funcName",
    "levelname",
    "levelno",
    "lineno",
    "module",
    "msecs",
    "message",
    "msg",
    "name",
    "pathname",
    "process",
    "processName",
    "relativeCreated",
    "stack_info",
    "thread",
    "threadName",
    "taskName",
}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        for key, value in record.__dict__.items():
            if key in _STANDARD_LOG_KEYS or key.startswith("_"):
                continue
            payload[key] = _normalize_value(value)

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, sort_keys=True)


def configure_logging(level_name: str) -> None:
    level = getattr(logging, level_name.upper(), logging.INFO)
    root_logger = logging.getLogger()
    formatter = JsonFormatter()

    if not root_logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(formatter)
        root_logger.addHandler(handler)
    else:
        for handler in root_logger.handlers:
            handler.setFormatter(formatter)

    root_logger.setLevel(level)

    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(logger_name)
        logger.handlers = []
        logger.setLevel(level)

    logging.getLogger("uvicorn").propagate = True
    logging.getLogger("uvicorn.error").propagate = True
    uvicorn_access_logger = logging.getLogger("uvicorn.access")
    uvicorn_access_logger.propagate = False
    uvicorn_access_logger.disabled = True


def describe_database_target(database_url: str) -> str:
    parsed = urlparse(database_url)
    host = parsed.hostname or "localhost"
    scheme = parsed.scheme or "postgresql"
    port = parsed.port or 5432
    database = parsed.path.lstrip("/") or "postgres"
    return f"{scheme}://{host}:{port}/{database}"


def bind_request_id(request_id: str) -> Token[str | None]:
    return _CURRENT_REQUEST_ID.set(request_id)


def reset_request_id(token: Token[str | None]) -> None:
    _CURRENT_REQUEST_ID.reset(token)


def current_request_id() -> str | None:
    return _CURRENT_REQUEST_ID.get()


def get_request_id(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


def with_request_context(extra: dict[str, Any]) -> dict[str, Any]:
    payload = dict(extra)
    request_id = current_request_id()
    if request_id and "request_id" not in payload:
        payload["request_id"] = request_id
    return payload


def request_log_context(
    request: Request,
    *,
    status_code: int | None = None,
    duration_ms: float | None = None,
) -> dict[str, Any]:
    context: dict[str, Any] = {
        "request_id": get_request_id(request),
        "method": request.method,
        "path": request.url.path,
        "query": request.url.query or None,
        "client_ip": request.client.host if request.client else None,
    }
    if status_code is not None:
        context["status_code"] = status_code
    if duration_ms is not None:
        context["duration_ms"] = round(duration_ms, 2)
    return context


def response_log_level(
    status_code: int,
    *,
    duration_ms: float | None = None,
    slow_ms: int | None = None,
) -> int:
    if status_code >= 500:
        return logging.ERROR
    if status_code >= 400:
        return logging.WARNING
    if duration_ms is not None and slow_ms is not None and duration_ms >= slow_ms:
        return logging.WARNING
    return logging.INFO


def operation_log_level(duration_ms: float, slow_ms: int) -> int:
    if duration_ms >= slow_ms:
        return logging.WARNING
    return logging.INFO


def duration_ms_since(started_at: float) -> float:
    return round((perf_counter() - started_at) * 1000, 2)


def _normalize_value(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [_normalize_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _normalize_value(item) for key, item in value.items()}
    return str(value)
