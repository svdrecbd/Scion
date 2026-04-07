SHELL := /bin/bash
API_PYTHON ?= $(shell if [ -x apps/api/.venv/bin/python ]; then printf '%s' .venv/bin/python; elif command -v python3 >/dev/null 2>&1; then printf '%s' python3; else printf '%s' python; fi)

.PHONY: bootstrap db-migrate db-seed api api-dev web web-dev web-install web-typecheck web-build smoke-web stack-up stack-down stack-status test-api check

bootstrap:
	bash scripts/bootstrap.sh

db-migrate:
	cd apps/api && $(API_PYTHON) ../../scripts/db_migrate.py

db-seed:
	cd apps/api && $(API_PYTHON) ../../scripts/db_seed.py

api:
	cd apps/api && $(API_PYTHON) -m uvicorn app.main:app --host 0.0.0.0 --port 8000

api-dev:
	cd apps/api && $(API_PYTHON) -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

web:
	cd apps/web && npm run start -- --hostname 0.0.0.0 --port 3000

web-dev:
	cd apps/web && npm run dev

web-install:
	cd apps/web && npm ci

web-typecheck:
	cd apps/web && rm -f tsconfig.tsbuildinfo && npm run typecheck

web-build:
	cd apps/web && npm run build

smoke-web:
	cd apps/api && $(API_PYTHON) ../../scripts/smoke_stack.py

stack-up:
	bash scripts/start_stack.sh

stack-down:
	bash scripts/stop_stack.sh

stack-status:
	bash scripts/status_stack.sh

test-api:
	cd apps/api && $(API_PYTHON) -m pytest -q

check: test-api web-typecheck web-build smoke-web
