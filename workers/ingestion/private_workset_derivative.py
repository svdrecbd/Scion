#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import struct
import sys
from array import array
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Iterable

try:
    from public_data_pilot import parse_classic_tiff_ifds, tiff_slice_pixels
except ModuleNotFoundError:  # Imported as a repo-root module in unit tests.
    from workers.ingestion.public_data_pilot import parse_classic_tiff_ifds, tiff_slice_pixels


WORKSET_SCHEMA = "cell-anatomy-archive-workset"
WORKSET_ASSET_SCHEMA = "cell-anatomy-archive-workset-asset"
DERIVATIVE_MANIFEST_SCHEMA = "cell-anatomy-workset-derivative-manifest"
DERIVATIVE_SCHEMA = "cell-anatomy-workset-derivative"
SCHEMA_VERSION = 1
FACTORY_VERSION = "private-workset-derivative-v0.1"
DEFAULT_CHUNKS = (32, 256, 256)
SUPPORTED_FORMATS = {"TIFF", "MRC"}


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


def iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    try:
        source = path.open()
    except FileNotFoundError as exc:
        raise ValueError(f"required_artifact_missing:{path}") from exc
    with source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid_jsonl:{path}:{line_number}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"expected_jsonl_object:{path}:{line_number}")
            yield value


def parse_chunk_shape(raw: str | None) -> tuple[int, int, int]:
    if not raw:
        return DEFAULT_CHUNKS
    parts = [part.strip() for part in raw.split(",")]
    if len(parts) != 3:
        raise ValueError("chunk_shape_must_be_z_y_x")
    try:
        chunks = tuple(int(part) for part in parts)
    except ValueError as exc:
        raise ValueError("chunk_shape_values_must_be_integers") from exc
    if any(value <= 0 for value in chunks):
        raise ValueError("chunk_shape_values_must_be_positive")
    return chunks  # type: ignore[return-value]


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


