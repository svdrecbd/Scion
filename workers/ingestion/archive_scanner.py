from __future__ import annotations

import argparse
import csv
import fcntl
import hashlib
import json
import os
import sqlite3
import stat
import struct
import sys
import time
import uuid
from collections.abc import Iterable, Iterator
from collections import Counter
from contextlib import ExitStack
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCANNER_VERSION = "archive-scanner-v0.4"
SCHEMA_VERSION = 1
CHECKSUM_CHUNK_BYTES = 1024 * 1024 * 8
DEFAULT_LARGEST_FILE_LIMIT = 200
DEFAULT_PROGRESS_INTERVAL_FILES = 5000
DEFAULT_PROGRESS_INTERVAL_SECONDS = 60.0
SCAN_STATE_FILENAME = "scan-state.sqlite"

SCAN_ERROR_FIELDS = ["relative_path", "operation", "error"]
VOLUME_CANDIDATE_FIELDS = [
    "relative_path",
    "source_metadata_path",
    "format",
    "status",
    "dtype",
    "x",
    "y",
    "z",
    "size_bytes",
    "metadata_source",
    "warning",
]
METADATA_GAP_FIELDS = [
    "relative_path",
    "asset_relative_path",
    "format",
    "metadata_status",
    "likely_role",
    "extension",
    "gap_code",
    "severity",
    "summary",
    "suggested_action",
]
COPY_ISSUE_FIELDS = [
    "issue_type",
    "relative_path",
    "source_path_type",
    "target_path_type",
    "source_size_bytes",
    "target_size_bytes",
    "source_algorithm",
    "target_algorithm",
    "source_digest",
    "target_digest",
    "detail",
]

VOLUME_EXTENSIONS = {
    ".am",
    ".h5",
    ".hdf",
    ".hdf5",
    ".ims",
    ".lif",
    ".mrc",
    ".nd2",
    ".oib",
    ".oir",
    ".tif",
    ".tiff",
    ".zarr",
}
PREVIEW_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
TABLE_EXTENSIONS = {".csv", ".tsv", ".xls", ".xlsx"}
DOCUMENT_EXTENSIONS = {".doc", ".docx", ".md", ".pdf", ".ppt", ".pptx", ".txt"}
CODE_EXTENSIONS = {".ipynb", ".m", ".py", ".r", ".sh"}
SIDECAR_EXTENSIONS = {".json", ".xml", ".yaml", ".yml"}
DERIVATIVE_PATH_HINTS = {
    "analysis",
    "cache",
    "derived",
    "export",
    "figure",
    "figures",
    "mask",
    "masks",
    "preview",
    "processed",
    "segmentation",
}


@dataclass
class ScanState:
    root: Path
    output_dir: Path
    archive_id: str
    checksum_algorithm: str | None
    run_id: str = field(default_factory=lambda: f"scan_{uuid.uuid4().hex}")
    started_at: str = field(default_factory=lambda: utc_now())
    file_count: int = 0
    directory_count: int = 0
    symlink_count: int = 0
    unreadable_count: int = 0
    bytes_total: int = 0
    bytes_hashed: int = 0
    bytes_reused: int = 0
    files_hashed: int = 0
    files_reused: int = 0
    extension_counts: Counter[str] = field(default_factory=Counter)
    extension_bytes: Counter[str] = field(default_factory=Counter)
    path_type_counts: Counter[str] = field(default_factory=Counter)
    likely_role_counts: Counter[str] = field(default_factory=Counter)
    modified_min: float | None = None
    modified_max: float | None = None
    largest_files: list[dict[str, Any]] = field(default_factory=list)
    checksum_duplicate_count: int = 0
    metadata_record_count: int = 0
    metadata_gap_count: int = 0
    volume_candidate_count: int = 0
    status_record_count: int = 0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def iso_from_timestamp(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def stable_archive_id(root: Path) -> str:
    text = str(root.resolve())
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    name = root.name.strip() or "archive"
    safe = "".join(ch.lower() if ch.isalnum() else "-" for ch in name).strip("-") or "archive"
    return f"{safe}-{digest}"


def relative_path(root: Path, path: Path) -> str:
    try:
        rel = path.relative_to(root)
    except ValueError:
        return path.name
    value = rel.as_posix()
    return value or "."


def extension_for(path: Path) -> str:
    name = path.name.lower()
    if name in {".zarray", ".zattrs", ".zgroup"}:
        return name
    if name.endswith(".ome.tif"):
        return ".ome.tif"
    if name.endswith(".ome.tiff"):
        return ".ome.tiff"
    if name.endswith(".nii.gz"):
        return ".nii.gz"
    if name.endswith(".xml.gz"):
        return ".xml.gz"
    return path.suffix.lower()


def path_contains_any(path: Path, values: set[str]) -> bool:
    parts = {part.lower() for part in path.parts}
    return bool(parts & values)


def likely_role(path: Path, is_symlink: bool) -> str:
    if is_symlink:
        return "symlink"
    ext = extension_for(path)
    if path_contains_any(path, DERIVATIVE_PATH_HINTS):
        return "derived_or_analysis_output"
    if ext in {".ome.tif", ".ome.tiff", ".tif", ".tiff", ".mrc", ".h5", ".hdf5", ".zarr"}:
        return "raw_volume_candidate"
    if ext in VOLUME_EXTENSIONS:
        return "imaging_candidate"
    if ext in PREVIEW_EXTENSIONS:
        return "preview_or_publication_figure"
    if ext in TABLE_EXTENSIONS:
        return "tabular_metadata_or_measurements"
    if ext in SIDECAR_EXTENSIONS:
        return "metadata_sidecar"
    if ext in DOCUMENT_EXTENSIONS:
        return "document_or_publication_context"
    if ext in CODE_EXTENSIONS:
        return "code_or_notebook"
    if not ext:
        return "no_extension"
    return "unknown"


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def write_json_atomic(path: Path, value: Any) -> None:
    temp_path = path.with_name(f"{path.name}.tmp")
    temp_path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temp_path.replace(path)


def staged_artifact_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.inprogress")


def publish_staged_artifacts(paths: Iterable[Path]) -> None:
    for path in paths:
        staged_artifact_path(path).replace(path)


def write_csv_atomic(path: Path, fieldnames: list[str], rows: Iterable[dict[str, Any]]) -> None:
    staged = staged_artifact_path(path)
    with staged.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    staged.replace(path)


class ExclusiveFileLock:
    def __init__(self, path: Path, operation: str) -> None:
        self.path = path
        self.handle = path.open("a+")
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            self.handle.close()
            raise RuntimeError(f"Another {operation} is already using {path.parent}.") from error
        self.handle.seek(0)
        self.handle.truncate()
        self.handle.write(json.dumps({"operation": operation, "pid": os.getpid(), "started_at": utc_now()}) + "\n")
        self.handle.flush()

    def close(self) -> None:
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()


def scan_preflight(
    root: Path,
    output_dir: Path,
    *,
    archive_id: str | None = None,
    checksum_algorithm: str | None = None,
    resume_checksums: bool = False,
) -> dict[str, Any]:
    root = root.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    resolved_archive_id = archive_id or stable_archive_id(root)
    blockers: list[str] = []
    warnings: list[str] = []

    if not root.exists():
        blockers.append(f"Archive root does not exist: {root}")
    elif not root.is_dir():
        blockers.append(f"Archive root is not a directory: {root}")
    elif not os.access(root, os.R_OK | os.X_OK):
        blockers.append(f"Archive root is not readable: {root}")

    try:
        output_dir.relative_to(root)
    except ValueError:
        pass
    else:
        blockers.append("Scanner output directory must be outside the archive root.")

    output_probe = output_dir
    while not output_probe.exists() and output_probe != output_probe.parent:
        output_probe = output_probe.parent
    if not output_probe.exists() or not output_probe.is_dir():
        blockers.append(f"No existing output parent is available for {output_dir}.")
        free_bytes = 0
        total_bytes = 0
        same_device = False
    else:
        if not os.access(output_probe, os.W_OK | os.X_OK):
            blockers.append(f"Output parent is not writable: {output_probe}")
        filesystem = os.statvfs(output_probe)
        free_bytes = int(filesystem.f_bavail * filesystem.f_frsize)
        total_bytes = int(filesystem.f_blocks * filesystem.f_frsize)
        same_device = bool(root.exists() and root.stat().st_dev == output_probe.stat().st_dev)
        if free_bytes < 1024**3:
            blockers.append("Output filesystem has less than 1 GiB free for manifests and scan state.")
        if same_device and checksum_algorithm:
            warnings.append(
                "Scan state and source data are on the same filesystem; checksum I/O may contend with manifest writes."
            )

    prior_summary: dict[str, Any] | None = None
    summary_path = output_dir / "inventory-summary.json"
    if summary_path.exists():
        try:
            prior_summary = read_json_file(summary_path)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            warnings.append(f"Existing inventory summary could not be read: {error}")

    checkpoint: dict[str, Any] | None = None
    checkpoint_path = output_dir / "scan-checkpoint.json"
    if checkpoint_path.exists():
        try:
            checkpoint = read_json_file(checkpoint_path)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            warnings.append(f"Existing scan checkpoint could not be read: {error}")

    state_identity: dict[str, str] | None = None
    state_checksum_records = 0
    state_path = output_dir / SCAN_STATE_FILENAME
    if state_path.exists():
        try:
            connection = sqlite3.connect(f"file:{state_path}?mode=ro", uri=True)
            try:
                row = connection.execute(
                    "SELECT archive_id, root FROM scan_identity WHERE singleton = 1"
                ).fetchone()
                if row:
                    state_identity = {"archive_id": str(row[0]), "root": str(row[1])}
                if checksum_algorithm:
                    count_row = connection.execute(
                        "SELECT COUNT(*) FROM checksum_cache WHERE algorithm = ?",
                        (checksum_algorithm,),
                    ).fetchone()
                    state_checksum_records = int(count_row[0]) if count_row else 0
            finally:
                connection.close()
        except sqlite3.Error as error:
            blockers.append(f"Existing disk-backed scan state is unreadable: {error}")

    if resume_checksums:
        if state_identity and state_identity != {"archive_id": resolved_archive_id, "root": str(root)}:
            blockers.append("Existing scan state belongs to a different archive id or source root.")
        if state_checksum_records == 0 and not (output_dir / "checksums.jsonl").exists():
            warnings.append("No prior checksum state exists; the resume run will hash every file.")

    lock_active = False
    lock_path = output_dir / "scan.lock"
    if lock_path.exists():
        lock_handle = lock_path.open("a+")
        try:
            try:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                lock_active = True
                blockers.append("Another archive scan currently holds the output-directory lock.")
            else:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        finally:
            lock_handle.close()

    inprogress = sorted(path.name for path in output_dir.glob("*.inprogress")) if output_dir.exists() else []
    if inprogress:
        warnings.append("Interrupted staged artifacts are present and will be replaced by the next successful scan.")

    return {
        "schema": "cell-anatomy-archive-scan-preflight",
        "schema_version": SCHEMA_VERSION,
        "scanner": SCANNER_VERSION,
        "status": "blocked" if blockers else "ready",
        "archive_id": resolved_archive_id,
        "root": str(root),
        "output_dir": str(output_dir),
        "checksum_algorithm": checksum_algorithm,
        "resume_checksums": resume_checksums,
        "source_output_same_device": same_device,
        "output_filesystem": {"probe_path": str(output_probe), "free_bytes": free_bytes, "total_bytes": total_bytes},
        "existing": {
            "summary": prior_summary,
            "checkpoint": checkpoint,
            "state_identity": state_identity,
            "state_checksum_records": state_checksum_records,
            "inprogress_artifacts": inprogress,
            "lock_active": lock_active,
        },
        "blockers": blockers,
        "warnings": warnings,
    }


def append_jsonl(handle, value: dict[str, Any]) -> None:
    handle.write(json.dumps(value, sort_keys=True) + "\n")


def iter_jsonl_records(path: Path) -> Iterator[dict[str, Any]]:
    if not path.exists():
        return
    with path.open() as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"Expected JSON object at {path}:{line_number}")
            yield value


