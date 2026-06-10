from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import stat
import struct
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCANNER_VERSION = "archive-scanner-v0.2"
SCHEMA_VERSION = 1
CHECKSUM_CHUNK_BYTES = 1024 * 1024 * 8
DEFAULT_LARGEST_FILE_LIMIT = 200

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
class ScanError:
    relative_path: str
    operation: str
    error: str


@dataclass
class ScanState:
    root: Path
    output_dir: Path
    archive_id: str
    checksum_algorithm: str | None
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
    errors: list[ScanError] = field(default_factory=list)
    checksum_first_seen: dict[str, str] = field(default_factory=dict)
    checksum_duplicate_count: int = 0
    metadata_records: list[dict[str, Any]] = field(default_factory=list)
    metadata_gaps: list[dict[str, Any]] = field(default_factory=list)
    volume_candidates: list[dict[str, Any]] = field(default_factory=list)
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


def append_jsonl(handle, value: dict[str, Any]) -> None:
    handle.write(json.dumps(value, sort_keys=True) + "\n")


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


def load_checksum_cache(path: Path, algorithm: str | None) -> dict[str, dict[str, Any]]:
    if not algorithm or not path.exists():
        return {}

    cache: dict[str, dict[str, Any]] = {}
    with path.open() as source:
        for line in source:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            relative = row.get("relative_path")
            digest = row.get("digest")
            if row.get("algorithm") == algorithm and isinstance(relative, str) and isinstance(digest, str):
                cache[relative] = row
    return cache


def cached_checksum_matches(cached: dict[str, Any] | None, record: dict[str, Any], algorithm: str) -> bool:
    if not cached:
        return False
    try:
        cached_size = int(cached.get("size_bytes"))
    except (TypeError, ValueError):
        return False
    return (
        cached.get("algorithm") == algorithm
        and cached_size == int(record["size_bytes"])
        and cached.get("modified_at") == record["modified_at"]
        and isinstance(cached.get("digest"), str)
    )


def record_checksum_seen(state: ScanState, digest: str, relative: str) -> str:
    duplicate_of = state.checksum_first_seen.get(digest, "")
    if duplicate_of:
        state.checksum_duplicate_count += 1
    else:
        state.checksum_first_seen[digest] = relative
    return duplicate_of


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


def record_scan_error(state: ScanState, relative: str, operation: str, error: Exception | str) -> None:
    state.errors.append(ScanError(relative_path=relative, operation=operation, error=str(error)))
    state.unreadable_count += 1


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


def scan_archive(
    root: Path,
    output_dir: Path,
    *,
    archive_id: str | None = None,
    checksum_algorithm: str | None = None,
    resume_checksums: bool = False,
    largest_file_limit: int = DEFAULT_LARGEST_FILE_LIMIT,
) -> dict[str, Any]:
    root = root.expanduser().resolve()
    if not root.exists():
        raise FileNotFoundError(f"Archive root does not exist: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"Archive root must be a directory: {root}")

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
    checksum_cache = load_checksum_cache(checksums_path, checksum_algorithm) if resume_checksums else {}

    with (
        manifest_path.open("w") as manifest,
        metadata_path.open("w") as metadata_handle,
        status_ledger_path.open("w") as status_ledger_handle,
    ):
        checksum_handle = checksums_path.open("w") if checksum_algorithm else None
        try:
            for current_dir, dir_names, file_names in os.walk(root, followlinks=False):
                current_path = Path(current_dir)
                state.directory_count += 1
                dir_names.sort()
                file_names.sort()

                for name in file_names:
                    path = current_path / name
                    rel = relative_path(root, path)
                    try:
                        stat_result = path.lstat()
                    except OSError as error:
                        record_scan_error(state, rel, "lstat", error)
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

                    checksum_record = None
                    checksum_error = False
                    if checksum_algorithm and path_type == "file":
                        try:
                            cached = checksum_cache.get(rel)
                            if cached_checksum_matches(cached, record, checksum_algorithm):
                                digest = str(cached["digest"])
                                duplicate_of = record_checksum_seen(state, digest, rel)
                                cached_computed_at = cached.get("computed_at")
                                checksum_record = checksum_record_for_path(
                                    state,
                                    record,
                                    stat_result,
                                    digest,
                                    duplicate_of,
                                    reused=True,
                                    computed_at=cached_computed_at if isinstance(cached_computed_at, str) else None,
                                )
                                state.files_reused += 1
                                state.bytes_reused += stat_result.st_size
                            else:
                                digest = sha256_file(path)
                                duplicate_of = record_checksum_seen(state, digest, rel)
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
                            append_jsonl(checksum_handle, checksum_record)
                        except OSError as error:
                            checksum_error = True
                            record_scan_error(state, rel, "checksum", error)

                    metadata_record = metadata_for_path(path, root, record)
                    if metadata_record:
                        state.metadata_records.append(metadata_record)
                        append_jsonl(metadata_handle, metadata_record)
                        if is_volume_candidate(metadata_record):
                            state.volume_candidates.append(candidate_from_metadata(metadata_record))

                    metadata_gaps = metadata_gap_records(record, metadata_record)
                    state.metadata_gaps.extend(metadata_gaps)
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
        finally:
            if checksum_handle:
                checksum_handle.close()

    write_summary_outputs(state)
    return summary_payload(state)


def summary_payload(state: ScanState) -> dict[str, Any]:
    finished_at = utc_now()
    return {
        "schema": "cell-anatomy-archive-inventory-summary",
        "schema_version": SCHEMA_VERSION,
        "scanner": SCANNER_VERSION,
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
        "metadata_records": len(state.metadata_records),
        "metadata_gaps": len(state.metadata_gaps),
        "volume_candidates": len(state.volume_candidates),
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
            "checksums": "checksums.jsonl" if state.checksum_algorithm else None,
            "fixity_run": "fixity-run.json" if state.checksum_algorithm else None,
        },
    }


