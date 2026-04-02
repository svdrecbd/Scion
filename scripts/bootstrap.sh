#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Bootstrapping API"
cd "$ROOT_DIR/apps/api"
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
deactivate

echo "==> Bootstrapping Web"
cd "$ROOT_DIR/apps/web"
npm ci

echo "Bootstrap complete."
echo "API virtualenv: apps/api/.venv"
echo "Run 'make api' and 'make web' from repo root."
