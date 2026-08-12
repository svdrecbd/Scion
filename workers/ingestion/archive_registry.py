from __future__ import annotations

import argparse
import csv
import fcntl
import hashlib
import json
import os
import sqlite3
import sys
import time
from collections.abc import Iterator
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REGISTRY_BUILDER_VERSION = "private-registry-import-v0.2"
STATUS_OVERLAY_VERSION = "private-registry-status-overlay-v0.1"
WORKSET_BUILDER_VERSION = "archive-workset-promote-v0.1"
SCHEMA_VERSION = 1
REGISTRY_SCHEMA = "cell-anatomy-private-archive-registry"
ASSET_SCHEMA = "cell-anatomy-private-archive-asset"
WORKSET_SCHEMA = "cell-anatomy-archive-workset"
MAX_WORKSET_ASSETS = 10_000
INTENDED_OPERATIONS = {"inspect", "convert", "measure", "publish", "review", "backup"}
STATUS_OVERLAY_FIELDS = {
    "asset_status",
    "fixity_status",
    "publication_status",
    "triage_status",
    "rights_status",
    "classification_status",
}
OPERATION_FIELDS = {
    "can_store_locally",
    "can_backup_to_cloud",
    "can_convert",
    "can_view_in_caos",
    "can_share_with_collaborators",
    "can_publish_derivatives",
    "can_release_publicly",
}
REVIEW_QUEUE_FIELDS = [
    "asset_id",
    "relative_path",
    "severity",
    "likely_role",
    "format",
    "status",
    "fixity_status",
    "rights_status",
    "reasons",
    "blockers",
    "recommended_actions",
]
REGISTRY_CANDIDATE_FIELDS = [
    "asset_id",
    "archive_id",
    "relative_path",
    "path_type",
    "format",
    "metadata_status",
    "dtype",
    "x",
    "y",
    "z",
    "size_bytes",
    "metadata_ready",
    "project_ready",
    "blockers",
]


@dataclass
class RegistryStats:
    asset_count: int = 0
    file_asset_count: int = 0
    logical_asset_count: int = 0
    bytes_total: int = 0
    volume_candidate_count: int = 0
    review_queue_count: int = 0
    metadata_gap_count: int = 0
    checksum_record_count: int = 0
    duplicate_asset_count: int = 0
    project_ready_count: int = 0
    extension_counts: Counter[str] = field(default_factory=Counter)
    role_counts: Counter[str] = field(default_factory=Counter)
    format_counts: Counter[str] = field(default_factory=Counter)
    status_counts: Counter[str] = field(default_factory=Counter)
    readiness_counts: Counter[str] = field(default_factory=Counter)


@dataclass
class WorksetSelection:
    workset_id: str
    title: str
    asset_ids: list[str] = field(default_factory=list)
    path_prefixes: list[str] = field(default_factory=list)
    queries: list[str] = field(default_factory=list)
    all_assets: bool = False
    volume_candidates_only: bool = False
    limit: int | None = None
    intended_operations: list[str] = field(default_factory=lambda: ["review"])
    notes: list[str] = field(default_factory=list)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_slug(value: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")
    return "-".join(part for part in slug.split("-") if part) or "registry"


def stable_asset_id(archive_id: str, relative_path: str) -> str:
    digest = hashlib.sha256(f"{archive_id}\n{relative_path}".encode("utf-8")).hexdigest()[:16]
    return f"{safe_slug(archive_id)}-{digest}"


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Required registry import input is missing: {path}")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return value


def iter_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    with path.open() as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"Expected JSON object at {path}:{line_number}")
            records.append(value)
    return records


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="") as source:
        return list(csv.DictReader(source))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def append_jsonl(handle, value: dict[str, Any]) -> None:
    handle.write(json.dumps(value, sort_keys=True) + "\n")


def staged_registry_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.inprogress")


@contextmanager
def registry_output_lock(output_dir: Path, operation: str) -> Iterator[None]:
    output_dir.mkdir(parents=True, exist_ok=True)
    lock_path = output_dir / ".registry-build.lock"
    handle = lock_path.open("a+")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(f"Another {operation} is already using {output_dir}.") from error
        handle.seek(0)
        handle.truncate()
        handle.write(json.dumps({"operation": operation, "pid": os.getpid(), "started_at": utc_now()}) + "\n")
        handle.flush()
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


