from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import smtplib
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from threading import Lock
from time import time
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response

from app.config import get_settings
from app.db import get_connection
from app.observability import with_request_context
from app.schemas import (
    AuthDevice,
    AuthDevicesResponse,
    AuthMeResponse,
    AuthSession,
    AuthSessionsResponse,
    AuthStartRequest,
    AuthStartResponse,
    AuthUser,
    AuthVerifyRequest,
    AuthVerifyResponse,
    DeviceMeResponse,
    DevicePairApproveRequest,
    DevicePairApproveResponse,
    DevicePairPollRequest,
    DevicePairPollResponse,
    DevicePairStartRequest,
    DevicePairStartResponse,
)


router = APIRouter(prefix="/auth", tags=["auth"])
route_logger = logging.getLogger("scion.route")
WINDOW_SECONDS = 60 * 60
MAX_CODE_ATTEMPTS = 5

_rate_limit_lock = Lock()
_rate_limit_hits: dict[str, list[float]] = {}


def _now() -> datetime:
    return datetime.now(UTC)


def _client_host(request: Request) -> str:
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _rate_limit_key(request: Request, email: str) -> str:
    return f"{email}:{_client_host(request)}"


def _guard_code_rate_limit(request: Request, email: str) -> None:
    settings = get_settings()
    limit = settings.auth_code_rate_limit_per_hour
    if limit <= 0:
        return

    now = time()
    cutoff = now - WINDOW_SECONDS
    key = _rate_limit_key(request, email)

    with _rate_limit_lock:
        hits = [timestamp for timestamp in _rate_limit_hits.get(key, []) if timestamp >= cutoff]
        if len(hits) >= limit:
            _rate_limit_hits[key] = hits
            raise HTTPException(status_code=429, detail="Login code requests are temporarily limited. Retry later.")

        hits.append(now)
        _rate_limit_hits[key] = hits


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _verify_secret(secret: str, digest: str) -> bool:
    return hmac.compare_digest(_hash_secret(secret), digest)


def _issue_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _issue_session_token() -> str:
    return secrets.token_urlsafe(48)


def _issue_device_code() -> str:
    return secrets.token_urlsafe(40)


def _issue_user_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def _normalize_user_code(code: str) -> str:
    return code.strip().upper().replace(" ", "").replace("-", "")


