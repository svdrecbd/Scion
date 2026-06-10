from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REGISTRY_BUILDER_VERSION = "private-registry-import-v0.1"
SCHEMA_VERSION = 1
REGISTRY_SCHEMA = "cell-anatomy-private-archive-registry"
ASSET_SCHEMA = "cell-anatomy-private-archive-asset"


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


def build_private_registry(scan_dir: Path, output_dir: Path, *, registry_id: str | None = None) -> dict[str, Any]:
    scan_dir = scan_dir.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    summary = read_json(scan_dir / "inventory-summary.json")
    manifest_rows = iter_jsonl(scan_dir / "file-manifest.jsonl")

    archive_id = str(summary.get("archive_id") or "archive")
    registry_id = registry_id or f"{safe_slug(archive_id)}-private-registry"
    output_dir.mkdir(parents=True, exist_ok=True)

    metadata_by_asset = map_metadata(iter_jsonl(scan_dir / "metadata-extraction.jsonl"))
    checksums_by_path = map_by_relative_path(iter_jsonl(scan_dir / "checksums.jsonl"))
    status_by_path = map_by_relative_path(iter_jsonl(scan_dir / "asset-status-ledger.jsonl"))
    gaps_by_asset = group_metadata_gaps(read_csv_rows(scan_dir / "metadata-gaps.csv"))
    candidates_by_path = map_csv_by_path(read_csv_rows(scan_dir / "volume-candidates.csv"))

    manifest_paths = {str(row.get("relative_path") or "") for row in manifest_rows}
    synthetic_candidate_paths = set(candidates_by_path) - manifest_paths
    prefix_stats = candidate_prefix_stats(manifest_rows, synthetic_candidate_paths)

    assets_path = output_dir / "private-registry-assets.jsonl"
    search_path = output_dir / "private-registry-search-index.jsonl"
    review_path = output_dir / "private-registry-review-queue.csv"
    candidates_path = output_dir / "private-registry-volume-candidates.csv"

    stats = RegistryStats()
    review_rows: list[dict[str, str]] = []
    candidate_rows: list[dict[str, Any]] = []

    with assets_path.open("w") as assets_handle, search_path.open("w") as search_handle:
        for row in manifest_rows:
            relative = str(row.get("relative_path") or "")
            if not relative:
                continue
            checksum = checksums_by_path.get(relative)
            status = status_by_path.get(relative) or default_status_record(row, checksum)
            asset = asset_record(
                registry_id,
                summary,
                row,
                checksum,
                status,
                metadata_by_asset.get(relative),
                gaps_by_asset.get(relative, []),
                candidates_by_path.get(relative),
            )
            append_jsonl(assets_handle, asset)
            append_jsonl(search_handle, search_index_for_asset(asset))
            summarize_asset(stats, asset)
            review_row = review_row_for_asset(asset)
            if review_row:
                review_rows.append(review_row)
            if asset["readiness"]["is_volume_candidate"]:
                candidate_rows.append(volume_candidate_export_row(asset))

        for relative in sorted(synthetic_candidate_paths):
            row = synthetic_candidate_record(summary, relative, prefix_stats.get(relative, {}))
            status = default_status_record(row, None)
            status["fixity_status"] = "component_checksums_pending"
            asset = asset_record(
                registry_id,
                summary,
                row,
                None,
                status,
                metadata_by_asset.get(relative),
                gaps_by_asset.get(relative, []),
                candidates_by_path.get(relative),
            )
            asset["readiness"]["blockers"] = sorted(set(asset["readiness"]["blockers"]) | {"missing_composite_checksum"})
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

    registry_summary = registry_summary_payload(
        registry_id=registry_id,
        scan_dir=scan_dir,
        output_dir=output_dir,
        source_summary=summary,
        stats=stats,
    )
    write_json(output_dir / "private-registry.json", registry_summary)
    return registry_summary


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
    fieldnames = [
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
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_volume_candidates(path: Path, rows: list[dict[str, Any]]) -> None:
    fieldnames = [
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
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
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
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    started = time.monotonic()

    if args.command == "import-scan":
        summary = build_private_registry(args.scan_dir, args.output_dir, registry_id=args.registry_id)
    elif args.command == "import-public-data":
        summary = build_public_data_registry(args.root, args.output_dir, registry_id=args.registry_id)
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
