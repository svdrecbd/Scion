# Scion API

FastAPI backend for the Scion MVP.

## Responsibilities

- dataset lookup
- facet summaries
- commonality summaries
- compare mode
- email-code account sessions
- Workbench device pairing
- future curation and ingestion APIs

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
.venv/bin/python -m uvicorn app.main:app --reload
```

## Account auth

Local login codes are written to `.run/auth-codes.log` unless `SCION_AUTH_SMTP_HOST` is configured. The session cookie is HTTP-only, same-site lax, and becomes secure automatically when `SCION_ENV=production`.

Required setup for account testing:

```bash
make db-migrate
```

Useful local env knobs:

```bash
SCION_AUTH_DEV_OUTBOX_PATH=.run/auth-codes.log
SCION_AUTH_COOKIE_SECURE=false
SCION_CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173,tauri://localhost,http://tauri.localhost
```