def read_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Required scanner artifact is missing: {path}")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return value


def map_records_by_relative_path(records: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    mapped: dict[str, dict[str, Any]] = {}
    for record in records:
        relative = record.get("relative_path")
        if isinstance(relative, str) and relative:
            mapped[relative] = record
    return mapped


def update_largest_files(state: ScanState, record: dict[str, Any], limit: int) -> None:
    state.largest_files.append(
        {
            "relative_path": record["relative_path"],
            "size_bytes": record["size_bytes"],
            "extension": record["extension"],
            "likely_role": record["likely_role"],
        }
    )
    state.largest_files.sort(key=lambda item: item["size_bytes"], reverse=True)
    if len(state.largest_files) > limit:
        state.largest_files.pop()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(CHECKSUM_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


class DiskChecksumIndex:
    """Disk-backed checksum resume and duplicate index for archive-scale scans."""

    def __init__(
        self,
        path: Path,
        algorithm: str | None,
        *,
        archive_id: str,
        root: Path,
        resume: bool,
        import_path: Path | None = None,
    ) -> None:
        self.algorithm = algorithm
        self.archive_id = archive_id
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS checksum_cache (
                relative_path TEXT NOT NULL,
                algorithm TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                modified_at TEXT NOT NULL,
                digest TEXT NOT NULL,
                computed_at TEXT NOT NULL,
                device_id INTEGER,
                inode INTEGER,
                PRIMARY KEY (relative_path, algorithm)
            )
            """
        )
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS current_digests (
                digest TEXT PRIMARY KEY,
                relative_path TEXT NOT NULL
            )
            """
        )
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS scan_identity (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                archive_id TEXT NOT NULL,
                root TEXT NOT NULL
            )
            """
        )
        existing_identity = self.connection.execute(
            "SELECT archive_id, root FROM scan_identity WHERE singleton = 1"
        ).fetchone()
        expected_identity = (archive_id, str(root))
        if existing_identity and tuple(existing_identity) != expected_identity:
            if resume:
                self.connection.close()
                raise ValueError(
                    "Cannot resume this scan output directory because its archive id or source root changed."
                )
            self.connection.execute("DELETE FROM checksum_cache")
        self.connection.execute(
            "INSERT OR REPLACE INTO scan_identity(singleton, archive_id, root) VALUES (1, ?, ?)",
            expected_identity,
        )
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS current_paths (
                relative_path TEXT PRIMARY KEY
            )
            """
        )
        self.connection.execute("DELETE FROM current_digests")
        self.connection.execute("DELETE FROM current_paths")
        if algorithm and import_path and import_path.exists():
            self.import_jsonl(import_path)
        self.connection.commit()

    def import_jsonl(self, path: Path) -> None:
        if not self.algorithm:
            return
        rows: list[tuple[str, str, int, str, str, str, int | None, int | None]] = []
        for row in iter_jsonl_records(path):
            relative = row.get("relative_path")
            digest = row.get("digest")
            if (
                row.get("algorithm") != self.algorithm
                or row.get("archive_id") not in {None, "", self.archive_id}
                or not isinstance(relative, str)
                or not isinstance(digest, str)
            ):
                continue
            try:
                size_bytes = int(row.get("size_bytes"))
            except (TypeError, ValueError):
                continue
            rows.append(
                (
                    relative,
                    self.algorithm,
                    size_bytes,
                    str(row.get("modified_at") or ""),
                    digest,
                    str(row.get("computed_at") or ""),
                    int(row["device_id"]) if row.get("device_id") is not None else None,
                    int(row["inode"]) if row.get("inode") is not None else None,
                )
            )
            if len(rows) >= 1000:
                self._upsert_rows(rows)
                rows.clear()
        if rows:
            self._upsert_rows(rows)

    def _upsert_rows(
        self,
        rows: list[tuple[str, str, int, str, str, str, int | None, int | None]],
    ) -> None:
        self.connection.executemany(
            """
            INSERT INTO checksum_cache (
                relative_path, algorithm, size_bytes, modified_at, digest, computed_at, device_id, inode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(relative_path, algorithm) DO UPDATE SET
                size_bytes = excluded.size_bytes,
                modified_at = excluded.modified_at,
                digest = excluded.digest,
                computed_at = excluded.computed_at,
                device_id = excluded.device_id,
                inode = excluded.inode
            """,
            rows,
        )

    def get(self, relative_path: str) -> dict[str, Any] | None:
        if not self.algorithm:
            return None
        row = self.connection.execute(
            """
            SELECT algorithm, size_bytes, modified_at, digest, computed_at, device_id, inode
            FROM checksum_cache
            WHERE relative_path = ? AND algorithm = ?
            """,
            (relative_path, self.algorithm),
        ).fetchone()
        if not row:
            return None
        return {
            "relative_path": relative_path,
            "algorithm": row[0],
            "size_bytes": row[1],
            "modified_at": row[2],
            "digest": row[3],
            "computed_at": row[4],
            "device_id": row[5],
            "inode": row[6],
        }

    def remember(self, record: dict[str, Any]) -> None:
        if not self.algorithm:
            return
        self.connection.execute(
            """
            INSERT INTO checksum_cache (
                relative_path, algorithm, size_bytes, modified_at, digest, computed_at, device_id, inode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(relative_path, algorithm) DO UPDATE SET
                size_bytes = excluded.size_bytes,
                modified_at = excluded.modified_at,
                digest = excluded.digest,
                computed_at = excluded.computed_at,
                device_id = excluded.device_id,
                inode = excluded.inode
            """,
            (
                record["relative_path"],
                record["algorithm"],
                int(record["size_bytes"]),
                record["modified_at"],
                record["digest"],
                record["computed_at"],
                int(record["device_id"]),
                int(record["inode"]),
            ),
        )

    def record_seen_path(self, relative_path: str) -> None:
        self.connection.execute(
            "INSERT OR IGNORE INTO current_paths (relative_path) VALUES (?)",
            (relative_path,),
        )

    def record_digest(self, digest: str, relative_path: str) -> str:
        row = self.connection.execute(
            "SELECT relative_path FROM current_digests WHERE digest = ?",
            (digest,),
        ).fetchone()
        if row:
            return str(row[0])
        self.connection.execute(
            "INSERT INTO current_digests (digest, relative_path) VALUES (?, ?)",
            (digest, relative_path),
        )
        return ""

    def checkpoint(self) -> None:
        self.connection.commit()

    def finish(self) -> None:
        if self.algorithm:
            self.connection.execute(
                """
                DELETE FROM checksum_cache
                WHERE algorithm = ?
                  AND relative_path NOT IN (SELECT relative_path FROM current_paths)
                """,
                (self.algorithm,),
            )
        self.connection.commit()

    def close(self) -> None:
        self.connection.commit()
        self.connection.close()