def _send_login_code(email: str, code: str) -> None:
    settings = get_settings()
    if settings.auth_smtp_host:
        message = EmailMessage()
        message["From"] = settings.auth_email_from
        message["To"] = email
        message["Subject"] = "Your Cell Anatomy login code"
        message.set_content(
            "\n".join(
                [
                    f"Your Cell Anatomy login code is {code}.",
                    "",
                    f"This code expires in {settings.auth_code_ttl_minutes} minutes.",
                    "If you did not request this code, you can ignore this email.",
                ]
            )
        )
        with smtplib.SMTP(settings.auth_smtp_host, settings.auth_smtp_port, timeout=10) as smtp:
            if settings.auth_smtp_starttls:
                smtp.starttls()
            if settings.auth_smtp_username and settings.auth_smtp_password:
                smtp.login(settings.auth_smtp_username, settings.auth_smtp_password)
            smtp.send_message(message)
        return

    outbox = Path(settings.auth_dev_outbox_path)
    outbox.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    line = f"{_now().isoformat(timespec='seconds')} email={email} code={code}\n"
    descriptor = os.open(outbox, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
        handle.write(line)
    route_logger.info(
        "auth login code written to development outbox",
        extra=with_request_context({"event": "auth_code_dev_outbox", "outbox_path": str(outbox)}),
    )


def _session_max_age_seconds(remember: bool) -> int:
    settings = get_settings()
    days = settings.auth_remember_days if remember else settings.auth_session_days
    return max(1, days) * 24 * 60 * 60


def _session_expires_at(remember: bool) -> datetime:
    return _now() + timedelta(seconds=_session_max_age_seconds(remember))


def _device_expires_at() -> datetime:
    return _now() + timedelta(days=max(1, get_settings().auth_device_days))


def _pairing_expires_at() -> datetime:
    return _now() + timedelta(minutes=max(1, get_settings().auth_device_pairing_ttl_minutes))


def _set_session_cookie(response: Response, token: str, remember: bool) -> None:
    settings = get_settings()
    secure_cookie = settings.auth_cookie_secure or settings.environment == "production"
    response.set_cookie(
        key=settings.auth_cookie_name,
        value=token,
        max_age=_session_max_age_seconds(remember),
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    settings = get_settings()
    secure_cookie = settings.auth_cookie_secure or settings.environment == "production"
    response.delete_cookie(
        key=settings.auth_cookie_name,
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        path="/",
    )


def _read_session_token(request: Request) -> str | None:
    token = request.cookies.get(get_settings().auth_cookie_name)
    if token and len(token) >= 32:
        return token
    return None


def _read_bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() == "bearer" and len(token) >= 32:
        return token
    return None


def _serialize_user(row) -> AuthUser:
    return AuthUser(
        user_id=row["user_id"],
        primary_email=row["primary_email"],
        display_name=row["display_name"],
        created_at=row["created_at"],
    )


def _serialize_session(row, current_session_id: UUID | None = None) -> AuthSession:
    return AuthSession(
        session_id=row["session_id"],
        created_at=row["created_at"],
        expires_at=row["expires_at"],
        last_seen_at=row["last_seen_at"],
        user_agent=row["user_agent"],
        ip_address=row["ip_address"],
        current=current_session_id is not None and row["session_id"] == current_session_id,
        remember=row["remember"],
    )


def _serialize_device(row, current_device_id: UUID | None = None) -> AuthDevice:
    return AuthDevice(
        device_id=row["device_id"],
        device_name=row["device_name"],
        platform=row["platform"],
        created_at=row["created_at"],
        expires_at=row["expires_at"],
        last_seen_at=row["last_seen_at"],
        current=current_device_id is not None and row["device_id"] == current_device_id,
    )


def _load_current_session(request: Request, *, refresh: bool = True):
    token = _read_session_token(request)
    if not token:
        return None

    session_hash = _hash_secret(token)
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    s.session_id,
                    s.user_id,
                    s.remember,
                    s.expires_at,
                    s.last_seen_at,
                    s.user_agent,
                    s.ip_address,
                    s.created_at,
                    u.primary_email,
                    u.display_name,
                    u.created_at AS user_created_at
                FROM sessions s
                JOIN users u ON u.user_id = s.user_id
                WHERE s.session_hash = %s
                  AND s.revoked_at IS NULL
                  AND s.expires_at > NOW()
                  AND u.deleted_at IS NULL
                """,
                (session_hash,),
            )
            row = cursor.fetchone()
            if not row:
                return None
            row = dict(row)

            if refresh:
                expires_at = _session_expires_at(bool(row["remember"]))
                cursor.execute(
                    """
                    UPDATE sessions
                    SET last_seen_at = NOW(), expires_at = %s
                    WHERE session_id = %s
                    RETURNING last_seen_at, expires_at
                    """,
                    (expires_at, row["session_id"]),
                )
                updated = cursor.fetchone()
                if updated:
                    row["last_seen_at"] = updated["last_seen_at"]
                    row["expires_at"] = updated["expires_at"]
        connection.commit()

    user = AuthUser(
        user_id=row["user_id"],
        primary_email=row["primary_email"],
        display_name=row["display_name"],
        created_at=row["user_created_at"],
    )
    session = _serialize_session(row, row["session_id"])
    return token, user, session


def _load_current_device(request: Request, *, refresh: bool = True):
    token = _read_bearer_token(request)
    if not token:
        return None

    token_hash = _hash_secret(token)
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    d.device_id,
                    d.user_id,
                    d.device_name,
                    d.platform,
                    d.expires_at,
                    d.last_seen_at,
                    d.created_at,
                    u.primary_email,
                    u.display_name,
                    u.created_at AS user_created_at
                FROM devices d
                JOIN users u ON u.user_id = d.user_id
                WHERE d.token_hash = %s
                  AND d.revoked_at IS NULL
                  AND d.expires_at > NOW()
                  AND u.deleted_at IS NULL
                """,
                (token_hash,),
            )
            row = cursor.fetchone()
            if not row:
                return None
            row = dict(row)

            if refresh:
                expires_at = _device_expires_at()
                cursor.execute(
                    """
                    UPDATE devices
                    SET last_seen_at = NOW(), expires_at = %s
                    WHERE device_id = %s
                    RETURNING last_seen_at, expires_at
                    """,
                    (expires_at, row["device_id"]),
                )
                updated = cursor.fetchone()
                if updated:
                    row["last_seen_at"] = updated["last_seen_at"]
                    row["expires_at"] = updated["expires_at"]
        connection.commit()

    user = AuthUser(
        user_id=row["user_id"],
        primary_email=row["primary_email"],
        display_name=row["display_name"],
        created_at=row["user_created_at"],
    )
    device = _serialize_device(row, row["device_id"])
    return token, user, device


@router.post("/login/start", response_model=AuthStartResponse)
def start_login(payload: AuthStartRequest, request: Request) -> AuthStartResponse:
    _guard_code_rate_limit(request, payload.email)
    code = _issue_code()
    settings = get_settings()
    expires_at = _now() + timedelta(minutes=max(1, settings.auth_code_ttl_minutes))

    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO email_verifications (
                    email, code_hash, expires_at, request_ip, user_agent
                )
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    payload.email,
                    _hash_secret(code),
                    expires_at,
                    _client_host(request),
                    request.headers.get("user-agent"),
                ),
            )
        connection.commit()

    try:
        _send_login_code(payload.email, code)
    except OSError:
        route_logger.exception(
            "auth login code delivery failed",
            extra=with_request_context({"event": "auth_code_delivery_failed"}),
        )
        raise HTTPException(status_code=503, detail="Login code delivery failed. Retry later.")

    return AuthStartResponse(status="ok", message="If that email can receive login codes, one has been sent.")


