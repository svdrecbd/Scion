from __future__ import annotations

import csv
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from time import time

from fastapi import APIRouter, HTTPException, Request

from app.config import get_settings
from app.observability import with_request_context
from app.schemas import BetaSignupRequest, BetaSignupResponse


router = APIRouter(prefix="/beta-signups", tags=["beta-signups"])
route_logger = logging.getLogger("scion.route")

CSV_FIELDS = [
    "Created At",
    "Email",
    "First Name",
    "Last Name",
    "Affiliation",
    "Source Path",
    "Consent Text Version",
]
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
WINDOW_SECONDS = 60 * 60

_csv_lock = Lock()
_rate_limit_lock = Lock()
_rate_limit_hits: dict[str, list[float]] = {}


def _csv_safe(value: str | None) -> str:
    normalized = (value or "").strip()
    if normalized.startswith(CSV_FORMULA_PREFIXES):
        return f"'{normalized}"
    return normalized


def _signup_path() -> Path:
    return Path(get_settings().beta_signup_csv_path).expanduser()


def _append_signup(row: dict[str, str]) -> None:
    path = _signup_path()
    parent_exists = path.parent.exists()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not parent_exists:
        path.parent.chmod(0o700)

    with _csv_lock:
        has_existing_content = path.exists() and path.stat().st_size > 0
        descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(descriptor, "a", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
            if not has_existing_content:
                writer.writeheader()
            writer.writerow(row)
        path.chmod(0o600)


def _rate_limit_key(request: Request) -> str:
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _guard_rate_limit(request: Request) -> None:
    settings = get_settings()
    limit = settings.beta_signup_rate_limit_per_hour
    if limit <= 0:
        return

    now = time()
    cutoff = now - WINDOW_SECONDS
    key = _rate_limit_key(request)

    with _rate_limit_lock:
        hits = [timestamp for timestamp in _rate_limit_hits.get(key, []) if timestamp >= cutoff]
        if len(hits) >= limit:
            _rate_limit_hits[key] = hits
            raise HTTPException(status_code=429, detail="Signup capacity is saturated. Retry later.")

        hits.append(now)
        _rate_limit_hits[key] = hits


@router.post("", response_model=BetaSignupResponse, status_code=201)
def create_beta_signup(signup: BetaSignupRequest, request: Request) -> BetaSignupResponse:
    if signup.website:
        route_logger.info(
            "beta signup ignored by honeypot",
            extra=with_request_context({"event": "beta_signup_honeypot"}),
        )
        return BetaSignupResponse(status="ok")

    _guard_rate_limit(request)

    row = {
        "Created At": datetime.now(UTC).isoformat(timespec="seconds"),
        "Email": _csv_safe(signup.email),
        "First Name": _csv_safe(signup.first_name),
        "Last Name": _csv_safe(signup.last_name),
        "Affiliation": _csv_safe(signup.affiliation),
        "Source Path": _csv_safe(signup.source_path),
        "Consent Text Version": _csv_safe(signup.consent_text_version),
    }

    try:
        _append_signup(row)
    except OSError:
        route_logger.exception(
            "beta signup write failed",
            extra=with_request_context({"event": "beta_signup_write_failed"}),
        )
        raise HTTPException(status_code=503, detail="The signup could not be saved. Retry later.")

    route_logger.info(
        "beta signup saved",
        extra=with_request_context(
            {
                "event": "beta_signup_saved",
                "source_path": signup.source_path,
            }
        ),
    )
    return BetaSignupResponse(status="ok")
