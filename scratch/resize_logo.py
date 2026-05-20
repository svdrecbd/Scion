#!/usr/bin/env python3
"""Regenerate the desktop app icons from the repo's square PNG source.

This helper uses macOS `sips` plus the local Tauri CLI so it does not require
Pillow or other Python packages.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESKTOP_DIR = ROOT / "apps" / "desktop"
DEFAULT_ICON = DESKTOP_DIR / "app-icon.png"
UNUSED_GENERATED_ICON_PATHS = (
    DESKTOP_DIR / "src-tauri" / "icons" / "android",
    DESKTOP_DIR / "src-tauri" / "icons" / "ios",
    DESKTOP_DIR / "src-tauri" / "icons" / "64x64.png",
)


def run(command: list[str], *, cwd: Path | None = None) -> None:
    print("+", " ".join(command))
    subprocess.run(command, cwd=cwd, check=True)


def read_dimension(path: Path, key: str) -> int:
    output = subprocess.check_output(["sips", "-g", key, str(path)], text=True)
    for line in output.splitlines():
        line = line.strip()
        if line.startswith(f"{key}:"):
            return int(line.split(":", 1)[1].strip())
    raise RuntimeError(f"Could not read {key} from {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path, default=DEFAULT_ICON)
    parser.add_argument("--pad-color", default="FBF8EF")
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    if not source.exists():
        print(f"Icon source not found: {source}", file=sys.stderr)
        return 1

    width = read_dimension(source, "pixelWidth")
    height = read_dimension(source, "pixelHeight")

    with tempfile.TemporaryDirectory() as tmpdir:
        square = Path(tmpdir) / "app-icon-square.png"
        working = source
        if width != height:
            side = max(width, height)
            run([
                "sips",
                "-p",
                str(side),
                str(side),
                "--padColor",
                args.pad_color,
                str(source),
                "--out",
                str(square),
            ])
            working = square

        run(["sips", "-z", "1024", "1024", str(working), "--out", str(DEFAULT_ICON)])

    run(["npm", "exec", "tauri", "icon", "--", "app-icon.png"], cwd=DESKTOP_DIR)
    for path in UNUSED_GENERATED_ICON_PATHS:
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    print(f"Regenerated icons from {DEFAULT_ICON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