@router.post("/login/verify", response_model=AuthVerifyResponse)
def verify_login(payload: AuthVerifyRequest, request: Request, response: Response) -> AuthVerifyResponse:
    if not payload.code:
        raise HTTPException(status_code=400, detail="Enter the login code.")

    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT verification_id, code_hash, attempts
                FROM email_verifications
                WHERE email = %s
                  AND purpose = 'login'
                  AND consumed_at IS NULL
                  AND expires_at > NOW()
                ORDER BY created_at DESC
                LIMIT 1
                FOR UPDATE
                """,
                (payload.email,),
            )
            verification = cursor.fetchone()
            if not verification:
                raise HTTPException(status_code=400, detail="The login code is invalid or expired.")

            if verification["attempts"] >= MAX_CODE_ATTEMPTS:
                raise HTTPException(status_code=429, detail="Too many attempts for this login code. Request a new code.")

            if not _verify_secret(payload.code, verification["code_hash"]):
                cursor.execute(
                    "UPDATE email_verifications SET attempts = attempts + 1 WHERE verification_id = %s",
                    (verification["verification_id"],),
                )
                connection.commit()
                raise HTTPException(status_code=400, detail="The login code is invalid or expired.")

            cursor.execute(
                """
                INSERT INTO users (primary_email)
                VALUES (%s)
                ON CONFLICT (primary_email)
                DO UPDATE SET updated_at = NOW()
                RETURNING user_id, primary_email, display_name, created_at
                """,
                (payload.email,),
            )
            user_row = cursor.fetchone()

            session_token = _issue_session_token()
            session_expires_at = _session_expires_at(payload.remember)
            cursor.execute(
                """
                INSERT INTO sessions (
                    user_id, session_hash, remember, expires_at, user_agent, ip_address
                )
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING session_id, created_at, expires_at, last_seen_at, user_agent, ip_address, remember
                """,
                (
                    user_row["user_id"],
                    _hash_secret(session_token),
                    payload.remember,
                    session_expires_at,
                    request.headers.get("user-agent"),
                    _client_host(request),
                ),
            )
            session_row = cursor.fetchone()
            cursor.execute(
                "UPDATE email_verifications SET consumed_at = NOW() WHERE verification_id = %s",
                (verification["verification_id"],),
            )
        connection.commit()

    _set_session_cookie(response, session_token, payload.remember)
    user = _serialize_user(user_row)
    session = _serialize_session(session_row, session_row["session_id"])
    return AuthVerifyResponse(status="ok", user=user, session=session)


@router.get("/me", response_model=AuthMeResponse)
def me(request: Request, response: Response) -> AuthMeResponse:
    current = _load_current_session(request)
    if not current:
        _clear_session_cookie(response)
        return AuthMeResponse(authenticated=False)

    token, user, session = current
    _set_session_cookie(response, token, session.remember)
    return AuthMeResponse(authenticated=True, user=user, session=session)


@router.post("/logout")
def logout(request: Request, response: Response) -> dict[str, str]:
    token = _read_session_token(request)
    if token:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE sessions SET revoked_at = NOW() WHERE session_hash = %s",
                    (_hash_secret(token),),
                )
            connection.commit()
    _clear_session_cookie(response)
    return {"status": "ok"}


@router.get("/sessions", response_model=AuthSessionsResponse)
def list_sessions(request: Request) -> AuthSessionsResponse:
    current = _load_current_session(request)
    if not current:
        raise HTTPException(status_code=401, detail="Sign in to view sessions.")

    _, user, current_session = current
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT session_id, created_at, expires_at, last_seen_at, user_agent, ip_address, remember
                FROM sessions
                WHERE user_id = %s
                  AND revoked_at IS NULL
                  AND expires_at > NOW()
                ORDER BY last_seen_at DESC
                """,
                (user.user_id,),
            )
            rows = cursor.fetchall()

    return AuthSessionsResponse(
        sessions=[_serialize_session(row, current_session.session_id) for row in rows]
    )


