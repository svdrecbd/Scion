#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.run/pids"
LOG_DIR="$ROOT_DIR/.run/logs"

show_status() {
  local name="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    echo "$name: stopped"
    return
  fi

  local pid
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "$name: running (pid $pid)"
  else
    echo "$name: stale pid file (pid $pid)"
  fi
}

show_status "api" "$PID_DIR/api.pid"
show_status "web" "$PID_DIR/web.pid"
echo "logs: $LOG_DIR"