def cached_checksum_matches(
    cached: dict[str, Any] | None,
    record: dict[str, Any],
    algorithm: str,
    stat_result: os.stat_result,
) -> bool:
    if not cached:
        return False
    try:
        cached_size = int(cached.get("size_bytes"))
    except (TypeError, ValueError):
        return False
    identity_matches = (
        cached.get("device_id") is None
        or cached.get("inode") is None
        or (
            int(cached["device_id"]) == int(stat_result.st_dev)
            and int(cached["inode"]) == int(stat_result.st_ino)
        )
    )
    return (
        cached.get("algorithm") == algorithm
        and cached_size == int(record["size_bytes"])
        and cached.get("modified_at") == record["modified_at"]
        and isinstance(cached.get("digest"), str)
        and identity_matches
    )


def checksum_record_for_path(
    state: ScanState,
    record: dict[str, Any],
    stat_result: os.stat_result,
    digest: str,
    duplicate_of: str,
    *,
    reused: bool,
    computed_at: str | None = None,
) -> dict[str, Any]:
    return {
        "schema": "cell-anatomy-archive-checksum",
        "schema_version": SCHEMA_VERSION,
        "scanner": SCANNER_VERSION,
        "run_id": state.run_id,
        "archive_id": state.archive_id,
        "relative_path": record["relative_path"],
        "algorithm": state.checksum_algorithm,
        "digest": digest,
        "size_bytes": stat_result.st_size,
        "modified_at": record["modified_at"],
        "device_id": stat_result.st_dev,
        "inode": stat_result.st_ino,
        "duplicate_of": duplicate_of,
        "computed_at": computed_at or utc_now(),
        "reused_from_previous_run": reused,
    }


def read_prefix(path: Path, limit: int) -> bytes:
    with path.open("rb") as source:
        return source.read(limit)


def parse_tiff_header(path: Path) -> dict[str, Any]:
    prefix = read_prefix(path, 65536)
    if len(prefix) < 8:
        return {"status": "unreadable", "error": "TIFF header is shorter than 8 bytes."}

    endian_marker = prefix[:2]
    if endian_marker == b"II":
        endian = "<"
    elif endian_marker == b"MM":
        endian = ">"
    else:
        return {"status": "unreadable", "error": "TIFF byte-order marker is missing."}

    magic = struct.unpack_from(f"{endian}H", prefix, 2)[0]
    if magic != 42:
        return {"status": "unsupported", "error": f"Unsupported TIFF magic value {magic}."}

    ifd_offset = struct.unpack_from(f"{endian}I", prefix, 4)[0]
    if ifd_offset + 2 > len(prefix):
        return {"status": "partial", "error": "TIFF first IFD offset is outside scanned header bytes."}

    entry_count = struct.unpack_from(f"{endian}H", prefix, ifd_offset)[0]
    offset = ifd_offset + 2
    tags: dict[int, Any] = {}

    def decode_value(value_type: int, count: int, raw_value: bytes) -> Any:
        if value_type == 3 and count == 1:
            return struct.unpack(f"{endian}H", raw_value[:2])[0]
        if value_type == 4 and count == 1:
            return struct.unpack(f"{endian}I", raw_value)[0]
        if value_type == 2:
            text_offset = struct.unpack(f"{endian}I", raw_value)[0]
            if text_offset < len(prefix):
                return prefix[text_offset : min(len(prefix), text_offset + count)].split(b"\x00", 1)[0].decode(
                    "utf-8",
                    errors="replace",
                )
        return None

    for _ in range(entry_count):
        if offset + 12 > len(prefix):
            break
        tag, value_type, count = struct.unpack_from(f"{endian}HHI", prefix, offset)
        raw_value = prefix[offset + 8 : offset + 12]
        value = decode_value(value_type, count, raw_value)
        if value is not None:
            tags[tag] = value
        offset += 12

    width = tags.get(256)
    height = tags.get(257)
    bits_per_sample = tags.get(258)
    samples_per_pixel = tags.get(277, 1)
    image_description = str(tags.get(270) or "")

    dimensions = {"x": width, "y": height} if isinstance(width, int) and isinstance(height, int) else {}
    dtype = None
    if isinstance(bits_per_sample, int):
        dtype = f"uint{bits_per_sample}"

    imagej_scale = parse_imagej_description_scale(image_description)
    return {
        "status": "readable" if dimensions else "partial",
        "format": "TIFF",
        "dimensions": dimensions,
        "dtype": dtype,
        "samples_per_pixel": samples_per_pixel,
        "voxel_size_nm": imagej_scale,
        "metadata_source": "tiff_ifd",
    }


def parse_imagej_description_scale(description: str) -> dict[str, Any] | None:
    if not description:
        return None
    values: dict[str, str] = {}
    for line in description.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip().lower()] = value.strip()
    unit = values.get("unit", "").lower()
    if unit not in {"nm", "nanometer", "nanometers"}:
        return None
    spacing = parse_positive_float(values.get("spacing"))
    pixel_width = parse_positive_float(values.get("pixelwidth"))
    pixel_height = parse_positive_float(values.get("pixelheight"))
    return {
        "x": pixel_width or 1.0,
        "y": pixel_height or pixel_width or 1.0,
        "z": spacing or pixel_height or pixel_width or 1.0,
        "source": "imagej_description",
    }


def parse_positive_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def unit_to_nanometers(unit: str | None) -> float | None:
    normalized = (unit or "").strip().lower()
    if normalized in {"nm", "nanometer", "nanometers"}:
        return 1.0
    if normalized in {"um", "µm", "micrometer", "micrometers", "micrometre", "micrometres"}:
        return 1000.0
    if normalized in {"angstrom", "angstroms", "ångström", "ångströms"}:
        return 0.1
    if normalized in {"m", "meter", "meters", "metre", "metres"}:
        return 1_000_000_000.0
    return None


def parse_mrc_header(path: Path) -> dict[str, Any]:
    header = read_prefix(path, 1024)
    if len(header) < 1024:
        return {"status": "unreadable", "error": "MRC header is shorter than 1024 bytes."}
    nx, ny, nz, mode = struct.unpack_from("<4i", header, 0)
    mx, my, mz = struct.unpack_from("<3i", header, 28)
    cella_x, cella_y, cella_z = struct.unpack_from("<3f", header, 40)
    map_id = header[208:212].decode("ascii", errors="replace")
    dtype = {
        0: "int8",
        1: "int16",
        2: "float32",
        4: "complex64",
        6: "uint16",
    }.get(mode, f"mrc-mode-{mode}")

    voxel_size_nm = None
    if mx > 0 and my > 0 and mz > 0 and cella_x > 0 and cella_y > 0 and cella_z > 0:
        voxel_size_nm = {
            "x": cella_x / mx / 10.0,
            "y": cella_y / my / 10.0,
            "z": cella_z / mz / 10.0,
            "source": "mrc_header",
        }

    dimensions = {"x": nx, "y": ny, "z": nz} if nx > 0 and ny > 0 and nz > 0 else {}
    return {
        "status": "readable" if dimensions else "partial",
        "format": "MRC",
        "dimensions": dimensions,
        "dtype": dtype,
        "voxel_size_nm": voxel_size_nm,
        "metadata_source": "mrc_header",
        "map_id": map_id,
    }


def read_json_object(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text())
    except Exception:  # noqa: BLE001 - scanner should ignore malformed optional sidecars.
        return None
    return value if isinstance(value, dict) else None


def matching_ome_dataset(
    multiscale: dict[str, Any],
    array_path: str,
) -> dict[str, Any] | None:
    normalized_array_path = "" if array_path == "." else array_path.strip("/")
    datasets = multiscale.get("datasets")
    if not isinstance(datasets, list):
        return None
    for dataset in datasets:
        if not isinstance(dataset, dict):
            continue
        dataset_path = str(dataset.get("path") or "").strip("/")
        if dataset_path == normalized_array_path or (not dataset_path and normalized_array_path in {"", "."}):
            return dataset
    return None


def voxel_size_from_ome_dataset(
    multiscale: dict[str, Any],
    dataset: dict[str, Any],
) -> dict[str, Any] | None:
    transforms = dataset.get("coordinateTransformations")
    if not isinstance(transforms, list):
        return None

    scale_values: list[Any] | None = None
    for transform in transforms:
        if isinstance(transform, dict) and transform.get("type") == "scale" and isinstance(transform.get("scale"), list):
            scale_values = transform["scale"]
            break
    if not scale_values:
        return None

    axes = multiscale.get("axes")
    if not isinstance(axes, list):
        axes = []

    voxel_size: dict[str, Any] = {}
    fallback_axis_names = ["z", "y", "x"]
    for index, raw_value in enumerate(scale_values):
        try:
            scale = float(raw_value)
        except (TypeError, ValueError):
            continue
        if scale <= 0:
            continue
        axis = axes[index] if index < len(axes) and isinstance(axes[index], dict) else {}
        axis_name = str(axis.get("name") or (fallback_axis_names[index] if index < len(fallback_axis_names) else ""))
        axis_name = axis_name.lower()
        if axis_name not in {"x", "y", "z"}:
            continue
        factor = unit_to_nanometers(str(axis.get("unit") or ""))
        if factor is None:
            continue
        voxel_size[axis_name] = scale * factor

    if all(axis in voxel_size for axis in ("x", "y", "z")):
        voxel_size["source"] = "ome_ngff_multiscales"
        return voxel_size
    return None