@router.delete("/sessions/{session_id}")
def revoke_session(session_id: UUID, request: Request, response: Response) -> dict[str, str]:
    current = _load_current_session(request)
    if not current:
        raise HTTPException(status_code=401, detail="Sign in to manage sessions.")

    _, user, current_session = current
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE sessions
                SET revoked_at = NOW()
                WHERE session_id = %s
                  AND user_id = %s
                  AND revoked_at IS NULL
                """,
                (session_id, user.user_id),
            )
        connection.commit()

    if session_id == current_session.session_id:
        _clear_session_cookie(response)
    return {"status": "ok"}


@router.post("/devices/pairing/start", response_model=DevicePairStartResponse)
def start_device_pairing(payload: DevicePairStartRequest, request: Request) -> DevicePairStartResponse:
    device_code = _issue_device_code()
    user_code = _issue_user_code()
    expires_at = _pairing_expires_at()
    settings = get_settings()

    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO device_pairing_codes (
                    device_code_hash,
                    user_code_hash,
                    device_name,
                    platform,
                    expires_at,
                    request_ip,
                    user_agent
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    _hash_secret(device_code),
                    _hash_secret(_normalize_user_code(user_code)),
                    payload.device_name,
                    payload.platform,
                    expires_at,
                    _client_host(request),
                    request.headers.get("user-agent"),
                ),
            )
        connection.commit()

    return DevicePairStartResponse(
        status="ok",
        user_code=user_code,
        device_code=device_code,
        verification_uri=f"/account?pair={user_code}",
        expires_at=expires_at,
        interval_seconds=max(1, settings.auth_device_pairing_poll_interval_seconds),
    )


@router.post("/devices/pairing/approve", response_model=DevicePairApproveResponse)
def approve_device_pairing(payload: DevicePairApproveRequest, request: Request) -> DevicePairApproveResponse:
    current = _load_current_session(request)
    if not current:
        raise HTTPException(status_code=401, detail="Sign in to approve Workbench pairing.")

    _, user, _ = current
    user_code_hash = _hash_secret(_normalize_user_code(payload.user_code))

    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT pairing_id, device_name, platform, approved_user_id, consumed_at
                FROM device_pairing_codes
                WHERE user_code_hash = %s
                  AND expires_at > NOW()
                ORDER BY created_at DESC
                LIMIT 1
                FOR UPDATE
                """,
                (user_code_hash,),
            )
            pairing = cursor.fetchone()
            if not pairing:
                raise HTTPException(status_code=400, detail="Pairing code is invalid or expired.")
            if pairing["consumed_at"] is not None:
                raise HTTPException(status_code=400, detail="Pairing code has already been used.")

            if pairing["approved_user_id"] is None:
                cursor.execute(
                    """
                    UPDATE device_pairing_codes
                    SET approved_user_id = %s, approved_at = NOW()
                    WHERE pairing_id = %s
                    """,
                    (user.user_id, pairing["pairing_id"]),
                )
        connection.commit()

    return DevicePairApproveResponse(
        status="approved",
        device_name=pairing["device_name"],
        platform=pairing["platform"],
    )