def write_summary_outputs(state: ScanState) -> None:
    summary = summary_payload(state)
    write_json(state.output_dir / "inventory-summary.json", summary)

    with (state.output_dir / "extension-summary.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=["extension", "file_count", "size_bytes"])
        writer.writeheader()
        for extension, count in sorted(state.extension_counts.items()):
            writer.writerow(
                {
                    "extension": extension,
                    "file_count": count,
                    "size_bytes": state.extension_bytes[extension],
                }
            )

    with (state.output_dir / "largest-files.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=["relative_path", "size_bytes", "extension", "likely_role"])
        writer.writeheader()
        writer.writerows(state.largest_files)

    with (state.output_dir / "scan-errors.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=["relative_path", "operation", "error"])
        writer.writeheader()
        for error in state.errors:
            writer.writerow(
                {
                    "relative_path": error.relative_path,
                    "operation": error.operation,
                    "error": error.error,
                }
            )

    with (state.output_dir / "volume-candidates.csv").open("w", newline="") as output:
        fieldnames = [
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
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(state.volume_candidates)

    with (state.output_dir / "metadata-gaps.csv").open("w", newline="") as output:
        fieldnames = [
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
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(state.metadata_gaps)

    if state.checksum_algorithm:
        write_json(
            state.output_dir / "fixity-run.json",
            {
                "schema": "cell-anatomy-archive-fixity-run",
                "schema_version": SCHEMA_VERSION,
                "scanner": SCANNER_VERSION,
                "archive_id": state.archive_id,
                "root": str(state.root),
                "algorithm": state.checksum_algorithm,
                "files_hashed": state.files_hashed,
                "files_reused": state.files_reused,
                "records_written": state.files_hashed + state.files_reused,
                "bytes_hashed": state.bytes_hashed,
                "bytes_reused": state.bytes_reused,
                "duplicate_files": state.checksum_duplicate_count,
                "finished_at": utc_now(),
            },
        )


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
        "--largest-file-limit",
        type=int,
        default=DEFAULT_LARGEST_FILE_LIMIT,
        help="Number of largest files to keep in largest-files.csv.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    started = time.monotonic()

    if args.command == "scan":
        if args.resume_checksums and not args.checksum:
            parser.error("--resume-checksums requires --checksum")
        summary = scan_archive(
            args.root,
            args.output_dir,
            archive_id=args.archive_id,
            checksum_algorithm=args.checksum,
            resume_checksums=args.resume_checksums,
            largest_file_limit=max(1, args.largest_file_limit),
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

    parser.error(f"Unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