def ome_ngff_metadata_for_array(array_dir: Path, root: Path) -> dict[str, Any]:
    current = array_dir
    while True:
        attrs = read_json_object(current / ".zattrs")
        multiscales = attrs.get("multiscales") if attrs else None
        if isinstance(multiscales, list):
            array_path = relative_path(current, array_dir)
            for multiscale in multiscales:
                if not isinstance(multiscale, dict):
                    continue
                dataset = matching_ome_dataset(multiscale, array_path)
                if not dataset:
                    continue
                metadata: dict[str, Any] = {
                    "asset_relative_path": relative_path(root, current),
                    "metadata_source": "ome_ngff_zarr_array_metadata",
                    "ome_ngff_version": multiscale.get("version") or "",
                    "ome_zarr_array_path": "" if array_path == "." else array_path,
                }
                voxel_size_nm = voxel_size_from_ome_dataset(multiscale, dataset)
                if voxel_size_nm:
                    metadata["voxel_size_nm"] = voxel_size_nm
                return metadata

        if current == root or current.parent == current:
            break
        current = current.parent
    return {}


def parse_zarr_metadata(path: Path, root: Path) -> dict[str, Any]:
    try:
        config = json.loads(path.read_text())
    except Exception as error:  # noqa: BLE001 - scanner must capture broad parse failures.
        return {"status": "unreadable", "error": f"Could not parse Zarr .zarray: {error}"}

    shape = config.get("shape")
    chunks = config.get("chunks")
    dtype = config.get("dtype")
    array_dir = path.parent
    array_relative = relative_path(root, array_dir)
    dimensions = {}
    if isinstance(shape, list) and len(shape) == 3 and all(isinstance(item, int) for item in shape):
        dimensions = {"z": shape[0], "y": shape[1], "x": shape[2]}

    ome_metadata = ome_ngff_metadata_for_array(array_dir, root)

    return {
        "status": "readable" if dimensions else "partial",
        "format": "Zarr",
        "asset_relative_path": "." if array_relative == "." else array_relative,
        "dimensions": dimensions,
        "shape": shape,
        "chunks": chunks,
        "dtype": dtype,
        "metadata_source": "zarr_array_metadata",
        "zarr_format": config.get("zarr_format", 2),
        "compressor": config.get("compressor"),
        "filters": config.get("filters"),
        "order": config.get("order"),
        **ome_metadata,
    }


def parse_hdf5_header(path: Path) -> dict[str, Any]:
    prefix = read_prefix(path, 8)
    if prefix == b"\x89HDF\r\n\x1a\n":
        return {
            "status": "detected",
            "format": "HDF5",
            "dimensions": {},
            "dtype": None,
            "metadata_source": "hdf5_signature",
            "warning": "HDF5 dimensions require a follow-up extractor.",
        }
    return {"status": "unreadable", "error": "HDF5 signature not found."}


def metadata_for_path(path: Path, root: Path, record: dict[str, Any]) -> dict[str, Any] | None:
    ext = record["extension"]
    if record["path_type"] != "file":
        return None

    base: dict[str, Any] = {
        "schema": "cell-anatomy-archive-metadata-extraction",
        "schema_version": SCHEMA_VERSION,
        "scanner": SCANNER_VERSION,
        "archive_id": record["archive_id"],
        "relative_path": record["relative_path"],
        "size_bytes": record["size_bytes"],
        "extension": ext,
        "likely_role": record["likely_role"],
    }

    try:
        if ext in {".tif", ".tiff", ".ome.tif", ".ome.tiff"}:
            parsed = parse_tiff_header(path)
        elif ext == ".mrc":
            parsed = parse_mrc_header(path)
        elif ext == ".zarray":
            parsed = parse_zarr_metadata(path, root)
        elif ext in {".h5", ".hdf", ".hdf5"}:
            parsed = parse_hdf5_header(path)
        else:
            return None
    except Exception as error:  # noqa: BLE001 - scanner must report broad extractor failures.
        parsed = {"status": "error", "error": str(error)}

    return {**base, **parsed}


def is_volume_candidate(metadata: dict[str, Any]) -> bool:
    if metadata.get("status") not in {"readable", "detected", "partial"}:
        return False
    fmt = metadata.get("format")
    return fmt in {"TIFF", "MRC", "Zarr", "HDF5"}


def candidate_from_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    dimensions = metadata.get("dimensions") if isinstance(metadata.get("dimensions"), dict) else {}
    return {
        "relative_path": metadata.get("asset_relative_path") or metadata["relative_path"],
        "source_metadata_path": metadata["relative_path"],
        "format": metadata.get("format") or "",
        "status": metadata.get("status") or "",
        "dtype": metadata.get("dtype") or "",
        "x": dimensions.get("x", ""),
        "y": dimensions.get("y", ""),
        "z": dimensions.get("z", ""),
        "size_bytes": metadata.get("size_bytes", ""),
        "metadata_source": metadata.get("metadata_source") or "",
        "warning": metadata.get("warning") or metadata.get("error") or "",
    }


def needs_metadata_review(record: dict[str, Any]) -> bool:
    if record["path_type"] != "file":
        return False
    ext = record["extension"]
    return (
        record["likely_role"] in {"raw_volume_candidate", "imaging_candidate"}
        or ext in VOLUME_EXTENSIONS
        or ext in {".ome.tif", ".ome.tiff", ".zarray"}
    )


def metadata_gap_row(
    record: dict[str, Any],
    metadata: dict[str, Any] | None,
    gap_code: str,
    severity: str,
    summary: str,
    suggested_action: str,
) -> dict[str, Any]:
    return {
        "relative_path": record["relative_path"],
        "asset_relative_path": (metadata or {}).get("asset_relative_path") or record["relative_path"],
        "format": (metadata or {}).get("format") or "",
        "metadata_status": (metadata or {}).get("status") or "not_extracted",
        "likely_role": record["likely_role"],
        "extension": record["extension"],
        "gap_code": gap_code,
        "severity": severity,
        "summary": summary,
        "suggested_action": suggested_action,
    }