@router.post("/devices/pairing/poll", response_model=DevicePairPollResponse)
def poll_device_pairing(payload: DevicePairPollRequest) -> DevicePairPollResponse:
    device_code_hash = _hash_secret(payload.device_code)

    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    p.pairing_id,
                    p.device_name,
                    p.platform,
                    p.expires_at,
                    p.approved_user_id,
                    p.consumed_at,
                    u.primary_email,
                    u.display_name,
                    u.created_at AS user_created_at
                FROM device_pairing_codes p
                LEFT JOIN users u ON u.user_id = p.approved_user_id
                WHERE p.device_code_hash = %s
                FOR UPDATE OF p
                """,
                (device_code_hash,),
            )
            pairing = cursor.fetchone()
            if not pairing:
                return DevicePairPollResponse(status="expired")

            if pairing["expires_at"] <= _now() or pairing["consumed_at"] is not None:
                return DevicePairPollResponse(status="expired", expires_at=pairing["expires_at"])

            if pairing["approved_user_id"] is None:
                return DevicePairPollResponse(status="pending", expires_at=pairing["expires_at"])

            device_token = _issue_session_token()
            expires_at = _device_expires_at()
            cursor.execute(
                """
                INSERT INTO devices (
                    user_id,
                    device_name,
                    platform,
                    token_hash,
                    expires_at,
                    last_seen_at
                )
                VALUES (%s, %s, %s, %s, %s, NOW())
                RETURNING device_id, device_name, platform, created_at, expires_at, last_seen_at
                """,
                (
                    pairing["approved_user_id"],
                    pairing["device_name"],
                    pairing["platform"],
                    _hash_secret(device_token),
                    expires_at,
                ),
            )
            device_row = cursor.fetchone()
            cursor.execute(
                "UPDATE device_pairing_codes SET consumed_at = NOW() WHERE pairing_id = %s",
                (pairing["pairing_id"],),
            )
        connection.commit()

    user = AuthUser(
        user_id=pairing["approved_user_id"],
        primary_email=pairing["primary_email"],
        display_name=pairing["display_name"],
        created_at=pairing["user_created_at"],
    )
    device = _serialize_device(device_row, device_row["device_id"])
    return DevicePairPollResponse(
        status="approved",
        device_token=device_token,
        user=user,
        device=device,
        expires_at=device.expires_at,
    )


@router.get("/devices", response_model=AuthDevicesResponse)
def list_devices(request: Request) -> AuthDevicesResponse:
    current = _load_current_session(request)
    if not current:
        raise HTTPException(status_code=401, detail="Sign in to view paired devices.")

    _, user, _ = current
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT device_id, device_name, platform, created_at, expires_at, last_seen_at
                FROM devices
                WHERE user_id = %s
                  AND revoked_at IS NULL
                  AND expires_at > NOW()
                ORDER BY COALESCE(last_seen_at, created_at) DESC
                """,
                (user.user_id,),
            )
            rows = cursor.fetchall()

    return AuthDevicesResponse(devices=[_serialize_device(row) for row in rows])


