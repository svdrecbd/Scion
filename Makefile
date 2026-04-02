SHELL := /bin/bash

.PHONY: bootstrap infra-up infra-down db-migrate db-seed api web web-install web-typecheck web-build test-api check

bootstrap:
	bash scripts/bootstrap.sh

infra-up:
	docker compose up -d postgres

infra-down:
	docker compose down

db-migrate:
	cd apps/api && .venv/bin/python ../../scripts/db_migrate.py

db-seed:
	cd apps/api && .venv/bin/python ../../scripts/db_seed.py

api:
	cd apps/api && .venv/bin/python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

web:
	cd apps/web && npm run dev

web-install:
	cd apps/web && npm ci

web-typecheck:
	cd apps/web && npm run typecheck

web-build:
	cd apps/web && npm run build

test-api:
	cd apps/api && .venv/bin/python -m pytest -q

check: test-api web-typecheck web-build
