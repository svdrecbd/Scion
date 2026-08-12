#!/usr/bin/env bash
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"
MANIFEST_PATH="$REPO_DIR/workers/volume-engine/Cargo.toml"
TARGET_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"

if [[ -z "$TARGET_TRIPLE" ]]; then
  echo "Could not determine the Rust host target triple." >&2
  exit 1
fi

cargo build --release --manifest-path "$MANIFEST_PATH"

SOURCE_BINARY="$REPO_DIR/workers/volume-engine/target/release/volume-engine"
TARGET_BINARY="$DESKTOP_DIR/src-tauri/binaries/volume-engine-$TARGET_TRIPLE"
if [[ "$TARGET_TRIPLE" == *windows* ]]; then
  SOURCE_BINARY="${SOURCE_BINARY}.exe"
  TARGET_BINARY="${TARGET_BINARY}.exe"
fi

if [[ ! -f "$SOURCE_BINARY" ]]; then
  echo "Built volume engine was not found at $SOURCE_BINARY." >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET_BINARY")"
install -m 755 "$SOURCE_BINARY" "$TARGET_BINARY"
echo "Prepared Tauri sidecar: $TARGET_BINARY"