def canonical_sha256(value: dict[str, Any]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def safe_name(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")
    return normalized[:120] or "asset"


def workset_file(path: Path) -> Path:
    expanded = path.expanduser().resolve()
    return expanded if expanded.is_file() else expanded / "workset.json"


def load_workset(path: Path) -> tuple[Path, dict[str, Any], list[dict[str, Any]]]:
    summary_path = workset_file(path)
    workset = read_json(summary_path)
    if workset.get("schema") != WORKSET_SCHEMA or workset.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported_workset_schema")
    if not str(workset.get("workset_id") or "").strip():
        raise ValueError("workset_id_required")
    assets = list(iter_jsonl(summary_path.parent / "workset-assets.jsonl"))
    seen: set[str] = set()
    for asset in assets:
        if asset.get("schema") != WORKSET_ASSET_SCHEMA or asset.get("schema_version") != SCHEMA_VERSION:
            raise ValueError("unsupported_workset_asset_schema")
        asset_id = str(asset.get("asset_id") or "")
        if not asset_id or asset_id in seen:
            raise ValueError("invalid_or_duplicate_workset_asset_id")
        seen.add(asset_id)
    return summary_path, workset, assets


def select_asset(
    assets: list[dict[str, Any]],
    *,
    asset_id: str | None,
    relative_path: str | None,
) -> dict[str, Any]:
    if bool(asset_id) == bool(relative_path):
        raise ValueError("select_exactly_one_asset_id_or_relative_path")
    matches = [
        asset
        for asset in assets
        if (asset_id and asset.get("asset_id") == asset_id)
        or (relative_path and asset.get("relative_path") == relative_path)
    ]
    if not matches:
        raise ValueError("workset_asset_not_found")
    if len(matches) != 1:
        raise ValueError("workset_asset_selection_ambiguous")
    return matches[0]


def require_conversion_ready(asset: dict[str, Any]) -> None:
    status = asset.get("status") if isinstance(asset.get("status"), dict) else {}
    operations = status.get("allowed_operations") if isinstance(status.get("allowed_operations"), dict) else {}
    readiness = asset.get("readiness") if isinstance(asset.get("readiness"), dict) else {}
    promotion = asset.get("promotion") if isinstance(asset.get("promotion"), dict) else {}
    metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
    checksum = asset.get("checksum") if isinstance(asset.get("checksum"), dict) else {}
    source_format = str(metadata.get("format") or "").upper()

    if not operations.get("can_convert") or "convert" in (promotion.get("blocked_operations") or []):
        raise ValueError("conversion_not_authorized")
    if not readiness.get("conversion_ready") or readiness.get("blockers"):
        raise ValueError("asset_not_conversion_ready")
    if source_format not in SUPPORTED_FORMATS:
        if source_format == "HDF5":
            raise ValueError("hdf5_layout_pending_real_archive_fixture")
        raise ValueError(f"unsupported_source_format:{source_format or 'unknown'}")
    if checksum.get("algorithm") != "sha256" or not re.fullmatch(r"[a-f0-9]{64}", str(checksum.get("digest") or "")):
        raise ValueError("source_sha256_required")
    dimensions = metadata.get("dimensions") if isinstance(metadata.get("dimensions"), dict) else {}
    if not all(int(dimensions.get(axis) or 0) > 0 for axis in ("x", "y", "z")):
        raise ValueError("source_dimensions_required")
    voxel = metadata.get("voxel_size_nm") if isinstance(metadata.get("voxel_size_nm"), dict) else {}
    if not all(float(voxel.get(axis) or 0) > 0 for axis in ("x", "y", "z")):
        raise ValueError("source_voxel_size_required")


def resolve_source(workset: dict[str, Any], asset: dict[str, Any]) -> Path:
    registry = workset.get("source_registry") if isinstance(workset.get("source_registry"), dict) else {}
    source = asset.get("source") if isinstance(asset.get("source"), dict) else {}
    root_raw = str(source.get("root") or registry.get("archive_root") or "")
    relative_raw = str(source.get("relative_path") or asset.get("relative_path") or "")
    if not root_raw or not relative_raw or Path(relative_raw).is_absolute():
        raise ValueError("invalid_workset_source_reference")
    root = Path(root_raw).expanduser().resolve()
    source_path = (root / relative_raw).resolve()
    try:
        source_path.relative_to(root)
    except ValueError as exc:
        raise ValueError("source_path_escapes_archive_root") from exc
    if not source_path.is_file():
        raise ValueError(f"source_file_missing:{source_path}")
    expected_size = int(asset.get("size_bytes") or 0)
    if expected_size and source_path.stat().st_size != expected_size:
        raise ValueError("source_size_mismatch")
    return source_path


def source_identity(source_path: Path) -> tuple[int, int, int, int]:
    stat = source_path.stat()
    return (stat.st_size, stat.st_mtime_ns, stat.st_dev, stat.st_ino)


def verified_source_digest(source_path: Path, asset: dict[str, Any]) -> tuple[str, tuple[int, int, int, int]]:
    expected = str(asset["checksum"]["digest"])
    before = source_identity(source_path)
    actual = sha256_file(source_path)
    after = source_identity(source_path)
    if after != before:
        raise ValueError("source_changed_while_hashing")
    if actual != expected:
        raise ValueError("source_sha256_mismatch")
    return actual, after


def write_zarr_metadata(
    store: Path,
    *,
    name: str,
    shape: tuple[int, int, int],
    chunks: tuple[int, int, int],
    dtype: str,
    voxel_size_nm: dict[str, Any],
    provenance: dict[str, Any],
) -> None:
    array_dir = store / "0"
    array_dir.mkdir(parents=True, exist_ok=True)
    write_json_atomic(store / ".zgroup", {"zarr_format": 2})
    write_json_atomic(
        store / ".zattrs",
        {
            "multiscales": [
                {
                    "version": "0.4",
                    "name": name,
                    "type": "image",
                    "axes": [
                        {"name": "z", "type": "space", "unit": "nanometer"},
                        {"name": "y", "type": "space", "unit": "nanometer"},
                        {"name": "x", "type": "space", "unit": "nanometer"},
                    ],
                    "datasets": [
                        {
                            "path": "0",
                            "coordinateTransformations": [
                                {
                                    "type": "scale",
                                    "scale": [
                                        float(voxel_size_nm["z"]),
                                        float(voxel_size_nm["y"]),
                                        float(voxel_size_nm["x"]),
                                    ],
                                }
                            ],
                        }
                    ],
                    "metadata": provenance,
                }
            ]
        },
    )
    write_json_atomic(
        array_dir / ".zarray",
        {
            "zarr_format": 2,
            "shape": list(shape),
            "chunks": list(chunks),
            "dtype": dtype,
            "compressor": None,
            "fill_value": 0,
            "order": "C",
            "filters": None,
            "dimension_separator": ".",
        },
    )
    write_json_atomic(array_dir / ".zattrs", {"_ARRAY_DIMENSIONS": ["z", "y", "x"]})


def chunk_specs(shape: tuple[int, int, int], chunks: tuple[int, int, int]) -> Iterable[tuple[str, tuple[int, int, int, int, int, int]]]:
    for z0 in range(0, shape[0], chunks[0]):
        z1 = min(shape[0], z0 + chunks[0])
        for y0 in range(0, shape[1], chunks[1]):
            y1 = min(shape[1], y0 + chunks[1])
            for x0 in range(0, shape[2], chunks[2]):
                x1 = min(shape[2], x0 + chunks[2])
                yield (
                    f"{z0 // chunks[0]}.{y0 // chunks[1]}.{x0 // chunks[2]}",
                    (z0, z1, y0, y1, x0, x1),
                )


def byteswap_u16(raw: bytes) -> bytes:
    if len(raw) % 2:
        raise ValueError("unaligned_uint16_payload")
    swapped = bytearray(len(raw))
    swapped[0::2] = raw[1::2]
    swapped[1::2] = raw[0::2]
    return bytes(swapped)


def offset_signed_mrc(raw: bytes, mode: int) -> tuple[bytes, dict[str, Any]]:
    if mode == 0:
        return bytes(value ^ 0x80 for value in raw), {
            "kind": "integer_offset",
            "source_dtype": "int8",
            "target_dtype": "uint8",
            "offset": 128,
            "reversible": True,
        }
    if mode == 1:
        signed = array("h")
        signed.frombytes(raw)
        if sys.byteorder != "little":
            signed.byteswap()
        unsigned = array("H", (value + 32768 for value in signed))
        if sys.byteorder != "little":
            unsigned.byteswap()
        return unsigned.tobytes(), {
            "kind": "integer_offset",
            "source_dtype": "int16",
            "target_dtype": "uint16",
            "offset": 32768,
            "reversible": True,
        }
    if mode == 6:
        return raw, {"kind": "identity", "source_dtype": "uint16", "target_dtype": "uint16", "reversible": True}
    if mode == 2:
        raise ValueError("unsupported_mrc_float32_requires_float_reader")
    raise ValueError(f"unsupported_mrc_mode:{mode}")


def mrc_reader(source_path: Path) -> tuple[tuple[int, int, int], str, dict[str, Any], Callable[[int], bytes]]:
    with source_path.open("rb") as source:
        header = source.read(1024)
    if len(header) != 1024 or header[208:212] != b"MAP ":
        raise ValueError("invalid_mrc_header")
    nx, ny, nz, mode = struct.unpack_from("<4i", header, 0)
    axis_mapping = struct.unpack_from("<3i", header, 64)
    extended_header = struct.unpack_from("<i", header, 92)[0]
    if min(nx, ny, nz) <= 0 or extended_header < 0:
        raise ValueError("invalid_mrc_dimensions")
    if axis_mapping not in {(0, 0, 0), (1, 2, 3)}:
        raise ValueError(f"unsupported_mrc_axis_mapping:{axis_mapping}")
    machine_stamp = header[212:216]
    if machine_stamp[:2] == b"\x11\x11":
        raise ValueError("unsupported_big_endian_mrc")
    source_bytes = {0: 1, 1: 2, 2: 4, 6: 2}.get(mode)
    if source_bytes is None:
        raise ValueError(f"unsupported_mrc_mode:{mode}")
    # Probe the transform before starting output so unsupported float data fails cleanly.
    _, transform = offset_signed_mrc(b"\0" * source_bytes, mode)
    transform["axis_mapping"] = list(axis_mapping if axis_mapping != (0, 0, 0) else (1, 2, 3))
    transform["axis_mapping_source"] = "header" if axis_mapping != (0, 0, 0) else "legacy_assumed_standard"
    dtype = "|u1" if mode == 0 else "<u2"
    plane_bytes = nx * ny * source_bytes
    data_offset = 1024 + extended_header
    if source_path.stat().st_size < data_offset + plane_bytes * nz:
        raise ValueError("mrc_payload_truncated")

    def read_plane(z_index: int) -> bytes:
        with source_path.open("rb") as source:
            source.seek(data_offset + z_index * plane_bytes)
            raw = source.read(plane_bytes)
        if len(raw) != plane_bytes:
            raise ValueError("mrc_payload_truncated")
        return offset_signed_mrc(raw, mode)[0]

    return (nz, ny, nx), dtype, transform, read_plane


def tiff_reader(source_path: Path) -> tuple[tuple[int, int, int], str, dict[str, Any], Callable[[int], bytes]]:
    endian, ifds = parse_classic_tiff_ifds(source_path)
    if not ifds:
        raise ValueError("no_tiff_ifds")
    first_tags = ifds[0]
    try:
        width = int(first_tags[256])
        height = int(first_tags[257])
        bits_value = first_tags.get(258, 8)
        bits = int(bits_value[0] if isinstance(bits_value, (tuple, list)) else bits_value)
    except (KeyError, TypeError, ValueError, IndexError) as exc:
        raise ValueError("invalid_tiff_dimensions_or_dtype") from exc
    if width <= 0 or height <= 0:
        raise ValueError("invalid_tiff_dimensions_or_dtype")
    if bits not in {8, 16}:
        raise ValueError(f"unsupported_tiff_bits:{bits}")
    expected_plane_bytes = width * height * (bits // 8)
    photometric = int(ifds[0].get(262, 1))
    if photometric not in {0, 1}:
        raise ValueError(f"unsupported_tiff_photometric:{photometric}")

    def tag_values(value: Any) -> list[int]:
        if isinstance(value, (tuple, list)):
            return [int(item) for item in value]
        return [int(value)]

    def validate_ifd(tags: dict[int, Any]) -> None:
        plane_bits = tag_values(tags.get(258, 8))[0]
        plane_photometric = int(tags.get(262, 1))
        orientation = int(tags.get(274, 1) or 1)
        offsets = tag_values(tags.get(273, 0))
        byte_counts = tag_values(tags.get(279, 0))
        rows_per_strip = int(tags.get(278, height) or height)
        if int(tags.get(256, 0)) != width or int(tags.get(257, 0)) != height or plane_bits != bits:
            raise ValueError("inconsistent_tiff_ifd_shape_or_dtype")
        if plane_photometric != photometric:
            raise ValueError("inconsistent_tiff_photometric")
        if orientation != 1:
            raise ValueError(f"unsupported_tiff_orientation:{orientation}")
        if not offsets or len(offsets) != len(byte_counts) or rows_per_strip * len(offsets) < height:
            raise ValueError("invalid_tiff_strip_layout")
        source_size = source_path.stat().st_size
        if sum(byte_counts) < expected_plane_bytes or any(
            offset < 0 or count <= 0 or offset + count > source_size
            for offset, count in zip(offsets, byte_counts, strict=True)
        ):
            raise ValueError("truncated_tiff_strip_payload")

    for tags in ifds:
        validate_ifd(tags)
    first_raw, plane_width, plane_height, plane_bits = tiff_slice_pixels(source_path, endian, first_tags)
    if (plane_width, plane_height, plane_bits) != (width, height, bits):
        raise ValueError("inconsistent_tiff_ifd_shape_or_dtype")

    def normalize(raw: bytes) -> bytes:
        if len(raw) != expected_plane_bytes:
            raise ValueError("tiff_plane_size_mismatch")
        normalized = byteswap_u16(raw) if bits == 16 and endian == ">" else raw
        if photometric == 0:
            if bits == 8:
                return bytes(value ^ 0xFF for value in normalized)
            values = array("H")
            values.frombytes(normalized)
            if sys.byteorder != "little":
                values.byteswap()
            inverted = array("H", (value ^ 0xFFFF for value in values))
            if sys.byteorder != "little":
                inverted.byteswap()
            return inverted.tobytes()
        return normalized

    first = normalize(first_raw)

    def read_plane(z_index: int) -> bytes:
        if z_index == 0:
            return first
        raw, plane_width, plane_height, plane_bits = tiff_slice_pixels(source_path, endian, ifds[z_index])
        if (plane_width, plane_height, plane_bits) != (width, height, bits):
            raise ValueError("inconsistent_tiff_ifd_shape_or_dtype")
        return normalize(raw)

    transform = {
        "kind": "unsigned_inversion" if photometric == 0 else "identity",
        "source_dtype": f"uint{bits}",
        "target_dtype": f"uint{bits}",
        "source_endianness": "big" if endian == ">" else "little",
        "photometric": photometric,
        "max_value": (2**bits) - 1 if photometric == 0 else None,
        "reversible": True,
    }
    return (len(ifds), height, width), "|u1" if bits == 8 else "<u2", transform, read_plane


def source_reader(source_format: str, source_path: Path):
    if source_format == "TIFF":
        return tiff_reader(source_path)
    if source_format == "MRC":
        return mrc_reader(source_path)
    raise ValueError(f"unsupported_source_format:{source_format}")


def write_chunks(
    store: Path,
    *,
    shape: tuple[int, int, int],
    chunks: tuple[int, int, int],
    dtype: str,
    read_plane: Callable[[int], bytes],
    checkpoint: dict[str, Any],
) -> dict[str, int]:
    array_dir = store / "0"
    bytes_per_voxel = 1 if dtype == "|u1" else 2
    written = 0
    reused = 0
    completed = set(str(item) for item in checkpoint.get("completed_chunks") or [])
    completed_sha256 = {
        str(name): str(digest)
        for name, digest in (checkpoint.get("completed_chunk_sha256") or {}).items()
        if isinstance(name, str) and re.fullmatch(r"[a-f0-9]{64}", str(digest))
    }
    expected_total = 0
    for z0 in range(0, shape[0], chunks[0]):
        z1 = min(shape[0], z0 + chunks[0])
        slab_specs: list[tuple[str, int, int, int, int, Path, Path, int]] = []
        for y0 in range(0, shape[1], chunks[1]):
            y1 = min(shape[1], y0 + chunks[1])
            for x0 in range(0, shape[2], chunks[2]):
                x1 = min(shape[2], x0 + chunks[2])
                name = f"{z0 // chunks[0]}.{y0 // chunks[1]}.{x0 // chunks[2]}"
                target = array_dir / name
                staging = target.with_name(f".{target.name}.tmp-{os.getpid()}")
                expected_size = (z1 - z0) * (y1 - y0) * (x1 - x0) * bytes_per_voxel
                expected_total += 1
                staging.unlink(missing_ok=True)
                if (
                    name in completed
                    and target.is_file()
                    and target.stat().st_size == expected_size
                    and completed_sha256.get(name) == sha256_file(target)
                ):
                    reused += 1
                    continue
                slab_specs.append((name, y0, y1, x0, x1, target, staging, expected_size))

        if not slab_specs:
            continue
        for z_index in range(z0, z1):
            plane = read_plane(z_index)
            expected_plane_size = shape[1] * shape[2] * bytes_per_voxel
            if len(plane) != expected_plane_size:
                raise ValueError("source_plane_size_mismatch")
            for _, y0, y1, x0, x1, _, staging, _ in slab_specs:
                plane_chunk = bytearray((y1 - y0) * (x1 - x0) * bytes_per_voxel)
                cursor = 0
                for y_index in range(y0, y1):
                    start = (y_index * shape[2] + x0) * bytes_per_voxel
                    end = (y_index * shape[2] + x1) * bytes_per_voxel
                    row = plane[start:end]
                    plane_chunk[cursor : cursor + len(row)] = row
                    cursor += len(row)
                with staging.open("ab") as output:
                    output.write(plane_chunk)

        for name, _, _, _, _, target, staging, expected_size in slab_specs:
            if staging.stat().st_size != expected_size:
                raise ValueError(f"output_chunk_size_mismatch:{name}")
            os.replace(staging, target)
            completed.add(name)
            completed_sha256[name] = sha256_file(target)
            checkpoint["completed_chunks"] = sorted(completed)
            checkpoint["completed_chunk_sha256"] = dict(sorted(completed_sha256.items()))
            checkpoint["updated_at"] = utc_now()
            write_json_atomic(store / ".conversion-checkpoint.json", checkpoint)
            written += 1
    return {"written": written, "reused": reused, "total": expected_total}


def validate_store(store: Path, shape: tuple[int, int, int], chunks: tuple[int, int, int], dtype: str) -> dict[str, Any]:
    bytes_per_voxel = 1 if dtype == "|u1" else 2
    checks: dict[str, bool] = {
        "root_zgroup": (store / ".zgroup").is_file(),
        "root_ome_metadata": (store / ".zattrs").is_file(),
        "array_metadata": (store / "0" / ".zarray").is_file(),
        "array_axes_metadata": (store / "0" / ".zattrs").is_file(),
    }
    expected_chunks = 0
    valid_chunks = 0
    for name, (z0, z1, y0, y1, x0, x1) in chunk_specs(shape, chunks):
        expected_chunks += 1
        path = store / "0" / name
        expected_size = (z1 - z0) * (y1 - y0) * (x1 - x0) * bytes_per_voxel
        if path.is_file() and path.stat().st_size == expected_size:
            valid_chunks += 1
    checks["all_chunks_present_and_sized"] = valid_chunks == expected_chunks
    return {
        "status": "passed" if all(checks.values()) else "failed",
        "checks": checks,
        "chunk_count_expected": expected_chunks,
        "chunk_count_actual": valid_chunks,
    }


def read_derivative_manifest(workset_dir: Path, workset: dict[str, Any]) -> dict[str, Any]:
    path = workset_dir / "workset-derivatives.json"
    if not path.exists():
        return {
            "schema": DERIVATIVE_MANIFEST_SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "factory_version": FACTORY_VERSION,
            "workset": {
                "workset_id": workset.get("workset_id") or "",
                "source_registry_id": (workset.get("source_registry") or {}).get("registry_id") or "",
                "archive_id": (workset.get("source_registry") or {}).get("archive_id") or "",
            },
            "updated_at": utc_now(),
            "derivatives": [],
        }
    manifest = read_json(path)
    if manifest.get("schema") != DERIVATIVE_MANIFEST_SCHEMA or manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported_workset_derivative_manifest")
    return manifest


def update_derivative_manifest(workset_dir: Path, workset: dict[str, Any], derivative: dict[str, Any]) -> Path:
    manifest = read_derivative_manifest(workset_dir, workset)
    existing = [
        item
        for item in manifest.get("derivatives") or []
        if not (isinstance(item, dict) and item.get("recipe_id") == derivative["recipe_id"])
    ]
    existing.append(derivative)
    manifest["factory_version"] = FACTORY_VERSION
    manifest["updated_at"] = utc_now()
    manifest["derivatives"] = sorted(existing, key=lambda item: (str(item.get("asset_id") or ""), str(item.get("recipe_id") or "")))
    path = workset_dir / "workset-derivatives.json"
    write_json_atomic(path, manifest)
    return path


def convert_workset_asset(
    workset_path: Path,
    *,
    asset_id: str | None = None,
    relative_path: str | None = None,
    chunk_shape: tuple[int, int, int] = DEFAULT_CHUNKS,
) -> dict[str, Any]:
    summary_path, workset, assets = load_workset(workset_path)
    asset = select_asset(assets, asset_id=asset_id, relative_path=relative_path)
    require_conversion_ready(asset)
    source_path = resolve_source(workset, asset)
    source_digest, verified_source_identity = verified_source_digest(source_path, asset)
    metadata = asset["metadata"]
    source_format = str(metadata["format"]).upper()
    shape, target_dtype, value_transform, read_plane = source_reader(source_format, source_path)
    declared_dtype = str(metadata.get("dtype") or "").lower()
    actual_source_dtype = str(value_transform.get("source_dtype") or "").lower()
    if declared_dtype != actual_source_dtype:
        raise ValueError(
            f"source_dtype_mismatch:declared={declared_dtype or 'unknown'}:"
            f"actual={actual_source_dtype or 'unknown'}"
        )

    declared = metadata["dimensions"]
    declared_shape = (int(declared["z"]), int(declared["y"]), int(declared["x"]))
    if shape != declared_shape:
        raise ValueError(f"source_shape_mismatch:declared={declared_shape}:actual={shape}")

    recipe = {
        "factory_version": FACTORY_VERSION,
        "target": "OME-Zarr-v2/OME-NGFF-0.4",
        "source": {
            "asset_id": asset["asset_id"],
            "relative_path": asset["relative_path"],
            "sha256": source_digest,
            "format": source_format,
            "dtype": metadata.get("dtype") or "",
            "shape_zyx": list(shape),
            "voxel_size_nm": metadata["voxel_size_nm"],
        },
        "output": {
            "dtype": target_dtype,
            "chunks_zyx": list(chunk_shape),
            "compressor": None,
            "value_transform": value_transform,
        },
    }
    recipe_sha256 = canonical_sha256(recipe)
    recipe_id = recipe_sha256[:20]
    derivatives_dir = summary_path.parent / "derivatives"
    target = derivatives_dir / f"{safe_name(str(asset['asset_id']))}--{recipe_id}.ome.zarr"
    staging = derivatives_dir / f".{target.name}.inprogress"
    provenance = {
        "schema": DERIVATIVE_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "factory_version": FACTORY_VERSION,
        "recipe_id": recipe_id,
        "recipe_sha256": recipe_sha256,
        "workset_id": workset.get("workset_id") or "",
        "asset_id": asset["asset_id"],
        "source_relative_path": asset["relative_path"],
        "source_sha256": source_digest,
        "recipe": recipe,
    }

    manifest = read_derivative_manifest(summary_path.parent, workset)
    existing = next(
        (
            item
            for item in manifest.get("derivatives") or []
            if isinstance(item, dict) and item.get("recipe_id") == recipe_id
        ),
        None,
    )
    other_recipe = next(
        (
            item
            for item in manifest.get("derivatives") or []
            if isinstance(item, dict)
            and item.get("asset_id") == asset["asset_id"]
            and item.get("recipe_id") != recipe_id
        ),
        None,
    )
    if other_recipe:
        raise ValueError(
            "asset_derivative_recipe_already_registered:"
            f"{other_recipe.get('recipe_id') or 'unknown'}"
        )
    if target.exists():
        stored = read_json(target / "caos-provenance.json")
        if stored.get("recipe_sha256") != recipe_sha256 or stored.get("source_sha256") != source_digest:
            raise ValueError("immutable_derivative_collision")
        validation = validate_store(target, shape, chunk_shape, target_dtype)
        if validation["status"] != "passed":
            raise ValueError("existing_derivative_validation_failed")
        if not existing:
            raise ValueError("existing_derivative_missing_manifest_record")
        recorded_checksum = existing.get("output_checksum")
        if not isinstance(recorded_checksum, dict) or sha256_tree(target) != recorded_checksum:
            raise ValueError("existing_derivative_checksum_mismatch")
        return {**existing, "reused": True, "manifest_path": str(summary_path.parent / "workset-derivatives.json")}

    derivatives_dir.mkdir(parents=True, exist_ok=True)
    if staging.exists():
        checkpoint_path = staging / ".conversion-checkpoint.json"
        checkpoint = read_json(checkpoint_path) if checkpoint_path.exists() else {}
        if checkpoint and checkpoint.get("recipe_sha256") != recipe_sha256:
            raise ValueError("staging_recipe_collision")
    else:
        staging.mkdir()
        checkpoint = {}
    checkpoint.update(
        {
            "schema": "cell-anatomy-workset-conversion-checkpoint",
            "schema_version": SCHEMA_VERSION,
            "recipe_id": recipe_id,
            "recipe_sha256": recipe_sha256,
            "source_sha256": source_digest,
            "target_path": str(target),
            "started_at": checkpoint.get("started_at") or utc_now(),
            "updated_at": utc_now(),
            "completed_chunks": checkpoint.get("completed_chunks") or [],
        }
    )
    write_json_atomic(staging / ".conversion-checkpoint.json", checkpoint)
    write_zarr_metadata(
        staging,
        name=Path(str(asset["relative_path"])).name,
        shape=shape,
        chunks=chunk_shape,
        dtype=target_dtype,
        voxel_size_nm=metadata["voxel_size_nm"],
        provenance={
            "method": FACTORY_VERSION,
            "recipe_id": recipe_id,
            "source_asset_id": asset["asset_id"],
            "source_sha256": source_digest,
            "value_transform": value_transform,
        },
    )
    chunk_result = write_chunks(
        staging,
        shape=shape,
        chunks=chunk_shape,
        dtype=target_dtype,
        read_plane=read_plane,
        checkpoint=checkpoint,
    )
    if source_identity(source_path) != verified_source_identity:
        raise ValueError("source_changed_during_conversion")
    validation = validate_store(staging, shape, chunk_shape, target_dtype)
    if validation["status"] != "passed":
        raise ValueError("derivative_validation_failed")
    (staging / ".conversion-checkpoint.json").unlink(missing_ok=True)
    write_json_atomic(staging / "caos-provenance.json", provenance)
    output_checksum = sha256_tree(staging)
    os.replace(staging, target)

    derivative = {
        "schema": DERIVATIVE_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "factory_version": FACTORY_VERSION,
        "recipe_id": recipe_id,
        "recipe_sha256": recipe_sha256,
        "workset_id": workset.get("workset_id") or "",
        "registry_id": asset.get("registry_id") or "",
        "archive_id": asset.get("archive_id") or "",
        "asset_id": asset["asset_id"],
        "archiveStatus": {
            "registryId": asset.get("registry_id") or (workset.get("source_registry") or {}).get("registry_id") or "",
            "assetId": asset["asset_id"],
            "archiveId": asset.get("archive_id") or (workset.get("source_registry") or {}).get("archive_id") or "",
            "relativePath": asset["relative_path"],
            "worksetId": workset.get("workset_id") or "",
        },
        "source_relative_path": asset["relative_path"],
        "source_local_path": str(source_path),
        "source_sha256": source_digest,
        "source_size_bytes": source_path.stat().st_size,
        "source_format": source_format,
        "output_path": str(target),
        "format": "OME-Zarr",
        "ome_ngff_version": "0.4",
        "zarr_format": 2,
        "array_path": "0",
        "shape_zyx": list(shape),
        "chunks_zyx": list(chunk_shape),
        "dtype": "uint8" if target_dtype == "|u1" else "uint16",
        "zarr_dtype": target_dtype,
        "physical_voxel_size_nm": metadata["voxel_size_nm"],
        "value_transform": value_transform,
        "output_checksum": output_checksum,
        "byte_size": output_checksum["size_bytes"],
        "converted_at": utc_now(),
        "validation": validation,
        "resume": chunk_result,
        "recipe": recipe,
    }
    manifest_path = update_derivative_manifest(summary_path.parent, workset, derivative)
    return {**derivative, "reused": False, "manifest_path": str(manifest_path)}


def queue_payload(workset_path: Path) -> dict[str, Any]:
    summary_path, workset, assets = load_workset(workset_path)
    manifest = read_derivative_manifest(summary_path.parent, workset)
    derivatives = {
        str(item.get("asset_id")): item
        for item in manifest.get("derivatives") or []
        if isinstance(item, dict) and item.get("asset_id")
    }
    archive_id = str((workset.get("source_registry") or {}).get("archive_id") or "archive")
    workset_id = str(workset["workset_id"])
    dataset_slug = f"private-workset:{archive_id}:{workset_id}"
    queue_assets = []
    counts = {"assets": 0, "indexed": 0, "ready_for_conversion": 0, "blocked": 0}
    for asset in assets:
        metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
        source_format = str(metadata.get("format") or "").upper()
        derivative = derivatives.get(str(asset.get("asset_id")))
        try:
            require_conversion_ready(asset)
            declared_dtype = str(metadata.get("dtype") or "").lower()
            supported = (
                source_format == "TIFF" and declared_dtype in {"uint8", "uint16"}
            ) or (
                source_format == "MRC" and declared_dtype in {"int8", "int16", "uint16"}
            )
        except ValueError:
            supported = False
        status = "indexed" if derivative else "ready_for_conversion" if supported else "needs_review"
        counts["assets"] += 1
        counts[status if status in counts else "blocked"] += 1
        command = None
        if status == "ready_for_conversion":
            command = (
                "python3 workers/ingestion/private_workset_derivative.py convert "
                f"--workset {json.dumps(str(summary_path))} --asset-id {json.dumps(str(asset['asset_id']))}"
            )
        queue_assets.append(
            {
                "relative_path": asset.get("relative_path") or "",
                "asset_id": asset.get("asset_id") or "",
                "format": source_format,
                "size_bytes": asset.get("size_bytes") or 0,
                "validated_state": "validated" if asset.get("readiness", {}).get("metadata_ready") else "needs_review",
                "streamable_state": "indexed" if derivative else "",
                "slice_cache_state": "",
                "index_status": status,
                "dimensions": metadata.get("dimensions") or {},
                "physical_voxel_size_nm": metadata.get("voxel_size_nm"),
                "warnings": [],
                "blockers": asset.get("readiness", {}).get("blockers") or [],
                "review_notes": asset.get("review", {}).get("recommended_actions") or [],
                "derivative": derivative,
                "convert_command": command,
                "slice_command": None,
                "queue_source": "private-workset",
                "workset_path": str(summary_path),
            }
        )
    return {
        "root": str((workset.get("source_registry") or {}).get("archive_root") or ""),
        "root_exists": True,
        "summary": counts,
        "datasets": [
            {
                "slug": dataset_slug,
                "archive_id": archive_id,
                "workset_id": workset_id,
                "dataset": {
                    "source": "Private Workset",
                    "entry_id": workset.get("workset_id") or "",
                    "title": workset.get("title") or workset.get("workset_id") or archive_id,
                    "experiment_type": "Promoted archive workset",
                },
                "readiness": {
                    "total_assets": counts["assets"],
                    "ready_assets": counts["ready_for_conversion"],
                    "blocked_assets": counts["blocked"],
                    "status": "ready" if counts["ready_for_conversion"] or counts["indexed"] else "blocked",
                },
                "derivative_count": counts["indexed"],
                "workset_path": str(summary_path),
                "queue_source": "private-workset",
                "assets": queue_assets,
            }
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert authorized private CAOS workset assets into immutable OME-Zarr derivatives.")
    commands = parser.add_subparsers(dest="command", required=True)
    convert = commands.add_parser("convert", help="Convert one promoted, conversion-ready workset asset.")
    convert.add_argument("--workset", type=Path, required=True, help="Path to workset.json or its directory.")
    selection = convert.add_mutually_exclusive_group(required=True)
    selection.add_argument("--asset-id")
    selection.add_argument("--relative-path")
    convert.add_argument("--chunk-shape", default=",".join(str(value) for value in DEFAULT_CHUNKS))
    queue = commands.add_parser("queue", help="Emit a sidecar-compatible conversion queue for one workset.")
    queue.add_argument("--workset", type=Path, required=True, help="Path to workset.json or its directory.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "convert":
            result = convert_workset_asset(
                args.workset,
                asset_id=args.asset_id,
                relative_path=args.relative_path,
                chunk_shape=parse_chunk_shape(args.chunk_shape),
            )
        else:
            result = queue_payload(args.workset)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
