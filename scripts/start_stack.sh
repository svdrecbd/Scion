#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_DIR="$RUN_DIR/pids"
LOG_DIR="$RUN_DIR/logs"

mkdir -p "$PID_DIR" "$LOG_DIR"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

API_HOST="${SCION_API_HOST:-127.0.0.1}"
API_PORT="${SCION_API_PORT:-8000}"
API_PREFIX="${SCION_API_PREFIX:-/api}"
WEB_HOST="${SCION_WEB_HOST:-127.0.0.1}"
WEB_PORT="${SCION_WEB_PORT:-3000}"
API_BASE_URL="${SCION_API_BASE_URL:-http://127.0.0.1:${API_PORT}${API_PREFIX}}"

API_PID_FILE="$PID_DIR/api.pid"
WEB_PID_FILE="$PID_DIR/web.pid"
API_LOG_FILE="$LOG_DIR/api.log"
WEB_LOG_FILE="$LOG_DIR/web.log"

: >"$API_LOG_FILE"
: >"$WEB_LOG_FILE"

require_command() {
  local name="$1"
  local message="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$message" >&2
    exit 1
  fi
}

require_file() {
  local path="$1"
  local message="$2"
  if [[ ! -e "$path" ]]; then
    echo "$message" >&2
    exit 1
  fi
}

is_running() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "$pid_file")"
  kill -0 "$pid" 2>/dev/null
}

remove_stale_pid() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]] && ! is_running "$pid_file"; then
    rm -f "$pid_file"
  fi
}

show_recent_logs() {
  local label="$1"
  local log_file="$2"
  if [[ -f "$log_file" ]]; then
    echo "Recent $label log output:" >&2
    tail -n 40 "$log_file" >&2 || true
  fi
}

stop_pid_if_running() {
  local pid_file="$1"
  if is_running "$pid_file"; then
    kill "$(cat "$pid_file")" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local pid_file="$3"
  local log_file="$4"
  for _ in {1..60}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -f "$pid_file" ]] && ! is_running "$pid_file"; then
      show_recent_logs "$label" "$log_file"
      echo "$label exited before it became ready." >&2
      exit 1
    fi
    sleep 0.5
  done

  show_recent_logs "$label" "$log_file"
  stop_pid_if_running "$pid_file"
  echo "Timed out waiting for $label at $url" >&2
  exit 1
}

start_detached() {
  local pid_file="$1"
  local log_file="$2"
  local cwd="$3"
  shift 3

  python3 - "$pid_file" "$log_file" "$cwd" "$@" <<'PY'
import os
import subprocess
import sys

pid_file, log_file, cwd, *command = sys.argv[1:]
env = os.environ.copy()

with open(log_file, "ab", buffering=0) as log_file_handle, open(os.devnull, "rb") as devnull:
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=devnull,
        stdout=log_file_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

with open(pid_file, "w", encoding="utf-8") as pid_handle:
    pid_handle.write(str(process.pid))
PY
}

require_file "$ROOT_DIR/apps/api/.venv/bin/python" "API virtualenv missing. Run make bootstrap."
require_file "$ROOT_DIR/apps/web/node_modules" "Web dependencies missing. Run make bootstrap."
require_command "curl" "curl is required to verify service startup."
require_command "pg_isready" "pg_isready is required to verify Postgres availability."
require_command "python3" "python3 is required to launch the stack."

if ! pg_isready -d "${SCION_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/scion}" >/dev/null 2>&1; then
  echo "Postgres is not accepting connections." >&2
  exit 1
fi

"$ROOT_DIR/apps/api/.venv/bin/python" "$ROOT_DIR/scripts/db_migrate.py" >/dev/null
(
cd "$ROOT_DIR/apps/api"
.venv/bin/python - <<'PY'
from app.readiness import readiness_snapshot

snapshot = readiness_snapshot()
print(snapshot)
PY
)

if [[ ! -f "$ROOT_DIR/apps/web/.next/BUILD_ID" ]]; then
  echo "==> Web build missing; running build"
  (cd "$ROOT_DIR/apps/web" && npm run build)
fi

remove_stale_pid "$API_PID_FILE"
remove_stale_pid "$WEB_PID_FILE"

if is_running "$API_PID_FILE" || is_running "$WEB_PID_FILE"; then
  echo "Stack appears to already be running. Use scripts/status_stack.sh or scripts/stop_stack.sh." >&2
  exit 1
fi

echo "==> Starting API"
start_detached \
  "$API_PID_FILE" \
  "$API_LOG_FILE" \
  "$ROOT_DIR/apps/api" \
  env \
  SCION_SKIP_STARTUP_CHECKS=false \
  .venv/bin/python \
  -m \
  uvicorn \
  app.main:app \
  --host \
  "$API_HOST" \
  --port \
  "$API_PORT"
wait_for_http "http://127.0.0.1:${API_PORT}${API_PREFIX}/health/ready" "API readiness" "$API_PID_FILE" "$API_LOG_FILE"

echo "==> Starting web"
start_detached \
  "$WEB_PID_FILE" \
  "$WEB_LOG_FILE" \
  "$ROOT_DIR/apps/web" \
  env \
  SCION_API_BASE_URL="$API_BASE_URL" \
  NEXT_PUBLIC_SCION_API_BASE_URL="$API_BASE_URL" \
  npm \
  run \
  start \
  -- \
  --hostname \
  "$WEB_HOST" \
  --port \
  "$WEB_PORT"
wait_for_http "http://127.0.0.1:${WEB_PORT}/guide" "web server" "$WEB_PID_FILE" "$WEB_LOG_FILE"

echo "Stack started."
echo "API: http://127.0.0.1:${API_PORT}${API_PREFIX}/health/ready"
echo "Web: http://127.0.0.1:${WEB_PORT}"
echo "Logs: $LOG_DIR"
