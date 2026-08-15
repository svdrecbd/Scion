#!/usr/bin/env python3
"""Create and validate immutable CAOS segmentation label volumes.

This module intentionally keeps inference and reliability separate.  The bundled
threshold runner is a deterministic plumbing baseline, not a validated biological
or clinical model.  Learned models can emit a compatible label Zarr and use the
``register`` command to enter the same provenance/QC path.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
from array import array
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Iterator


SCHEMA_VERSION = 1
PIPELINE_VERSION = "caos-segmentation-v0.1"
MANIFEST_SCHEMA = "cell-anatomy-segmentation-manifest"
SEGMENTATION_SCHEMA = "cell-anatomy-segmentation"
CHECKPOINT_SCHEMA = "cell-anatomy-segmentation-checkpoint"
SUPPORTED_DTYPES = {"|u1", "uint8", "<u2", ">u2", "uint16"}
TASKS = {"cell", "tooth", "custom"}
OPERATORS = {"ge", "gt", "le", "lt"}


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise ValueError(f"required_artifact_missing:{path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid_json:{path}:{exc.lineno}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"expected_json_object:{path}")
    return value


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    staging.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.replace(staging, path)


def canonical_sha256(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def sha256_file(path: Path, block_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(block_size):
            digest.update(block)
    return digest.hexdigest()


def sha256_tree(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    size_bytes = 0
    component_count = 0
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = child.relative_to(path).as_posix()
        size = child.stat().st_size
        child_digest = sha256_file(child)
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(child_digest.encode("ascii"))
        digest.update(b"\n")
        size_bytes += size
        component_count += 1
    return {
        "algorithm": "sha256-tree-v1",
        "digest": digest.hexdigest(),
        "size_bytes": size_bytes,
        "component_count": component_count,
    }


def safe_name(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")
    return normalized[:80] or "segmentation"


def zarr_array_path(root: Path) -> tuple[Path, Path, str]:
    resolved = root.expanduser().resolve()
    direct = resolved / ".zarray"
    nested = resolved / "0" / ".zarray"
    if nested.is_file():
        return resolved, resolved / "0", "0"
    if direct.is_file():
        return resolved, resolved, "."
    raise ValueError(f"zarr_array_metadata_missing:{resolved}")


def normalize_dtype(dtype: str) -> tuple[str, int, bool]:
    if dtype in {"|u1", "uint8"}:
        return "|u1", 1, False
    if dtype in {"<u2", "uint16"}:
        return "<u2", 2, False
    if dtype == ">u2":
        return ">u2", 2, True
    raise ValueError(f"unsupported_zarr_dtype:{dtype}")


def load_zarr(root: Path) -> dict[str, Any]:
    store, array_dir, array_path = zarr_array_path(root)
    config = read_json(array_dir / ".zarray")
    shape = config.get("shape")
    chunks = config.get("chunks")
    dtype = str(config.get("dtype") or "")
    if config.get("zarr_format") != 2:
        raise ValueError("unsupported_zarr_version")
    if not isinstance(shape, list) or len(shape) != 3 or not all(isinstance(value, int) and value > 0 for value in shape):
        raise ValueError("zarr_shape_must_be_positive_zyx")
    if not isinstance(chunks, list) or len(chunks) != 3 or not all(isinstance(value, int) and value > 0 for value in chunks):
        raise ValueError("zarr_chunks_must_be_positive_zyx")
    if dtype not in SUPPORTED_DTYPES:
        raise ValueError(f"unsupported_zarr_dtype:{dtype or 'missing'}")
    if config.get("compressor") is not None or config.get("filters") is not None:
        raise ValueError("compressed_or_filtered_zarr_not_supported")
    if config.get("order", "C") != "C":
        raise ValueError("fortran_order_zarr_not_supported")
    if config.get("dimension_separator", ".") != ".":
        raise ValueError("unsupported_zarr_dimension_separator")
    normalized_dtype, bytes_per_voxel, big_endian = normalize_dtype(dtype)
    return {
        "store": store,
        "array_dir": array_dir,
        "array_path": array_path,
        "shape": tuple(shape),
        "chunks": tuple(chunks),
        "dtype": normalized_dtype,
        "bytes_per_voxel": bytes_per_voxel,
        "big_endian": big_endian,
        "fill_value": config.get("fill_value", 0),
        "metadata_sha256": canonical_sha256(config),
    }


def chunk_specs(
    shape: tuple[int, int, int], chunks: tuple[int, int, int]
) -> Iterator[tuple[str, tuple[int, int, int, int, int, int]]]:
    for z0 in range(0, shape[0], chunks[0]):
        z1 = min(shape[0], z0 + chunks[0])
        for y0 in range(0, shape[1], chunks[1]):
            y1 = min(shape[1], y0 + chunks[1])
            for x0 in range(0, shape[2], chunks[2]):
                x1 = min(shape[2], x0 + chunks[2])
                yield f"{z0 // chunks[0]}.{y0 // chunks[1]}.{x0 // chunks[2]}", (z0, z1, y0, y1, x0, x1)


def expected_chunk_size(bounds: tuple[int, int, int, int, int, int], bytes_per_voxel: int) -> int:
    z0, z1, y0, y1, x0, x1 = bounds
    return (z1 - z0) * (y1 - y0) * (x1 - x0) * bytes_per_voxel


def read_chunk(zarr: dict[str, Any], name: str, bounds: tuple[int, int, int, int, int, int]) -> bytes:
    path = zarr["array_dir"] / name
    if not path.is_file():
        raise ValueError(f"source_chunk_missing:{name}")
    raw = path.read_bytes()
    expected = expected_chunk_size(bounds, zarr["bytes_per_voxel"])
    if len(raw) != expected:
        raise ValueError(f"source_chunk_size_mismatch:{name}:expected={expected}:actual={len(raw)}")
    return raw


def iter_values(raw: bytes, zarr: dict[str, Any]) -> Iterable[int]:
    if zarr["bytes_per_voxel"] == 1:
        return raw
    values = array("H")
    values.frombytes(raw)
    host_big_endian = sys.byteorder == "big"
    if bool(zarr["big_endian"]) != host_big_endian:
        values.byteswap()
    return values


def array_checksum_update(digest: Any, name: str, raw: bytes) -> None:
    child_digest = hashlib.sha256(raw).hexdigest()
    digest.update(name.encode("ascii"))
    digest.update(b"\0")
    digest.update(str(len(raw)).encode("ascii"))
    digest.update(b"\0")
    digest.update(child_digest.encode("ascii"))
    digest.update(b"\n")


def read_voxel_size_nm(store: Path) -> dict[str, float]:
    attrs_path = store / ".zattrs"
    if attrs_path.is_file():
        attrs = read_json(attrs_path)
        for multiscale in attrs.get("multiscales") or []:
            if not isinstance(multiscale, dict):
                continue
            for dataset in multiscale.get("datasets") or []:
                if not isinstance(dataset, dict):
                    continue
                for transform in dataset.get("coordinateTransformations") or []:
                    if isinstance(transform, dict) and transform.get("type") == "scale":
                        scale = transform.get("scale")
                        if isinstance(scale, list) and len(scale) == 3:
                            try:
                                values = [float(value) for value in scale]
                            except (TypeError, ValueError):
                                continue
                            if all(math.isfinite(value) and value > 0 for value in values):
                                return {"z": values[0], "y": values[1], "x": values[2]}
    return {"z": 1.0, "y": 1.0, "x": 1.0}


def write_label_metadata(
    store: Path,
    *,
    name: str,
    shape: tuple[int, int, int],
    chunks: tuple[int, int, int],
    voxel_size_nm: dict[str, float],
    source_path: Path,
    task: str,
) -> None:
    array_dir = store / "0"
    array_dir.mkdir(parents=True, exist_ok=True)
    write_json_atomic(store / ".zgroup", {"zarr_format": 2})
    write_json_atomic(
        store / ".zattrs",
        {
            "image-label": {
                "version": "0.4",
                "source": {"image": str(source_path)},
                "colors": [{"label-value": 1, "rgba": [230, 112, 45, 220]}],
                "properties": [{"label-value": 1, "task": task, "name": name}],
            },
            "multiscales": [
                {
                    "version": "0.4",
                    "name": name,
                    "type": "labels",
                    "axes": [
                        {"name": "z", "type": "space", "unit": "nanometer"},
                        {"name": "y", "type": "space", "unit": "nanometer"},
                        {"name": "x", "type": "space", "unit": "nanometer"},
                    ],
                    "datasets": [
                        {
                            "path": "0",
                            "coordinateTransformations": [
                                {"type": "scale", "scale": [voxel_size_nm[axis] for axis in ("z", "y", "x")]}
                            ],
                        }
                    ],
                }
            ],
        },
    )
    write_json_atomic(
        array_dir / ".zarray",
        {
            "zarr_format": 2,
            "shape": list(shape),
            "chunks": list(chunks),
            "dtype": "|u1",
            "compressor": None,
            "fill_value": 0,
            "order": "C",
            "filters": None,
            "dimension_separator": ".",
        },
    )
    write_json_atomic(array_dir / ".zattrs", {"_ARRAY_DIMENSIONS": ["z", "y", "x"]})


def segmentation_paths(source: Path, recipe_id: str) -> tuple[Path, Path, Path]:
    root = source.parent / f"{source.name}.caos-segmentations"
    target = root / f"{recipe_id}.labels.ome.zarr"
    staging = root / f".{recipe_id}.labels.ome.zarr.inprogress"
    manifest = source.parent / f"{source.name}.caos-segmentations.json"
    return target, staging, manifest


def empty_manifest(source: Path) -> dict[str, Any]:
    return {
        "schema": MANIFEST_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "source_output_path": str(source),
        "updated_at": utc_now(),
        "segmentations": [],
    }


def load_manifest(path: Path, source: Path) -> dict[str, Any]:
    if not path.exists():
        return empty_manifest(source)
    manifest = read_json(path)
    if manifest.get("schema") != MANIFEST_SCHEMA or manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported_segmentation_manifest_schema")
    recorded_source = Path(str(manifest.get("source_output_path") or "")).expanduser().resolve()
    if recorded_source != source:
        raise ValueError("segmentation_manifest_source_mismatch")
    if not isinstance(manifest.get("segmentations"), list):
        raise ValueError("segmentation_manifest_entries_required")
    return manifest


def update_manifest(path: Path, source: Path, entry: dict[str, Any]) -> None:
    manifest = load_manifest(path, source)
    entries = [
        item
        for item in manifest["segmentations"]
        if isinstance(item, dict) and item.get("segmentation_id") != entry["segmentation_id"]
    ]
    entries.append(entry)
    manifest["pipeline_version"] = PIPELINE_VERSION
    manifest["updated_at"] = utc_now()
    manifest["segmentations"] = sorted(entries, key=lambda item: str(item.get("segmentation_id") or ""))
    write_json_atomic(path, manifest)


def validate_label_store(
    store: Path,
    *,
    shape: tuple[int, int, int],
    chunks: tuple[int, int, int],
) -> dict[str, Any]:
    label = load_zarr(store)
    checks = {
        "shape_matches_source": label["shape"] == shape,
        "chunks_match_source": label["chunks"] == chunks,
        "label_dtype_uint8": label["dtype"] == "|u1",
        "root_ome_metadata": (store / ".zattrs").is_file(),
        "array_axes_metadata": (label["array_dir"] / ".zattrs").is_file(),
    }
    expected = 0
    actual = 0
    binary = True
    for name, bounds in chunk_specs(shape, chunks):
        expected += 1
        path = label["array_dir"] / name
        expected_size = expected_chunk_size(bounds, 1)
        if path.is_file() and path.stat().st_size == expected_size:
            actual += 1
            if any(value not in (0, 1) for value in path.read_bytes()):
                binary = False
    checks["all_chunks_present_and_sized"] = actual == expected
    checks["binary_labels"] = binary
    return {
        "status": "passed" if all(checks.values()) else "failed",
        "checks": checks,
        "chunk_count_expected": expected,
        "chunk_count_actual": actual,
    }


def threshold_chunk(values: Iterable[int], threshold: float, operator: str) -> bytes:
    if operator == "ge":
        return bytes(1 if value >= threshold else 0 for value in values)
    if operator == "gt":
        return bytes(1 if value > threshold else 0 for value in values)
    if operator == "le":
        return bytes(1 if value <= threshold else 0 for value in values)
    if operator == "lt":
        return bytes(1 if value < threshold else 0 for value in values)
    raise ValueError(f"unsupported_threshold_operator:{operator}")


def update_bbox(
    bbox: list[int] | None,
    labels: bytes,
    bounds: tuple[int, int, int, int, int, int],
) -> list[int] | None:
    z0, z1, y0, y1, x0, x1 = bounds
    local_y = y1 - y0
    local_x = x1 - x0
    current = bbox
    for index, label in enumerate(labels):
        if label == 0:
            continue
        lz, remainder = divmod(index, local_y * local_x)
        ly, lx = divmod(remainder, local_x)
        z, y, x = z0 + lz, y0 + ly, x0 + lx
        if current is None:
            current = [z, y, x, z, y, x]
        else:
            current[0] = min(current[0], z)
            current[1] = min(current[1], y)
            current[2] = min(current[2], x)
            current[3] = max(current[3], z)
            current[4] = max(current[4], y)
            current[5] = max(current[5], x)
    return current


def source_array_checksum(source: dict[str, Any]) -> dict[str, Any]:
    digest = hashlib.sha256()
    size_bytes = 0
    chunk_count = 0
    for name, bounds in chunk_specs(source["shape"], source["chunks"]):
        raw = read_chunk(source, name, bounds)
        array_checksum_update(digest, name, raw)
        size_bytes += len(raw)
        chunk_count += 1
    return {
        "algorithm": "sha256-zarr-array-v1",
        "digest": digest.hexdigest(),
        "size_bytes": size_bytes,
        "chunk_count": chunk_count,
    }


def run_threshold_segmentation(
    source_path: Path,
    *,
    task: str,
    threshold: float,
    operator: str = "ge",
    label_name: str | None = None,
) -> dict[str, Any]:
    if task not in TASKS:
        raise ValueError(f"unsupported_segmentation_task:{task}")
    if operator not in OPERATORS:
        raise ValueError(f"unsupported_threshold_operator:{operator}")
    if not math.isfinite(threshold):
        raise ValueError("threshold_must_be_finite")
    source = load_zarr(source_path)
    source_root: Path = source["store"]
    max_value = 255 if source["bytes_per_voxel"] == 1 else 65535
    if threshold < 0 or threshold > max_value:
        raise ValueError(f"threshold_out_of_range:0:{max_value}")
    name = (label_name or task).strip()
    if not name:
        raise ValueError("label_name_required")

    recipe = {
        "pipeline_version": PIPELINE_VERSION,
        "method": "threshold-baseline-v1",
        "task": task,
        "source": {
            "output_path": str(source_root),
            "array_path": source["array_path"],
            "metadata_sha256": source["metadata_sha256"],
            "shape_zyx": list(source["shape"]),
            "chunks_zyx": list(source["chunks"]),
            "dtype": source["dtype"],
        },
        "parameters": {"threshold": threshold, "operator": operator, "foreground_label": 1},
        "output": {"dtype": "|u1", "label_name": name},
    }
    recipe_sha256 = canonical_sha256(recipe)
    segmentation_id = recipe_sha256[:20]
    target, staging, manifest_path = segmentation_paths(source_root, segmentation_id)
    manifest = load_manifest(manifest_path, source_root)
    existing = next(
        (
            item
            for item in manifest["segmentations"]
            if isinstance(item, dict) and item.get("segmentation_id") == segmentation_id
        ),
        None,
    )
    if target.exists():
        if not existing:
            raise ValueError("existing_segmentation_missing_manifest_record")
        provenance = read_json(target / "caos-segmentation.json")
        if provenance.get("recipe_sha256") != recipe_sha256:
            raise ValueError("immutable_segmentation_collision")
        current_source_checksum = source_array_checksum(source)
        if existing.get("source_array_checksum") != current_source_checksum:
            raise ValueError("existing_segmentation_source_checksum_mismatch")
        validation = validate_label_store(target, shape=source["shape"], chunks=source["chunks"])
        if validation["status"] != "passed":
            raise ValueError("existing_segmentation_validation_failed")
        if existing.get("output_checksum") != sha256_tree(target):
            raise ValueError("existing_segmentation_checksum_mismatch")
        return {**existing, "reused": True, "manifest_path": str(manifest_path)}

    target.parent.mkdir(parents=True, exist_ok=True)
    if staging.exists():
        checkpoint_path = staging / ".segmentation-checkpoint.json"
        checkpoint = read_json(checkpoint_path) if checkpoint_path.exists() else {}
        if checkpoint and checkpoint.get("recipe_sha256") != recipe_sha256:
            raise ValueError("segmentation_staging_recipe_collision")
    else:
        staging.mkdir()
        checkpoint = {}
    completed_sha = checkpoint.get("completed_chunk_sha256")
    if not isinstance(completed_sha, dict):
        completed_sha = {}
    checkpoint.update(
        {
            "schema": CHECKPOINT_SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "recipe_sha256": recipe_sha256,
            "segmentation_id": segmentation_id,
            "started_at": checkpoint.get("started_at") or utc_now(),
            "updated_at": utc_now(),
            "completed_chunk_sha256": completed_sha,
        }
    )
    write_label_metadata(
        staging,
        name=name,
        shape=source["shape"],
        chunks=source["chunks"],
        voxel_size_nm=read_voxel_size_nm(source_root),
        source_path=source_root,
        task=task,
    )

    input_digest = hashlib.sha256()
    input_size = 0
    foreground = 0
    bbox: list[int] | None = None
    written = 0
    reused = 0
    for chunk_name, bounds in chunk_specs(source["shape"], source["chunks"]):
        raw = read_chunk(source, chunk_name, bounds)
        array_checksum_update(input_digest, chunk_name, raw)
        input_size += len(raw)
        labels = threshold_chunk(iter_values(raw, source), threshold, operator)
        foreground += sum(labels)
        bbox = update_bbox(bbox, labels, bounds)
        output_chunk = staging / "0" / chunk_name
        expected_digest = hashlib.sha256(labels).hexdigest()
        recorded_digest = str(completed_sha.get(chunk_name) or "")
        if output_chunk.is_file() and recorded_digest == expected_digest and sha256_file(output_chunk) == expected_digest:
            reused += 1
        else:
            chunk_staging = output_chunk.with_name(f".{chunk_name}.tmp-{os.getpid()}")
            chunk_staging.write_bytes(labels)
            os.replace(chunk_staging, output_chunk)
            written += 1
        completed_sha[chunk_name] = expected_digest
        checkpoint["completed_chunk_sha256"] = dict(sorted(completed_sha.items()))
        checkpoint["updated_at"] = utc_now()
        write_json_atomic(staging / ".segmentation-checkpoint.json", checkpoint)

    voxel_count = math.prod(source["shape"])
    fraction = foreground / voxel_count
    qc = {
        "status": "passed" if 0 < foreground < voxel_count else "failed",
        "checks": {
            "foreground_not_empty": foreground > 0,
            "foreground_not_full_volume": foreground < voxel_count,
        },
        "foreground_voxels": foreground,
        "background_voxels": voxel_count - foreground,
        "foreground_fraction": fraction,
        "foreground_bbox_zyx_inclusive": bbox,
    }
    if qc["status"] != "passed":
        raise ValueError("degenerate_segmentation_candidate")
    source_checksum = {
        "algorithm": "sha256-zarr-array-v1",
        "digest": input_digest.hexdigest(),
        "size_bytes": input_size,
        "chunk_count": len(completed_sha),
    }
    validation = validate_label_store(staging, shape=source["shape"], chunks=source["chunks"])
    if validation["status"] != "passed":
        raise ValueError("segmentation_validation_failed")
    (staging / ".segmentation-checkpoint.json").unlink(missing_ok=True)
    provenance = {
        "schema": SEGMENTATION_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "segmentation_id": segmentation_id,
        "recipe_sha256": recipe_sha256,
        "recipe": recipe,
        "source_array_checksum": source_checksum,
        "automation": {
            "level": "baseline",
            "review_state": "unreviewed_candidate",
            "human_review_required": True,
            "validated_for_clinical_use": False,
        },
        "qc": qc,
    }
    write_json_atomic(staging / "caos-segmentation.json", provenance)
    output_checksum = sha256_tree(staging)
    os.replace(staging, target)
    voxel_size = read_voxel_size_nm(source_root)
    entry = {
        "schema": SEGMENTATION_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "segmentation_id": segmentation_id,
        "recipe_sha256": recipe_sha256,
        "task": task,
        "label_name": name,
        "method": "threshold-baseline-v1",
        "source_output_path": str(source_root),
        "source_array_path": source["array_path"],
        "source_array_checksum": source_checksum,
        "output_path": str(target),
        "format": "OME-Zarr Labels",
        "ome_ngff_version": "0.4",
        "zarr_format": 2,
        "array_path": "0",
        "shape_zyx": list(source["shape"]),
        "chunks_zyx": list(source["chunks"]),
        "dtype": "uint8",
        "zarr_dtype": "|u1",
        "physical_voxel_size_nm": voxel_size,
        "output_checksum": output_checksum,
        "byte_size": output_checksum["size_bytes"],
        "created_at": utc_now(),
        "review_state": "unreviewed_candidate",
        "human_review_required": True,
        "validated_for_clinical_use": False,
        "qc": qc,
        "validation": validation,
        "recipe": recipe,
        "resume": {"written": written, "reused": reused, "total": len(completed_sha)},
    }
    update_manifest(manifest_path, source_root, entry)
    return {**entry, "reused": False, "manifest_path": str(manifest_path)}


def register_label_segmentation(
    source_path: Path,
    labels_path: Path,
    *,
    task: str,
    model_id: str,
    model_version: str,
    expected_source_sha256: str,
    label_name: str | None = None,
) -> dict[str, Any]:
    """Validate external model labels and copy them through the immutable contract."""
    if task not in TASKS:
        raise ValueError(f"unsupported_segmentation_task:{task}")
    if not model_id.strip() or not model_version.strip():
        raise ValueError("model_id_and_version_required")
    if not re.fullmatch(r"[a-f0-9]{64}", expected_source_sha256):
        raise ValueError("expected_source_sha256_required")
    source = load_zarr(source_path)
    labels = load_zarr(labels_path)
    if labels["shape"] != source["shape"]:
        raise ValueError("label_shape_mismatch")
    if labels["chunks"] != source["chunks"]:
        raise ValueError("label_chunk_shape_mismatch")
    if labels["dtype"] != "|u1":
        raise ValueError("external_labels_must_be_uint8")
    name = (label_name or task).strip()
    source_checksum = source_array_checksum(source)
    if source_checksum["digest"] != expected_source_sha256:
        raise ValueError("external_labels_source_checksum_mismatch")
    label_checksum = source_array_checksum(labels)
    recipe = {
        "pipeline_version": PIPELINE_VERSION,
        "method": "external-model-labels-v1",
        "task": task,
        "source": {
            "output_path": str(source["store"]),
            "array_path": source["array_path"],
            "metadata_sha256": source["metadata_sha256"],
            "array_checksum": source_checksum,
            "shape_zyx": list(source["shape"]),
            "dtype": source["dtype"],
        },
        "model": {"id": model_id.strip(), "version": model_version.strip()},
        "labels": {"input_array_checksum": label_checksum, "label_name": name},
        "output": {"dtype": "|u1"},
    }
    recipe_sha256 = canonical_sha256(recipe)
    segmentation_id = recipe_sha256[:20]
    target, staging, manifest_path = segmentation_paths(source["store"], segmentation_id)
    manifest = load_manifest(manifest_path, source["store"])
    existing = next(
        (item for item in manifest["segmentations"] if isinstance(item, dict) and item.get("segmentation_id") == segmentation_id),
        None,
    )
    if target.exists():
        if not existing or existing.get("output_checksum") != sha256_tree(target):
            raise ValueError("existing_registered_segmentation_mismatch")
        return {**existing, "reused": True, "manifest_path": str(manifest_path)}
    target.parent.mkdir(parents=True, exist_ok=True)
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    write_label_metadata(
        staging,
        name=name,
        shape=source["shape"],
        chunks=source["chunks"],
        voxel_size_nm=read_voxel_size_nm(source["store"]),
        source_path=source["store"],
        task=task,
    )
    foreground = 0
    bbox: list[int] | None = None
    output_array = staging / "0"
    for chunk_name, bounds in chunk_specs(source["shape"], source["chunks"]):
        raw = read_chunk(labels, chunk_name, bounds)
        if any(value not in (0, 1) for value in raw):
            raise ValueError(f"external_labels_not_binary:{chunk_name}")
        foreground += sum(raw)
        bbox = update_bbox(bbox, raw, bounds)
        (output_array / chunk_name).write_bytes(raw)
    voxel_count = math.prod(source["shape"])
    if foreground == 0 or foreground == voxel_count:
        raise ValueError("degenerate_segmentation_candidate")
    qc = {
        "status": "passed",
        "checks": {"foreground_not_empty": True, "foreground_not_full_volume": True},
        "foreground_voxels": foreground,
        "background_voxels": voxel_count - foreground,
        "foreground_fraction": foreground / voxel_count,
        "foreground_bbox_zyx_inclusive": bbox,
    }
    validation = validate_label_store(staging, shape=source["shape"], chunks=source["chunks"])
    provenance = {
        "schema": SEGMENTATION_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "segmentation_id": segmentation_id,
        "recipe_sha256": recipe_sha256,
        "recipe": recipe,
        "source_array_checksum": source_checksum,
        "automation": {
            "level": "model",
            "review_state": "unreviewed_candidate",
            "human_review_required": True,
            "validated_for_clinical_use": False,
        },
        "qc": qc,
    }
    write_json_atomic(staging / "caos-segmentation.json", provenance)
    output_checksum = sha256_tree(staging)
    os.replace(staging, target)
    entry = {
        "schema": SEGMENTATION_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "segmentation_id": segmentation_id,
        "recipe_sha256": recipe_sha256,
        "task": task,
        "label_name": name,
        "method": "external-model-labels-v1",
        "model": recipe["model"],
        "source_output_path": str(source["store"]),
        "source_array_path": source["array_path"],
        "source_array_checksum": source_checksum,
        "output_path": str(target),
        "format": "OME-Zarr Labels",
        "ome_ngff_version": "0.4",
        "zarr_format": 2,
        "array_path": "0",
        "shape_zyx": list(source["shape"]),
        "chunks_zyx": list(source["chunks"]),
        "dtype": "uint8",
        "zarr_dtype": "|u1",
        "physical_voxel_size_nm": read_voxel_size_nm(source["store"]),
        "output_checksum": output_checksum,
        "byte_size": output_checksum["size_bytes"],
        "created_at": utc_now(),
        "review_state": "unreviewed_candidate",
        "human_review_required": True,
        "validated_for_clinical_use": False,
        "qc": qc,
        "validation": validation,
        "recipe": recipe,
    }
    update_manifest(manifest_path, source["store"], entry)
    return {**entry, "reused": False, "manifest_path": str(manifest_path)}


def inspect_segmentations(source_path: Path) -> dict[str, Any]:
    source = load_zarr(source_path)
    _, _, manifest_path = segmentation_paths(source["store"], "unused")
    return load_manifest(manifest_path, source["store"])


def inspect_source_checksum(source_path: Path) -> dict[str, Any]:
    source = load_zarr(source_path)
    return {
        "source_output_path": str(source["store"]),
        "array_path": source["array_path"],
        "shape_zyx": list(source["shape"]),
        "chunks_zyx": list(source["chunks"]),
        "dtype": source["dtype"],
        "array_checksum": source_array_checksum(source),
    }


def ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def evaluate_segmentation(
    prediction_path: Path,
    truth_path: Path,
    *,
    truth_id: str,
    output_path: Path | None = None,
    min_dice: float | None = None,
    min_iou: float | None = None,
    min_recall: float | None = None,
    max_false_positive_rate: float | None = None,
) -> dict[str, Any]:
    if not truth_id.strip():
        raise ValueError("truth_id_required")
    thresholds = {
        "min_dice": min_dice,
        "min_iou": min_iou,
        "min_recall": min_recall,
        "max_false_positive_rate": max_false_positive_rate,
    }
    for name, value in thresholds.items():
        if value is not None and (not math.isfinite(value) or value < 0 or value > 1):
            raise ValueError(f"evaluation_threshold_out_of_range:{name}")

    prediction = load_zarr(prediction_path)
    truth = load_zarr(truth_path)
    if prediction["dtype"] != "|u1" or truth["dtype"] != "|u1":
        raise ValueError("evaluation_requires_uint8_binary_labels")
    if prediction["shape"] != truth["shape"]:
        raise ValueError("evaluation_shape_mismatch")
    if prediction["chunks"] != truth["chunks"]:
        raise ValueError("evaluation_chunk_shape_mismatch")

    prediction_digest = hashlib.sha256()
    truth_digest = hashlib.sha256()
    prediction_size = 0
    truth_size = 0
    tp = fp = fn = tn = 0
    chunk_count = 0
    for name, bounds in chunk_specs(prediction["shape"], prediction["chunks"]):
        predicted = read_chunk(prediction, name, bounds)
        expected = read_chunk(truth, name, bounds)
        if any(value not in (0, 1) for value in predicted):
            raise ValueError(f"prediction_labels_not_binary:{name}")
        if any(value not in (0, 1) for value in expected):
            raise ValueError(f"truth_labels_not_binary:{name}")
        array_checksum_update(prediction_digest, name, predicted)
        array_checksum_update(truth_digest, name, expected)
        prediction_size += len(predicted)
        truth_size += len(expected)
        chunk_count += 1
        for predicted_value, truth_value in zip(predicted, expected, strict=True):
            if predicted_value and truth_value:
                tp += 1
            elif predicted_value:
                fp += 1
            elif truth_value:
                fn += 1
            else:
                tn += 1
    if tp + fn == 0:
        raise ValueError("ground_truth_has_no_foreground")

    dice = ratio(2 * tp, 2 * tp + fp + fn)
    iou = ratio(tp, tp + fp + fn)
    recall = ratio(tp, tp + fn)
    precision = ratio(tp, tp + fp)
    specificity = ratio(tn, tn + fp)
    false_positive_rate = ratio(fp, fp + tn)
    accuracy = ratio(tp + tn, tp + fp + fn + tn)
    assert dice is not None and iou is not None and recall is not None
    metrics = {
        "dice": dice,
        "iou": iou,
        "precision": precision,
        "recall": recall,
        "specificity": specificity,
        "false_positive_rate": false_positive_rate,
        "accuracy": accuracy,
    }
    configured = {name: value for name, value in thresholds.items() if value is not None}
    checks = {
        "min_dice": min_dice is None or dice >= min_dice,
        "min_iou": min_iou is None or iou >= min_iou,
        "min_recall": min_recall is None or recall >= min_recall,
        "max_false_positive_rate": max_false_positive_rate is None
        or (false_positive_rate is not None and false_positive_rate <= max_false_positive_rate),
    }
    gate_status = "not_configured" if not configured else "passed" if all(checks.values()) else "failed"
    prediction_checksum = {
        "algorithm": "sha256-zarr-array-v1",
        "digest": prediction_digest.hexdigest(),
        "size_bytes": prediction_size,
        "chunk_count": chunk_count,
    }
    truth_checksum = {
        "algorithm": "sha256-zarr-array-v1",
        "digest": truth_digest.hexdigest(),
        "size_bytes": truth_size,
        "chunk_count": chunk_count,
    }
    identity = {
        "pipeline_version": PIPELINE_VERSION,
        "prediction_checksum": prediction_checksum,
        "truth_id": truth_id.strip(),
        "truth_checksum": truth_checksum,
        "thresholds": configured,
    }
    evaluation_sha256 = canonical_sha256(identity)
    evaluation_id = evaluation_sha256[:20]
    provenance_path = prediction["store"] / "caos-segmentation.json"
    segmentation_id = ""
    if provenance_path.is_file():
        segmentation_id = str(read_json(provenance_path).get("segmentation_id") or "")
    report = {
        "schema": "cell-anatomy-segmentation-evaluation",
        "schema_version": SCHEMA_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "evaluation_id": evaluation_id,
        "evaluation_sha256": evaluation_sha256,
        "created_at": utc_now(),
        "prediction": {
            "segmentation_id": segmentation_id,
            "output_path": str(prediction["store"]),
            "array_checksum": prediction_checksum,
        },
        "ground_truth": {
            "truth_id": truth_id.strip(),
            "output_path": str(truth["store"]),
            "array_checksum": truth_checksum,
        },
        "shape_zyx": list(prediction["shape"]),
        "confusion": {
            "true_positive": tp,
            "false_positive": fp,
            "false_negative": fn,
            "true_negative": tn,
        },
        "metrics": metrics,
        "acceptance_gate": {
            "status": gate_status,
            "thresholds": configured,
            "checks": {name: checks[name] for name in configured},
        },
        "promotion": {
            "eligible_from_this_evaluation": gate_status == "passed",
            "human_review_required": True,
            "cohort_evaluation_required": True,
            "validated_for_clinical_use": False,
        },
    }
    target = (
        output_path.expanduser().resolve()
        if output_path
        else prediction["store"].parent
        / f"{prediction['store'].name}.evaluation-{evaluation_id}.json"
    )
    if target.exists():
        existing = read_json(target)
        if existing.get("evaluation_id") != evaluation_id:
            raise ValueError("evaluation_output_collision")
        return {**existing, "reused": True, "output_path": str(target)}
    write_json_atomic(target, report)
    return {**report, "reused": False, "output_path": str(target)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create immutable, review-gated CAOS segmentation labels.")
    commands = parser.add_subparsers(dest="command", required=True)

    threshold = commands.add_parser("threshold", help="Run the deterministic threshold plumbing baseline.")
    threshold.add_argument("--source", type=Path, required=True, help="Source OME-Zarr/Zarr v2 store.")
    threshold.add_argument("--task", choices=sorted(TASKS), required=True)
    threshold.add_argument("--threshold", type=float, required=True)
    threshold.add_argument("--operator", choices=sorted(OPERATORS), default="ge")
    threshold.add_argument("--label-name")

    register = commands.add_parser("register", help="Validate and register externally generated binary model labels.")
    register.add_argument("--source", type=Path, required=True)
    register.add_argument("--labels", type=Path, required=True)
    register.add_argument("--task", choices=sorted(TASKS), required=True)
    register.add_argument("--model-id", required=True)
    register.add_argument("--model-version", required=True)
    register.add_argument("--expected-source-sha256", required=True)
    register.add_argument("--label-name")

    inspect = commands.add_parser("inspect", help="Print the segmentation manifest for a source volume.")
    inspect.add_argument("--source", type=Path, required=True)

    checksum = commands.add_parser("checksum", help="Compute the canonical input-array checksum for a model run.")
    checksum.add_argument("--source", type=Path, required=True)

    evaluate = commands.add_parser("evaluate", help="Compare binary prediction labels with fixed ground truth.")
    evaluate.add_argument("--prediction", type=Path, required=True)
    evaluate.add_argument("--truth", type=Path, required=True)
    evaluate.add_argument("--truth-id", required=True)
    evaluate.add_argument("--output", type=Path)
    evaluate.add_argument("--min-dice", type=float)
    evaluate.add_argument("--min-iou", type=float)
    evaluate.add_argument("--min-recall", type=float)
    evaluate.add_argument("--max-false-positive-rate", type=float)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "threshold":
            result = run_threshold_segmentation(
                args.source,
                task=args.task,
                threshold=args.threshold,
                operator=args.operator,
                label_name=args.label_name,
            )
        elif args.command == "register":
            result = register_label_segmentation(
                args.source,
                args.labels,
                task=args.task,
                model_id=args.model_id,
                model_version=args.model_version,
                expected_source_sha256=args.expected_source_sha256,
                label_name=args.label_name,
            )
        elif args.command == "inspect":
            result = inspect_segmentations(args.source)
        elif args.command == "checksum":
            result = inspect_source_checksum(args.source)
        else:
            result = evaluate_segmentation(
                args.prediction,
                args.truth,
                truth_id=args.truth_id,
                output_path=args.output,
                min_dice=args.min_dice,
                min_iou=args.min_iou,
                min_recall=args.min_recall,
                max_false_positive_rate=args.max_false_positive_rate,
            )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
