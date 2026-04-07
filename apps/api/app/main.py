import logging
from contextlib import asynccontextmanager
from time import perf_counter
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.errors import (
    DatabaseUnavailableError,
    ExportLimitError,
    PressureLimitError,
    StartupCheckError,
)
from app.observability import (
    REQUEST_ID_HEADER,
    bind_request_id,
    configure_logging,
    describe_database_target,
    duration_ms_since,
    get_request_id,
    request_log_context,
    reset_request_id,
    response_log_level,
)
from app.readiness import readiness_snapshot
from app.routes.datasets import router as datasets_router
from app.routes.health import router as health_router

configure_logging(get_settings().log_level)
settings = get_settings()
logger = logging.getLogger("scion.startup")
request_logger = logging.getLogger("scion.request")
error_logger = logging.getLogger("scion.error")


@asynccontextmanager
async def lifespan(_: FastAPI):
    current_settings = get_settings()
    if current_settings.skip_startup_checks:
        logger.info("startup checks skipped", extra={"event": "startup_skipped"})
        yield
        return

    database_target = describe_database_target(current_settings.database_url)
    try:
        snapshot = readiness_snapshot()
    except (DatabaseUnavailableError, StartupCheckError) as exc:
        logger.error(
            "startup checks failed",
            extra={
                "event": "startup_failed",
                "database_target": database_target,
                "error": str(exc),
            },
        )
        raise
    except Exception:
        logger.exception(
            "unexpected startup failure",
            extra={
                "event": "startup_failed_unexpected",
                "database_target": database_target,
            },
        )
        raise

    logger.info(
        "startup checks passed",
        extra={
            "event": "startup_ready",
            "database_target": database_target,
            **snapshot,
        },
    )
    yield

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="API for Scion, a structured lookup and comparison layer for whole-cell datasets.",
    lifespan=lifespan,
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    request_id = request.headers.get(REQUEST_ID_HEADER) or uuid4().hex[:12]
    request.state.request_id = request_id
    request_id_token = bind_request_id(request_id)
    started_at = perf_counter()
    current_settings = get_settings()

    try:
        response = await call_next(request)
    except Exception:
        duration_ms = duration_ms_since(started_at)
        request_logger.exception(
            "request raised an unhandled exception",
            extra={
                "event": "request_failed",
                **request_log_context(request, duration_ms=duration_ms),
            },
        )
        reset_request_id(request_id_token)
        raise

    duration_ms = duration_ms_since(started_at)
    response.headers[REQUEST_ID_HEADER] = request_id
    request_logger.log(
        response_log_level(
            response.status_code,
            duration_ms=duration_ms,
            slow_ms=current_settings.slow_operation_ms,
        ),
        "request completed",
        extra={
            "event": "request_completed",
            **request_log_context(
                request,
                status_code=response.status_code,
                duration_ms=duration_ms,
            ),
        },
    )
    reset_request_id(request_id_token)
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router, prefix=settings.api_prefix)
app.include_router(datasets_router, prefix=settings.api_prefix)


def _error_payload(request: Request, detail: str) -> dict[str, str]:
    payload = {"detail": detail}
    request_id = get_request_id(request)
    if request_id:
        payload["request_id"] = request_id
    return payload


@app.exception_handler(DatabaseUnavailableError)
def handle_database_unavailable(request: Request, exc: DatabaseUnavailableError) -> JSONResponse:
    error_logger.error(
        "database unavailable during request",
        extra={
            "event": "database_unavailable",
            **request_log_context(request, status_code=503),
        },
    )
    return JSONResponse(status_code=503, content=_error_payload(request, str(exc)))


@app.exception_handler(StartupCheckError)
def handle_startup_check_failure(request: Request, exc: StartupCheckError) -> JSONResponse:
    error_logger.warning(
        "request failed readiness check",
        extra={
            "event": "request_not_ready",
            **request_log_context(request, status_code=503),
        },
    )
    return JSONResponse(status_code=503, content=_error_payload(request, str(exc)))


@app.exception_handler(PressureLimitError)
def handle_pressure_limit(request: Request, exc: PressureLimitError) -> JSONResponse:
    error_logger.warning(
        "request rejected due to pressure limit",
        extra={
            "event": "request_rejected_busy",
            "retry_after_seconds": exc.retry_after_seconds,
            **request_log_context(request, status_code=429),
        },
    )
    return JSONResponse(
        status_code=429,
        content=_error_payload(request, str(exc)),
        headers={"Retry-After": str(exc.retry_after_seconds)},
    )


@app.exception_handler(ExportLimitError)
def handle_export_limit(request: Request, exc: ExportLimitError) -> JSONResponse:
    error_logger.warning(
        "request rejected due to export safety limit",
        extra={
            "event": "request_rejected_export_limit",
            "row_limit": exc.row_limit,
            **request_log_context(request, status_code=413),
        },
    )
    return JSONResponse(status_code=413, content=_error_payload(request, str(exc)))


@app.get("/")
def root() -> dict[str, str]:
    return {"message": "Scion API is running"}
