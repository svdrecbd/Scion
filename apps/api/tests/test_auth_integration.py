from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app.config import get_settings


def _read_latest_code(outbox_text: str, email: str) -> str:
    matches = re.findall(rf"email={re.escape(email)} code=(\d{{6}})", outbox_text)
    assert matches
    return matches[-1]


def test_passwordless_email_auth_flow(
    integration_client: TestClient,
    monkeypatch,
    tmp_path,
) -> None:
    email = "researcher@example.org"
    outbox = tmp_path / "auth-codes.log"
    monkeypatch.setenv("SCION_AUTH_DEV_OUTBOX_PATH", str(outbox))
    monkeypatch.setenv("SCION_AUTH_COOKIE_SECURE", "false")
    get_settings.cache_clear()

    start_response = integration_client.post(
        "/api/auth/login/start",
        json={"email": email},
    )
    assert start_response.status_code == 200
    assert start_response.json()["status"] == "ok"
    assert outbox.exists()

    code = _read_latest_code(outbox.read_text(encoding="utf-8"), email)
    verify_response = integration_client.post(
        "/api/auth/login/verify",
        json={"email": email, "code": code, "remember": True},
    )
    assert verify_response.status_code == 200
    verify_payload = verify_response.json()
    assert verify_payload["user"]["primary_email"] == email
    assert verify_payload["session"]["remember"] is True
    assert "cell_anatomy_session=" in verify_response.headers["set-cookie"]

    me_response = integration_client.get("/api/auth/me")
    assert me_response.status_code == 200
    me_payload = me_response.json()
    assert me_payload["authenticated"] is True
    assert me_payload["user"]["primary_email"] == email

    sessions_response = integration_client.get("/api/auth/sessions")
    assert sessions_response.status_code == 200
    sessions = sessions_response.json()["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["current"] is True

    export_response = integration_client.get("/api/auth/account/export")
    assert export_response.status_code == 200
    export_payload = export_response.json()
    assert export_payload["user"]["primary_email"] == email
    assert export_payload["sessions"]

    revoke_response = integration_client.delete(f"/api/auth/sessions/{sessions[0]['session_id']}")
    assert revoke_response.status_code == 200

    signed_out_response = integration_client.get("/api/auth/me")
    assert signed_out_response.status_code == 200
    assert signed_out_response.json()["authenticated"] is False


def test_account_delete_clears_session(
    integration_client: TestClient,
    monkeypatch,
    tmp_path,
) -> None:
    email = "delete-me@example.org"
    outbox = tmp_path / "auth-codes.log"
    monkeypatch.setenv("SCION_AUTH_DEV_OUTBOX_PATH", str(outbox))
    monkeypatch.setenv("SCION_AUTH_COOKIE_SECURE", "false")
    get_settings.cache_clear()

    assert integration_client.post("/api/auth/login/start", json={"email": email}).status_code == 200
    code = _read_latest_code(outbox.read_text(encoding="utf-8"), email)
    assert integration_client.post(
        "/api/auth/login/verify",
        json={"email": email, "code": code},
    ).status_code == 200

    delete_response = integration_client.delete("/api/auth/account")
    assert delete_response.status_code == 200
    assert delete_response.json() == {"status": "ok"}

    me_response = integration_client.get("/api/auth/me")
    assert me_response.status_code == 200
    assert me_response.json()["authenticated"] is False


def test_workbench_device_pairing_flow(
    integration_client: TestClient,
    monkeypatch,
    tmp_path,
) -> None:
    email = "pairing@example.org"
    outbox = tmp_path / "auth-codes.log"
    monkeypatch.setenv("SCION_AUTH_DEV_OUTBOX_PATH", str(outbox))
    monkeypatch.setenv("SCION_AUTH_COOKIE_SECURE", "false")
    get_settings.cache_clear()

    start_pair_response = integration_client.post(
        "/api/auth/devices/pairing/start",
        json={"device_name": "Cell Anatomy Workbench", "platform": "macOS"},
    )
    assert start_pair_response.status_code == 200
    pair_payload = start_pair_response.json()
    assert pair_payload["user_code"]
    assert pair_payload["device_code"]
    assert pair_payload["verification_uri"].startswith("/account?pair=")

    pending_response = integration_client.post(
        "/api/auth/devices/pairing/poll",
        json={"device_code": pair_payload["device_code"]},
    )
    assert pending_response.status_code == 200
    assert pending_response.json()["status"] == "pending"

    unauthorized_approve = integration_client.post(
        "/api/auth/devices/pairing/approve",
        json={"user_code": pair_payload["user_code"]},
    )
    assert unauthorized_approve.status_code == 401

    assert integration_client.post("/api/auth/login/start", json={"email": email}).status_code == 200
    code = _read_latest_code(outbox.read_text(encoding="utf-8"), email)
    assert integration_client.post(
        "/api/auth/login/verify",
        json={"email": email, "code": code},
    ).status_code == 200

    approve_response = integration_client.post(
        "/api/auth/devices/pairing/approve",
        json={"user_code": pair_payload["user_code"]},
    )
    assert approve_response.status_code == 200
    assert approve_response.json()["status"] == "approved"

    approved_poll_response = integration_client.post(
        "/api/auth/devices/pairing/poll",
        json={"device_code": pair_payload["device_code"]},
    )
    assert approved_poll_response.status_code == 200
    approved_payload = approved_poll_response.json()
    assert approved_payload["status"] == "approved"
    assert approved_payload["device_token"]
    assert approved_payload["user"]["primary_email"] == email
    assert approved_payload["device"]["device_name"] == "Cell Anatomy Workbench"

    device_me_response = integration_client.get(
        "/api/auth/devices/me",
        headers={"Authorization": f"Bearer {approved_payload['device_token']}"},
    )
    assert device_me_response.status_code == 200
    assert device_me_response.json()["authenticated"] is True

    devices_response = integration_client.get("/api/auth/devices")
    assert devices_response.status_code == 200
    assert devices_response.json()["devices"]

    revoke_current_device_response = integration_client.delete(
        "/api/auth/devices/me",
        headers={"Authorization": f"Bearer {approved_payload['device_token']}"},
    )
    assert revoke_current_device_response.status_code == 200

    revoked_device_me_response = integration_client.get(
        "/api/auth/devices/me",
        headers={"Authorization": f"Bearer {approved_payload['device_token']}"},
    )
    assert revoked_device_me_response.status_code == 200
    assert revoked_device_me_response.json()["authenticated"] is False