@router.get("/devices/me", response_model=DeviceMeResponse)
def device_me(request: Request) -> DeviceMeResponse:
    current = _load_current_device(request)
    if not current:
        return DeviceMeResponse(authenticated=False)

    _, user, device = current
    return DeviceMeResponse(authenticated=True, user=user, device=device)


@router.delete("/devices/me")
def revoke_current_device(request: Request) -> dict[str, str]:
    current = _load_current_device(request, refresh=False)
    if not current:
        return {"status": "ok"}

    _, _, device = current
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE devices SET revoked_at = NOW() WHERE device_id = %s",
                (device.device_id,),
            )
        connection.commit()

    return {"status": "ok"}


@router.delete("/devices/{device_id}")
def revoke_device(device_id: UUID, request: Request) -> dict[str, str]:
    current = _load_current_session(request)
    if not current:
        raise HTTPException(status_code=401, detail="Sign in to manage paired devices.")

    _, user, _ = current
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE devices
                SET revoked_at = NOW()
                WHERE device_id = %s
                  AND user_id = %s
                  AND revoked_at IS NULL
                """,
                (device_id, user.user_id),
            )
        connection.commit()

    return {"status": "ok"}


@router.get("/account/export")
def export_account(request: Request) -> dict:
    current = _load_current_session(request)
    if not current:
        raise HTTPException(status_code=401, detail="Sign in to export account data.")

    _, user, current_session = current
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT session_id, created_at, expires_at, last_seen_at, user_agent, ip_address, remember
                FROM sessions
                WHERE user_id = %s
                ORDER BY created_at DESC
                """,
                (user.user_id,),
            )
            sessions = [dict(row) for row in cursor.fetchall()]

            cursor.execute(
                """
                SELECT device_id, device_name, platform, expires_at, last_seen_at, revoked_at, created_at
                FROM devices
                WHERE user_id = %s
                ORDER BY created_at DESC
                """,
                (user.user_id,),
            )
            devices = [dict(row) for row in cursor.fetchall()]

            cursor.execute(
                """
                SELECT saved_item_id, item_type, name, payload_json, created_at, updated_at
                FROM saved_items
                WHERE user_id = %s
                ORDER BY updated_at DESC
                """,
                (user.user_id,),
            )
            saved_items = [dict(row) for row in cursor.fetchall()]

            cursor.execute(
                """
                SELECT workbench_session_id, name, payload_json, created_at, updated_at
                FROM workbench_sessions
                WHERE user_id = %s
                ORDER BY updated_at DESC
                """,
                (user.user_id,),
            )
            workbench_sessions = [dict(row) for row in cursor.fetchall()]

    return {
        "exported_at": _now(),
        "user": user.model_dump(),
        "current_session_id": current_session.session_id,
        "sessions": sessions,
        "devices": devices,
        "saved_items": saved_items,
        "workbench_sessions": workbench_sessions,
    }


@router.delete("/account")
def delete_account(request: Request, response: Response) -> dict[str, str]:
    current = _load_current_session(request, refresh=False)
    if not current:
        raise HTTPException(status_code=401, detail="Sign in to delete account.")

    _, user, _ = current
    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM email_verifications WHERE email = %s", (user.primary_email,))
            cursor.execute("DELETE FROM users WHERE user_id = %s", (user.user_id,))
        connection.commit()

    _clear_session_cookie(response)
    return {"status": "ok"}