class RegistryBuildIndex:
    """Disposable SQLite join index for archive-scale registry imports."""

    def __init__(self, path: Path) -> None:
        self.path = path
        if path.exists():
            path.unlink()
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.executescript(
            """
            CREATE TABLE records (
                kind TEXT NOT NULL,
                asset_key TEXT NOT NULL,
                quality_rank INTEGER NOT NULL DEFAULT 0,
                payload TEXT NOT NULL,
                PRIMARY KEY (kind, asset_key)
            );
            CREATE TABLE gaps (
                asset_key TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE INDEX gaps_asset_key_idx ON gaps(asset_key);
            CREATE TABLE manifest (
                relative_path TEXT PRIMARY KEY,
                size_bytes INTEGER NOT NULL,
                modified_at TEXT NOT NULL
            );
            """
        )

    def put_record(self, kind: str, key: str, payload: dict[str, Any], quality_rank: int = 0) -> None:
        if not key:
            return
        self.connection.execute(
            """
            INSERT INTO records(kind, asset_key, quality_rank, payload)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(kind, asset_key) DO UPDATE SET
                quality_rank = excluded.quality_rank,
                payload = excluded.payload
            WHERE excluded.quality_rank >= records.quality_rank
            """,
            (kind, key, quality_rank, json.dumps(payload, sort_keys=True)),
        )

    def load_jsonl(
        self,
        kind: str,
        path: Path,
        *,
        key_name: str = "relative_path",
        metadata_keys: bool = False,
    ) -> None:
        for index, payload in enumerate(iter_jsonl_stream(path), start=1):
            key = metadata_asset_key(payload) if metadata_keys else str(payload.get(key_name) or "")
            rank = metadata_quality_rank(payload) if metadata_keys else index
            self.put_record(kind, key, payload, rank)
            if index % 5000 == 0:
                self.connection.commit()
        self.connection.commit()

    def load_csv(self, kind: str, path: Path, *, grouped: bool = False) -> None:
        if not path.exists():
            return
        with path.open(newline="") as source:
            for index, payload in enumerate(csv.DictReader(source), start=1):
                key = str(payload.get("asset_relative_path") or payload.get("relative_path") or "")
                if grouped:
                    if key:
                        self.connection.execute(
                            "INSERT INTO gaps(asset_key, payload) VALUES (?, ?)",
                            (key, json.dumps(payload, sort_keys=True)),
                        )
                else:
                    self.put_record(kind, key, dict(payload), index)
                if index % 5000 == 0:
                    self.connection.commit()
        self.connection.commit()

    def get_record(self, kind: str, key: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT payload FROM records WHERE kind = ? AND asset_key = ?",
            (kind, key),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def get_gaps(self, key: str) -> list[dict[str, str]]:
        return [
            json.loads(row[0])
            for row in self.connection.execute(
                "SELECT payload FROM gaps WHERE asset_key = ? ORDER BY rowid",
                (key,),
            )
        ]

    def record_manifest(self, record: dict[str, Any]) -> None:
        relative = str(record.get("relative_path") or "")
        if not relative:
            return
        self.connection.execute(
            "INSERT OR REPLACE INTO manifest(relative_path, size_bytes, modified_at) VALUES (?, ?, ?)",
            (relative, int_value(record.get("size_bytes")), str(record.get("modified_at") or "")),
        )

    def synthetic_candidate_paths(self) -> Iterator[str]:
        rows = self.connection.execute(
            """
            SELECT records.asset_key
            FROM records
            LEFT JOIN manifest ON manifest.relative_path = records.asset_key
            WHERE records.kind = 'candidate' AND manifest.relative_path IS NULL
            ORDER BY records.asset_key
            """
        )
        for row in rows:
            yield str(row[0])

    def prefix_stats(self, relative_path: str) -> dict[str, Any]:
        prefix = f"{relative_path.rstrip('/')}/"
        upper_bound = f"{prefix}\U0010ffff"
        row = self.connection.execute(
            """
            SELECT COALESCE(SUM(size_bytes), 0), COUNT(*), COALESCE(MAX(modified_at), '')
            FROM manifest
            WHERE relative_path >= ? AND relative_path < ?
            """,
            (prefix, upper_bound),
        ).fetchone()
        return {"size_bytes": int(row[0]), "file_count": int(row[1]), "modified_at": str(row[2])}

    def checkpoint(self) -> None:
        self.connection.commit()

    def close(self) -> None:
        self.connection.commit()
        self.connection.close()
        self.path.unlink(missing_ok=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024 * 8)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def int_value(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def bool_value(value: Any) -> bool:
    return bool(value)


def list_value(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def dict_value(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def extension_for_path(relative_path: str) -> str:
    name = Path(relative_path).name.lower()
    if name.endswith(".ome.tif"):
        return ".ome.tif"
    if name.endswith(".ome.tiff"):
        return ".ome.tiff"
    if name.endswith(".nii.gz"):
        return ".nii.gz"
    return Path(name).suffix.lower()


def metadata_asset_key(record: dict[str, Any]) -> str:
    asset_path = record.get("asset_relative_path") or record.get("relative_path")
    return str(asset_path or "")


def metadata_quality_rank(record: dict[str, Any]) -> int:
    status = record.get("status")
    if status == "readable":
        return 3
    if status == "partial":
        return 2
    if status == "detected":
        return 1
    return 0


def map_metadata(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    mapped: dict[str, dict[str, Any]] = {}
    for record in records:
        key = metadata_asset_key(record)
        if not key:
            continue
        existing = mapped.get(key)
        if existing is None or metadata_quality_rank(record) >= metadata_quality_rank(existing):
            mapped[key] = record
    return mapped


def map_by_relative_path(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    mapped: dict[str, dict[str, Any]] = {}
    for record in records:
        relative = record.get("relative_path")
        if isinstance(relative, str) and relative:
            mapped[relative] = record
    return mapped


def map_csv_by_path(rows: list[dict[str, str]], key_name: str = "relative_path") -> dict[str, dict[str, str]]:
    mapped: dict[str, dict[str, str]] = {}
    for row in rows:
        key = row.get(key_name) or ""
        if key:
            mapped[key] = row
    return mapped


def group_metadata_gaps(rows: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        key = row.get("asset_relative_path") or row.get("relative_path") or ""
        if key:
            grouped.setdefault(key, []).append(row)
    return grouped


def default_status_record(record: dict[str, Any], checksum: dict[str, Any] | None) -> dict[str, Any]:
    path_type = str(record.get("path_type") or "file")
    return {
        "asset_status": "discovered",
        "fixity_status": "checksummed" if checksum else "not_requested",
        "publication_status": "unknown",
        "triage_status": "unknown",
        "rights_status": "unknown",
        "classification_status": "unreviewed",
        "blocked_states": ["blocked_permission"],
        "review_required": True,
        "review_notes": ["registry_import_default_status"],
        "allowed_operations": {
            "can_store_locally": path_type == "file",
            "can_backup_to_cloud": False,
            "can_convert": False,
            "can_view_in_caos": False,
            "can_share_with_collaborators": False,
            "can_publish_derivatives": False,
            "can_release_publicly": False,
        },
    }


def compact_status_record(record: dict[str, Any], status: dict[str, Any], checksum: dict[str, Any] | None) -> dict[str, Any]:
    fallback = default_status_record(record, checksum)
    fields = [
        "asset_status",
        "fixity_status",
        "publication_status",
        "triage_status",
        "rights_status",
        "classification_status",
        "blocked_states",
        "review_required",
        "review_notes",
    ]
    compact = {field: status.get(field, fallback[field]) for field in fields}
    compact["allowed_operations"] = allowed_operations(status)
    return compact


def allowed_operations(status: dict[str, Any]) -> dict[str, bool]:
    value = status.get("allowed_operations")
    if not isinstance(value, dict):
        return {
            "can_store_locally": True,
            "can_backup_to_cloud": False,
            "can_convert": False,
            "can_view_in_caos": False,
            "can_share_with_collaborators": False,
            "can_publish_derivatives": False,
            "can_release_publicly": False,
        }
    keys = [
        "can_store_locally",
        "can_backup_to_cloud",
        "can_convert",
        "can_view_in_caos",
        "can_share_with_collaborators",
        "can_publish_derivatives",
        "can_release_publicly",
    ]
    return {key: bool(value.get(key)) for key in keys}


def compact_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    if not metadata:
        return {
            "status": "not_extracted",
            "format": "",
            "dimensions": {},
            "dtype": "",
            "voxel_size_nm": None,
            "metadata_source": "",
            "source_metadata_path": "",
        }
    return {
        "status": metadata.get("status") or "unknown",
        "format": metadata.get("format") or "",
        "dimensions": metadata.get("dimensions") if isinstance(metadata.get("dimensions"), dict) else {},
        "shape": metadata.get("shape"),
        "chunks": metadata.get("chunks"),
        "dtype": metadata.get("dtype") or "",
        "voxel_size_nm": metadata.get("voxel_size_nm"),
        "metadata_source": metadata.get("metadata_source") or "",
        "source_metadata_path": metadata.get("relative_path") or "",
        "warning": metadata.get("warning") or metadata.get("error") or "",
    }


def compact_checksum(checksum: dict[str, Any] | None) -> dict[str, Any]:
    if not checksum:
        return {
            "algorithm": "",
            "digest": "",
            "duplicate_of": "",
            "computed_at": "",
            "reused_from_previous_run": False,
        }
    return {
        "algorithm": checksum.get("algorithm") or "",
        "digest": checksum.get("digest") or "",
        "duplicate_of": checksum.get("duplicate_of") or "",
        "computed_at": checksum.get("computed_at") or "",
        "reused_from_previous_run": bool(checksum.get("reused_from_previous_run")),
    }


def metadata_ready(metadata: dict[str, Any]) -> bool:
    dimensions = metadata.get("dimensions") if isinstance(metadata.get("dimensions"), dict) else {}
    dtype_ready = bool(metadata.get("dtype")) or metadata.get("metadata_source") == "public_data_conversion_readiness_manifest"
    return bool(
        metadata.get("status") == "readable"
        and dimensions.get("x")
        and dimensions.get("y")
        and dimensions.get("z")
        and dtype_ready
        and metadata.get("voxel_size_nm")
    )


def readiness_for_asset(
    record: dict[str, Any],
    checksum: dict[str, Any] | None,
    status: dict[str, Any],
    metadata: dict[str, Any],
    gaps: list[dict[str, str]],
    is_volume_candidate: bool,
) -> dict[str, Any]:
    operations = allowed_operations(status)
    blockers = set(status.get("blocked_states") if isinstance(status.get("blocked_states"), list) else [])
    gap_codes = [gap.get("gap_code") or "" for gap in gaps if gap.get("gap_code")]
    blockers.update(gap_codes)

    path_type = str(record.get("path_type") or "file")
    if path_type == "file" and not checksum:
        blockers.add("missing_checksum")
    if is_volume_candidate and not metadata_ready(metadata):
        blockers.add("blocked_missing_metadata")
    if not operations.get("can_view_in_caos"):
        blockers.add("blocked_permission")

    project_ready = bool(operations.get("can_view_in_caos") and checksum and metadata_ready(metadata) and not blockers)
    conversion_ready = bool(operations.get("can_convert") and checksum and metadata_ready(metadata) and not blockers)

    return {
        "metadata_ready": metadata_ready(metadata),
        "has_checksum": bool(checksum),
        "is_volume_candidate": is_volume_candidate,
        "conversion_ready": conversion_ready,
        "project_ready": project_ready,
        "blockers": sorted(blocker for blocker in blockers if blocker),
    }


def review_row_for_asset(asset: dict[str, Any]) -> dict[str, str] | None:
    readiness = asset["readiness"]
    metadata = asset["metadata"]
    review = asset["review"]
    checksum = asset["checksum"]
    is_candidate = bool(readiness["is_volume_candidate"])
    has_gaps = bool(review["gap_codes"])
    duplicate_of = checksum.get("duplicate_of") or ""
    fixity_status = asset["status"].get("fixity_status") or ""

    if not (is_candidate or has_gaps or duplicate_of or fixity_status == "error"):
        return None

    reasons: list[str] = []
    if is_candidate:
        reasons.append("volume_candidate")
    if has_gaps:
        reasons.extend(review["gap_codes"])
    if duplicate_of:
        reasons.append("duplicate_checksum")
    if fixity_status == "error":
        reasons.append("checksum_error")

    severity = "review"
    if any(gap.get("severity") == "blocker" for gap in review["gaps"]):
        severity = "blocker"
    if fixity_status == "error":
        severity = "blocker"

    return {
        "asset_id": asset["asset_id"],
        "relative_path": asset["relative_path"],
        "severity": severity,
        "likely_role": asset["likely_role"],
        "format": str(metadata.get("format") or ""),
        "status": asset["status"].get("asset_status") or "",
        "fixity_status": fixity_status,
        "rights_status": asset["status"].get("rights_status") or "unknown",
        "reasons": ";".join(reasons),
        "blockers": ";".join(readiness["blockers"]),
        "recommended_actions": " ".join(review["recommended_actions"]),
    }


def search_index_for_asset(asset: dict[str, Any]) -> dict[str, Any]:
    metadata = asset["metadata"]
    status = asset["status"]
    tokens = [
        asset["archive_id"],
        asset["relative_path"],
        Path(asset["relative_path"]).name,
        asset["extension"],
        asset["likely_role"],
        str(metadata.get("format") or ""),
        str(metadata.get("dtype") or ""),
        str(status.get("publication_status") or ""),
        str(status.get("triage_status") or ""),
        str(status.get("rights_status") or ""),
    ]
    return {
        "schema": "cell-anatomy-private-archive-search-entry",
        "schema_version": SCHEMA_VERSION,
        "asset_id": asset["asset_id"],
        "archive_id": asset["archive_id"],
        "relative_path": asset["relative_path"],
        "title": Path(asset["relative_path"]).name or asset["relative_path"],
        "search_text": " ".join(token for token in tokens if token).lower(),
        "format": metadata.get("format") or "",
        "likely_role": asset["likely_role"],
        "project_ready": asset["readiness"]["project_ready"],
        "volume_candidate": asset["readiness"]["is_volume_candidate"],
    }


def asset_record(
    registry_id: str,
    summary: dict[str, Any],
    record: dict[str, Any],
    checksum: dict[str, Any] | None,
    status: dict[str, Any],
    metadata: dict[str, Any] | None,
    gaps: list[dict[str, str]],
    candidate: dict[str, str] | None,
) -> dict[str, Any]:
    archive_id = str(summary.get("archive_id") or record.get("archive_id") or "archive")
    relative_path = str(record["relative_path"])
    compact_status = compact_status_record(record, status, checksum)

    compact_meta = compact_metadata(metadata)
    compact_fixity = compact_checksum(checksum)
    is_candidate = bool(candidate)
    readiness = readiness_for_asset(record, checksum, compact_status, compact_meta, gaps, is_candidate)
    recommended_actions = sorted(
        {
            action
            for gap in gaps
            for action in [gap.get("suggested_action") or ""]
            if action
        }
    )

    return {
        "schema": ASSET_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "registry_id": registry_id,
        "registry_builder": REGISTRY_BUILDER_VERSION,
        "asset_id": stable_asset_id(archive_id, relative_path),
        "archive_id": archive_id,
        "relative_path": relative_path,
        "name": record.get("name") or Path(relative_path).name,
        "path_type": record.get("path_type") or "file",
        "extension": record.get("extension") or extension_for_path(relative_path),
        "likely_role": record.get("likely_role") or "unknown",
        "size_bytes": int_value(record.get("size_bytes")),
        "modified_at": record.get("modified_at") or "",
        "source": {
            "root": summary.get("root") or record.get("root") or "",
            "relative_path": relative_path,
            "link_target": record.get("link_target") or "",
        },
        "checksum": compact_fixity,
        "metadata": compact_meta,
        "status": compact_status,
        "volume_candidate": {
            "is_candidate": is_candidate,
            "source_metadata_path": (candidate or {}).get("source_metadata_path") or compact_meta.get("source_metadata_path") or "",
            "candidate_status": (candidate or {}).get("status") or "",
        },
        "review": {
            "gap_count": len(gaps),
            "gap_codes": [gap.get("gap_code") or "" for gap in gaps if gap.get("gap_code")],
            "gap_severities": sorted({gap.get("severity") or "review" for gap in gaps}),
            "gaps": gaps,
            "recommended_actions": recommended_actions,
        },
        "readiness": readiness,
    }


def summarize_asset(stats: RegistryStats, asset: dict[str, Any]) -> None:
    stats.asset_count += 1
    if asset["path_type"] == "directory_volume":
        stats.logical_asset_count += 1
    else:
        stats.file_asset_count += 1
    stats.bytes_total += int_value(asset.get("size_bytes"))
    stats.extension_counts.update([asset["extension"] or "[none]"])
    stats.role_counts.update([asset["likely_role"] or "unknown"])
    stats.format_counts.update([asset["metadata"].get("format") or "[none]"])
    stats.status_counts.update([asset["status"].get("asset_status") or "unknown"])
    stats.readiness_counts.update(asset["readiness"]["blockers"] or ["ready"])
    stats.metadata_gap_count += len(asset["review"]["gap_codes"])
    if asset["checksum"].get("digest"):
        stats.checksum_record_count += 1
    if asset["checksum"].get("duplicate_of"):
        stats.duplicate_asset_count += 1
    if asset["readiness"]["is_volume_candidate"]:
        stats.volume_candidate_count += 1
    if asset["readiness"]["project_ready"]:
        stats.project_ready_count += 1


def candidate_prefix_stats(manifest_rows: list[dict[str, Any]], candidate_paths: set[str]) -> dict[str, dict[str, Any]]:
    stats = {
        candidate: {"size_bytes": 0, "file_count": 0, "modified_at": ""}
        for candidate in candidate_paths
    }
    for row in manifest_rows:
        relative = str(row.get("relative_path") or "")
        for candidate in candidate_paths:
            prefix = f"{candidate.rstrip('/')}/"
            if relative.startswith(prefix):
                item = stats[candidate]
                item["size_bytes"] += int_value(row.get("size_bytes"))
                item["file_count"] += 1
                modified = str(row.get("modified_at") or "")
                if modified > item["modified_at"]:
                    item["modified_at"] = modified
    return stats


def synthetic_candidate_record(
    summary: dict[str, Any],
    relative_path: str,
    prefix_stats: dict[str, Any],
) -> dict[str, Any]:
    return {
        "archive_id": summary.get("archive_id") or "archive",
        "root": summary.get("root") or "",
        "relative_path": relative_path,
        "name": Path(relative_path).name,
        "extension": extension_for_path(relative_path),
        "path_type": "directory_volume",
        "size_bytes": int_value(prefix_stats.get("size_bytes")),
        "modified_at": prefix_stats.get("modified_at") or "",
        "likely_role": "raw_volume_candidate",
    }


def _build_private_registry_unlocked(
    scan_dir: Path,
    output_dir: Path,
    *,
    registry_id: str | None = None,
) -> dict[str, Any]:
    scan_dir = scan_dir.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    summary = read_json(scan_dir / "inventory-summary.json")

    archive_id = str(summary.get("archive_id") or "archive")
    registry_id = registry_id or f"{safe_slug(archive_id)}-private-registry"
    output_dir.mkdir(parents=True, exist_ok=True)

    assets_path = output_dir / "private-registry-assets.jsonl"
    search_path = output_dir / "private-registry-search-index.jsonl"
    review_path = output_dir / "private-registry-review-queue.csv"
    candidates_path = output_dir / "private-registry-volume-candidates.csv"
    build_index = RegistryBuildIndex(output_dir / ".private-registry-build.sqlite")

    stats = RegistryStats()
    try:
        build_index.load_jsonl(
            "metadata",
            scan_dir / "metadata-extraction.jsonl",
            metadata_keys=True,
        )
        build_index.load_jsonl("checksum", scan_dir / "checksums.jsonl")
        build_index.load_jsonl("status", scan_dir / "asset-status-ledger.jsonl")
        build_index.load_csv("gap", scan_dir / "metadata-gaps.csv", grouped=True)
        build_index.load_csv("candidate", scan_dir / "volume-candidates.csv")

        staged_assets = staged_registry_path(assets_path)
        staged_search = staged_registry_path(search_path)
        staged_review = staged_registry_path(review_path)
        staged_candidates = staged_registry_path(candidates_path)
        with (
            staged_assets.open("w") as assets_handle,
            staged_search.open("w") as search_handle,
            staged_review.open("w", newline="") as review_handle,
            staged_candidates.open("w", newline="") as candidates_handle,
        ):
            review_writer = csv.DictWriter(review_handle, fieldnames=REVIEW_QUEUE_FIELDS)
            candidate_writer = csv.DictWriter(candidates_handle, fieldnames=REGISTRY_CANDIDATE_FIELDS)
            review_writer.writeheader()
            candidate_writer.writeheader()

            for index, row in enumerate(iter_jsonl_stream(scan_dir / "file-manifest.jsonl"), start=1):
                relative = str(row.get("relative_path") or "")
                if not relative:
                    continue
                build_index.record_manifest(row)
                checksum = build_index.get_record("checksum", relative)
                status = build_index.get_record("status", relative) or default_status_record(row, checksum)
                asset = asset_record(
                    registry_id,
                    summary,
                    row,
                    checksum,
                    status,
                    build_index.get_record("metadata", relative),
                    build_index.get_gaps(relative),
                    build_index.get_record("candidate", relative),
                )
                append_jsonl(assets_handle, asset)
                append_jsonl(search_handle, search_index_for_asset(asset))
                summarize_asset(stats, asset)
                review_row = review_row_for_asset(asset)
                if review_row:
                    review_writer.writerow(review_row)
                    stats.review_queue_count += 1
                if asset["readiness"]["is_volume_candidate"]:
                    candidate_writer.writerow(volume_candidate_export_row(asset))
                if index % 5000 == 0:
                    build_index.checkpoint()
                    for handle in (assets_handle, search_handle, review_handle, candidates_handle):
                        handle.flush()
            build_index.checkpoint()

            for relative in build_index.synthetic_candidate_paths():
                row = synthetic_candidate_record(summary, relative, build_index.prefix_stats(relative))
                status = default_status_record(row, None)
                status["fixity_status"] = "component_checksums_pending"
                asset = asset_record(
                    registry_id,
                    summary,
                    row,
                    None,
                    status,
                    build_index.get_record("metadata", relative),
                    build_index.get_gaps(relative),
                    build_index.get_record("candidate", relative),
                )
                asset["readiness"]["blockers"] = sorted(
                    set(asset["readiness"]["blockers"]) | {"missing_composite_checksum"}
                )
                append_jsonl(assets_handle, asset)
                append_jsonl(search_handle, search_index_for_asset(asset))
                summarize_asset(stats, asset)
                review_row = review_row_for_asset(asset)
                if review_row:
                    review_writer.writerow(review_row)
                    stats.review_queue_count += 1
                candidate_writer.writerow(volume_candidate_export_row(asset))

        for path in (assets_path, search_path, review_path, candidates_path):
            staged_registry_path(path).replace(path)
    finally:
        build_index.close()

    registry_summary = registry_summary_payload(
        registry_id=registry_id,
        scan_dir=scan_dir,
        output_dir=output_dir,
        source_summary=summary,
        stats=stats,
    )
    summary_path = output_dir / "private-registry.json"
    staged_summary = staged_registry_path(summary_path)
    write_json(staged_summary, registry_summary)
    staged_summary.replace(summary_path)
    return registry_summary


def build_private_registry(scan_dir: Path, output_dir: Path, *, registry_id: str | None = None) -> dict[str, Any]:
    resolved_output = output_dir.expanduser().resolve()
    with registry_output_lock(resolved_output, "private registry import"):
        return _build_private_registry_unlocked(scan_dir, resolved_output, registry_id=registry_id)


def volume_candidate_export_row(asset: dict[str, Any]) -> dict[str, Any]:
    dimensions = asset["metadata"].get("dimensions") if isinstance(asset["metadata"].get("dimensions"), dict) else {}
    return {
        "asset_id": asset["asset_id"],
        "archive_id": asset["archive_id"],
        "relative_path": asset["relative_path"],
        "path_type": asset["path_type"],
        "format": asset["metadata"].get("format") or "",
        "metadata_status": asset["metadata"].get("status") or "",
        "dtype": asset["metadata"].get("dtype") or "",
        "x": dimensions.get("x", ""),
        "y": dimensions.get("y", ""),
        "z": dimensions.get("z", ""),
        "size_bytes": asset["size_bytes"],
        "metadata_ready": asset["readiness"]["metadata_ready"],
        "project_ready": asset["readiness"]["project_ready"],
        "blockers": ";".join(asset["readiness"]["blockers"]),
    }


def write_review_queue(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=REVIEW_QUEUE_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def write_volume_candidates(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=REGISTRY_CANDIDATE_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def registry_summary_payload(
    *,
    registry_id: str,
    scan_dir: Path,
    output_dir: Path,
    source_summary: dict[str, Any],
    stats: RegistryStats,
) -> dict[str, Any]:
    return {
        "schema": REGISTRY_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "registry_builder": REGISTRY_BUILDER_VERSION,
        "registry_id": registry_id,
        "created_at": utc_now(),
        "source_scan": {
            "scan_dir": str(scan_dir),
            "archive_id": source_summary.get("archive_id"),
            "root": source_summary.get("root"),
            "scanner": source_summary.get("scanner"),
            "started_at": source_summary.get("started_at"),
            "finished_at": source_summary.get("finished_at"),
            "file_count": source_summary.get("file_count"),
            "bytes_total": source_summary.get("bytes_total"),
        },
        "asset_count": stats.asset_count,
        "file_asset_count": stats.file_asset_count,
        "logical_asset_count": stats.logical_asset_count,
        "bytes_total": stats.bytes_total,
        "volume_candidate_count": stats.volume_candidate_count,
        "review_queue_count": stats.review_queue_count,
        "metadata_gap_count": stats.metadata_gap_count,
        "checksum_record_count": stats.checksum_record_count,
        "duplicate_asset_count": stats.duplicate_asset_count,
        "project_ready_count": stats.project_ready_count,
        "extension_counts": dict(sorted(stats.extension_counts.items())),
        "role_counts": dict(sorted(stats.role_counts.items())),
        "format_counts": dict(sorted(stats.format_counts.items())),
        "status_counts": dict(sorted(stats.status_counts.items())),
        "readiness_counts": dict(sorted(stats.readiness_counts.items())),
        "artifacts": {
            "registry_summary": "private-registry.json",
            "assets": "private-registry-assets.jsonl",
            "search_index": "private-registry-search-index.jsonl",
            "review_queue": "private-registry-review-queue.csv",
            "volume_candidates": "private-registry-volume-candidates.csv",
        },
        "output_dir": str(output_dir),
    }


def path_relative_to_root(root: Path, path: str | Path) -> str:
    value = Path(path).expanduser()
    try:
        return value.resolve().relative_to(root.resolve()).as_posix()
    except (OSError, ValueError):
        return value.as_posix()


def checksum_record_from_digest(
    *,
    archive_id: str,
    relative_path: str,
    algorithm: str,
    digest: str,
    size_bytes: int,
    modified_at: str = "",
) -> dict[str, Any]:
    return {
        "schema": "cell-anatomy-archive-checksum",
        "schema_version": SCHEMA_VERSION,
        "scanner": "public-data-registry-import-v0.1",
        "archive_id": archive_id,
        "relative_path": relative_path,
        "algorithm": algorithm,
        "digest": digest,
        "size_bytes": size_bytes,
        "modified_at": modified_at,
        "device_id": "",
        "inode": "",
        "duplicate_of": "",
        "computed_at": utc_now(),
        "reused_from_previous_run": False,
    }


def composite_checksum_for_directory(path: Path, root: Path, archive_id: str, relative_path: str) -> dict[str, Any] | None:
    if not path.exists() or not path.is_dir():
        return None

    digest = hashlib.sha256()
    total_bytes = 0
    latest_modified = ""
    file_count = 0
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        rel = child.relative_to(path).as_posix()
        stat_result = child.stat()
        child_digest = sha256_file(child)
        total_bytes += stat_result.st_size
        file_count += 1
        modified = datetime.fromtimestamp(stat_result.st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")
        latest_modified = max(latest_modified, modified)
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(stat_result.st_size).encode("ascii"))
        digest.update(b"\0")
        digest.update(child_digest.encode("ascii"))
        digest.update(b"\n")

    if file_count == 0:
        return None

    record = checksum_record_from_digest(
        archive_id=archive_id,
        relative_path=relative_path,
        algorithm="sha256-tree-v1",
        digest=digest.hexdigest(),
        size_bytes=total_bytes,
        modified_at=latest_modified,
    )
    record["component_count"] = file_count
    record["root"] = str(root)
    return record


def public_source_status(state: str, *, converted: bool = False) -> dict[str, Any]:
    blocked_states: list[str] = []
    if state in {"blocked", "needs_review"}:
        blocked_states.append("blocked_review")

    can_convert = state in {"validated", "ready_for_conversion_trial", "ready_with_review_notes"}
    return {
        "asset_status": "validated" if can_convert else state or "indexed",
        "fixity_status": "checksummed",
        "publication_status": "published",
        "triage_status": "validated" if can_convert else state or "unknown",
        "rights_status": "public",
        "classification_status": "public_data_pilot",
        "blocked_states": blocked_states,
        "review_required": bool(blocked_states),
        "review_notes": ["public_data_manifest", *([] if not converted else ["streamable_derivative_available"])],
        "allowed_operations": {
            "can_store_locally": True,
            "can_backup_to_cloud": False,
            "can_convert": can_convert,
            "can_view_in_caos": False,
            "can_share_with_collaborators": False,
            "can_publish_derivatives": False,
            "can_release_publicly": False,
        },
    }


def public_derivative_status(validation_status: str, checksum: dict[str, Any] | None) -> dict[str, Any]:
    blocked_states: list[str] = []
    if validation_status != "passed":
        blocked_states.append("blocked_validation")
    if not checksum:
        blocked_states.append("missing_composite_checksum")

    return {
        "asset_status": "project_ready" if not blocked_states else "derived_review",
        "fixity_status": "composite_checksummed" if checksum else "component_checksums_pending",
        "publication_status": "published",
        "triage_status": "converted",
        "rights_status": "public",
        "classification_status": "public_data_pilot_derivative",
        "blocked_states": blocked_states,
        "review_required": bool(blocked_states),
        "review_notes": ["public_data_derivative_manifest"],
        "allowed_operations": {
            "can_store_locally": True,
            "can_backup_to_cloud": False,
            "can_convert": False,
            "can_view_in_caos": not blocked_states,
            "can_share_with_collaborators": False,
            "can_publish_derivatives": False,
            "can_release_publicly": False,
        },
    }


def metadata_from_public_source(asset: dict[str, Any]) -> dict[str, Any]:
    dimensions = asset.get("dimensions") if isinstance(asset.get("dimensions"), dict) else {}
    voxel_size = asset.get("physical_voxel_size_nm") if isinstance(asset.get("physical_voxel_size_nm"), dict) else None
    return {
        "status": "readable" if dimensions else "not_extracted",
        "format": asset.get("format") or "",
        "dimensions": dimensions,
        "dtype": asset.get("dtype") or "",
        "voxel_size_nm": voxel_size,
        "metadata_source": "public_data_conversion_readiness_manifest",
        "relative_path": asset.get("relative_path") or "",
    }


def metadata_from_public_derivative(derivative: dict[str, Any], relative_path: str) -> dict[str, Any]:
    shape = derivative.get("shape_zyx") if isinstance(derivative.get("shape_zyx"), list) else []
    dimensions = {}
    if len(shape) == 3:
        dimensions = {"z": shape[0], "y": shape[1], "x": shape[2]}
    return {
        "status": "readable" if dimensions else "not_extracted",
        "format": "Zarr",
        "asset_relative_path": relative_path,
        "dimensions": dimensions,
        "shape": shape,
        "chunks": derivative.get("chunks_zyx"),
        "dtype": derivative.get("dtype") or "",
        "voxel_size_nm": derivative.get("physical_voxel_size_nm"),
        "metadata_source": "public_data_derivative_manifest",
        "relative_path": f"{relative_path}/{derivative.get('array_path') or '0'}/.zarray",
    }


def public_source_gaps(asset: dict[str, Any]) -> list[dict[str, str]]:
    gaps: list[dict[str, str]] = []
    for blocker in asset.get("blockers") or []:
        gaps.append(
            {
                "relative_path": asset.get("relative_path") or "",
                "asset_relative_path": asset.get("relative_path") or "",
                "format": asset.get("format") or "",
                "metadata_status": "readable",
                "likely_role": "raw_volume_candidate",
                "extension": extension_for_path(asset.get("relative_path") or ""),
                "gap_code": str(blocker),
                "severity": "blocker",
                "summary": str(blocker),
                "suggested_action": " ".join(str(item) for item in asset.get("recommended_actions") or []),
            }
        )
    for note in asset.get("review_notes") or []:
        gaps.append(
            {
                "relative_path": asset.get("relative_path") or "",
                "asset_relative_path": asset.get("relative_path") or "",
                "format": asset.get("format") or "",
                "metadata_status": "readable",
                "likely_role": "raw_volume_candidate",
                "extension": extension_for_path(asset.get("relative_path") or ""),
                "gap_code": str(note),
                "severity": "review",
                "summary": str(note),
                "suggested_action": "Review the curated public-data advisory before quantitative measurement.",
            }
        )
    return gaps


def public_source_record(root: Path, dataset_slug: str, asset: dict[str, Any], archive_id: str) -> dict[str, Any]:
    local_path = Path(str(asset.get("local_path") or ""))
    relative_path = path_relative_to_root(root, local_path) if local_path else f"{dataset_slug}/data/{asset.get('relative_path') or ''}"
    return {
        "archive_id": archive_id,
        "root": str(root),
        "relative_path": relative_path,
        "name": Path(relative_path).name,
        "extension": extension_for_path(relative_path),
        "path_type": "file",
        "size_bytes": int_value(asset.get("size_bytes")),
        "modified_at": "",
        "likely_role": "raw_volume_candidate" if asset.get("conversion_target") else "metadata_sidecar",
    }


def public_derivative_record(root: Path, derivative: dict[str, Any], archive_id: str) -> dict[str, Any]:
    output_path = Path(str(derivative.get("output_path") or ""))
    relative_path = path_relative_to_root(root, output_path)
    return {
        "archive_id": archive_id,
        "root": str(root),
        "relative_path": relative_path,
        "name": Path(relative_path).name,
        "extension": extension_for_path(relative_path),
        "path_type": "directory_volume",
        "size_bytes": int_value(derivative.get("byte_size")),
        "modified_at": derivative.get("converted_at") or "",
        "likely_role": "raw_volume_candidate",
    }


def build_public_data_registry(root: Path, output_dir: Path, *, registry_id: str | None = None) -> dict[str, Any]:
    root = root.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    index = read_json(root / "pilot-index.json")
    archive_id = "scion-public-data-local"
    registry_id = registry_id or f"{archive_id}-registry"
    output_dir.mkdir(parents=True, exist_ok=True)

    assets_path = output_dir / "private-registry-assets.jsonl"
    search_path = output_dir / "private-registry-search-index.jsonl"
    review_path = output_dir / "private-registry-review-queue.csv"
    candidates_path = output_dir / "private-registry-volume-candidates.csv"

    stats = RegistryStats()
    review_rows: list[dict[str, str]] = []
    candidate_rows: list[dict[str, Any]] = []
    seen_derivatives: set[str] = set()

    with assets_path.open("w") as assets_handle, search_path.open("w") as search_handle:
        for dataset_entry in index.get("datasets") or []:
            if not isinstance(dataset_entry, dict):
                continue
            slug = str(dataset_entry.get("slug") or "")
            if not slug:
                continue
            dataset_dir = root / slug
            readiness = read_json(dataset_dir / "metadata" / "conversion-readiness-manifest.json")
            derivative_manifest_path = dataset_dir / "metadata" / "derivative-manifest.json"
            derivative_manifest = read_json(derivative_manifest_path) if derivative_manifest_path.exists() else {"derivatives": []}
            derivative_by_source = {
                str(item.get("source_relative_path") or ""): item
                for item in derivative_manifest.get("derivatives") or []
                if isinstance(item, dict)
            }

            for group_name in ("ready_assets", "blocked_assets", "sidecar_assets"):
                for public_asset in readiness.get(group_name) or []:
                    if not isinstance(public_asset, dict):
                        continue
                    source_relative = str(public_asset.get("relative_path") or "")
                    derivative = derivative_by_source.get(source_relative)
                    record = public_source_record(root, slug, public_asset, archive_id)
                    checksum = None
                    if public_asset.get("sha256"):
                        checksum = checksum_record_from_digest(
                            archive_id=archive_id,
                            relative_path=record["relative_path"],
                            algorithm="sha256",
                            digest=str(public_asset["sha256"]),
                            size_bytes=int_value(public_asset.get("size_bytes")),
                        )
                    state = str(public_asset.get("readiness") or ("not_applicable" if group_name == "sidecar_assets" else "unknown"))
                    status = public_source_status(state, converted=bool(derivative))
                    metadata = metadata_from_public_source(public_asset)
                    gaps = public_source_gaps(public_asset)
                    candidate = {
                        "relative_path": record["relative_path"],
                        "source_metadata_path": record["relative_path"],
                        "format": metadata.get("format") or "",
                        "status": metadata.get("status") or "",
                    } if group_name in {"ready_assets", "blocked_assets"} else None
                    asset = asset_record(registry_id, {"archive_id": archive_id, "root": str(root)}, record, checksum, status, metadata, gaps, candidate)
                    append_jsonl(assets_handle, asset)
                    append_jsonl(search_handle, search_index_for_asset(asset))
                    summarize_asset(stats, asset)
                    review_row = review_row_for_asset(asset)
                    if review_row:
                        review_rows.append(review_row)
                    if asset["readiness"]["is_volume_candidate"]:
                        candidate_rows.append(volume_candidate_export_row(asset))

            for derivative in derivative_manifest.get("derivatives") or []:
                if not isinstance(derivative, dict):
                    continue
                record = public_derivative_record(root, derivative, archive_id)
                if record["relative_path"] in seen_derivatives:
                    continue
                seen_derivatives.add(record["relative_path"])
                output_path = Path(str(derivative.get("output_path") or ""))
                checksum = composite_checksum_for_directory(output_path, root, archive_id, record["relative_path"])
                validation_status = str((derivative.get("validation") or {}).get("status") or "")
                status = public_derivative_status(validation_status, checksum)
                metadata = metadata_from_public_derivative(derivative, record["relative_path"])
                candidate = {
                    "relative_path": record["relative_path"],
                    "source_metadata_path": metadata["relative_path"],
                    "format": "Zarr",
                    "status": metadata.get("status") or "",
                }
                asset = asset_record(registry_id, {"archive_id": archive_id, "root": str(root)}, record, checksum, status, metadata, [], candidate)
                append_jsonl(assets_handle, asset)
                append_jsonl(search_handle, search_index_for_asset(asset))
                summarize_asset(stats, asset)
                review_row = review_row_for_asset(asset)
                if review_row:
                    review_rows.append(review_row)
                candidate_rows.append(volume_candidate_export_row(asset))

    stats.review_queue_count = len(review_rows)
    write_review_queue(review_path, review_rows)
    write_volume_candidates(candidates_path, candidate_rows)

    summary = registry_summary_payload(
        registry_id=registry_id,
        scan_dir=root,
        output_dir=output_dir,
        source_summary={
            "archive_id": archive_id,
            "root": str(root),
            "scanner": index.get("pipeline_version") or "public-data-pilot",
            "started_at": "",
            "finished_at": utc_now(),
            "file_count": stats.file_asset_count,
            "bytes_total": stats.bytes_total,
        },
        stats=stats,
    )
    summary["source_scan"]["source_kind"] = "public_data_bundle"
    summary["source_scan"]["pilot_index"] = str(root / "pilot-index.json")
    write_json(output_dir / "private-registry.json", summary)
    return summary


def iter_jsonl_stream(path: Path) -> Iterator[dict[str, Any]]:
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


def parse_optional_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if not text:
        return None
    if text in {"1", "true", "yes", "y"}:
        return True
    if text in {"0", "false", "no", "n"}:
        return False
    raise ValueError(f"Expected a boolean value, got {value!r}")


def split_overlay_list(value: Any) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value).strip()
    if not text:
        return None
    if text.lower() in {"none", "[]"}:
        return []
    return [part.strip() for part in text.replace(",", ";").split(";") if part.strip()]


def read_status_overlay(path: Path) -> list[dict[str, Any]]:
    path = path.expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Status overlay does not exist: {path}")
    if path.suffix.lower() == ".jsonl":
        return list(iter_jsonl_stream(path))
    with path.open(newline="") as source:
        return list(csv.DictReader(source))


def normalized_status_overlay(row: dict[str, Any]) -> dict[str, Any]:
    asset_id = str(row.get("asset_id") or "").strip()
    relative_path = str(row.get("relative_path") or "").strip()
    if not asset_id and not relative_path:
        raise ValueError("Status overlay rows need asset_id or relative_path.")

    status_updates = {
        field: str(row[field]).strip()
        for field in STATUS_OVERLAY_FIELDS
        if row.get(field) is not None and str(row.get(field)).strip()
    }
    review_required = parse_optional_bool(row.get("review_required"))
    if review_required is not None:
        status_updates["review_required"] = review_required

    blocked_states = split_overlay_list(row.get("blocked_states"))
    review_notes = split_overlay_list(row.get("review_notes"))
    operation_updates: dict[str, bool] = {}
    for field in OPERATION_FIELDS:
        parsed = parse_optional_bool(row.get(field))
        if parsed is not None:
            operation_updates[field] = parsed

    return {
        "asset_id": asset_id,
        "relative_path": relative_path,
        "status_updates": status_updates,
        "blocked_states": blocked_states,
        "review_notes": review_notes,
        "operation_updates": operation_updates,
    }


def status_overlay_maps(rows: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    by_asset_id: dict[str, dict[str, Any]] = {}
    by_path: dict[str, dict[str, Any]] = {}
    for row in rows:
        overlay = normalized_status_overlay(row)
        if overlay["asset_id"]:
            by_asset_id[overlay["asset_id"]] = overlay
        if overlay["relative_path"]:
            by_path[overlay["relative_path"]] = overlay
    return by_asset_id, by_path


def apply_status_overlay_to_asset(asset: dict[str, Any], overlay: dict[str, Any], registry_id: str) -> dict[str, Any]:
    updated = dict(asset)
    updated["registry_id"] = registry_id
    updated["registry_builder"] = f"{REGISTRY_BUILDER_VERSION}+{STATUS_OVERLAY_VERSION}"
    status = dict_value(updated.get("status")).copy()
    status.update(overlay["status_updates"])
    if overlay["blocked_states"] is not None:
        status["blocked_states"] = overlay["blocked_states"]
    if overlay["review_notes"] is not None:
        existing_notes = [str(item) for item in list_value(status.get("review_notes"))]
        status["review_notes"] = existing_notes + overlay["review_notes"]
    operations = allowed_operations(status)
    operations.update(overlay["operation_updates"])
    status["allowed_operations"] = operations
    updated["status"] = status

    checksum = dict_value(updated.get("checksum"))
    metadata = dict_value(updated.get("metadata"))
    review = dict_value(updated.get("review"))
    gaps = [
        gap
        for gap in list_value(review.get("gaps"))
        if isinstance(gap, dict)
    ]
    is_candidate = bool_value(dict_value(updated.get("volume_candidate")).get("is_candidate"))
    updated["readiness"] = readiness_for_asset(updated, checksum if checksum.get("digest") else None, status, metadata, gaps, is_candidate)
    return updated


def write_unmatched_overlay_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fieldnames = ["asset_id", "relative_path", "reason"]
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def apply_status_overlay(
    registry_dir: Path,
    overlay_path: Path,
    output_dir: Path,
    *,
    registry_id: str | None = None,
) -> dict[str, Any]:
    registry_dir = registry_dir.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    source_registry = read_json(registry_dir / "private-registry.json")
    registry_id = registry_id or f"{source_registry.get('registry_id') or 'registry'}-curated"
    overlay_rows = read_status_overlay(overlay_path)
    overlays_by_asset, overlays_by_path = status_overlay_maps(overlay_rows)
    unmatched_keys = {
        (overlay.get("asset_id") or "", overlay.get("relative_path") or "")
        for overlay in list(overlays_by_asset.values()) + list(overlays_by_path.values())
    }

    assets_path = output_dir / "private-registry-assets.jsonl"
    search_path = output_dir / "private-registry-search-index.jsonl"
    review_path = output_dir / "private-registry-review-queue.csv"
    candidates_path = output_dir / "private-registry-volume-candidates.csv"
    unmatched_path = output_dir / "status-overlay-unmatched.csv"

    stats = RegistryStats()
    review_rows: list[dict[str, str]] = []
    candidate_rows: list[dict[str, Any]] = []
    applied_count = 0

    with assets_path.open("w") as assets_handle, search_path.open("w") as search_handle:
        for asset in iter_jsonl_stream(registry_dir / "private-registry-assets.jsonl"):
            asset_id = str(asset.get("asset_id") or "")
            relative_path = str(asset.get("relative_path") or "")
            overlay = overlays_by_asset.get(asset_id) or overlays_by_path.get(relative_path)
            if overlay:
                asset = apply_status_overlay_to_asset(asset, overlay, registry_id)
                applied_count += 1
                unmatched_keys.discard((overlay.get("asset_id") or "", overlay.get("relative_path") or ""))
            else:
                asset = dict(asset)
                asset["registry_id"] = registry_id
                asset["registry_builder"] = f"{REGISTRY_BUILDER_VERSION}+{STATUS_OVERLAY_VERSION}"

            append_jsonl(assets_handle, asset)
            append_jsonl(search_handle, search_index_for_asset(asset))
            summarize_asset(stats, asset)
            review_row = review_row_for_asset(asset)
            if review_row:
                review_rows.append(review_row)
            if asset["readiness"]["is_volume_candidate"]:
                candidate_rows.append(volume_candidate_export_row(asset))

    stats.review_queue_count = len(review_rows)
    write_review_queue(review_path, review_rows)
    write_volume_candidates(candidates_path, candidate_rows)
    write_unmatched_overlay_csv(
        unmatched_path,
        [
            {"asset_id": asset_id, "relative_path": relative_path, "reason": "no_matching_registry_asset"}
            for asset_id, relative_path in sorted(unmatched_keys)
        ],
    )

    source_scan = dict_value(source_registry.get("source_scan"))
    summary = registry_summary_payload(
        registry_id=registry_id,
        scan_dir=Path(str(source_scan.get("scan_dir") or registry_dir)),
        output_dir=output_dir,
        source_summary=source_scan,
        stats=stats,
    )
    summary["registry_builder"] = f"{REGISTRY_BUILDER_VERSION}+{STATUS_OVERLAY_VERSION}"
    summary["status_overlay"] = {
        "overlay_path": str(overlay_path.expanduser().resolve()),
        "input_registry_dir": str(registry_dir),
        "input_registry_id": source_registry.get("registry_id") or "",
        "rows": len(overlay_rows),
        "applied_rows": applied_count,
        "unmatched_rows": len(unmatched_keys),
        "unmatched_artifact": "status-overlay-unmatched.csv",
    }
    write_json(output_dir / "private-registry.json", summary)
    return summary


def workset_asset_search_text(asset: dict[str, Any], search_entry: dict[str, Any] | None) -> str:
    metadata = dict_value(asset.get("metadata"))
    status = dict_value(asset.get("status"))
    tokens = [
        asset.get("asset_id"),
        asset.get("archive_id"),
        asset.get("relative_path"),
        asset.get("name"),
        asset.get("extension"),
        asset.get("likely_role"),
        metadata.get("format"),
        metadata.get("dtype"),
        status.get("publication_status"),
        status.get("triage_status"),
        status.get("rights_status"),
        search_entry.get("search_text") if search_entry else "",
    ]
    return " ".join(str(token) for token in tokens if token).lower()


def matches_workset_selection(
    asset: dict[str, Any],
    selection: WorksetSelection,
    search_entry: dict[str, Any] | None,
    asset_id_set: set[str] | None = None,
) -> bool:
    has_explicit_selector = bool(selection.asset_ids or selection.path_prefixes or selection.queries)
    if selection.all_assets or (selection.volume_candidates_only and not has_explicit_selector):
        selected = True
    else:
        selected = False
        asset_id = str(asset.get("asset_id") or "")
        relative_path = str(asset.get("relative_path") or "")
        if asset_id and asset_id in (asset_id_set if asset_id_set is not None else set(selection.asset_ids)):
            selected = True
        if selection.path_prefixes and any(relative_path.startswith(prefix) for prefix in selection.path_prefixes):
            selected = True
        if selection.queries:
            text = workset_asset_search_text(asset, search_entry)
            selected = selected or all(query.lower() in text for query in selection.queries)

    if not selected:
        return False
    if selection.volume_candidates_only and not bool_value(dict_value(asset.get("readiness")).get("is_volume_candidate")):
        return False
    return True


def select_workset_assets(registry_dir: Path, selection: WorksetSelection) -> list[dict[str, Any]]:
    if not (
        selection.all_assets
        or selection.asset_ids
        or selection.path_prefixes
        or selection.queries
        or selection.volume_candidates_only
    ):
        raise ValueError("Provide at least one selector (--asset-id, --path-prefix, --query) or use --all.")

    if selection.limit is not None and selection.limit <= 0:
        raise ValueError("Workset --limit must be greater than zero.")
    if selection.limit is not None and selection.limit > MAX_WORKSET_ASSETS:
        raise ValueError(
            f"Worksets are capped at {MAX_WORKSET_ASSETS} assets; partition the selection into smaller worksets."
        )
    effective_limit = selection.limit or MAX_WORKSET_ASSETS
    asset_id_set = set(selection.asset_ids)
    selected: list[dict[str, Any]] = []
    for asset in iter_jsonl_stream(registry_dir / "private-registry-assets.jsonl"):
        if matches_workset_selection(asset, selection, None, asset_id_set):
            if selection.limit is None and len(selected) >= effective_limit:
                raise ValueError(
                    f"Selection exceeds the {MAX_WORKSET_ASSETS}-asset workset safety cap; add --limit or partition by path."
                )
            selected.append(asset)
            if selection.limit is not None and len(selected) >= effective_limit:
                break

    selected.sort(
        key=lambda asset: (
            not bool_value(dict_value(asset.get("readiness")).get("is_volume_candidate")),
            str(asset.get("relative_path") or ""),
        )
    )
    return selected


def operation_allowed(asset: dict[str, Any], operation: str) -> bool:
    status = dict_value(asset.get("status"))
    operations = dict_value(status.get("allowed_operations"))
    if operation == "review":
        return True
    if operation == "inspect":
        return bool_value(operations.get("can_view_in_caos"))
    if operation == "convert":
        return bool_value(operations.get("can_convert"))
    if operation == "measure":
        return bool_value(operations.get("can_view_in_caos"))
    if operation == "publish":
        return bool_value(operations.get("can_publish_derivatives"))
    if operation == "backup":
        return bool_value(operations.get("can_backup_to_cloud"))
    return False


def blocked_operations(asset: dict[str, Any], intended_operations: list[str]) -> list[str]:
    return sorted(operation for operation in intended_operations if not operation_allowed(asset, operation))


def workset_asset_record(
    asset: dict[str, Any],
    *,
    intended_operations: list[str],
    promoted_at: str,
) -> dict[str, Any]:
    readiness = dict_value(asset.get("readiness"))
    status = dict_value(asset.get("status"))
    checksum = dict_value(asset.get("checksum"))
    metadata = dict_value(asset.get("metadata"))
    review = dict_value(asset.get("review"))
    blocked = blocked_operations(asset, intended_operations)
    return {
        "schema": "cell-anatomy-archive-workset-asset",
        "schema_version": SCHEMA_VERSION,
        "workset_builder": WORKSET_BUILDER_VERSION,
        "promoted_at": promoted_at,
        "asset_id": asset.get("asset_id") or "",
        "registry_id": asset.get("registry_id") or "",
        "archive_id": asset.get("archive_id") or "",
        "relative_path": asset.get("relative_path") or "",
        "path_type": asset.get("path_type") or "",
        "likely_role": asset.get("likely_role") or "",
        "size_bytes": int_value(asset.get("size_bytes")),
        "source": dict_value(asset.get("source")),
        "checksum": {
            "algorithm": checksum.get("algorithm") or "",
            "digest": checksum.get("digest") or "",
            "duplicate_of": checksum.get("duplicate_of") or "",
            "computed_at": checksum.get("computed_at") or "",
        },
        "metadata": {
            "status": metadata.get("status") or "",
            "format": metadata.get("format") or "",
            "dimensions": dict_value(metadata.get("dimensions")),
            "dtype": metadata.get("dtype") or "",
            "voxel_size_nm": metadata.get("voxel_size_nm"),
            "metadata_source": metadata.get("metadata_source") or "",
        },
        "status": {
            "asset_status": status.get("asset_status") or "",
            "fixity_status": status.get("fixity_status") or "",
            "publication_status": status.get("publication_status") or "unknown",
            "triage_status": status.get("triage_status") or "unknown",
            "rights_status": status.get("rights_status") or "unknown",
            "blocked_states": list_value(status.get("blocked_states")),
            "allowed_operations": dict_value(status.get("allowed_operations")),
        },
        "readiness": {
            "metadata_ready": bool_value(readiness.get("metadata_ready")),
            "has_checksum": bool_value(readiness.get("has_checksum")),
            "is_volume_candidate": bool_value(readiness.get("is_volume_candidate")),
            "conversion_ready": bool_value(readiness.get("conversion_ready")),
            "project_ready": bool_value(readiness.get("project_ready")),
            "blockers": list_value(readiness.get("blockers")),
        },
        "review": {
            "gap_count": int_value(review.get("gap_count")),
            "gap_codes": list_value(review.get("gap_codes")),
            "recommended_actions": list_value(review.get("recommended_actions")),
        },
        "promotion": {
            "intended_operations": intended_operations,
            "blocked_operations": blocked,
            "can_enter_dataset_mode": not blocked,
        },
    }


def counter_dict(counter: Counter[str]) -> dict[str, int]:
    return dict(sorted(counter.items()))


def workset_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    bytes_total = sum(int_value(record.get("size_bytes")) for record in records)
    rights_counts: Counter[str] = Counter()
    triage_counts: Counter[str] = Counter()
    publication_counts: Counter[str] = Counter()
    format_counts: Counter[str] = Counter()
    blocker_counts: Counter[str] = Counter()
    blocked_operation_counts: Counter[str] = Counter()
    checksum_count = 0
    metadata_ready_count = 0
    conversion_ready_count = 0
    project_ready_count = 0
    dataset_mode_ready_count = 0

    for record in records:
        status = dict_value(record.get("status"))
        metadata = dict_value(record.get("metadata"))
        readiness = dict_value(record.get("readiness"))
        promotion = dict_value(record.get("promotion"))
        checksum = dict_value(record.get("checksum"))
        rights_counts.update([str(status.get("rights_status") or "unknown")])
        triage_counts.update([str(status.get("triage_status") or "unknown")])
        publication_counts.update([str(status.get("publication_status") or "unknown")])
        format_counts.update([str(metadata.get("format") or "[none]")])
        blocker_counts.update(str(item) for item in list_value(readiness.get("blockers")) if item)
        blocked_operation_counts.update(str(item) for item in list_value(promotion.get("blocked_operations")) if item)
        if checksum.get("digest"):
            checksum_count += 1
        if readiness.get("metadata_ready"):
            metadata_ready_count += 1
        if readiness.get("conversion_ready"):
            conversion_ready_count += 1
        if readiness.get("project_ready"):
            project_ready_count += 1
        if promotion.get("can_enter_dataset_mode"):
            dataset_mode_ready_count += 1

    return {
        "selected_asset_count": len(records),
        "selected_bytes_total": bytes_total,
        "checksum_record_count": checksum_count,
        "metadata_ready_count": metadata_ready_count,
        "conversion_ready_count": conversion_ready_count,
        "project_ready_count": project_ready_count,
        "dataset_mode_ready_count": dataset_mode_ready_count,
        "rights_status_counts": counter_dict(rights_counts),
        "triage_status_counts": counter_dict(triage_counts),
        "publication_status_counts": counter_dict(publication_counts),
        "format_counts": counter_dict(format_counts),
        "blocker_counts": counter_dict(blocker_counts),
        "blocked_operation_counts": counter_dict(blocked_operation_counts),
    }


def workset_findings(summary: dict[str, Any], intended_operations: list[str]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    selected_count = int_value(summary.get("selected_asset_count"))
    if selected_count == 0:
        return [
            {
                "severity": "blocker",
                "code": "empty_selection",
                "summary": "The workset selector did not match any registry assets.",
            }
        ]
    if summary["checksum_record_count"] < selected_count:
        findings.append(
            {
                "severity": "review",
                "code": "missing_fixity",
                "summary": f"{selected_count - summary['checksum_record_count']} selected assets lack checksum records.",
            }
        )
    if summary["rights_status_counts"].get("unknown", 0) > 0:
        findings.append(
            {
                "severity": "blocker",
                "code": "rights_unknown",
                "summary": f"{summary['rights_status_counts']['unknown']} selected assets still have unknown rights status.",
            }
        )
    if summary["blocked_operation_counts"]:
        blocked_total = sum(summary["blocked_operation_counts"].values())
        findings.append(
            {
                "severity": "blocker",
                "code": "intended_operations_blocked",
                "summary": f"{blocked_total} requested asset operations are blocked for {', '.join(intended_operations)}.",
            }
        )
    return findings


def write_workset_assets_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    with path.open("w") as output:
        for record in records:
            append_jsonl(output, record)


def write_workset_assets_csv(path: Path, records: list[dict[str, Any]]) -> None:
    fieldnames = [
        "asset_id",
        "archive_id",
        "relative_path",
        "path_type",
        "likely_role",
        "format",
        "metadata_status",
        "size_bytes",
        "checksum_algorithm",
        "checksum_digest",
        "rights_status",
        "triage_status",
        "publication_status",
        "metadata_ready",
        "conversion_ready",
        "project_ready",
        "can_enter_dataset_mode",
        "blocked_operations",
        "blockers",
        "metadata_gap_codes",
    ]
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        for record in records:
            metadata = dict_value(record.get("metadata"))
            checksum = dict_value(record.get("checksum"))
            status = dict_value(record.get("status"))
            readiness = dict_value(record.get("readiness"))
            promotion = dict_value(record.get("promotion"))
            review = dict_value(record.get("review"))
            writer.writerow(
                {
                    "asset_id": record.get("asset_id") or "",
                    "archive_id": record.get("archive_id") or "",
                    "relative_path": record.get("relative_path") or "",
                    "path_type": record.get("path_type") or "",
                    "likely_role": record.get("likely_role") or "",
                    "format": metadata.get("format") or "",
                    "metadata_status": metadata.get("status") or "",
                    "size_bytes": int_value(record.get("size_bytes")),
                    "checksum_algorithm": checksum.get("algorithm") or "",
                    "checksum_digest": checksum.get("digest") or "",
                    "rights_status": status.get("rights_status") or "",
                    "triage_status": status.get("triage_status") or "",
                    "publication_status": status.get("publication_status") or "",
                    "metadata_ready": bool_value(readiness.get("metadata_ready")),
                    "conversion_ready": bool_value(readiness.get("conversion_ready")),
                    "project_ready": bool_value(readiness.get("project_ready")),
                    "can_enter_dataset_mode": bool_value(promotion.get("can_enter_dataset_mode")),
                    "blocked_operations": ";".join(str(item) for item in list_value(promotion.get("blocked_operations"))),
                    "blockers": ";".join(str(item) for item in list_value(readiness.get("blockers"))),
                    "metadata_gap_codes": ";".join(str(item) for item in list_value(review.get("gap_codes"))),
                }
            )


def build_workset(
    registry_dir: Path,
    output_dir: Path,
    selection: WorksetSelection,
) -> dict[str, Any]:
    registry_dir = registry_dir.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    registry_summary = read_json(registry_dir / "private-registry.json")
    promoted_at = utc_now()
    selected_assets = select_workset_assets(registry_dir, selection)
    records = [
        workset_asset_record(asset, intended_operations=selection.intended_operations, promoted_at=promoted_at)
        for asset in selected_assets
    ]
    summary = workset_summary(records)
    selected_asset_refs = [
        {
            "asset_id": record["asset_id"],
            "archive_id": record["archive_id"],
            "relative_path": record["relative_path"],
        }
        for record in records
    ]

    write_workset_assets_jsonl(output_dir / "workset-assets.jsonl", records)
    write_workset_assets_csv(output_dir / "workset-assets.csv", records)
    write_workset_assets_csv(
        output_dir / "workset-review-queue.csv",
        [
            record
            for record in records
            if list_value(dict_value(record.get("promotion")).get("blocked_operations"))
            or list_value(dict_value(record.get("readiness")).get("blockers"))
            or dict_value(record.get("status")).get("rights_status") == "unknown"
        ],
    )

    workset = {
        "schema": WORKSET_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "workset_builder": WORKSET_BUILDER_VERSION,
        "generated_at": promoted_at,
        "workset_id": selection.workset_id,
        "title": selection.title,
        "source_registry": {
            "registry_dir": str(registry_dir),
            "registry_id": registry_summary.get("registry_id") or "",
            "archive_id": dict_value(registry_summary.get("source_scan")).get("archive_id") or "",
            "archive_root": dict_value(registry_summary.get("source_scan")).get("root") or "",
            "asset_count": registry_summary.get("asset_count") or 0,
        },
        "selection": {
            "asset_ids": selection.asset_ids,
            "path_prefixes": selection.path_prefixes,
            "queries": selection.queries,
            "all_assets": selection.all_assets,
            "volume_candidates_only": selection.volume_candidates_only,
            "limit": selection.limit,
        },
        "promotion_rule": {
            "selected_asset_count": len(records),
            "selected_assets_artifact": "workset-assets.jsonl",
            "selected_assets_preview": selected_asset_refs[:100],
            "known_status_counts": {
                "rights": summary["rights_status_counts"],
                "triage": summary["triage_status_counts"],
                "publication": summary["publication_status_counts"],
            },
            "fixity": {
                "checksum_record_count": summary["checksum_record_count"],
                "selected_asset_count": summary["selected_asset_count"],
            },
            "metadata_readiness": {
                "metadata_ready_count": summary["metadata_ready_count"],
                "conversion_ready_count": summary["conversion_ready_count"],
                "project_ready_count": summary["project_ready_count"],
            },
            "intended_operations": selection.intended_operations,
            "destination_workset_dir": str(output_dir),
            "notes": selection.notes,
        },
        "summary": summary,
        "findings": workset_findings(summary, selection.intended_operations),
        "artifacts": {
            "json": "workset.json",
            "assets_jsonl": "workset-assets.jsonl",
            "assets_csv": "workset-assets.csv",
            "review_queue_csv": "workset-review-queue.csv",
        },
        "output_dir": str(output_dir),
    }
    write_json(output_dir / "workset.json", workset)
    return workset


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a private CAOS registry from archive scanner artifacts.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    import_scan = subparsers.add_parser("import-scan", help="Import one archive scanner output directory.")
    import_scan.add_argument("scan_dir", type=Path, help="Directory containing archive_scanner.py outputs.")
    import_scan.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory where private registry artifacts will be written.",
    )
    import_scan.add_argument("--registry-id", help="Stable registry id. Defaults to <archive-id>-private-registry.")

    import_public = subparsers.add_parser("import-public-data", help="Import a local scion-public-data bundle.")
    import_public.add_argument("root", type=Path, help="Directory containing pilot-index.json.")
    import_public.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory where private registry artifacts will be written.",
    )
    import_public.add_argument("--registry-id", help="Stable registry id. Defaults to scion-public-data-local-registry.")

    overlay = subparsers.add_parser("apply-status-overlay", help="Apply curated status rows to a private registry.")
    overlay.add_argument("registry_dir", type=Path, help="Directory containing private-registry.json and assets JSONL.")
    overlay.add_argument("--overlay", type=Path, required=True, help="CSV or JSONL status overlay file.")
    overlay.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory where the curated registry artifacts will be written.",
    )
    overlay.add_argument("--registry-id", help="Stable id for the curated registry.")

    promote = subparsers.add_parser("promote-workset", help="Promote selected registry assets into a bounded workset.")
    promote.add_argument("registry_dir", type=Path, help="Directory containing private-registry.json and assets JSONL.")
    promote.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory where workset artifacts will be written.",
    )
    promote.add_argument("--workset-id", required=True, help="Stable workset id.")
    promote.add_argument("--title", help="Human-readable workset title. Defaults to the workset id.")
    promote.add_argument("--asset-id", action="append", default=[], help="Select a registry asset id. Can be repeated.")
    promote.add_argument(
        "--path-prefix",
        action="append",
        default=[],
        help="Select assets with this relative-path prefix. Can be repeated.",
    )
    promote.add_argument("--query", action="append", default=[], help="Case-insensitive search term. Repeated terms must all match.")
    promote.add_argument("--all", action="store_true", help="Select all registry assets.")
    promote.add_argument("--volume-candidates-only", action="store_true", help="Restrict selection to volume candidates.")
    promote.add_argument("--limit", type=int, help="Maximum number of selected assets to include.")
    promote.add_argument(
        "--intended-operation",
        action="append",
        choices=sorted(INTENDED_OPERATIONS),
        default=[],
        help="Operation this workset is being promoted for. Can be repeated.",
    )
    promote.add_argument("--note", action="append", default=[], help="Promotion note to include in workset.json.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    started = time.monotonic()

    if args.command == "import-scan":
        summary = build_private_registry(args.scan_dir, args.output_dir, registry_id=args.registry_id)
    elif args.command == "import-public-data":
        summary = build_public_data_registry(args.root, args.output_dir, registry_id=args.registry_id)
    elif args.command == "apply-status-overlay":
        summary = apply_status_overlay(
            args.registry_dir,
            args.overlay,
            args.output_dir,
            registry_id=args.registry_id,
        )
        elapsed = time.monotonic() - started
        print(
            json.dumps(
                {
                    "status": "ok",
                    "registry_id": summary["registry_id"],
                    "asset_count": summary["asset_count"],
                    "project_ready_count": summary["project_ready_count"],
                    "overlay_rows": summary["status_overlay"]["rows"],
                    "overlay_applied_rows": summary["status_overlay"]["applied_rows"],
                    "overlay_unmatched_rows": summary["status_overlay"]["unmatched_rows"],
                    "output_dir": summary["output_dir"],
                    "elapsed_seconds": round(elapsed, 3),
                },
                sort_keys=True,
            )
        )
        return 0
    elif args.command == "promote-workset":
        operations = args.intended_operation or ["review"]
        workset = build_workset(
            args.registry_dir,
            args.output_dir,
            WorksetSelection(
                workset_id=safe_slug(args.workset_id),
                title=args.title or args.workset_id,
                asset_ids=args.asset_id,
                path_prefixes=args.path_prefix,
                queries=args.query,
                all_assets=args.all,
                volume_candidates_only=args.volume_candidates_only,
                limit=max(1, args.limit) if args.limit is not None else None,
                intended_operations=operations,
                notes=args.note,
            ),
        )
        elapsed = time.monotonic() - started
        print(
            json.dumps(
                {
                    "status": "ok",
                    "workset_id": workset["workset_id"],
                    "selected_asset_count": workset["summary"]["selected_asset_count"],
                    "dataset_mode_ready_count": workset["summary"]["dataset_mode_ready_count"],
                    "finding_count": len(workset["findings"]),
                    "output_dir": workset["output_dir"],
                    "elapsed_seconds": round(elapsed, 3),
                },
                sort_keys=True,
            )
        )
        return 0
    else:
        raise ValueError(f"Unsupported command: {args.command}")

    if args.command in {"import-scan", "import-public-data"}:
        elapsed = time.monotonic() - started
        print(
            json.dumps(
                {
                    "status": "ok",
                    "registry_id": summary["registry_id"],
                    "asset_count": summary["asset_count"],
                    "volume_candidate_count": summary["volume_candidate_count"],
                    "review_queue_count": summary["review_queue_count"],
                    "output_dir": summary["output_dir"],
                    "elapsed_seconds": round(elapsed, 3),
                },
                sort_keys=True,
            )
        )
        return 0

    parser.error(f"Unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