def metadata_gap_records(record: dict[str, Any], metadata: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not needs_metadata_review(record):
        return []

    if not metadata:
        return [
            metadata_gap_row(
                record,
                None,
                "no_metadata_extractor",
                "review",
                "No metadata extractor produced dimensions, dtype, or calibration for this candidate asset.",
                "Add or run a format-specific extractor before conversion or analysis.",
            )
        ]

    gaps: list[dict[str, Any]] = []
    status = metadata.get("status")
    fmt = metadata.get("format") or ""
    if status == "detected" and fmt == "HDF5":
        gaps.append(
            metadata_gap_row(
                record,
                metadata,
                "hdf5_internal_metadata_pending",
                "review",
                "The HDF5 signature was detected, but internal datasets were not inspected.",
                "Run an HDF5 extractor that enumerates datasets, dimensions, dtype, and candidate image arrays.",
            )
        )
    elif status != "readable":
        gaps.append(
            metadata_gap_row(
                record,
                metadata,
                f"metadata_status_{status or 'unknown'}",
                "blocker" if status in {"error", "unreadable"} else "review",
                "The metadata extractor did not produce a fully readable volume record.",
                "Review the extractor result and rerun with a richer parser if the file should be analyzed.",
            )
        )

    dimensions = metadata.get("dimensions") if isinstance(metadata.get("dimensions"), dict) else {}
    if not dimensions.get("x") or not dimensions.get("y"):
        gaps.append(
            metadata_gap_row(
                record,
                metadata,
                "missing_dimensions",
                "blocker",
                "X/Y dimensions are missing.",
                "Extract or curate dimensions before any viewer, conversion, or measurement workflow.",
            )
        )
    if not dimensions.get("z"):
        gaps.append(
            metadata_gap_row(
                record,
                metadata,
                "missing_z_dimension",
                "review",
                "Z dimension is missing, so the scanner cannot distinguish a 2D image from a volume.",
                "Confirm whether this asset is a single plane, a stack, or a sidecar-managed series.",
            )
        )
    if not metadata.get("dtype"):
        gaps.append(
            metadata_gap_row(
                record,
                metadata,
                "missing_dtype",
                "blocker",
                "Pixel or voxel dtype is missing.",
                "Extract dtype from embedded metadata or curate it before conversion.",
            )
        )
    if not metadata.get("voxel_size_nm"):
        gaps.append(
            metadata_gap_row(
                record,
                metadata,
                "missing_voxel_size",
                "review",
                "Physical voxel size is missing.",
                "Find authoritative calibration in embedded metadata, sidecars, lab notes, or publication methods.",
            )
        )

    return gaps


def asset_status_ledger_record(
    state: ScanState,
    record: dict[str, Any],
    checksum_record: dict[str, Any] | None,
    checksum_error: bool,
    metadata: dict[str, Any] | None,
    metadata_gaps: list[dict[str, Any]],
) -> dict[str, Any]:
    if record["path_type"] == "symlink":
        fixity_status = "not_applicable"
    elif not state.checksum_algorithm:
        fixity_status = "not_requested"
    elif checksum_error:
        fixity_status = "error"
    elif checksum_record:
        fixity_status = "checksummed"
    else:
        fixity_status = "pending"

    blocked_states = ["blocked_permission"]
    if any(gap["gap_code"] in {"missing_dimensions", "missing_dtype", "no_metadata_extractor"} for gap in metadata_gaps):
        blocked_states.append("blocked_missing_metadata")
    if any(gap["gap_code"].startswith("metadata_status_") and gap["severity"] == "blocker" for gap in metadata_gaps):
        blocked_states.append("blocked_unreadable")
    if any(gap["gap_code"] == "missing_voxel_size" for gap in metadata_gaps):
        blocked_states.append("blocked_unknown_voxel_size")

    return {
        "schema": "cell-anatomy-archive-asset-status",
        "schema_version": SCHEMA_VERSION,
        "scanner": SCANNER_VERSION,
        "run_id": state.run_id,
        "archive_id": state.archive_id,
        "relative_path": record["relative_path"],
        "path_type": record["path_type"],
        "extension": record["extension"],
        "likely_role": record["likely_role"],
        "size_bytes": record["size_bytes"],
        "asset_status": "discovered",
        "fixity_status": fixity_status,
        "checksum_algorithm": state.checksum_algorithm,
        "checksum_digest": (checksum_record or {}).get("digest"),
        "metadata_status": (metadata or {}).get("status") or "not_extracted",
        "metadata_format": (metadata or {}).get("format") or "",
        "metadata_gap_count": len(metadata_gaps),
        "publication_status": "unknown",
        "triage_status": "unknown",
        "rights_status": "unknown",
        "classification_status": "unreviewed",
        "blocked_states": sorted(set(blocked_states)),
        "review_required": True,
        "review_notes": [
            "scanner_seeded_status",
            "rights_unknown",
            "publication_status_unknown",
        ],
        "allowed_operations": {
            "can_store_locally": record["path_type"] == "file",
            "can_backup_to_cloud": False,
            "can_convert": False,
            "can_view_in_caos": False,
            "can_share_with_collaborators": False,
            "can_publish_derivatives": False,
            "can_release_publicly": False,
        },
        "created_at": state.started_at,
    }


def file_record_for_path(state: ScanState, path: Path, path_type: str, stat_result: os.stat_result) -> dict[str, Any]:
    rel = relative_path(state.root, path)
    ext = extension_for(path)
    modified = stat_result.st_mtime
    return {
        "schema": "cell-anatomy-archive-file",
        "schema_version": SCHEMA_VERSION,
        "scanner": SCANNER_VERSION,
        "run_id": state.run_id,
        "archive_id": state.archive_id,
        "root": str(state.root),
        "relative_path": rel,
        "name": path.name,
        "extension": ext,
        "path_type": path_type,
        "size_bytes": stat_result.st_size,
        "modified_at": iso_from_timestamp(modified),
        "mode_octal": oct(stat.S_IMODE(stat_result.st_mode)),
        "likely_role": likely_role(Path(rel), path_type == "symlink"),
        "is_hidden": any(part.startswith(".") for part in Path(rel).parts),
    }


def record_scan_error(state: ScanState, relative: str, operation: str, error: Exception | str) -> dict[str, str]:
    state.unreadable_count += 1
    return {"relative_path": relative, "operation": operation, "error": str(error)}


def update_summary_from_record(state: ScanState, record: dict[str, Any]) -> None:
    state.file_count += 1
    state.path_type_counts.update([record["path_type"]])
    state.likely_role_counts.update([record["likely_role"]])
    state.extension_counts.update([record["extension"] or "[none]"])
    state.extension_bytes.update({record["extension"] or "[none]": int(record["size_bytes"])})
    state.bytes_total += int(record["size_bytes"])
    modified_ts = datetime.fromisoformat(record["modified_at"].replace("Z", "+00:00")).timestamp()
    if state.modified_min is None or modified_ts < state.modified_min:
        state.modified_min = modified_ts
    if state.modified_max is None or modified_ts > state.modified_max:
        state.modified_max = modified_ts


def progress_payload(
    state: ScanState,
    *,
    phase: str,
    event: str,
    started_monotonic: float,
    current_directory: str = "",
    last_relative_path: str = "",
    error: str = "",
) -> dict[str, Any]:
    elapsed_seconds = max(0.0, time.monotonic() - started_monotonic)
    checksum_bytes_processed = state.bytes_hashed + state.bytes_reused
    payload: dict[str, Any] = {
        "schema": "cell-anatomy-archive-scan-progress",
        "schema_version": SCHEMA_VERSION,
        "scanner": SCANNER_VERSION,
        "archive_id": state.archive_id,
        "root": str(state.root),
        "output_dir": str(state.output_dir),
        "phase": phase,
        "event": event,
        "emitted_at": utc_now(),
        "started_at": state.started_at,
        "elapsed_seconds": round(elapsed_seconds, 3),
        "current_directory": current_directory,
        "last_relative_path": last_relative_path,
        "file_count": state.file_count,
        "directory_count": state.directory_count,
        "symlink_count": state.symlink_count,
        "unreadable_count": state.unreadable_count,
        "bytes_total": state.bytes_total,
        "metadata_records": state.metadata_record_count,
        "metadata_gaps": state.metadata_gap_count,
        "volume_candidates": state.volume_candidate_count,
        "status_records": state.status_record_count,
        "checksum": {
            "algorithm": state.checksum_algorithm,
            "files_hashed": state.files_hashed,
            "files_reused": state.files_reused,
            "records_written": state.files_hashed + state.files_reused,
            "bytes_hashed": state.bytes_hashed,
            "bytes_reused": state.bytes_reused,
            "duplicate_files": state.checksum_duplicate_count,
            "bytes_processed": checksum_bytes_processed,
            "bytes_per_second": round(checksum_bytes_processed / elapsed_seconds, 3)
            if elapsed_seconds > 0
            else 0.0,
        },
    }
    if error:
        payload["error"] = error
    return payload


def emit_progress(
    state: ScanState,
    progress_handle,
    checkpoint_path: Path,
    *,
    phase: str,
    event: str,
    started_monotonic: float,
    current_directory: str = "",
    last_relative_path: str = "",
    error: str = "",
) -> None:
    payload = progress_payload(
        state,
        phase=phase,
        event=event,
        started_monotonic=started_monotonic,
        current_directory=current_directory,
        last_relative_path=last_relative_path,
        error=error,
    )
    append_jsonl(progress_handle, payload)
    progress_handle.flush()
    write_json_atomic(checkpoint_path, payload)


def scan_archive(
    root: Path,
    output_dir: Path,
    *,
    archive_id: str | None = None,
    checksum_algorithm: str | None = None,
    resume_checksums: bool = False,
    largest_file_limit: int = DEFAULT_LARGEST_FILE_LIMIT,
    progress_interval_files: int = DEFAULT_PROGRESS_INTERVAL_FILES,
    progress_interval_seconds: float = DEFAULT_PROGRESS_INTERVAL_SECONDS,
) -> dict[str, Any]:
    root = root.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    if not root.exists():
        raise FileNotFoundError(f"Archive root does not exist: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"Archive root must be a directory: {root}")
    try:
        output_dir.relative_to(root)
    except ValueError:
        pass
    else:
        raise ValueError("Scanner output directory must be outside the archive root.")

    output_dir.mkdir(parents=True, exist_ok=True)
    state = ScanState(
        root=root,
        output_dir=output_dir,
        archive_id=archive_id or stable_archive_id(root),
        checksum_algorithm=checksum_algorithm,
    )

    manifest_path = output_dir / "file-manifest.jsonl"
    metadata_path = output_dir / "metadata-extraction.jsonl"
    checksums_path = output_dir / "checksums.jsonl"
    status_ledger_path = output_dir / "asset-status-ledger.jsonl"
    errors_path = output_dir / "scan-errors.csv"
    candidates_path = output_dir / "volume-candidates.csv"
    gaps_path = output_dir / "metadata-gaps.csv"
    progress_path = output_dir / "scan-progress.jsonl"
    checkpoint_path = output_dir / "scan-checkpoint.json"
    scan_lock = ExclusiveFileLock(output_dir / "scan.lock", "archive scan")
    try:
        checksum_index = DiskChecksumIndex(
            output_dir / SCAN_STATE_FILENAME,
            checksum_algorithm,
            archive_id=state.archive_id,
            root=root,
            resume=resume_checksums,
            import_path=checksums_path if resume_checksums else None,
        )
    except BaseException:
        scan_lock.close()
        raise
    staged_paths = [manifest_path, metadata_path, status_ledger_path, errors_path, candidates_path, gaps_path]
    if checksum_algorithm:
        staged_paths.append(checksums_path)

    progress_interval_files = max(1, progress_interval_files)
    progress_interval_seconds = max(0.0, progress_interval_seconds)
    started_monotonic = time.monotonic()
    last_progress_file_count = 0
    last_progress_time = started_monotonic

    progress_handle = progress_path.open("a")
    try:
        emit_progress(
            state,
            progress_handle,
            checkpoint_path,
            phase="running",
            event="scan_started",
            started_monotonic=started_monotonic,
        )
        with ExitStack() as stack:
            manifest = stack.enter_context(staged_artifact_path(manifest_path).open("w"))
            metadata_handle = stack.enter_context(staged_artifact_path(metadata_path).open("w"))
            status_ledger_handle = stack.enter_context(staged_artifact_path(status_ledger_path).open("w"))
            errors_handle = stack.enter_context(staged_artifact_path(errors_path).open("w", newline=""))
            candidates_handle = stack.enter_context(staged_artifact_path(candidates_path).open("w", newline=""))
            gaps_handle = stack.enter_context(staged_artifact_path(gaps_path).open("w", newline=""))
            checksum_handle = (
                stack.enter_context(staged_artifact_path(checksums_path).open("w"))
                if checksum_algorithm
                else None
            )
            error_writer = csv.DictWriter(errors_handle, fieldnames=SCAN_ERROR_FIELDS)
            candidate_writer = csv.DictWriter(candidates_handle, fieldnames=VOLUME_CANDIDATE_FIELDS)
            gap_writer = csv.DictWriter(gaps_handle, fieldnames=METADATA_GAP_FIELDS)
            error_writer.writeheader()
            candidate_writer.writeheader()
            gap_writer.writeheader()
            artifact_handles = [
                manifest,
                metadata_handle,
                status_ledger_handle,
                errors_handle,
                candidates_handle,
                gaps_handle,
                *([checksum_handle] if checksum_handle else []),
            ]

            try:
                for current_dir, dir_names, file_names in os.walk(root, followlinks=False):
                    current_path = Path(current_dir)
                    current_relative_dir = relative_path(root, current_path)
                    state.directory_count += 1
                    dir_names.sort()
                    file_names.sort()

                    for name in file_names:
                        path = current_path / name
                        rel = relative_path(root, path)
                        try:
                            stat_result = path.lstat()
                        except OSError as error:
                            error_writer.writerow(record_scan_error(state, rel, "lstat", error))
                            continue

                        path_type = "symlink" if path.is_symlink() else "file"
                        if path_type == "symlink":
                            state.symlink_count += 1
                        record = file_record_for_path(state, path, path_type, stat_result)
                        if path_type == "symlink":
                            try:
                                record["link_target"] = os.readlink(path)
                            except OSError as error:
                                record["link_target_error"] = str(error)

                        update_summary_from_record(state, record)
                        update_largest_files(state, record, largest_file_limit)
                        checksum_index.record_seen_path(rel)

                        checksum_record = None
                        checksum_error = False
                        if checksum_algorithm and path_type == "file":
                            try:
                                cached = checksum_index.get(rel) if resume_checksums else None
                                if cached_checksum_matches(cached, record, checksum_algorithm, stat_result):
                                    digest = str(cached["digest"])
                                    duplicate_of = checksum_index.record_digest(digest, rel)
                                    if duplicate_of:
                                        state.checksum_duplicate_count += 1
                                    cached_computed_at = cached.get("computed_at")
                                    checksum_record = checksum_record_for_path(
                                        state,
                                        record,
                                        stat_result,
                                        digest,
                                        duplicate_of,
                                        reused=True,
                                        computed_at=cached_computed_at
                                        if isinstance(cached_computed_at, str)
                                        else None,
                                    )
                                    state.files_reused += 1
                                    state.bytes_reused += stat_result.st_size
                                else:
                                    digest = sha256_file(path)
                                    duplicate_of = checksum_index.record_digest(digest, rel)
                                    if duplicate_of:
                                        state.checksum_duplicate_count += 1
                                    checksum_record = checksum_record_for_path(
                                        state,
                                        record,
                                        stat_result,
                                        digest,
                                        duplicate_of,
                                        reused=False,
                                    )
                                    state.files_hashed += 1
                                    state.bytes_hashed += stat_result.st_size
                                checksum_index.remember(checksum_record)
                                append_jsonl(checksum_handle, checksum_record)
                            except OSError as error:
                                checksum_error = True
                                error_writer.writerow(record_scan_error(state, rel, "checksum", error))

                        metadata_record = metadata_for_path(path, root, record)
                        if metadata_record:
                            state.metadata_record_count += 1
                            append_jsonl(metadata_handle, metadata_record)
                            if is_volume_candidate(metadata_record):
                                state.volume_candidate_count += 1
                                candidate_writer.writerow(candidate_from_metadata(metadata_record))

                        metadata_gaps = metadata_gap_records(record, metadata_record)
                        state.metadata_gap_count += len(metadata_gaps)
                        gap_writer.writerows(metadata_gaps)
                        append_jsonl(
                            status_ledger_handle,
                            asset_status_ledger_record(
                                state,
                                record,
                                checksum_record,
                                checksum_error,
                                metadata_record,
                                metadata_gaps,
                            ),
                        )
                        state.status_record_count += 1
                        append_jsonl(manifest, record)

                        now = time.monotonic()
                        file_interval_due = state.file_count - last_progress_file_count >= progress_interval_files
                        time_interval_due = (
                            progress_interval_seconds > 0
                            and now - last_progress_time >= progress_interval_seconds
                        )
                        if file_interval_due or time_interval_due:
                            for handle in artifact_handles:
                                handle.flush()
                            checksum_index.checkpoint()
                            emit_progress(
                                state,
                                progress_handle,
                                checkpoint_path,
                                phase="running",
                                event="progress_checkpoint",
                                started_monotonic=started_monotonic,
                                current_directory=current_relative_dir,
                                last_relative_path=rel,
                            )
                            last_progress_file_count = state.file_count
                            last_progress_time = now
            finally:
                for handle in artifact_handles:
                    handle.flush()

        checksum_index.finish()
        publish_staged_artifacts(staged_paths)
        write_summary_outputs(state)
        emit_progress(
            state,
            progress_handle,
            checkpoint_path,
            phase="completed",
            event="scan_finished",
            started_monotonic=started_monotonic,
        )
    except BaseException as error:
        try:
            emit_progress(
                state,
                progress_handle,
                checkpoint_path,
                phase="failed",
                event="scan_failed",
                started_monotonic=started_monotonic,
                error=str(error),
            )
        except Exception:
            pass
        raise
    finally:
        progress_handle.close()
        checksum_index.close()
        scan_lock.close()

    return summary_payload(state)


def summary_payload(state: ScanState) -> dict[str, Any]:
    finished_at = utc_now()
    return {
        "schema": "cell-anatomy-archive-inventory-summary",
        "schema_version": SCHEMA_VERSION,
        "scanner": SCANNER_VERSION,
        "run_id": state.run_id,
        "archive_id": state.archive_id,
        "root": str(state.root),
        "output_dir": str(state.output_dir),
        "started_at": state.started_at,
        "finished_at": finished_at,
        "file_count": state.file_count,
        "directory_count": state.directory_count,
        "symlink_count": state.symlink_count,
        "unreadable_count": state.unreadable_count,
        "bytes_total": state.bytes_total,
        "extension_count": len(state.extension_counts),
        "metadata_records": state.metadata_record_count,
        "metadata_gaps": state.metadata_gap_count,
        "volume_candidates": state.volume_candidate_count,
        "status_records": state.status_record_count,
        "modified_at_min": iso_from_timestamp(state.modified_min) if state.modified_min else None,
        "modified_at_max": iso_from_timestamp(state.modified_max) if state.modified_max else None,
        "path_type_counts": dict(sorted(state.path_type_counts.items())),
        "likely_role_counts": dict(sorted(state.likely_role_counts.items())),
        "checksum": {
            "algorithm": state.checksum_algorithm,
            "files_hashed": state.files_hashed,
            "files_reused": state.files_reused,
            "records_written": state.files_hashed + state.files_reused,
            "bytes_hashed": state.bytes_hashed,
            "bytes_reused": state.bytes_reused,
            "duplicate_files": state.checksum_duplicate_count,
        },
        "artifacts": {
            "file_manifest": "file-manifest.jsonl",
            "metadata_extraction": "metadata-extraction.jsonl",
            "metadata_gaps": "metadata-gaps.csv",
            "volume_candidates": "volume-candidates.csv",
            "asset_status_ledger": "asset-status-ledger.jsonl",
            "extension_summary": "extension-summary.csv",
            "largest_files": "largest-files.csv",
            "scan_errors": "scan-errors.csv",
            "scan_progress": "scan-progress.jsonl",
            "scan_checkpoint": "scan-checkpoint.json",
            "scan_state": SCAN_STATE_FILENAME,
            "scan_lock": "scan.lock",
            "checksums": "checksums.jsonl" if state.checksum_algorithm else None,
            "fixity_run": "fixity-run.json" if state.checksum_algorithm else None,
        },
    }


def write_summary_outputs(state: ScanState) -> None:
    summary = summary_payload(state)
    write_csv_atomic(
        state.output_dir / "extension-summary.csv",
        ["extension", "file_count", "size_bytes"],
        (
            {
                "extension": extension,
                "file_count": count,
                "size_bytes": state.extension_bytes[extension],
            }
            for extension, count in sorted(state.extension_counts.items())
        ),
    )
    write_csv_atomic(
        state.output_dir / "largest-files.csv",
        ["relative_path", "size_bytes", "extension", "likely_role"],
        state.largest_files,
    )

    if state.checksum_algorithm:
        write_json_atomic(
            state.output_dir / "fixity-run.json",
            {
                "schema": "cell-anatomy-archive-fixity-run",
                "schema_version": SCHEMA_VERSION,
                "scanner": SCANNER_VERSION,
                "run_id": state.run_id,
                "archive_id": state.archive_id,
                "root": str(state.root),
                "algorithm": state.checksum_algorithm,
                "started_at": state.started_at,
                "files_hashed": state.files_hashed,
                "files_reused": state.files_reused,
                "records_written": state.files_hashed + state.files_reused,
                "bytes_hashed": state.bytes_hashed,
                "bytes_reused": state.bytes_reused,
                "duplicate_files": state.checksum_duplicate_count,
                "progress_log": "scan-progress.jsonl",
                "checkpoint": "scan-checkpoint.json",
                "finished_at": utc_now(),
            },
        )
    write_json_atomic(state.output_dir / "inventory-summary.json", summary)


def issue_count(issues: list[dict[str, Any]], issue_type: str) -> int:
    return sum(1 for issue in issues if issue["issue_type"] == issue_type)


def checksum_digest(record: dict[str, Any] | None) -> str:
    value = (record or {}).get("digest")
    return value if isinstance(value, str) else ""


def checksum_algorithm(record: dict[str, Any] | None) -> str:
    value = (record or {}).get("algorithm")
    return value if isinstance(value, str) else ""


def add_copy_issue(
    issues: list[dict[str, Any]],
    issue_type: str,
    relative_path: str,
    source_record: dict[str, Any] | None,
    target_record: dict[str, Any] | None,
    source_checksum: dict[str, Any] | None,
    target_checksum: dict[str, Any] | None,
    detail: str,
) -> None:
    issues.append(
        copy_issue_record(
            issue_type,
            relative_path,
            source_record,
            target_record,
            source_checksum,
            target_checksum,
            detail,
        )
    )


def copy_issue_record(
    issue_type: str,
    relative_path: str,
    source_record: dict[str, Any] | None,
    target_record: dict[str, Any] | None,
    source_checksum: dict[str, Any] | None,
    target_checksum: dict[str, Any] | None,
    detail: str,
) -> dict[str, Any]:
    return {
        "issue_type": issue_type,
        "relative_path": relative_path,
        "source_path_type": (source_record or {}).get("path_type") or "",
        "target_path_type": (target_record or {}).get("path_type") or "",
        "source_size_bytes": (source_record or {}).get("size_bytes") or "",
        "target_size_bytes": (target_record or {}).get("size_bytes") or "",
        "source_algorithm": checksum_algorithm(source_checksum),
        "target_algorithm": checksum_algorithm(target_checksum),
        "source_digest": checksum_digest(source_checksum),
        "target_digest": checksum_digest(target_checksum),
        "detail": detail,
    }


def write_copy_issues_csv(path: Path, issues: list[dict[str, Any]]) -> None:
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=COPY_ISSUE_FIELDS)
        writer.writeheader()
        writer.writerows(issues)


class CopyVerificationIndex:
    def __init__(self, path: Path) -> None:
        if path.exists():
            path.unlink()
        self.path = path
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute(
            """
            CREATE TABLE records (
                side TEXT NOT NULL,
                kind TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY(side, kind, relative_path)
            )
            """
        )

    def load(self, side: str, kind: str, path: Path) -> None:
        rows: list[tuple[str, str, str, str]] = []
        for record in iter_jsonl_records(path):
            relative = record.get("relative_path")
            if not isinstance(relative, str) or not relative:
                continue
            rows.append((side, kind, relative, json.dumps(record, sort_keys=True)))
            if len(rows) >= 1000:
                self.connection.executemany(
                    "INSERT OR REPLACE INTO records(side, kind, relative_path, payload) VALUES (?, ?, ?, ?)",
                    rows,
                )
                rows.clear()
        if rows:
            self.connection.executemany(
                "INSERT OR REPLACE INTO records(side, kind, relative_path, payload) VALUES (?, ?, ?, ?)",
                rows,
            )
        self.connection.commit()

    def count(self, side: str, kind: str) -> int:
        row = self.connection.execute(
            "SELECT COUNT(*) FROM records WHERE side = ? AND kind = ?",
            (side, kind),
        ).fetchone()
        return int(row[0])

    def path_counts(self) -> tuple[int, int, int]:
        row = self.connection.execute(
            """
            WITH paths AS (
                SELECT relative_path, MAX(side = 'source') AS in_source, MAX(side = 'target') AS in_target
                FROM records
                WHERE kind = 'manifest'
                GROUP BY relative_path
            )
            SELECT
                SUM(in_source = 1 AND in_target = 1),
                SUM(in_source = 1 AND in_target = 0),
                SUM(in_source = 0 AND in_target = 1)
            FROM paths
            """
        ).fetchone()
        return tuple(int(value or 0) for value in row)  # type: ignore[return-value]

    def rows(self) -> Iterator[tuple[str, dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]]:
        query = """
            WITH paths AS (
                SELECT relative_path FROM records WHERE kind = 'manifest' GROUP BY relative_path
            )
            SELECT
                paths.relative_path,
                source_manifest.payload,
                target_manifest.payload,
                source_checksum.payload,
                target_checksum.payload
            FROM paths
            LEFT JOIN records AS source_manifest
              ON source_manifest.side = 'source'
             AND source_manifest.kind = 'manifest'
             AND source_manifest.relative_path = paths.relative_path
            LEFT JOIN records AS target_manifest
              ON target_manifest.side = 'target'
             AND target_manifest.kind = 'manifest'
             AND target_manifest.relative_path = paths.relative_path
            LEFT JOIN records AS source_checksum
              ON source_checksum.side = 'source'
             AND source_checksum.kind = 'checksum'
             AND source_checksum.relative_path = paths.relative_path
            LEFT JOIN records AS target_checksum
              ON target_checksum.side = 'target'
             AND target_checksum.kind = 'checksum'
             AND target_checksum.relative_path = paths.relative_path
            ORDER BY paths.relative_path
        """
        for relative, source_record, target_record, source_checksum, target_checksum in self.connection.execute(query):
            yield (
                str(relative),
                json.loads(source_record) if source_record else None,
                json.loads(target_record) if target_record else None,
                json.loads(source_checksum) if source_checksum else None,
                json.loads(target_checksum) if target_checksum else None,
            )

    def close(self) -> None:
        self.connection.close()
        self.path.unlink(missing_ok=True)


def compare_scan_outputs(
    source_scan_dir: Path,
    target_scan_dir: Path,
    output_dir: Path,
    *,
    require_checksums: bool = False,
) -> dict[str, Any]:
    source_scan_dir = source_scan_dir.expanduser().resolve()
    target_scan_dir = target_scan_dir.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    source_summary = read_json_file(source_scan_dir / "inventory-summary.json")
    target_summary = read_json_file(target_scan_dir / "inventory-summary.json")
    verification_index = CopyVerificationIndex(output_dir / ".copy-verification-state.sqlite")
    issue_counts: Counter[str] = Counter()
    issues_preview: list[dict[str, Any]] = []
    checksum_compared = 0
    common_paths = 0
    source_manifest_count = 0
    target_manifest_count = 0
    source_checksum_count = 0
    target_checksum_count = 0
    mismatches_path = output_dir / "copy-verification-mismatches.csv"
    staged_mismatches = staged_artifact_path(mismatches_path)

    try:
        verification_index.load("source", "manifest", source_scan_dir / "file-manifest.jsonl")
        verification_index.load("target", "manifest", target_scan_dir / "file-manifest.jsonl")
        verification_index.load("source", "checksum", source_scan_dir / "checksums.jsonl")
        verification_index.load("target", "checksum", target_scan_dir / "checksums.jsonl")
        common_paths, _, _ = verification_index.path_counts()
        source_manifest_count = verification_index.count("source", "manifest")
        target_manifest_count = verification_index.count("target", "manifest")
        source_checksum_count = verification_index.count("source", "checksum")
        target_checksum_count = verification_index.count("target", "checksum")

        with staged_mismatches.open("w", newline="") as output:
            writer = csv.DictWriter(output, fieldnames=COPY_ISSUE_FIELDS)
            writer.writeheader()

            def record_issue(
                issue_type: str,
                relative_path: str,
                source_record: dict[str, Any] | None,
                target_record: dict[str, Any] | None,
                source_checksum: dict[str, Any] | None,
                target_checksum: dict[str, Any] | None,
                detail: str,
            ) -> None:
                issue = copy_issue_record(
                    issue_type,
                    relative_path,
                    source_record,
                    target_record,
                    source_checksum,
                    target_checksum,
                    detail,
                )
                writer.writerow(issue)
                issue_counts[issue_type] += 1
                if len(issues_preview) < 100:
                    issues_preview.append(issue)

            for relative, source_record, target_record, source_checksum, target_checksum in verification_index.rows():
                if source_record is None:
                    record_issue(
                        "unexpected_in_target",
                        relative,
                        None,
                        target_record,
                        None,
                        target_checksum,
                        "Target path is absent from the source scan.",
                    )
                    continue
                if target_record is None:
                    record_issue(
                        "missing_in_target",
                        relative,
                        source_record,
                        None,
                        source_checksum,
                        None,
                        "Source path is absent from the target scan.",
                    )
                    continue

                if source_record.get("path_type") != target_record.get("path_type"):
                    record_issue(
                        "path_type_mismatch",
                        relative,
                        source_record,
                        target_record,
                        source_checksum,
                        target_checksum,
                        "Source and target path types differ.",
                    )
                if int(source_record.get("size_bytes") or 0) != int(target_record.get("size_bytes") or 0):
                    record_issue(
                        "size_mismatch",
                        relative,
                        source_record,
                        target_record,
                        source_checksum,
                        target_checksum,
                        "Source and target byte sizes differ.",
                    )
                if require_checksums and source_record.get("path_type") == "file" and not source_checksum:
                    record_issue(
                        "missing_source_checksum",
                        relative,
                        source_record,
                        target_record,
                        source_checksum,
                        target_checksum,
                        "Checksum verification is required, but source has no checksum record for this file.",
                    )
                if require_checksums and target_record.get("path_type") == "file" and not target_checksum:
                    record_issue(
                        "missing_target_checksum",
                        relative,
                        source_record,
                        target_record,
                        source_checksum,
                        target_checksum,
                        "Checksum verification is required, but target has no checksum record for this file.",
                    )

                if source_checksum and target_checksum:
                    source_algorithm = checksum_algorithm(source_checksum)
                    target_algorithm = checksum_algorithm(target_checksum)
                    if source_algorithm != target_algorithm:
                        record_issue(
                            "checksum_algorithm_mismatch",
                            relative,
                            source_record,
                            target_record,
                            source_checksum,
                            target_checksum,
                            "Source and target checksum algorithms differ.",
                        )
                    elif checksum_digest(source_checksum) != checksum_digest(target_checksum):
                        record_issue(
                            "checksum_digest_mismatch",
                            relative,
                            source_record,
                            target_record,
                            source_checksum,
                            target_checksum,
                            "Source and target checksum digests differ.",
                        )
                    else:
                        checksum_compared += 1
                elif not require_checksums and source_checksum and not target_checksum:
                    record_issue(
                        "missing_target_checksum",
                        relative,
                        source_record,
                        target_record,
                        source_checksum,
                        target_checksum,
                        "Source has a checksum record but target does not.",
                    )
                elif not require_checksums and target_checksum and not source_checksum:
                    record_issue(
                        "missing_source_checksum",
                        relative,
                        source_record,
                        target_record,
                        source_checksum,
                        target_checksum,
                        "Target has a checksum record but source does not.",
                    )

            if require_checksums and (source_checksum_count == 0 or target_checksum_count == 0):
                record_issue(
                    "required_checksum_artifact_missing",
                    "",
                    None,
                    None,
                    None,
                    None,
                    "Checksum verification was required, but at least one scan has no checksum records.",
                )
        staged_mismatches.replace(mismatches_path)
    finally:
        verification_index.close()

    issue_total = sum(issue_counts.values())
    verification_level = "checksum" if checksum_compared else "inventory"
    passed = issue_total == 0 and (not require_checksums or verification_level == "checksum")
    report = {
        "schema": "cell-anatomy-archive-copy-verification-report",
        "schema_version": SCHEMA_VERSION,
        "scanner": SCANNER_VERSION,
        "generated_at": utc_now(),
        "status": "passed" if passed else "failed",
        "passed": passed,
        "verification_level": verification_level,
        "require_checksums": require_checksums,
        "source": {
            "scan_dir": str(source_scan_dir),
            "archive_id": source_summary.get("archive_id") or "",
            "root": source_summary.get("root") or "",
            "file_count": source_manifest_count,
            "checksum_records": source_checksum_count,
            "bytes_total": source_summary.get("bytes_total") or 0,
        },
        "target": {
            "scan_dir": str(target_scan_dir),
            "archive_id": target_summary.get("archive_id") or "",
            "root": target_summary.get("root") or "",
            "file_count": target_manifest_count,
            "checksum_records": target_checksum_count,
            "bytes_total": target_summary.get("bytes_total") or 0,
        },
        "counts": {
            "common_paths": common_paths,
            "missing_in_target": issue_counts["missing_in_target"],
            "unexpected_in_target": issue_counts["unexpected_in_target"],
            "path_type_mismatches": issue_counts["path_type_mismatch"],
            "size_mismatches": issue_counts["size_mismatch"],
            "checksum_compared": checksum_compared,
            "checksum_algorithm_mismatches": issue_counts["checksum_algorithm_mismatch"],
            "checksum_digest_mismatches": issue_counts["checksum_digest_mismatch"],
            "missing_source_checksums": issue_counts["missing_source_checksum"],
            "missing_target_checksums": issue_counts["missing_target_checksum"],
            "issue_count": issue_total,
        },
        "artifacts": {
            "mismatches": "copy-verification-mismatches.csv",
        },
        "issues_preview": issues_preview,
    }
    write_json_atomic(output_dir / "copy-verification-report.json", report)
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only archive scanner for CAOS data beachheads.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan = subparsers.add_parser("scan", help="Inventory a local archive root.")
    scan.add_argument("root", type=Path, help="Archive root directory to scan read-only.")
    scan.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory where scanner artifacts will be written.",
    )
    scan.add_argument("--archive-id", help="Stable archive id to write into manifests.")
    scan.add_argument(
        "--checksum",
        choices=["sha256"],
        help="Optional checksum algorithm. Omit for the fast inventory pass.",
    )
    scan.add_argument(
        "--resume-checksums",
        action="store_true",
        help="Reuse matching rows from an existing checksums.jsonl when size and modified time are unchanged.",
    )
    scan.add_argument(
        "--preflight-only",
        action="store_true",
        help="Validate source, output, locking, free space, and resume identity without scanning files.",
    )
    scan.add_argument(
        "--largest-file-limit",
        type=int,
        default=DEFAULT_LARGEST_FILE_LIMIT,
        help="Number of largest files to keep in largest-files.csv.",
    )
    scan.add_argument(
        "--progress-interval-files",
        type=int,
        default=DEFAULT_PROGRESS_INTERVAL_FILES,
        help="Write a progress checkpoint after this many additional discovered files.",
    )
    scan.add_argument(
        "--progress-interval-seconds",
        type=float,
        default=DEFAULT_PROGRESS_INTERVAL_SECONDS,
        help="Write a progress checkpoint after this many seconds even when the file interval is not reached.",
    )

    compare = subparsers.add_parser("compare-scans", help="Compare two scanner output directories after a copy.")
    compare.add_argument("source_scan_dir", type=Path, help="Scanner output directory for the source archive.")
    compare.add_argument("target_scan_dir", type=Path, help="Scanner output directory for the copied target archive.")
    compare.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory where copy verification artifacts will be written.",
    )
    compare.add_argument(
        "--require-checksums",
        action="store_true",
        help="Fail verification when checksum records are absent.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    started = time.monotonic()

    if args.command == "scan":
        if args.resume_checksums and not args.checksum:
            parser.error("--resume-checksums requires --checksum")
        if args.preflight_only:
            report = scan_preflight(
                args.root,
                args.output_dir,
                archive_id=args.archive_id,
                checksum_algorithm=args.checksum,
                resume_checksums=args.resume_checksums,
            )
            print(json.dumps(report, sort_keys=True))
            return 0 if report["status"] == "ready" else 2
        summary = scan_archive(
            args.root,
            args.output_dir,
            archive_id=args.archive_id,
            checksum_algorithm=args.checksum,
            resume_checksums=args.resume_checksums,
            largest_file_limit=max(1, args.largest_file_limit),
            progress_interval_files=max(1, args.progress_interval_files),
            progress_interval_seconds=max(0.0, args.progress_interval_seconds),
        )
        elapsed = time.monotonic() - started
        print(
            json.dumps(
                {
                    "status": "ok",
                    "archive_id": summary["archive_id"],
                    "file_count": summary["file_count"],
                    "bytes_total": summary["bytes_total"],
                    "metadata_gaps": summary["metadata_gaps"],
                    "volume_candidates": summary["volume_candidates"],
                    "checksum_records": summary["checksum"]["records_written"],
                    "checksum_reused": summary["checksum"]["files_reused"],
                    "output_dir": summary["output_dir"],
                    "elapsed_seconds": round(elapsed, 3),
                },
                sort_keys=True,
            )
        )
        return 0

    if args.command == "compare-scans":
        report = compare_scan_outputs(
            args.source_scan_dir,
            args.target_scan_dir,
            args.output_dir,
            require_checksums=args.require_checksums,
        )
        elapsed = time.monotonic() - started
        print(
            json.dumps(
                {
                    "status": report["status"],
                    "passed": report["passed"],
                    "verification_level": report["verification_level"],
                    "issue_count": report["counts"]["issue_count"],
                    "checksum_compared": report["counts"]["checksum_compared"],
                    "output_dir": str(args.output_dir.expanduser().resolve()),
                    "elapsed_seconds": round(elapsed, 3),
                },
                sort_keys=True,
            )
        )
        return 0 if report["passed"] else 1

    parser.error(f"Unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
