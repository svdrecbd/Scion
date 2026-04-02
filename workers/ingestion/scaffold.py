from __future__ import annotations

from dataclasses import dataclass
from typing import Any

REQUIRED_FIELDS = {
    "dataset_id",
    "title",
    "paper_title",
    "year",
    "source",
    "source_type",
    "public_data_status",
    "species",
    "cell_type",
    "modality",
    "modality_family",
    "organelles",
    "organelle_pairs",
    "metric_families",
    "metadata_completeness_score",
    "whole_cell_boundary_confirmed",
}


@dataclass
class IngestionResult:
    records: list[dict[str, Any]]
    warnings: list[str]


def normalize_record(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize a raw source record into the first-pass Scion shape.

    This is intentionally lightweight. The early objective is to make field
    mapping explicit, not to hide complexity behind a black box.
    """

    normalized = {
        "dataset_id": raw.get("dataset_id") or raw.get("id"),
        "title": raw.get("title"),
        "paper_title": raw.get("paper_title") or raw.get("publication_title"),
        "year": raw.get("year"),
        "source": raw.get("source"),
        "source_type": raw.get("source_type", "repository"),
        "public_data_status": raw.get("public_data_status", "none"),
        "species": raw.get("species"),
        "cell_type": raw.get("cell_type"),
        "tissue_or_system": raw.get("tissue_or_system"),
        "comparator_class": raw.get("comparator_class"),
        "comparator_detail": raw.get("comparator_detail"),
        "modality": raw.get("modality"),
        "modality_family": raw.get("modality_family", "other"),
        "lateral_resolution_nm": raw.get("lateral_resolution_nm"),
        "axial_resolution_nm": raw.get("axial_resolution_nm"),
        "isotropic": raw.get("isotropic"),
        "organelles": raw.get("organelles", []),
        "organelle_pairs": raw.get("organelle_pairs", []),
        "metric_families": raw.get("metric_families", []),
        "sample_size": raw.get("sample_size"),
        "sample_size_bucket": raw.get("sample_size_bucket", "unknown"),
        "metadata_completeness_score": raw.get("metadata_completeness_score", 0.0),
        "whole_cell_boundary_confirmed": raw.get("whole_cell_boundary_confirmed", "unclear"),
        "notes": raw.get("notes"),
    }
    return normalized


def validate_record(record: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    missing = sorted(field for field in REQUIRED_FIELDS if not record.get(field))
    if missing:
        warnings.append(f"Missing required fields: {', '.join(missing)}")
    return warnings


def ingest(records: list[dict[str, Any]]) -> IngestionResult:
    normalized_records: list[dict[str, Any]] = []
    warnings: list[str] = []

    for raw in records:
        normalized = normalize_record(raw)
        record_warnings = validate_record(normalized)
        warnings.extend(
            [f"{normalized.get('dataset_id', 'unknown')}: {message}" for message in record_warnings]
        )
        normalized_records.append(normalized)

    return IngestionResult(records=normalized_records, warnings=warnings)
