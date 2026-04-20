from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import html
import json
import math
import os
import re
import shutil
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


DEFAULT_ROOT = Path(os.environ.get("SCION_PUBLIC_DATA_ROOT", "~/Downloads/scion-public-data")).expanduser()
EMPIAR_API_URL = "https://www.ebi.ac.uk/empiar/api/entry/{entry_id}"
EMPIAR_DATA_URL = "https://ftp.ebi.ac.uk/empiar/world_availability/{entry_id}/data/"
FIGSHARE_ARTICLE_URL = "https://api.figshare.com/v2/articles/{article_id}"
DOWNLOAD_CHUNK_BYTES = 1024 * 1024 * 8
MRC_HEADER_BYTES = 1024
PIPELINE_VERSION = "public-data-pilot-v0.2"
TRAKEM2_PARSE_BYTES = 32 * 1024 * 1024
DEFAULT_ZARR_CHUNK_SHAPE = (32, 256, 256)
SLICE_CACHE_FORMATS = {"MRC", "TIFF"}


class DirectoryLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        href = dict(attrs).get("href")
        if href:
            self.links.append(html.unescape(href))


@dataclass(frozen=True)
class RemoteFile:
    relative_path: str
    url: str
    expected_size: int | None = None
    expected_md5: str = ""
    source_file_id: str = ""


@dataclass
class PreviewRecord:
    filename: str
    kind: str
    preview: str
    width: int | str
    height: int | str
    slices: int | str
    mode: int | str
    middle_z: int | str
    warning: str = ""


def request_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def request_text(url: str) -> str:
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_links(index_html: str) -> list[str]:
    parser = DirectoryLinkParser()
    parser.feed(index_html)
    links: list[str] = []
    for link in parser.links:
        if link.startswith("?"):
            continue
        if link in {"../", "/"}:
            continue
        if "Parent Directory" in link:
            continue
        if link.rstrip("/").endswith("/data"):
            continue
        links.append(link)
    return links


def url_join(base_url: str, href: str) -> str:
    return urllib.parse.urljoin(base_url, href)


def discover_remote_files(base_url: str) -> tuple[list[RemoteFile], dict[str, str]]:
    visited: set[str] = set()
    files: list[RemoteFile] = []
    indexes: dict[str, str] = {}

    def walk(url: str, relative_prefix: str = "") -> None:
        if url in visited:
            return
        visited.add(url)
        text = request_text(url)
        indexes[relative_prefix or "."] = text
        for link in parse_links(text):
            if link.startswith("/"):
                absolute = urllib.parse.urljoin("https://ftp.ebi.ac.uk", link)
                if not absolute.startswith(base_url):
                    continue
            else:
                absolute = url_join(url, link)
            name = urllib.parse.unquote(link.rstrip("/").split("/")[-1])
            if not name:
                continue
            if link.endswith("/"):
                walk(absolute if absolute.endswith("/") else f"{absolute}/", f"{relative_prefix}{name}/")
            else:
                files.append(RemoteFile(relative_path=f"{relative_prefix}{name}", url=absolute))

    walk(base_url)
    return sorted(files, key=lambda item: item.relative_path), indexes


def fetch_empiar_metadata(
    entry_id: str,
    metadata_dir: Path,
    refresh: bool,
    offline: bool,
) -> tuple[dict[str, Any], list[RemoteFile]]:
    metadata_dir.mkdir(parents=True, exist_ok=True)
    api_path = metadata_dir / f"empiar-{entry_id}-api.json"
    index_path = metadata_dir / f"empiar-{entry_id}-data-index.html"

    if offline:
        if not api_path.exists():
            raise FileNotFoundError(f"Cached EMPIAR API metadata not found: {api_path}")
        api_data = json.loads(api_path.read_text())
        return api_data, read_download_manifest(metadata_dir)

    if refresh or not api_path.exists():
        api_data = request_json(EMPIAR_API_URL.format(entry_id=entry_id))
        api_path.write_text(json.dumps(api_data, indent=2, sort_keys=True))
    else:
        api_data = json.loads(api_path.read_text())

    base_url = EMPIAR_DATA_URL.format(entry_id=entry_id)
    remote_files, indexes = discover_remote_files(base_url)
    index_path.write_text(indexes.get(".", ""))
    for relative, text in indexes.items():
        if relative == ".":
            continue
        safe_name = relative.strip("/").replace("/", "__")
        (metadata_dir / f"empiar-{entry_id}-data-index__{safe_name}.html").write_text(text)

    return api_data, remote_files


def fetch_figshare_metadata(
    article_id: str,
    metadata_dir: Path,
    refresh: bool,
    offline: bool,
) -> tuple[dict[str, Any], list[RemoteFile]]:
    metadata_dir.mkdir(parents=True, exist_ok=True)
    article_path = metadata_dir / f"figshare-{article_id}-article.json"
    if offline:
        if not article_path.exists():
            raise FileNotFoundError(f"Cached Figshare article metadata not found: {article_path}")
        article_data = json.loads(article_path.read_text())
        return article_data, read_download_manifest(metadata_dir)

    if refresh or not article_path.exists():
        article_data = request_json(FIGSHARE_ARTICLE_URL.format(article_id=article_id))
        article_path.write_text(json.dumps(article_data, indent=2, sort_keys=True))
    else:
        article_data = json.loads(article_path.read_text())

    remote_files = figshare_remote_files(article_data)
    return article_data, remote_files


def figshare_remote_files(article_data: dict[str, Any]) -> list[RemoteFile]:
    remote_files: list[RemoteFile] = []
    for file_info in article_data.get("files", []):
        name = str(file_info.get("name") or "")
        url = str(file_info.get("download_url") or "")
        if not name or not url:
            continue
        remote_files.append(
            RemoteFile(
                relative_path=name,
                url=url,
                expected_size=int(file_info["size"]) if file_info.get("size") is not None else None,
                expected_md5=str(file_info.get("computed_md5") or file_info.get("supplied_md5") or ""),
                source_file_id=str(file_info.get("id") or ""),
            )
        )
    return sorted(remote_files, key=lambda item: item.relative_path)


def write_download_manifest(remote_files: list[RemoteFile], metadata_dir: Path) -> Path:
    path = metadata_dir / "download-manifest.tsv"
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(
            output,
            fieldnames=["relative_path", "url", "expected_size", "expected_md5", "source_file_id"],
            delimiter="\t",
        )
        writer.writeheader()
        for remote in remote_files:
            writer.writerow(
                {
                    "relative_path": remote.relative_path,
                    "url": remote.url,
                    "expected_size": remote.expected_size or "",
                    "expected_md5": remote.expected_md5,
                    "source_file_id": remote.source_file_id,
                }
            )
    return path


def read_download_manifest(metadata_dir: Path) -> list[RemoteFile]:
    path = metadata_dir / "download-manifest.tsv"
    if not path.exists():
        raise FileNotFoundError(f"Cached download manifest not found: {path}")
    with path.open() as source:
        rows = list(csv.DictReader(source, delimiter="\t"))
    remote_files: list[RemoteFile] = []
    for row in rows:
        relative_path = row.get("relative_path") or row.get("filename")
        url = row.get("url")
        expected_size_raw = row.get("expected_size") or ""
        try:
            expected_size = int(expected_size_raw) if expected_size_raw else None
        except ValueError:
            expected_size = None
        if relative_path and url:
            remote_files.append(
                RemoteFile(
                    relative_path=relative_path,
                    url=url,
                    expected_size=expected_size,
                    expected_md5=row.get("expected_md5") or "",
                    source_file_id=row.get("source_file_id") or "",
                )
            )
    return remote_files


def remote_content_length(url: str) -> int | None:
    request = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.headers.get("Content-Length")
            return int(raw) if raw else None
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None


def download_file(url: str, destination: Path, expected_size: int | None = None) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    remote_size = expected_size or remote_content_length(url)
    local_size = destination.stat().st_size if destination.exists() else 0
    if remote_size is not None and local_size == remote_size:
        return "skipped"

    headers: dict[str, str] = {}
    mode = "wb"
    if local_size > 0:
        headers["Range"] = f"bytes={local_size}-"
        mode = "ab"

    request = urllib.request.Request(url, headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=120)
    except urllib.error.HTTPError as exc:
        if exc.code == 416 and remote_size is not None and local_size == remote_size:
            return "skipped"
        raise

    status = getattr(response, "status", None)
    if local_size > 0 and status != 206:
        mode = "wb"

    start = time.monotonic()
    written = local_size if mode == "ab" else 0
    with response, destination.open(mode + "") as output:
        while True:
            chunk = response.read(DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            output.write(chunk)
            written += len(chunk)
            if remote_size and time.monotonic() - start > 10:
                pct = written / remote_size * 100
                print(f"  {destination.name}: {pct:5.1f}% ({written / (1024**3):.2f} GiB)", flush=True)
                start = time.monotonic()
    final_size = destination.stat().st_size
    if remote_size is not None and final_size != remote_size:
        raise IOError(f"download_size_mismatch: expected {remote_size} bytes, got {final_size} bytes for {destination}")
    return "downloaded"


def download_files(remote_files: list[RemoteFile], data_dir: Path, max_files: int | None) -> list[str]:
    statuses: list[str] = []
    selected = remote_files[:max_files] if max_files else remote_files
    for index, remote in enumerate(selected, start=1):
        destination = data_dir / remote.relative_path
        print(f"[{index}/{len(selected)}] {remote.relative_path}", flush=True)
        status = download_file(remote.url, destination, expected_size=remote.expected_size)
        statuses.append(f"{remote.relative_path}: {status}")
    return statuses


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(DOWNLOAD_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def md5_file(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(DOWNLOAD_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def format_name(path: Path) -> str:
    suffixes = "".join(path.suffixes).lower()
    if path.suffix.lower() == ".mrc":
        return "MRC"
    if ".tif" in suffixes or ".tiff" in suffixes:
        return "TIFF"
    if suffixes.endswith(".h5") or suffixes.endswith(".hdf5"):
        return "HDF5"
    if suffixes.endswith(".gz"):
        return "GZIP"
    return path.suffix.lower().lstrip(".").upper() or "UNKNOWN"


def is_volume_format(format_value: Any) -> bool:
    return str(format_value) in {"MRC", "TIFF"}


def mrc_header(path: Path) -> dict[str, str | int]:
    if path.suffix.lower() != ".mrc":
        return {}
    with path.open("rb") as source:
        header = source.read(MRC_HEADER_BYTES)
    if len(header) < MRC_HEADER_BYTES:
        return {"mrc_error": "header_too_short"}

    nx, ny, nz, mode = struct.unpack("<4i", header[:16])
    mx, my, mz = struct.unpack("<3i", header[28:40])
    cella_x, cella_y, cella_z = struct.unpack("<3f", header[40:52])
    map_id = header[208:212].decode("latin-1", errors="replace")
    result: dict[str, str | int] = {
        "mrc_nx": nx,
        "mrc_ny": ny,
        "mrc_nz": nz,
        "mrc_mode": mode,
        "mrc_mx": mx,
        "mrc_my": my,
        "mrc_mz": mz,
        "mrc_cella_x_a": f"{cella_x:.6g}",
        "mrc_cella_y_a": f"{cella_y:.6g}",
        "mrc_cella_z_a": f"{cella_z:.6g}",
        "mrc_map": map_id,
    }
    if mx and my and mz:
        result.update(
            {
                "mrc_voxel_x_nm": f"{(cella_x / mx) / 10:.6g}",
                "mrc_voxel_y_nm": f"{(cella_y / my) / 10:.6g}",
                "mrc_voxel_z_nm": f"{(cella_z / mz) / 10:.6g}",
            }
        )
    return result


def read_tiff_scalar(endian: str, value_type: int, count: int, data: bytes) -> int | tuple[int, ...] | str | bytes:
    if value_type == 2:
        return data.rstrip(b"\x00").decode("latin-1", errors="replace")
    if value_type == 3:
        values = struct.unpack(endian + f"{count}H", data)
    elif value_type == 4:
        values = struct.unpack(endian + f"{count}I", data)
    elif value_type == 5:
        raw = struct.unpack(endian + f"{count * 2}I", data)
        rationals = tuple((raw[index], raw[index + 1]) for index in range(0, len(raw), 2))
        return rationals[0] if count == 1 else rationals
    elif value_type == 1:
        values = tuple(data)
    else:
        return data
    return values[0] if count == 1 else values


def parse_classic_tiff_ifds(path: Path, max_ifds: int = 100000) -> tuple[str, list[dict[int, Any]]]:
    with path.open("rb") as source:
        first = source.read(8)
        if first[:2] == b"II":
            endian = "<"
        elif first[:2] == b"MM":
            endian = ">"
        else:
            raise ValueError("not_tiff")
        magic = struct.unpack(endian + "H", first[2:4])[0]
        if magic == 43:
            raise ValueError("bigtiff_not_supported")
        if magic != 42:
            raise ValueError("not_classic_tiff")
        next_ifd = struct.unpack(endian + "I", first[4:8])[0]
        type_sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8}
        ifds: list[dict[int, Any]] = []
        while next_ifd and len(ifds) < max_ifds:
            source.seek(next_ifd)
            count_raw = source.read(2)
            if len(count_raw) < 2:
                break
            entry_count = struct.unpack(endian + "H", count_raw)[0]
            tags: dict[int, Any] = {}
            for _ in range(entry_count):
                entry = source.read(12)
                tag, value_type, value_count = struct.unpack(endian + "HHI", entry[:8])
                value_size = type_sizes.get(value_type, 1) * value_count
                raw_value = entry[8:12]
                if value_size <= 4:
                    value_data = raw_value[:value_size]
                else:
                    offset = struct.unpack(endian + "I", raw_value)[0]
                    position = source.tell()
                    source.seek(offset)
                    value_data = source.read(value_size)
                    source.seek(position)
                tags[tag] = read_tiff_scalar(endian, value_type, value_count, value_data)
            next_raw = source.read(4)
            if len(next_raw) < 4:
                break
            next_ifd = struct.unpack(endian + "I", next_raw)[0]
            ifds.append(tags)
    return endian, ifds


def tiff_header(path: Path) -> dict[str, Any]:
    suffixes = "".join(path.suffixes).lower()
    if ".tif" not in suffixes and ".tiff" not in suffixes:
        return {}
    try:
        endian, ifds = parse_classic_tiff_ifds(path)
    except ValueError as exc:
        return {"tiff_error": str(exc)}
    if not ifds:
        return {"tiff_error": "no_ifds"}
    first = ifds[0]
    description = first.get(270, "")
    x_resolution = first.get(282, "")
    y_resolution = first.get(283, "")
    resolution_unit = first.get(296, "")
    imagej = parse_imagej_description(description if isinstance(description, str) else "")
    tiff_scale = tiff_scale_nm(x_resolution, y_resolution, resolution_unit, imagej)
    return {
        "tiff_endian": "little" if endian == "<" else "big",
        "tiff_width": first.get(256, ""),
        "tiff_height": first.get(257, ""),
        "tiff_slices": len(ifds),
        "tiff_bits_per_sample": first.get(258, ""),
        "tiff_compression": first.get(259, ""),
        "tiff_photometric": first.get(262, ""),
        "tiff_x_resolution": rational_to_string(x_resolution),
        "tiff_y_resolution": rational_to_string(y_resolution),
        "tiff_resolution_unit": resolution_unit,
        "tiff_imagej_unit": imagej.get("unit", ""),
        "tiff_imagej_spacing": imagej.get("spacing", ""),
        "tiff_pixel_x_nm": f"{tiff_scale[0]:.6g}" if tiff_scale else "",
        "tiff_pixel_y_nm": f"{tiff_scale[1]:.6g}" if tiff_scale else "",
        "tiff_pixel_z_nm": f"{tiff_scale[2]:.6g}" if tiff_scale and tiff_scale[2] else "",
        "tiff_description": description[:300] if isinstance(description, str) else "",
    }


def parse_imagej_description(description: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in description.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip().lower()] = value.strip()
    return result


def rational_to_float(value: Any) -> float | None:
    if isinstance(value, tuple) and len(value) == 2:
        numerator, denominator = value
        if denominator:
            return float(numerator) / float(denominator)
    if isinstance(value, int | float):
        return float(value)
    return None


def rational_to_string(value: Any) -> str:
    if isinstance(value, tuple) and len(value) == 2:
        return f"{value[0]}/{value[1]}"
    return str(value) if value != "" else ""


def unit_to_nm(unit: str, resolution_unit: Any) -> float | None:
    normalized = unit.strip().lower().replace("µ", "u").replace("μ", "u").replace("�", "u").replace("\xb5", "u")
    if normalized in {"nm", "nanometer", "nanometers"}:
        return 1.0
    if normalized in {"um", "micron", "microns", "micrometer", "micrometers"}:
        return 1000.0
    if normalized in {"angstrom", "angstroms", "a"}:
        return 0.1
    if resolution_unit == 2:
        return 25_400_000.0
    if resolution_unit == 3:
        return 10_000_000.0
    return None


def tiff_scale_nm(
    x_resolution: Any,
    y_resolution: Any,
    resolution_unit: Any,
    imagej: dict[str, str],
) -> tuple[float, float, float | None] | None:
    x_pixels_per_unit = rational_to_float(x_resolution)
    y_pixels_per_unit = rational_to_float(y_resolution)
    nm_per_unit = unit_to_nm(imagej.get("unit", ""), resolution_unit)
    if not x_pixels_per_unit or not y_pixels_per_unit or not nm_per_unit:
        return None
    pixel_x_nm = nm_per_unit / x_pixels_per_unit
    pixel_y_nm = nm_per_unit / y_pixels_per_unit
    pixel_z_nm: float | None = None
    spacing = imagej.get("spacing")
    if spacing:
        try:
            pixel_z_nm = float(spacing) * nm_per_unit
        except ValueError:
            pixel_z_nm = None
    return pixel_x_nm, pixel_y_nm, pixel_z_nm


def find_imageset(api_entry: dict[str, Any], relative_path: str, path: Path) -> dict[str, Any]:
    imagesets = api_entry.get("imagesets", [])
    relative_no_suffix = re.sub(r"(\.mrc|\.mrc\.tif|\.tif|\.tiff)$", "", relative_path, flags=re.IGNORECASE)
    for item in imagesets:
        name = str(item.get("name") or "")
        directory = str(item.get("directory") or "").strip("/")
        if name and (Path(relative_path).stem == name or relative_no_suffix.endswith(name)):
            return item
        if directory and relative_path.startswith(directory.rstrip("/") + "/"):
            return item
    if len(imagesets) == 1:
        return imagesets[0]
    return {}


def inventory_files(root_dir: Path, api_data: dict[str, Any], entry_id: str, hash_files: bool) -> list[dict[str, Any]]:
    entry = api_data.get(f"EMPIAR-{entry_id}", {})
    rows: list[dict[str, Any]] = []
    data_dir = root_dir / "data"
    for path in sorted(item for item in data_dir.rglob("*") if item.is_file()):
        relative = path.relative_to(data_dir).as_posix()
        imageset = find_imageset(entry, relative, path)
        row: dict[str, Any] = {
            "relative_path": relative,
            "filename": path.name,
            "size_bytes": path.stat().st_size,
            "size_gib": f"{path.stat().st_size / (1024**3):.3f}",
            "sha256": sha256_file(path) if hash_files else "",
            "format": format_name(path),
            "api_name": imageset.get("name", ""),
            "api_directory": imageset.get("directory", ""),
            "api_num_images": imageset.get("num_images_or_tilt_series", ""),
            "api_voxel_type": imageset.get("voxel_type", ""),
            "api_pixel_width": imageset.get("pixel_width", ""),
            "api_pixel_height": imageset.get("pixel_height", ""),
            "api_details": str(imageset.get("details", "")).replace("\t", " ").replace("\n", " "),
        }
        row.update(mrc_header(path))
        row.update(tiff_header(path))
        rows.append(row)
    return rows


def inventory_figshare_files(root_dir: Path, article_data: dict[str, Any], hash_files: bool) -> list[dict[str, Any]]:
    data_dir = root_dir / "data"
    figshare_by_name = {str(item.get("name") or ""): item for item in article_data.get("files", [])}
    trakem2_by_key = trakem2_calibrations(data_dir)
    rows: list[dict[str, Any]] = []
    for path in sorted(item for item in data_dir.rglob("*") if item.is_file()):
        relative = path.relative_to(data_dir).as_posix()
        file_info = figshare_by_name.get(relative, {})
        local_md5 = md5_file(path) if hash_files and file_info.get("computed_md5") else ""
        trakem2 = trakem2_by_key.get(pairing_key(relative), {})
        row: dict[str, Any] = {
            "relative_path": relative,
            "filename": path.name,
            "size_bytes": path.stat().st_size,
            "size_gib": f"{path.stat().st_size / (1024**3):.3f}",
            "sha256": sha256_file(path) if hash_files else "",
            "format": format_name(path),
            "figshare_file_id": file_info.get("id", ""),
            "figshare_expected_size": file_info.get("size", ""),
            "figshare_computed_md5": file_info.get("computed_md5", ""),
            "figshare_supplied_md5": file_info.get("supplied_md5", ""),
            "figshare_local_md5": local_md5,
            "figshare_mimetype": file_info.get("mimetype", ""),
            "trakem2_pair_key": pairing_key(relative),
            "trakem2_pixel_x_nm": trakem2.get("pixel_x_nm", ""),
            "trakem2_pixel_y_nm": trakem2.get("pixel_y_nm", ""),
            "trakem2_pixel_z_nm": trakem2.get("pixel_z_nm", ""),
            "trakem2_raw_pixel_z_nm": trakem2.get("raw_pixel_z_nm", ""),
            "trakem2_layer_thickness": trakem2.get("layer_thickness", ""),
            "trakem2_z_source": trakem2.get("z_source", ""),
            "trakem2_unit": trakem2.get("unit", ""),
            "trakem2_source_file": trakem2.get("source_file", ""),
            "api_name": article_data.get("title", ""),
            "api_directory": "",
            "api_num_images": "",
            "api_voxel_type": "",
            "api_pixel_width": "",
            "api_pixel_height": "",
            "api_details": str(article_data.get("description") or "").replace("\t", " ").replace("\n", " "),
        }
        row.update(mrc_header(path))
        row.update(tiff_header(path))
        rows.append(row)
    return rows


def pairing_key(relative_path: str) -> str:
    name = Path(relative_path).name
    for suffix in [".xml.gz", ".mrc.tif", ".tiff", ".tif", ".mrc"]:
        if name.lower().endswith(suffix):
            name = name[: -len(suffix)]
            break
    name = re.sub(r"_TrakEm2$", "", name, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", name).strip().lower()


def trakem2_calibrations(data_dir: Path) -> dict[str, dict[str, str]]:
    calibrations: dict[str, dict[str, str]] = {}
    for path in sorted(data_dir.rglob("*.xml.gz")):
        parsed = parse_trakem2_calibration(path)
        if parsed:
            calibrations[pairing_key(path.name)] = parsed
    return calibrations


def parse_trakem2_calibration(path: Path) -> dict[str, str]:
    try:
        with gzip.open(path, "rt", encoding="latin-1", errors="replace") as source:
            text = source.read(TRAKEM2_PARSE_BYTES)
    except OSError:
        return {}
    match = re.search(r"<t2_calibration\b(?P<attrs>[^>]*)/>", text, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return {}
    attrs = dict(re.findall(r"(\w+)=\"([^\"]*)\"", match.group("attrs")))
    unit = attrs.get("unit", "")
    nm_per_unit = unit_to_nm(unit, None)
    if not nm_per_unit:
        return {}
    try:
        x_nm = float(attrs["pixelWidth"]) * nm_per_unit
        y_nm = float(attrs["pixelHeight"]) * nm_per_unit
        raw_z_nm = float(attrs["pixelDepth"]) * nm_per_unit
    except (KeyError, ValueError):
        return {}
    layer_thickness = first_trakem2_layer_thickness(text)
    z_nm = raw_z_nm
    z_source = "trakem2_calibration"
    if (
        layer_thickness
        and layer_thickness > 1
        and math.isclose(raw_z_nm, x_nm, rel_tol=0.05)
        and math.isclose(raw_z_nm, y_nm, rel_tol=0.05)
    ):
        z_nm = raw_z_nm * layer_thickness
        z_source = "trakem2_calibration_times_layer_thickness"
    return {
        "pixel_x_nm": f"{x_nm:.6g}",
        "pixel_y_nm": f"{y_nm:.6g}",
        "pixel_z_nm": f"{z_nm:.6g}",
        "raw_pixel_z_nm": f"{raw_z_nm:.6g}",
        "layer_thickness": f"{layer_thickness:.6g}" if layer_thickness else "",
        "z_source": z_source,
        "unit": unit,
        "source_file": path.name,
    }


def first_trakem2_layer_thickness(xml_text: str) -> float | None:
    match = re.search(r"<t2_layer\s+oid=\"[^\"]+\"(?P<attrs>[^>]*)>", xml_text, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    attrs = dict(re.findall(r"(\w+)=\"([^\"]*)\"", match.group("attrs")))
    try:
        return float(attrs["thickness"])
    except (KeyError, ValueError):
        return None


def write_inventory(rows: list[dict[str, Any]], metadata_dir: Path) -> Path:
    path = metadata_dir / "local-file-inventory.tsv"
    field_order = [
        "relative_path",
        "filename",
        "size_bytes",
        "size_gib",
        "sha256",
        "format",
        "mrc_nx",
        "mrc_ny",
        "mrc_nz",
        "mrc_mode",
        "mrc_mx",
        "mrc_my",
        "mrc_mz",
        "mrc_cella_x_a",
        "mrc_cella_y_a",
        "mrc_cella_z_a",
        "mrc_voxel_x_nm",
        "mrc_voxel_y_nm",
        "mrc_voxel_z_nm",
        "mrc_map",
        "tiff_width",
        "tiff_height",
        "tiff_slices",
        "tiff_bits_per_sample",
        "tiff_compression",
        "tiff_photometric",
        "tiff_endian",
        "tiff_x_resolution",
        "tiff_y_resolution",
        "tiff_resolution_unit",
        "tiff_imagej_unit",
        "tiff_imagej_spacing",
        "tiff_pixel_x_nm",
        "tiff_pixel_y_nm",
        "tiff_pixel_z_nm",
        "tiff_description",
        "tiff_error",
        "api_name",
        "api_directory",
        "api_num_images",
        "api_voxel_type",
        "api_pixel_width",
        "api_pixel_height",
        "api_details",
        "figshare_file_id",
        "figshare_expected_size",
        "figshare_computed_md5",
        "figshare_supplied_md5",
        "figshare_local_md5",
        "figshare_mimetype",
        "trakem2_pair_key",
        "trakem2_pixel_x_nm",
        "trakem2_pixel_y_nm",
        "trakem2_pixel_z_nm",
        "trakem2_raw_pixel_z_nm",
        "trakem2_layer_thickness",
        "trakem2_z_source",
        "trakem2_unit",
        "trakem2_source_file",
    ]
    fields = field_order + sorted({key for row in rows for key in row if key not in field_order})
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields, delimiter="\t")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return path


def percentile(sorted_values: list[float], pct: float) -> float:
    if not sorted_values:
        return 0.0
    index = (len(sorted_values) - 1) * pct / 100.0
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return sorted_values[int(index)]
    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (index - lower)


def normalize_to_u8(values: list[float]) -> bytes:
    finite = [value for value in values if math.isfinite(value)]
    if not finite:
        return bytes(len(values))
    finite.sort()
    lo = percentile(finite, 1)
    hi = percentile(finite, 99)
    if hi <= lo:
        lo, hi = min(finite), max(finite)
    if hi <= lo:
        return bytes(len(values))
    output = bytearray()
    scale = 255.0 / (hi - lo)
    for value in values:
        if not math.isfinite(value):
            output.append(0)
        else:
            output.append(max(0, min(255, int((value - lo) * scale))))
    return bytes(output)


def downsample_u8(image: bytes, width: int, height: int, max_width: int = 280, max_height: int = 220) -> tuple[bytes, int, int]:
    scale = min(max_width / width, max_height / height, 1.0)
    next_width = max(1, int(width * scale))
    next_height = max(1, int(height * scale))
    if next_width == width and next_height == height:
        return image, width, height
    output = bytearray(next_width * next_height)
    for y in range(next_height):
        source_y = min(height - 1, int(y * height / next_height))
        source_row = source_y * width
        target_row = y * next_width
        for x in range(next_width):
            source_x = min(width - 1, int(x * width / next_width))
            output[target_row + x] = image[source_row + source_x]
    return bytes(output), next_width, next_height


def write_png_gray(path: Path, image: bytes, width: int, height: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw.extend(image[y * width : (y + 1) * width])

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), level=6))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def mrc_volume_info(path: Path) -> tuple[int, int, int, int, int]:
    with path.open("rb") as source:
        header = source.read(MRC_HEADER_BYTES)
    if len(header) < MRC_HEADER_BYTES:
        raise ValueError("mrc_header_too_short")
    nx, ny, nz, mode = struct.unpack("<4i", header[:16])
    bytes_per_pixel = {0: 1, 1: 2, 2: 4, 6: 2}.get(mode)
    if not bytes_per_pixel:
        raise ValueError(f"unsupported_mrc_mode_{mode}")
    if nx <= 0 or ny <= 0 or nz <= 0:
        raise ValueError("invalid_mrc_dimensions")
    return nx, ny, nz, mode, bytes_per_pixel


def mrc_dtype_label(mode: int) -> str:
    labels = {0: "int8", 1: "int16", 2: "float32", 6: "uint16"}
    return labels.get(mode, f"mode_{mode}")


def mrc_raw_to_u8(raw: bytes, mode: int) -> bytes:
    if mode == 0:
        values = [float(struct.unpack("b", raw[index : index + 1])[0]) for index in range(0, len(raw), 1)]
    elif mode == 1:
        values = [float(item[0]) for item in struct.iter_unpack("<h", raw)]
    elif mode == 2:
        values = [float(item[0]) for item in struct.iter_unpack("<f", raw)]
    elif mode == 6:
        values = [float(item[0]) for item in struct.iter_unpack("<H", raw)]
    else:
        raise ValueError(f"unsupported_mrc_mode_{mode}")
    return normalize_to_u8(values)


def mrc_slice_u8(path: Path, z_index: int) -> tuple[bytes, int, int, int, int]:
    nx, ny, nz, mode, bytes_per_pixel = mrc_volume_info(path)
    if z_index < 0 or z_index >= nz:
        raise ValueError(f"mrc_z_index_out_of_bounds:{z_index}")
    plane_bytes = nx * ny * bytes_per_pixel
    with path.open("rb") as source:
        source.seek(MRC_HEADER_BYTES + z_index * plane_bytes)
        raw = source.read(plane_bytes)
    if len(raw) != plane_bytes:
        raise ValueError("mrc_slice_short_read")
    return mrc_raw_to_u8(raw, mode), nx, ny, nz, mode


def mrc_middle_slice(path: Path) -> tuple[bytes, int, int, int, int, int]:
    _, _, nz, _, _ = mrc_volume_info(path)
    middle_z = nz // 2
    image, nx, ny, depth, mode = mrc_slice_u8(path, middle_z)
    return image, nx, ny, depth, mode, middle_z


def tuple_or_int(value: Any) -> list[int]:
    if isinstance(value, tuple):
        return [int(item) for item in value]
    if isinstance(value, list):
        return [int(item) for item in value]
    return [int(value)]


def tiff_slice_pixels(path: Path, endian: str, tags: dict[int, Any]) -> tuple[bytes, int, int, int]:
    width = int(tags[256])
    height = int(tags[257])
    bits = tuple_or_int(tags.get(258, 8))[0]
    compression = int(tags.get(259, 1) or 1)
    if compression != 1:
        raise ValueError(f"unsupported_tiff_compression_{compression}")
    offsets = tuple_or_int(tags[273])
    byte_counts = tuple_or_int(tags[279])
    rows_per_strip = int(tags.get(278, height) or height)
    samples_per_pixel = int(tags.get(277, 1) or 1)
    if samples_per_pixel != 1:
        raise ValueError(f"unsupported_tiff_samples_{samples_per_pixel}")

    strips: list[bytes] = []
    with path.open("rb") as source:
        for offset, byte_count in zip(offsets, byte_counts, strict=False):
            source.seek(offset)
            strips.append(source.read(byte_count))
    raw = b"".join(strips)
    expected_rows = min(height, rows_per_strip * len(strips))
    bytes_per_pixel = 1 if bits == 8 else 2 if bits == 16 else 0
    if not bytes_per_pixel:
        raise ValueError(f"unsupported_tiff_bits_{bits}")
    image = raw[: width * expected_rows * bytes_per_pixel]
    if expected_rows < height:
        image += bytes(width * (height - expected_rows) * bytes_per_pixel)
    return image[: width * height * bytes_per_pixel], width, height, bits


def tiff_middle_slice(path: Path) -> tuple[bytes, int, int, int, str, int]:
    endian, ifds = parse_classic_tiff_ifds(path)
    if not ifds:
        raise ValueError("no_tiff_ifds")
    middle_z = len(ifds) // 2
    tags = ifds[middle_z]
    raw, width, height, bits = tiff_slice_pixels(path, endian, tags)
    if bits == 8:
        image = raw
    elif bits == 16:
        unpack = ">" if endian == ">" else "<"
        values = [float(item[0]) for item in struct.iter_unpack(unpack + "H", raw)]
        image = normalize_to_u8(values)
    else:
        raise ValueError(f"unsupported_tiff_bits_{bits}")
    return image[: width * height], width, height, len(ifds), f"uint{bits}", middle_z


def generate_previews(root_dir: Path, inventory_rows: list[dict[str, Any]]) -> list[PreviewRecord]:
    preview_dir = root_dir / "derived" / "middle-slices"
    records: list[PreviewRecord] = []
    data_dir = root_dir / "data"
    for row in inventory_rows:
        relative_path = str(row["relative_path"])
        path = data_dir / relative_path
        safe = relative_path.replace("/", "__").replace(".", "_")
        output = preview_dir / f"{safe}_middle-z.png"
        kind = str(row["format"])
        try:
            if kind == "MRC":
                image, width, height, slices, mode, middle_z = mrc_middle_slice(path)
            elif kind == "TIFF":
                image, width, height, slices, mode, middle_z = tiff_middle_slice(path)
            else:
                records.append(
                    PreviewRecord(
                        filename=relative_path,
                        kind=kind,
                        preview="",
                        width="",
                        height="",
                        slices="",
                        mode="",
                        middle_z="",
                        warning="preview_unsupported_format",
                    )
                )
                continue
            downsampled, preview_width, preview_height = downsample_u8(image, width, height)
            write_png_gray(output, downsampled, preview_width, preview_height)
            records.append(
                PreviewRecord(
                    filename=relative_path,
                    kind=kind,
                    preview=str(output),
                    width=width,
                    height=height,
                    slices=slices,
                    mode=mode,
                    middle_z=middle_z,
                )
            )
        except Exception as exc:
            records.append(
                PreviewRecord(
                    filename=relative_path,
                    kind=kind,
                    preview="",
                    width=row.get("mrc_nx") or row.get("tiff_width") or "",
                    height=row.get("mrc_ny") or row.get("tiff_height") or "",
                    slices=row.get("mrc_nz") or row.get("tiff_slices") or "",
                    mode=row.get("mrc_mode") or row.get("tiff_bits_per_sample") or "",
                    middle_z="",
                    warning=f"{exc.__class__.__name__}: {exc}",
                )
            )
    return records


def write_preview_outputs(root_dir: Path, records: list[PreviewRecord]) -> tuple[Path, Path]:
    metadata_dir = root_dir / "metadata"
    derived_dir = root_dir / "derived"
    index_path = metadata_dir / "preview-inventory.tsv"
    with index_path.open("w", newline="") as output:
        writer = csv.DictWriter(
            output,
            fieldnames=["filename", "kind", "preview", "width", "height", "slices", "mode", "middle_z", "warning"],
            delimiter="\t",
        )
        writer.writeheader()
        for record in records:
            writer.writerow(record.__dict__)

    html_path = derived_dir / "preview-index.html"
    cards: list[str] = []
    for record in records:
        title = html.escape(record.filename)
        if record.preview:
            image_path = Path(record.preview).relative_to(derived_dir).as_posix()
            image = f'<img src="{html.escape(image_path)}" alt="{title} middle slice" loading="lazy" />'
        else:
            image = f'<div class="missing">No preview<br />{html.escape(record.warning)}</div>'
        cards.append(
            f"""
      <article class="card">
        {image}
        <h2>{title}</h2>
        <p>{html.escape(str(record.kind))} · {html.escape(str(record.width))} x {html.escape(str(record.height))} x {html.escape(str(record.slices))} · middle z {html.escape(str(record.middle_z))}</p>
      </article>"""
        )
    html_path.write_text(
        f"""<!doctype html>
<meta charset="utf-8" />
<title>Scion Public Data Pilot Preview</title>
<style>
  body {{ margin: 32px; background: #f3f0e8; color: #171717; font-family: Georgia, serif; }}
  h1 {{ font-family: Futura, Avenir Next, sans-serif; letter-spacing: .04em; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; }}
  .card {{ border: 1px solid #cfcac0; background: #faf8f1; padding: 14px; }}
  img {{ width: 100%; image-rendering: auto; background: #000; display: block; }}
  h2 {{ font-size: 15px; margin: 12px 0 4px; overflow-wrap: anywhere; }}
  p {{ margin: 0; color: #555; }}
  .missing {{ min-height: 180px; display: grid; place-items: center; background: #ded9ce; color: #555; text-align: center; padding: 12px; }}
</style>
<h1>Scion Public Data Pilot Preview</h1>
<p>Dependency-light middle-slice previews generated from local volume data.</p>
<div class="grid">{''.join(cards)}
</div>
"""
    )
    return index_path, html_path


def physical_scale_from_text(text: str) -> tuple[float, float, float] | None:
    normalized = text.replace("×", "x").replace("nm3", "nm").replace("nm^3", "nm")
    match = re.search(
        r"(?P<x>\d+(?:\.\d+)?)\s*(?:nm)?\s*x\s*(?P<y>\d+(?:\.\d+)?)\s*(?:nm)?\s*x\s*(?P<z>\d+(?:\.\d+)?)\s*nm",
        normalized,
        re.IGNORECASE,
    )
    if not match:
        return None
    return tuple(float(match.group(name)) for name in ("x", "y", "z"))  # type: ignore[return-value]


def build_normalized_manifest(
    api_data: dict[str, Any],
    entry_id: str,
    inventory_rows: list[dict[str, Any]],
    download_manifest: Path,
) -> dict[str, Any]:
    entry = api_data.get(f"EMPIAR-{entry_id}", {})
    citation = (entry.get("citation") or [{}])[0]
    citation_details = str(citation.get("details") or "")
    entry_scale = physical_scale_from_text(citation_details)
    assets: list[dict[str, Any]] = []
    for row in inventory_rows:
        asset_details = str(row.get("api_details") or "")
        asset_scale = physical_scale_from_text(asset_details)
        tiff_scale = tiff_physical_scale(row)
        scale = asset_scale or entry_scale or tiff_scale
        assets.append(
            {
                "relative_path": row["relative_path"],
                "format": row["format"],
                "size_bytes": row["size_bytes"],
                "sha256": row.get("sha256", ""),
                "dimensions": {
                    "x": row.get("mrc_nx") or row.get("tiff_width") or "",
                    "y": row.get("mrc_ny") or row.get("tiff_height") or "",
                    "z": row.get("mrc_nz") or row.get("tiff_slices") or "",
                },
                "physical_voxel_size_nm": {
                    "x": scale[0] if scale else "",
                    "y": scale[1] if scale else "",
                    "z": scale[2] if scale else "",
                    "source": (
                        "asset_api_details"
                        if asset_scale
                        else "citation_details"
                        if entry_scale
                        else "tiff_imagej_metadata"
                        if tiff_scale
                        else ""
                    ),
                },
                "header_voxel_size_nm": {
                    "x": row.get("mrc_voxel_x_nm", ""),
                    "y": row.get("mrc_voxel_y_nm", ""),
                    "z": row.get("mrc_voxel_z_nm", ""),
                    "source": "mrc_header" if row.get("mrc_voxel_x_nm") else "",
                },
                "api_name": row.get("api_name", ""),
                "api_details": row.get("api_details", ""),
            }
        )
    return {
        "source": "EMPIAR",
        "entry_id": entry_id,
        "entry_doi": entry.get("entry_doi", ""),
        "title": entry.get("title", ""),
        "dataset_size": entry.get("dataset_size", ""),
        "experiment_type": entry.get("experiment_type", ""),
        "release_date": entry.get("release_date", ""),
        "citation": {
            "title": citation.get("title", ""),
            "journal": citation.get("journal", ""),
            "year": citation.get("year", ""),
            "doi": citation.get("doi", ""),
            "pubmedid": citation.get("pubmedid", ""),
            "details": citation_details,
        },
        "download_manifest": str(download_manifest),
        "asset_count": len(assets),
        "assets": assets,
    }


def build_normalized_figshare_manifest(
    article_data: dict[str, Any],
    article_id: str,
    inventory_rows: list[dict[str, Any]],
    download_manifest: Path,
) -> dict[str, Any]:
    assets: list[dict[str, Any]] = []
    for row in inventory_rows:
        tiff_scale = tiff_physical_scale(row)
        trakem2_scale = trakem2_physical_scale(row)
        scale = tiff_scale or trakem2_scale
        scale_source = ""
        if tiff_scale:
            scale_source = "tiff_imagej_metadata"
        elif trakem2_scale:
            scale_source = str(row.get("trakem2_z_source") or "trakem2_calibration")
        assets.append(
            {
                "relative_path": row["relative_path"],
                "format": row["format"],
                "size_bytes": row["size_bytes"],
                "sha256": row.get("sha256", ""),
                "dimensions": {
                    "x": row.get("mrc_nx") or row.get("tiff_width") or "",
                    "y": row.get("mrc_ny") or row.get("tiff_height") or "",
                    "z": row.get("mrc_nz") or row.get("tiff_slices") or "",
                },
                "physical_voxel_size_nm": {
                    "x": scale[0] if scale else "",
                    "y": scale[1] if scale else "",
                    "z": scale[2] if scale else "",
                    "source": scale_source,
                },
                "header_voxel_size_nm": {
                    "x": row.get("mrc_voxel_x_nm", ""),
                    "y": row.get("mrc_voxel_y_nm", ""),
                    "z": row.get("mrc_voxel_z_nm", ""),
                    "source": "mrc_header" if row.get("mrc_voxel_x_nm") else "",
                },
                "api_name": article_data.get("title", ""),
                "api_details": str(article_data.get("description") or ""),
            }
        )
    total_bytes = sum(int(row["size_bytes"]) for row in inventory_rows)
    return {
        "source": "Figshare",
        "entry_id": article_id,
        "entry_doi": article_data.get("doi", ""),
        "title": article_data.get("title", ""),
        "dataset_size": f"{total_bytes} bytes",
        "experiment_type": "",
        "release_date": article_data.get("published_date", ""),
        "citation": {
            "title": article_data.get("title", ""),
            "journal": "",
            "year": str(article_data.get("published_date", ""))[:4],
            "doi": article_data.get("doi", ""),
            "pubmedid": "",
            "details": str(article_data.get("description") or ""),
        },
        "download_manifest": str(download_manifest),
        "asset_count": len(assets),
        "assets": assets,
    }


def tiff_physical_scale(row: dict[str, Any]) -> tuple[float, float, float] | None:
    try:
        x = float(row["tiff_pixel_x_nm"])
        y = float(row["tiff_pixel_y_nm"])
        z = float(row["tiff_pixel_z_nm"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
        return None
    return x, y, z


def trakem2_physical_scale(row: dict[str, Any]) -> tuple[float, float, float] | None:
    try:
        x = float(row["trakem2_pixel_x_nm"])
        y = float(row["trakem2_pixel_y_nm"])
        z = float(row["trakem2_pixel_z_nm"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
        return None
    return x, y, z


def write_normalized_manifest(root_dir: Path, manifest: dict[str, Any]) -> Path:
    path = root_dir / "metadata" / "normalized-manifest.json"
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return path


def build_asset_state_manifest(
    root_dir: Path,
    normalized_manifest: dict[str, Any],
    inventory_rows: list[dict[str, Any]],
    remote_files: list[RemoteFile],
    preview_records: list[PreviewRecord],
) -> dict[str, Any]:
    remote_by_path = {remote.relative_path: remote for remote in remote_files}
    preview_by_path = {record.filename: record for record in preview_records}
    inventory_by_path = {str(row["relative_path"]): row for row in inventory_rows}
    assets: list[dict[str, Any]] = []
    for normalized_asset in normalized_manifest["assets"]:
        relative_path = str(normalized_asset["relative_path"])
        row = inventory_by_path.get(relative_path, {})
        remote = remote_by_path.get(relative_path)
        preview = preview_by_path.get(relative_path)
        warnings = asset_warnings(row, preview)
        blockers, review_notes = classify_asset_warnings(warnings, normalized_asset)
        dimensions = normalized_asset["dimensions"]
        physical_scale = normalized_asset["physical_voxel_size_nm"]
        is_volume = is_volume_format(normalized_asset["format"])
        has_dimensions = all(dimensions.get(axis) not in {"", None} for axis in ("x", "y", "z"))
        has_physical_scale = all(physical_scale.get(axis) not in {"", None} for axis in ("x", "y", "z"))
        has_preview = bool(preview and preview.preview)
        if is_volume:
            validated_state = "validated" if has_dimensions and has_physical_scale and has_preview and not blockers else "needs_review"
        else:
            validated_state = "not_applicable"
        assets.append(
            {
                "source_asset": {
                    "state": "indexed",
                    "source": normalized_manifest["source"],
                    "url": remote.url if remote else "",
                    "repository_path": relative_path,
                },
                "mirrored_asset": {
                    "state": "mirrored",
                    "local_path": str(root_dir / "data" / relative_path),
                    "size_bytes": normalized_asset["size_bytes"],
                    "sha256": normalized_asset["sha256"],
                    "format": normalized_asset["format"],
                },
                "validated_volume": {
                    "state": validated_state,
                    "dimensions": dimensions,
                    "physical_voxel_size_nm": physical_scale,
                    "header_voxel_size_nm": normalized_asset["header_voxel_size_nm"],
                    "preview_path": preview.preview if preview else "",
                    "warnings": warnings,
                    "blockers": blockers,
                    "review_notes": review_notes,
                },
                "streamable_derivative": {
                    "state": "not_started",
                    "format": "",
                    "path": "",
                    "note": "OME-Zarr or equivalent conversion has not been attempted in the pilot stage.",
                },
            }
        )
    return {
        "pipeline_version": PIPELINE_VERSION,
        "dataset": {
            "source": normalized_manifest["source"],
            "entry_id": normalized_manifest["entry_id"],
            "entry_doi": normalized_manifest["entry_doi"],
            "title": normalized_manifest["title"],
            "dataset_size": normalized_manifest["dataset_size"],
            "experiment_type": normalized_manifest["experiment_type"],
        },
        "asset_count": len(assets),
        "assets": assets,
    }


def asset_warnings(row: dict[str, Any], preview: PreviewRecord | None) -> list[str]:
    warnings: list[str] = []
    if row.get("format") == "MRC" and row.get("mrc_nx") and row.get("mrc_mx") and row.get("mrc_nx") == row.get("mrc_mx"):
        if row.get("mrc_cella_x_a") == str(row.get("mrc_nx")):
            warnings.append("mrc_header_physical_scale_likely_default")
    if row.get("tiff_error"):
        warnings.append(f"tiff_parse_warning:{row['tiff_error']}")
    z_warning = trakem2_z_spacing_warning(row)
    if z_warning:
        warnings.append(z_warning)
    if is_volume_format(row.get("format")) and preview and preview.warning:
        warnings.append(f"preview_warning:{preview.warning}")
    return warnings


def classify_asset_warnings(warnings: list[str], normalized_asset: dict[str, Any]) -> tuple[list[str], list[str]]:
    blockers: list[str] = []
    review_notes: list[str] = []
    physical_source = str((normalized_asset.get("physical_voxel_size_nm") or {}).get("source") or "")
    for warning in warnings:
        if warning == "mrc_header_physical_scale_likely_default" and physical_source in {"asset_api_details", "citation_details"}:
            review_notes.append(warning)
        else:
            blockers.append(warning)
    return sorted(set(blockers)), sorted(set(review_notes))


def trakem2_z_spacing_warning(row: dict[str, Any]) -> str:
    if not (is_volume_format(row.get("format")) and row.get("trakem2_pixel_z_nm")):
        return ""
    try:
        z_nm = float(row["trakem2_pixel_z_nm"])
    except (TypeError, ValueError):
        return ""
    if z_nm and (z_nm < 30 or z_nm > 250):
        return f"trakem2_z_spacing_suspicious:{z_nm:g}nm"
    return ""


def write_asset_state_manifest(root_dir: Path, manifest: dict[str, Any]) -> Path:
    path = root_dir / "metadata" / "asset-state-manifest.json"
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return path


def conversion_blockers(asset: dict[str, Any]) -> list[str]:
    volume = asset["validated_volume"]
    if volume["state"] == "not_applicable":
        return []
    if "blockers" in volume:
        blockers = list(volume.get("blockers") or [])
    else:
        normalized_asset = {"physical_voxel_size_nm": volume.get("physical_voxel_size_nm") or {}}
        blockers, _ = classify_asset_warnings(list(volume.get("warnings") or []), normalized_asset)
    dimensions = volume.get("dimensions") or {}
    physical_scale = volume.get("physical_voxel_size_nm") or {}
    if not all(dimensions.get(axis) not in {"", None} for axis in ("x", "y", "z")):
        blockers.append("missing_volume_dimensions")
    if not all(physical_scale.get(axis) not in {"", None} for axis in ("x", "y", "z")):
        blockers.append("missing_physical_voxel_size")
    if not volume.get("preview_path"):
        blockers.append("missing_preview")
    return sorted(set(str(item) for item in blockers if item))


def conversion_review_notes(asset: dict[str, Any]) -> list[str]:
    volume = asset["validated_volume"]
    if volume["state"] == "not_applicable":
        return []
    if "review_notes" in volume:
        return sorted(set(str(item) for item in (volume.get("review_notes") or []) if item))
    normalized_asset = {"physical_voxel_size_nm": volume.get("physical_voxel_size_nm") or {}}
    _, review_notes = classify_asset_warnings(list(volume.get("warnings") or []), normalized_asset)
    return review_notes


def review_action(blocker: str) -> str:
    if blocker.startswith("mrc_header_physical_scale_likely_default"):
        return "Verify voxel size from curated repository or paper metadata; do not trust the raw MRC header alone."
    if blocker.startswith("trakem2_z_spacing_suspicious"):
        return "Inspect the paired TrakEM2 XML and paper methods for section thickness before conversion."
    if blocker == "missing_physical_voxel_size":
        return "Find an authoritative voxel-size source or add a curated override before conversion."
    if blocker == "missing_volume_dimensions":
        return "Inspect parser support for this volume format before conversion."
    if blocker == "missing_preview":
        return "Regenerate or debug preview extraction before conversion."
    if blocker.startswith("preview_warning:"):
        return "Inspect the preview extraction warning and confirm the volume can be read."
    return "Human review required before conversion."


def build_conversion_readiness_manifest(root_dir: Path, asset_state_manifest: dict[str, Any]) -> dict[str, Any]:
    ready_assets: list[dict[str, Any]] = []
    blocked_assets: list[dict[str, Any]] = []
    sidecar_assets: list[dict[str, Any]] = []

    for asset in asset_state_manifest["assets"]:
        mirrored = asset["mirrored_asset"]
        volume = asset["validated_volume"]
        relative_path = Path(mirrored["local_path"]).relative_to(root_dir / "data").as_posix()
        base_record = {
            "relative_path": relative_path,
            "local_path": mirrored["local_path"],
            "format": mirrored["format"],
            "size_bytes": mirrored["size_bytes"],
            "sha256": mirrored["sha256"],
        }
        blockers = conversion_blockers(asset)
        review_notes = conversion_review_notes(asset)
        if volume["state"] == "not_applicable":
            sidecar_assets.append({**base_record, "readiness": "not_a_volume"})
        elif not blockers:
            ready_assets.append(
                {
                    **base_record,
                    "dimensions": volume["dimensions"],
                    "physical_voxel_size_nm": volume["physical_voxel_size_nm"],
                    "preview_path": volume["preview_path"],
                    "review_notes": review_notes,
                    "conversion_target": "OME-Zarr",
                    "readiness": "ready_with_review_notes" if review_notes else "ready_for_conversion_trial",
                }
            )
        else:
            blocked_assets.append(
                {
                    **base_record,
                    "dimensions": volume["dimensions"],
                    "physical_voxel_size_nm": volume["physical_voxel_size_nm"],
                    "preview_path": volume["preview_path"],
                    "blockers": blockers,
                    "recommended_actions": sorted({review_action(blocker) for blocker in blockers}),
                    "readiness": "blocked",
                }
            )

    ready_bytes = sum(int(asset["size_bytes"]) for asset in ready_assets)
    blocked_bytes = sum(int(asset["size_bytes"]) for asset in blocked_assets)
    return {
        "pipeline_version": PIPELINE_VERSION,
        "dataset": asset_state_manifest["dataset"],
        "summary": {
            "total_assets": len(asset_state_manifest["assets"]),
            "ready_assets": len(ready_assets),
            "ready_gib": round(ready_bytes / (1024**3), 3),
            "blocked_assets": len(blocked_assets),
            "blocked_gib": round(blocked_bytes / (1024**3), 3),
            "sidecar_assets": len(sidecar_assets),
            "target_format": "OME-Zarr",
            "status": "ready_for_conversion_trial" if ready_assets else "blocked",
        },
        "ready_assets": ready_assets,
        "blocked_assets": blocked_assets,
        "sidecar_assets": sidecar_assets,
    }


def write_conversion_readiness_outputs(root_dir: Path, manifest: dict[str, Any]) -> tuple[Path, Path]:
    metadata_dir = root_dir / "metadata"
    manifest_path = metadata_dir / "conversion-readiness-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True))

    queue_path = metadata_dir / "curation-review-queue.tsv"
    with queue_path.open("w", newline="") as output:
        writer = csv.DictWriter(
            output,
            fieldnames=[
                "relative_path",
                "format",
                "size_gib",
                "blockers",
                "recommended_actions",
                "preview_path",
            ],
            delimiter="\t",
        )
        writer.writeheader()
        for asset in manifest["blocked_assets"]:
            writer.writerow(
                {
                    "relative_path": asset["relative_path"],
                    "format": asset["format"],
                    "size_gib": f"{int(asset['size_bytes']) / (1024**3):.3f}",
                    "blockers": "; ".join(asset["blockers"]),
                    "recommended_actions": " | ".join(asset["recommended_actions"]),
                    "preview_path": asset["preview_path"],
                }
            )
    return manifest_path, queue_path


def safe_derivative_name(relative_path: str) -> str:
    name = relative_path.replace("/", "__")
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", name)
    name = re.sub(r"(\.ome\.tiff?|\.tiff?|\.mrc)$", "", name, flags=re.IGNORECASE)
    return name.strip("._") or "asset"


def tiff_raw_to_u8(raw: bytes, bits: int, endian: str) -> bytes:
    if bits == 8:
        return raw
    if bits == 16:
        unpack = ">" if endian == ">" else "<"
        values = [float(item[0]) for item in struct.iter_unpack(unpack + "H", raw)]
        return normalize_to_u8(values)
    raise ValueError(f"unsupported_tiff_bits_{bits}")


def tiff_slice_u8(path: Path, endian: str, tags: dict[int, Any]) -> tuple[bytes, int, int, int]:
    raw, width, height, bits = tiff_slice_pixels(path, endian, tags)
    return tiff_raw_to_u8(raw, bits, endian), width, height, bits


def sample_slice_indices(depth: int, max_slices: int, all_slices: bool = False) -> list[int]:
    if depth <= 0:
        return []
    if all_slices or depth <= max_slices:
        return list(range(depth))
    if max_slices <= 1:
        return [depth // 2]
    step = (depth - 1) / (max_slices - 1)
    indices = [round(index * step) for index in range(max_slices)]
    deduped = sorted(set(max(0, min(depth - 1, index)) for index in indices))
    cursor = 0
    while len(deduped) < max_slices and cursor < depth:
        if cursor not in deduped:
            deduped.append(cursor)
        cursor += 1
    return sorted(deduped)


def write_tiff_slice_cache(
    root_dir: Path,
    source_path: Path,
    asset: dict[str, Any],
    max_slices: int,
    all_slices: bool,
    max_width: int,
    max_height: int,
) -> dict[str, Any]:
    if max_slices <= 0:
        raise ValueError("max_slices_must_be_positive")
    if max_width <= 0 or max_height <= 0:
        raise ValueError("max_dimensions_must_be_positive")

    endian, ifds = parse_classic_tiff_ifds(source_path)
    if not ifds:
        raise ValueError("no_tiff_ifds")

    selected_indices = sample_slice_indices(len(ifds), max_slices, all_slices)
    output_dir = root_dir / "derived" / "slice-cache" / safe_derivative_name(asset["relative_path"])
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)

    frames: list[dict[str, Any]] = []
    source_width = 0
    source_height = 0
    source_bits = 0
    frame_width = 0
    frame_height = 0
    for sequence_index, z_index in enumerate(selected_indices):
        image, width, height, bits = tiff_slice_u8(source_path, endian, ifds[z_index])
        source_width = width
        source_height = height
        source_bits = bits
        downsampled, preview_width, preview_height = downsample_u8(
            image,
            width,
            height,
            max_width=max_width,
            max_height=max_height,
        )
        frame_width = preview_width
        frame_height = preview_height
        output = output_dir / f"slice-z{z_index:06d}.png"
        write_png_gray(output, downsampled, preview_width, preview_height)
        frames.append(
            {
                "sequence_index": sequence_index,
                "z_index": z_index,
                "relative_path": output.relative_to(root_dir).as_posix(),
                "width": preview_width,
                "height": preview_height,
            }
        )

    if source_bits == 8:
        contrast = {
            "mode": "source_uint8",
            "note": "8-bit source planes are written directly without intensity renormalization.",
        }
    else:
        contrast = {
            "mode": "per_slice_auto",
            "note": "Each generated plane is normalized independently for visual inspection.",
        }

    return {
        "source_relative_path": asset["relative_path"],
        "source_local_path": str(source_path),
        "source_sha256": asset.get("sha256", ""),
        "source_size_bytes": asset.get("size_bytes", ""),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generation_tool": "scion_public_data_pilot.write_tiff_slice_cache",
        "format": "PNG Slice Cache",
        "source_format": "TIFF",
        "source_dtype": f"uint{source_bits}" if source_bits else "",
        "source_shape_zyx": [len(ifds), source_height, source_width],
        "frame_shape_yx": [frame_height, frame_width],
        "physical_voxel_size_nm": asset.get("physical_voxel_size_nm", {}),
        "sampling": {
            "mode": "all" if all_slices or len(selected_indices) == len(ifds) else "sampled",
            "source_slices": len(ifds),
            "cached_slices": len(frames),
            "max_slices": max_slices,
            "selected_z_indices": selected_indices,
        },
        "contrast": contrast,
        "frames": frames,
        "byte_size": directory_size(output_dir),
    }


def write_mrc_slice_cache(
    root_dir: Path,
    source_path: Path,
    asset: dict[str, Any],
    max_slices: int,
    all_slices: bool,
    max_width: int,
    max_height: int,
) -> dict[str, Any]:
    if max_slices <= 0:
        raise ValueError("max_slices_must_be_positive")
    if max_width <= 0 or max_height <= 0:
        raise ValueError("max_dimensions_must_be_positive")

    source_width, source_height, source_depth, mode, _ = mrc_volume_info(source_path)
    selected_indices = sample_slice_indices(source_depth, max_slices, all_slices)
    output_dir = root_dir / "derived" / "slice-cache" / safe_derivative_name(asset["relative_path"])
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)

    frames: list[dict[str, Any]] = []
    frame_width = 0
    frame_height = 0
    for sequence_index, z_index in enumerate(selected_indices):
        image, width, height, _, current_mode = mrc_slice_u8(source_path, z_index)
        mode = current_mode
        downsampled, preview_width, preview_height = downsample_u8(
            image,
            width,
            height,
            max_width=max_width,
            max_height=max_height,
        )
        frame_width = preview_width
        frame_height = preview_height
        output = output_dir / f"slice-z{z_index:06d}.png"
        write_png_gray(output, downsampled, preview_width, preview_height)
        frames.append(
            {
                "sequence_index": sequence_index,
                "z_index": z_index,
                "relative_path": output.relative_to(root_dir).as_posix(),
                "width": preview_width,
                "height": preview_height,
            }
        )

    return {
        "source_relative_path": asset["relative_path"],
        "source_local_path": str(source_path),
        "source_sha256": asset.get("sha256", ""),
        "source_size_bytes": asset.get("size_bytes", ""),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generation_tool": "scion_public_data_pilot.write_mrc_slice_cache",
        "format": "PNG Slice Cache",
        "source_format": "MRC",
        "source_dtype": mrc_dtype_label(mode),
        "source_shape_zyx": [source_depth, source_height, source_width],
        "frame_shape_yx": [frame_height, frame_width],
        "physical_voxel_size_nm": asset.get("physical_voxel_size_nm", {}),
        "sampling": {
            "mode": "all" if all_slices or len(selected_indices) == source_depth else "sampled",
            "source_slices": source_depth,
            "cached_slices": len(frames),
            "max_slices": max_slices,
            "selected_z_indices": selected_indices,
        },
        "contrast": {
            "mode": "per_slice_auto",
            "note": "Each generated plane is normalized independently for visual inspection.",
        },
        "frames": frames,
        "byte_size": directory_size(output_dir),
    }


def write_slice_cache(
    root_dir: Path,
    source_path: Path,
    asset: dict[str, Any],
    max_slices: int,
    all_slices: bool,
    max_width: int,
    max_height: int,
) -> dict[str, Any]:
    source_format = str(asset.get("format") or "")
    if source_format == "TIFF":
        return write_tiff_slice_cache(root_dir, source_path, asset, max_slices, all_slices, max_width, max_height)
    if source_format == "MRC":
        return write_mrc_slice_cache(root_dir, source_path, asset, max_slices, all_slices, max_width, max_height)
    raise ValueError(f"unsupported_slice_cache_format:{source_format}")


def parse_chunk_shape(raw: str | None) -> tuple[int, int, int]:
    if not raw:
        return DEFAULT_ZARR_CHUNK_SHAPE
    parts = [part.strip() for part in raw.split(",")]
    if len(parts) != 3:
        raise ValueError("chunk_shape_must_be_z_y_x")
    values = tuple(int(part) for part in parts)
    if any(value <= 0 for value in values):
        raise ValueError("chunk_shape_values_must_be_positive")
    return values  # type: ignore[return-value]


def zarr_dtype_for_tiff_bits(bits: int) -> tuple[str, str]:
    if bits == 8:
        return "|u1", "uint8"
    if bits == 16:
        return "<u2", "uint16"
    raise ValueError(f"unsupported_tiff_bits_{bits}")


def write_zarr_array_metadata(array_dir: Path, shape: tuple[int, int, int], chunks: tuple[int, int, int], dtype: str) -> None:
    array_dir.mkdir(parents=True, exist_ok=True)
    (array_dir / ".zarray").write_text(
        json.dumps(
            {
                "zarr_format": 2,
                "shape": list(shape),
                "chunks": list(chunks),
                "dtype": dtype,
                "compressor": None,
                "fill_value": 0,
                "order": "C",
                "filters": None,
            },
            indent=2,
            sort_keys=True,
        )
    )
    (array_dir / ".zattrs").write_text(json.dumps({"_ARRAY_DIMENSIONS": ["z", "y", "x"]}, indent=2, sort_keys=True))


def write_ome_zarr_root_metadata(
    store_dir: Path,
    name: str,
    shape: tuple[int, int, int],
    chunks: tuple[int, int, int],
    physical_scale_nm: dict[str, Any],
) -> None:
    z_nm = float(physical_scale_nm["z"])
    y_nm = float(physical_scale_nm["y"])
    x_nm = float(physical_scale_nm["x"])
    (store_dir / ".zgroup").write_text(json.dumps({"zarr_format": 2}, indent=2, sort_keys=True))
    (store_dir / ".zattrs").write_text(
        json.dumps(
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
                                    {"type": "scale", "scale": [z_nm, y_nm, x_nm]},
                                ],
                            }
                        ],
                        "metadata": {
                            "method": "scion_public_data_pilot",
                            "source_physical_scale": physical_scale_nm.get("source", ""),
                            "shape_zyx": list(shape),
                            "chunks_zyx": list(chunks),
                        },
                    }
                ]
            },
            indent=2,
            sort_keys=True,
        )
    )


def zarr_chunk_count(shape: tuple[int, int, int], chunks: tuple[int, int, int]) -> int:
    return math.prod(math.ceil(axis / chunk) for axis, chunk in zip(shape, chunks, strict=True))


def iter_zarr_chunk_names(shape: tuple[int, int, int], chunks: tuple[int, int, int]) -> list[str]:
    names: list[str] = []
    for z_index in range(math.ceil(shape[0] / chunks[0])):
        for y_index in range(math.ceil(shape[1] / chunks[1])):
            for x_index in range(math.ceil(shape[2] / chunks[2])):
                names.append(f"{z_index}.{y_index}.{x_index}")
    return names


def write_tiff_as_ome_zarr(
    source_path: Path,
    output_dir: Path,
    physical_scale_nm: dict[str, Any],
    chunks: tuple[int, int, int],
) -> dict[str, Any]:
    try:
        import numpy as np
    except ImportError as exc:
        raise RuntimeError("numpy_required_for_conversion") from exc

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)

    endian, ifds = parse_classic_tiff_ifds(source_path)
    if not ifds:
        raise ValueError("no_tiff_ifds")
    first_raw, width, height, bits = tiff_slice_pixels(source_path, endian, ifds[0])
    dtype, dtype_label = zarr_dtype_for_tiff_bits(bits)
    source_dtype = np.dtype("u1") if bits == 8 else np.dtype((">" if endian == ">" else "<") + "u2")
    target_dtype = np.dtype(dtype)
    shape = (len(ifds), height, width)
    array_dir = output_dir / "0"
    write_ome_zarr_root_metadata(output_dir, source_path.name, shape, chunks, physical_scale_nm)
    write_zarr_array_metadata(array_dir, shape, chunks, dtype)

    def raw_to_array(raw: bytes) -> Any:
        array = np.frombuffer(raw, dtype=source_dtype).reshape((height, width))
        if array.dtype != target_dtype:
            array = array.astype(target_dtype, copy=False)
        return array

    for z0 in range(0, shape[0], chunks[0]):
        z1 = min(shape[0], z0 + chunks[0])
        z_block = np.empty((z1 - z0, height, width), dtype=target_dtype)
        for local_z, tags in enumerate(ifds[z0:z1]):
            raw = first_raw if z0 == 0 and local_z == 0 else tiff_slice_pixels(source_path, endian, tags)[0]
            z_block[local_z] = raw_to_array(raw)
        for y0 in range(0, height, chunks[1]):
            y1 = min(height, y0 + chunks[1])
            for x0 in range(0, width, chunks[2]):
                x1 = min(width, x0 + chunks[2])
                chunk = z_block[:, y0:y1, x0:x1]
                chunk_name = f"{z0 // chunks[0]}.{y0 // chunks[1]}.{x0 // chunks[2]}"
                (array_dir / chunk_name).write_bytes(chunk.tobytes(order="C"))

    expected_chunks = zarr_chunk_count(shape, chunks)
    actual_chunks = sum(1 for name in iter_zarr_chunk_names(shape, chunks) if (array_dir / name).exists())
    validation_status = "passed" if actual_chunks == expected_chunks else "failed"
    return {
        "output_path": str(output_dir),
        "format": "OME-Zarr",
        "ome_ngff_version": "0.4",
        "zarr_format": 2,
        "array_path": "0",
        "shape_zyx": list(shape),
        "chunks_zyx": list(chunks),
        "dtype": dtype_label,
        "physical_voxel_size_nm": physical_scale_nm,
        "chunk_count_expected": expected_chunks,
        "chunk_count_actual": actual_chunks,
        "byte_size": directory_size(output_dir),
        "validation": {
            "status": validation_status,
            "checks": {
                "root_zgroup": (output_dir / ".zgroup").exists(),
                "root_ome_metadata": (output_dir / ".zattrs").exists(),
                "array_metadata": (array_dir / ".zarray").exists(),
                "all_chunks_present": actual_chunks == expected_chunks,
            },
        },
    }


def directory_size(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def read_asset_state_manifest(root_dir: Path) -> dict[str, Any]:
    return read_json_file(root_dir / "metadata" / "asset-state-manifest.json")


def read_conversion_readiness_manifest(root_dir: Path) -> dict[str, Any]:
    return read_json_file(root_dir / "metadata" / "conversion-readiness-manifest.json")


def select_conversion_asset(readiness: dict[str, Any], requested_asset: str | None) -> dict[str, Any]:
    ready_assets = [asset for asset in readiness.get("ready_assets", []) if asset.get("format") == "TIFF"]
    if requested_asset:
        for asset in ready_assets:
            if asset["relative_path"] == requested_asset:
                return asset
        raise ValueError(f"requested_asset_not_ready:{requested_asset}")
    if not ready_assets:
        raise ValueError("no_ready_tiff_assets")
    return min(ready_assets, key=lambda asset: int(asset.get("size_bytes") or 0))


def select_slice_assets(readiness: dict[str, Any], requested_asset: str | None, all_ready: bool) -> list[dict[str, Any]]:
    ready_assets = [asset for asset in readiness.get("ready_assets", []) if asset.get("format") in SLICE_CACHE_FORMATS]
    if requested_asset and all_ready:
        raise ValueError("cannot_combine_asset_and_all_ready")
    if requested_asset:
        for asset in ready_assets:
            if asset["relative_path"] == requested_asset:
                return [asset]
        raise ValueError(f"requested_asset_not_ready:{requested_asset}")
    if not ready_assets:
        raise ValueError("no_ready_slice_cache_assets")
    if all_ready:
        return sorted(ready_assets, key=lambda asset: asset["relative_path"])
    return [min(ready_assets, key=lambda asset: int(asset.get("size_bytes") or 0))]


def derivative_manifest_path(root_dir: Path) -> Path:
    return root_dir / "metadata" / "derivative-manifest.json"


def read_derivative_manifest(root_dir: Path) -> dict[str, Any]:
    path = derivative_manifest_path(root_dir)
    if not path.exists():
        return {"pipeline_version": PIPELINE_VERSION, "dataset": {}, "derivatives": []}
    return read_json_file(path)


def write_derivative_manifest(root_dir: Path, manifest: dict[str, Any]) -> Path:
    path = derivative_manifest_path(root_dir)
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return path


def update_derivative_manifest(root_dir: Path, dataset: dict[str, Any], derivative: dict[str, Any]) -> dict[str, Any]:
    manifest = read_derivative_manifest(root_dir)
    manifest["pipeline_version"] = PIPELINE_VERSION
    manifest["dataset"] = dataset
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
    derivatives = [
        item
        for item in manifest.get("derivatives", [])
        if item.get("source_relative_path") != derivative["source_relative_path"]
    ]
    derivatives.append(derivative)
    manifest["derivatives"] = sorted(derivatives, key=lambda item: item["source_relative_path"])
    return manifest


def update_asset_state_derivative(root_dir: Path, relative_path: str, derivative: dict[str, Any]) -> Path:
    path = root_dir / "metadata" / "asset-state-manifest.json"
    manifest = read_asset_state_manifest(root_dir)
    for asset in manifest.get("assets", []):
        local_path = Path(str(asset["mirrored_asset"]["local_path"]))
        try:
            asset_relative = local_path.relative_to(root_dir / "data").as_posix()
        except ValueError:
            asset_relative = ""
        if asset_relative == relative_path:
            asset["streamable_derivative"] = {
                "state": "converted" if derivative["validation"]["status"] == "passed" else "needs_review",
                "format": "OME-Zarr",
                "path": derivative["output_path"],
                "note": "Local conversion spike; not yet production-serving infrastructure.",
                "manifest_path": str(derivative_manifest_path(root_dir)),
            }
            break
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return path


def slice_manifest_path(root_dir: Path) -> Path:
    return root_dir / "metadata" / "slice-manifest.json"


def read_slice_manifest(root_dir: Path) -> dict[str, Any]:
    path = slice_manifest_path(root_dir)
    if not path.exists():
        return {"pipeline_version": PIPELINE_VERSION, "dataset": {}, "caches": []}
    return read_json_file(path)


def write_slice_manifest(root_dir: Path, manifest: dict[str, Any]) -> Path:
    path = slice_manifest_path(root_dir)
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return path


def update_slice_manifest(root_dir: Path, dataset: dict[str, Any], cache: dict[str, Any]) -> dict[str, Any]:
    manifest = read_slice_manifest(root_dir)
    manifest["pipeline_version"] = PIPELINE_VERSION
    manifest["dataset"] = dataset
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
    caches = [
        item
        for item in manifest.get("caches", [])
        if item.get("source_relative_path") != cache["source_relative_path"]
    ]
    caches.append(cache)
    manifest["caches"] = sorted(caches, key=lambda item: item["source_relative_path"])
    return manifest


def update_asset_state_slice_cache(root_dir: Path, relative_path: str, cache: dict[str, Any]) -> Path:
    path = root_dir / "metadata" / "asset-state-manifest.json"
    manifest = read_asset_state_manifest(root_dir)
    for asset in manifest.get("assets", []):
        local_path = Path(str(asset["mirrored_asset"]["local_path"]))
        try:
            asset_relative = local_path.relative_to(root_dir / "data").as_posix()
        except ValueError:
            asset_relative = ""
        if asset_relative == relative_path:
            asset["browser_slice_cache"] = {
                "state": "ready",
                "format": cache["format"],
                "cached_slices": cache["sampling"]["cached_slices"],
                "source_slices": cache["sampling"]["source_slices"],
                "byte_size": cache["byte_size"],
                "manifest_path": str(slice_manifest_path(root_dir)),
                "note": "Local viewer cache; not a canonical scientific derivative.",
            }
            break
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return path


def run_convert(args: argparse.Namespace) -> int:
    root_dir = Path(args.root).expanduser() / args.slug
    readiness = read_conversion_readiness_manifest(root_dir)
    asset = select_conversion_asset(readiness, args.asset)
    source_path = root_dir / "data" / asset["relative_path"]
    if not source_path.exists():
        print(f"Source asset does not exist: {source_path}", file=sys.stderr)
        return 2
    chunks = parse_chunk_shape(args.chunk_shape)
    output_dir = root_dir / "derived" / "ome-zarr" / f"{safe_derivative_name(asset['relative_path'])}.ome.zarr"
    print(f"Converting: {asset['relative_path']}")
    print(f"Output: {output_dir}")
    derivative_payload = write_tiff_as_ome_zarr(source_path, output_dir, asset["physical_voxel_size_nm"], chunks)
    derivative = {
        "source_relative_path": asset["relative_path"],
        "source_local_path": str(source_path),
        "source_sha256": asset.get("sha256", ""),
        "source_size_bytes": asset.get("size_bytes", ""),
        "conversion_tool": "scion_public_data_pilot.write_tiff_as_ome_zarr",
        "converted_at": datetime.now(timezone.utc).isoformat(),
        **derivative_payload,
    }
    manifest = update_derivative_manifest(root_dir, readiness["dataset"], derivative)
    manifest_path = write_derivative_manifest(root_dir, manifest)
    asset_state_path = update_asset_state_derivative(root_dir, asset["relative_path"], derivative)
    write_pilot_index(Path(args.root).expanduser())
    print(f"Derivative manifest: {manifest_path}")
    print(f"Asset state manifest: {asset_state_path}")
    print(f"Validation: {derivative['validation']['status']}")
    print(f"Chunks: {derivative['chunk_count_actual']}/{derivative['chunk_count_expected']}")
    print(f"Derivative size: {derivative['byte_size'] / (1024**3):.3f} GiB")
    return 0 if derivative["validation"]["status"] == "passed" else 1


def run_slices(args: argparse.Namespace) -> int:
    root_dir = Path(args.root).expanduser() / args.slug
    readiness = read_conversion_readiness_manifest(root_dir)
    assets = select_slice_assets(readiness, args.asset, args.all_ready)
    manifest_path = slice_manifest_path(root_dir)
    asset_state_path = root_dir / "metadata" / "asset-state-manifest.json"
    for index, asset in enumerate(assets, start=1):
        source_path = root_dir / "data" / asset["relative_path"]
        if not source_path.exists():
            print(f"Source asset does not exist: {source_path}", file=sys.stderr)
            return 2

        print(f"[{index}/{len(assets)}] Generating slice cache: {asset['relative_path']}", flush=True)
        cache = write_slice_cache(
            root_dir=root_dir,
            source_path=source_path,
            asset=asset,
            max_slices=args.max_slices,
            all_slices=args.all_slices,
            max_width=args.max_width,
            max_height=args.max_height,
        )
        manifest = update_slice_manifest(root_dir, readiness["dataset"], cache)
        manifest_path = write_slice_manifest(root_dir, manifest)
        asset_state_path = update_asset_state_slice_cache(root_dir, asset["relative_path"], cache)
        print(
            f"  cached {cache['sampling']['cached_slices']}/{cache['sampling']['source_slices']} slices "
            f"({cache['byte_size'] / (1024**2):.1f} MiB)",
            flush=True,
        )
    write_pilot_index(Path(args.root).expanduser())
    print(f"Slice manifest: {manifest_path}")
    print(f"Asset state manifest: {asset_state_path}")
    print(f"Generated caches: {len(assets)}")
    return 0


def read_json_file(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def root_href(root: Path, target: Path) -> str:
    return urllib.parse.quote(target.relative_to(root).as_posix())


def write_pilot_index(root: Path) -> tuple[Path, Path]:
    root.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for dataset_dir in sorted(item for item in root.iterdir() if item.is_dir()):
        metadata_dir = dataset_dir / "metadata"
        state_path = metadata_dir / "asset-state-manifest.json"
        report_path = metadata_dir / "validation-report.json"
        if not state_path.exists() or not report_path.exists():
            continue
        state = read_json_file(state_path)
        report = read_json_file(report_path)
        readiness_path = metadata_dir / "conversion-readiness-manifest.json"
        readiness = build_conversion_readiness_manifest(dataset_dir, state)
        write_conversion_readiness_outputs(dataset_dir, readiness)
        asset_states: dict[str, int] = {}
        for asset in state["assets"]:
            value = str(asset["validated_volume"]["state"])
            asset_states[value] = asset_states.get(value, 0) + 1
        records.append(
            {
                "slug": dataset_dir.name,
                "dataset": state["dataset"],
                "report": report,
                "asset_states": asset_states,
                "readiness": readiness["summary"],
                "preview_href": root_href(root, dataset_dir / "derived" / "preview-index.html"),
                "readiness_href": root_href(root, readiness_path),
                "review_href": root_href(root, metadata_dir / "curation-review-queue.tsv"),
                "validation_href": root_href(root, report_path),
            }
        )

    json_path = root / "pilot-index.json"
    json_path.write_text(json.dumps({"pipeline_version": PIPELINE_VERSION, "datasets": records}, indent=2, sort_keys=True))

    rows: list[str] = []
    for record in records:
        dataset = record["dataset"]
        report = record["report"]
        readiness = record["readiness"]
        states = ", ".join(f"{key}: {value}" for key, value in sorted(record["asset_states"].items()))
        rows.append(
            f"""
      <tr>
        <td><strong>{html.escape(record['slug'])}</strong><br />{html.escape(dataset.get('source', ''))} {html.escape(str(dataset.get('entry_id', '')))}</td>
        <td>{html.escape(dataset.get('title', ''))}</td>
        <td>{html.escape(str(report.get('file_count', '')))} files<br />{html.escape(str(report.get('total_gib', '')))} GiB</td>
        <td>{html.escape(states)}</td>
        <td>{html.escape(str(readiness.get('ready_assets', '')))} ready<br />{html.escape(str(readiness.get('blocked_assets', '')))} blocked</td>
        <td>{html.escape(str(len(report.get('warnings', []))))}</td>
        <td><a href="{record['preview_href']}">previews</a> · <a href="{record['readiness_href']}">readiness</a> · <a href="{record['review_href']}">review queue</a> · <a href="{record['validation_href']}">validation</a></td>
      </tr>"""
        )

    html_path = root / "pilot-index.html"
    html_path.write_text(
        f"""<!doctype html>
<meta charset="utf-8" />
<title>Scion Public Data Pilot Index</title>
<style>
  body {{ margin: 32px; background: #f3f0e8; color: #171717; font-family: Georgia, serif; }}
  h1 {{ font-family: Futura, Avenir Next, sans-serif; letter-spacing: .04em; }}
  table {{ width: 100%; border-collapse: collapse; background: #faf8f1; }}
  th, td {{ border: 1px solid #cfcac0; padding: 12px; vertical-align: top; text-align: left; }}
  th {{ font-family: Futura, Avenir Next, sans-serif; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; }}
  a {{ color: #087ea4; }}
</style>
<h1>Scion Public Data Pilot Index</h1>
<p>Local audit view for mirrored public datasets before OME-Zarr conversion.</p>
<table>
  <thead>
    <tr>
      <th>Dataset</th>
      <th>Title</th>
      <th>Footprint</th>
      <th>Asset States</th>
      <th>Conversion Gate</th>
      <th>Warnings</th>
      <th>Open</th>
    </tr>
  </thead>
  <tbody>{''.join(rows)}
  </tbody>
</table>
"""
    )
    return json_path, html_path


def validate_manifest(
    api_data: dict[str, Any],
    entry_id: str,
    inventory_rows: list[dict[str, Any]],
    preview_records: list[PreviewRecord],
) -> dict[str, Any]:
    entry = api_data.get(f"EMPIAR-{entry_id}", {})
    warnings: list[str] = []
    total_bytes = sum(int(row["size_bytes"]) for row in inventory_rows)
    formats = sorted({str(row["format"]) for row in inventory_rows})
    if not inventory_rows:
        warnings.append("No local data files found.")
    if entry.get("dataset_size") and not total_bytes:
        warnings.append(f"Entry reports dataset_size={entry.get('dataset_size')} but no local bytes were inventoried.")
    for row in inventory_rows:
        if row.get("format") == "MRC" and row.get("mrc_map") != "MAP ":
            warnings.append(f"{row['relative_path']}: MRC MAP marker missing or unexpected.")
        if row.get("format") == "MRC" and row.get("mrc_nx") and row.get("mrc_mx") and row.get("mrc_nx") == row.get("mrc_mx"):
            if row.get("mrc_cella_x_a") == str(row.get("mrc_nx")):
                warnings.append(
                    f"{row['relative_path']}: MRC cell dimensions mirror voxel counts; header physical scale is likely default, not authoritative."
                )
        if row.get("tiff_error"):
            warnings.append(f"{row['relative_path']}: TIFF parse warning: {row['tiff_error']}")
        if is_volume_format(row.get("format")) and not physical_scale_from_row(row, entry):
            warnings.append(f"{row['relative_path']}: no physical voxel size found in curated text, API metadata, TIFF metadata, or MRC header.")
    warnings.extend(validate_imageset_counts(inventory_rows))
    for record in preview_records:
        if is_volume_format(record.kind) and record.warning:
            warnings.append(f"{record.filename}: preview warning: {record.warning}")
    return {
        "entry_id": entry_id,
        "title": entry.get("title", ""),
        "dataset_size_reported": entry.get("dataset_size", ""),
        "file_count": len(inventory_rows),
        "formats": formats,
        "total_bytes": total_bytes,
        "total_gib": round(total_bytes / (1024**3), 3),
        "preview_count": sum(1 for record in preview_records if record.preview),
        "warnings": warnings,
    }


def validate_figshare_manifest(
    article_data: dict[str, Any],
    article_id: str,
    inventory_rows: list[dict[str, Any]],
    preview_records: list[PreviewRecord],
) -> dict[str, Any]:
    warnings: list[str] = []
    total_bytes = sum(int(row["size_bytes"]) for row in inventory_rows)
    formats = sorted({str(row["format"]) for row in inventory_rows})
    if not inventory_rows:
        warnings.append("No local data files found.")
    for row in inventory_rows:
        relative_path = row["relative_path"]
        expected_size = row.get("figshare_expected_size")
        if expected_size not in {"", None} and int(row["size_bytes"]) != int(expected_size):
            warnings.append(f"{relative_path}: Figshare expected {expected_size} bytes but local file has {row['size_bytes']} bytes.")
        expected_md5 = str(row.get("figshare_computed_md5") or row.get("figshare_supplied_md5") or "")
        local_md5 = str(row.get("figshare_local_md5") or "")
        if expected_md5 and local_md5 and expected_md5 != local_md5:
            warnings.append(f"{relative_path}: Figshare MD5 mismatch.")
        if row.get("tiff_error"):
            warnings.append(f"{relative_path}: TIFF parse warning: {row['tiff_error']}")
        z_warning = trakem2_z_spacing_warning(row)
        if z_warning:
            warnings.append(f"{relative_path}: {z_warning}")
        if is_volume_format(row.get("format")) and not (tiff_physical_scale(row) or trakem2_physical_scale(row)):
            warnings.append(f"{relative_path}: no physical voxel size found in Figshare, TIFF, or paired TrakEM2 metadata.")
    for record in preview_records:
        if is_volume_format(record.kind) and record.warning:
            warnings.append(f"{record.filename}: preview warning: {record.warning}")
    return {
        "entry_id": article_id,
        "title": article_data.get("title", ""),
        "dataset_size_reported": f"{sum(int(item.get('size') or 0) for item in article_data.get('files', []))} bytes",
        "file_count": len(inventory_rows),
        "formats": formats,
        "total_bytes": total_bytes,
        "total_gib": round(total_bytes / (1024**3), 3),
        "preview_count": sum(1 for record in preview_records if record.preview),
        "warnings": warnings,
    }


def physical_scale_from_row(row: dict[str, Any], entry: dict[str, Any]) -> bool:
    citation = (entry.get("citation") or [{}])[0]
    if physical_scale_from_text(str(row.get("api_details") or "")):
        return True
    if physical_scale_from_text(str(citation.get("details") or "")):
        return True
    if row.get("tiff_pixel_x_nm") and row.get("tiff_pixel_y_nm"):
        return True
    if row.get("mrc_voxel_x_nm") and row.get("mrc_voxel_y_nm") and row.get("mrc_voxel_z_nm"):
        return True
    return False


def validate_imageset_counts(inventory_rows: list[dict[str, Any]]) -> list[str]:
    warnings: list[str] = []
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in inventory_rows:
        key = str(row.get("api_name") or "")
        if key:
            groups.setdefault(key, []).append(row)
    for api_name, rows in groups.items():
        expected_raw = rows[0].get("api_num_images")
        try:
            expected = int(expected_raw)
        except (TypeError, ValueError):
            continue
        depths: list[int] = []
        for row in rows:
            raw_depth = row.get("mrc_nz") or row.get("tiff_slices")
            try:
                depths.append(int(raw_depth))
            except (TypeError, ValueError):
                continue
        if len(rows) > 1 and depths:
            total = sum(depths)
            if total != expected:
                warnings.append(
                    f"{api_name}: API reports {expected} images for an imageset spanning {len(rows)} local files with {total} total slices; treat API count as collection-level metadata."
                )
        elif len(rows) == 1 and depths and depths[0] != expected:
            warnings.append(
                f"{rows[0]['relative_path']}: API reports {expected} images but local file has {depths[0]} slices."
            )
    return warnings


def write_validation_report(root_dir: Path, report: dict[str, Any]) -> Path:
    path = root_dir / "metadata" / "validation-report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True))
    return path


def run_empiar(args: argparse.Namespace) -> int:
    entry_id = str(args.entry_id).replace("EMPIAR-", "")
    slug = args.slug or f"empiar-{entry_id}"
    root_dir = Path(args.root).expanduser() / slug
    data_dir = root_dir / "data"
    metadata_dir = root_dir / "metadata"
    derived_dir = root_dir / "derived"
    for directory in [data_dir, metadata_dir, derived_dir]:
        directory.mkdir(parents=True, exist_ok=True)

    print(f"Working directory: {root_dir}")
    if args.offline and args.download:
        print("--offline cannot be combined with --download.", file=sys.stderr)
        return 2
    api_data, remote_files = fetch_empiar_metadata(entry_id, metadata_dir, args.refresh_metadata, args.offline)
    download_manifest = metadata_dir / "download-manifest.tsv" if args.offline else write_download_manifest(remote_files, metadata_dir)
    print(f"Remote files {'loaded from cache' if args.offline else 'discovered'}: {len(remote_files)}")
    print(f"Download manifest: {download_manifest}")

    download_statuses: list[str] = []
    if args.download:
        download_statuses = download_files(remote_files, data_dir, args.max_files)
    elif args.require_existing_data and not any(data_dir.rglob("*")):
        print("No local data files exist. Re-run with --download.", file=sys.stderr)
        return 2

    if download_statuses:
        (metadata_dir / "download-status.log").write_text("\n".join(download_statuses) + "\n")

    inventory_rows = inventory_files(root_dir, api_data, entry_id, hash_files=not args.skip_hash)
    inventory_path = write_inventory(inventory_rows, metadata_dir)
    preview_records: list[PreviewRecord] = []
    preview_index = None
    preview_html = None
    if args.previews:
        preview_records = generate_previews(root_dir, inventory_rows)
        preview_index, preview_html = write_preview_outputs(root_dir, preview_records)

    normalized_manifest = build_normalized_manifest(api_data, entry_id, inventory_rows, download_manifest)
    normalized_path = write_normalized_manifest(root_dir, normalized_manifest)
    asset_state_manifest = build_asset_state_manifest(root_dir, normalized_manifest, inventory_rows, remote_files, preview_records)
    asset_state_path = write_asset_state_manifest(root_dir, asset_state_manifest)
    readiness_manifest = build_conversion_readiness_manifest(root_dir, asset_state_manifest)
    readiness_path, review_queue_path = write_conversion_readiness_outputs(root_dir, readiness_manifest)
    report = validate_manifest(api_data, entry_id, inventory_rows, preview_records)
    report_path = write_validation_report(root_dir, report)
    _, pilot_index_html = write_pilot_index(Path(args.root).expanduser())

    print(f"Inventory: {inventory_path}")
    print(f"Normalized manifest: {normalized_path}")
    print(f"Asset state manifest: {asset_state_path}")
    print(f"Conversion readiness: {readiness_path}")
    print(f"Curation review queue: {review_queue_path}")
    print(f"Validation report: {report_path}")
    print(f"Pilot index: {pilot_index_html}")
    if preview_index and preview_html:
        print(f"Preview inventory: {preview_index}")
        print(f"Preview HTML: {preview_html}")
    print(f"Local files: {report['file_count']} ({report['total_gib']} GiB)")
    print(f"Warnings: {len(report['warnings'])}")
    for warning in report["warnings"][:12]:
        print(f"  - {warning}")
    if len(report["warnings"]) > 12:
        print(f"  ... {len(report['warnings']) - 12} more warnings")
    return 0


def run_figshare(args: argparse.Namespace) -> int:
    article_id = str(args.article_id)
    slug = args.slug or f"figshare-{article_id}"
    root_dir = Path(args.root).expanduser() / slug
    data_dir = root_dir / "data"
    metadata_dir = root_dir / "metadata"
    derived_dir = root_dir / "derived"
    for directory in [data_dir, metadata_dir, derived_dir]:
        directory.mkdir(parents=True, exist_ok=True)

    print(f"Working directory: {root_dir}")
    if args.offline and args.download:
        print("--offline cannot be combined with --download.", file=sys.stderr)
        return 2
    article_data, remote_files = fetch_figshare_metadata(article_id, metadata_dir, args.refresh_metadata, args.offline)
    download_manifest = metadata_dir / "download-manifest.tsv" if args.offline else write_download_manifest(remote_files, metadata_dir)
    print(f"Remote files {'loaded from cache' if args.offline else 'discovered'}: {len(remote_files)}")
    print(f"Download manifest: {download_manifest}")

    download_statuses: list[str] = []
    if args.download:
        download_statuses = download_files(remote_files, data_dir, args.max_files)
    elif args.require_existing_data and not any(data_dir.rglob("*")):
        print("No local data files exist. Re-run with --download.", file=sys.stderr)
        return 2

    if download_statuses:
        (metadata_dir / "download-status.log").write_text("\n".join(download_statuses) + "\n")

    inventory_rows = inventory_figshare_files(root_dir, article_data, hash_files=not args.skip_hash)
    inventory_path = write_inventory(inventory_rows, metadata_dir)
    preview_records: list[PreviewRecord] = []
    preview_index = None
    preview_html = None
    if args.previews:
        preview_records = generate_previews(root_dir, inventory_rows)
        preview_index, preview_html = write_preview_outputs(root_dir, preview_records)

    normalized_manifest = build_normalized_figshare_manifest(article_data, article_id, inventory_rows, download_manifest)
    normalized_path = write_normalized_manifest(root_dir, normalized_manifest)
    asset_state_manifest = build_asset_state_manifest(root_dir, normalized_manifest, inventory_rows, remote_files, preview_records)
    asset_state_path = write_asset_state_manifest(root_dir, asset_state_manifest)
    readiness_manifest = build_conversion_readiness_manifest(root_dir, asset_state_manifest)
    readiness_path, review_queue_path = write_conversion_readiness_outputs(root_dir, readiness_manifest)
    report = validate_figshare_manifest(article_data, article_id, inventory_rows, preview_records)
    report_path = write_validation_report(root_dir, report)
    _, pilot_index_html = write_pilot_index(Path(args.root).expanduser())

    print(f"Inventory: {inventory_path}")
    print(f"Normalized manifest: {normalized_path}")
    print(f"Asset state manifest: {asset_state_path}")
    print(f"Conversion readiness: {readiness_path}")
    print(f"Curation review queue: {review_queue_path}")
    print(f"Validation report: {report_path}")
    print(f"Pilot index: {pilot_index_html}")
    if preview_index and preview_html:
        print(f"Preview inventory: {preview_index}")
        print(f"Preview HTML: {preview_html}")
    print(f"Local files: {report['file_count']} ({report['total_gib']} GiB)")
    print(f"Warnings: {len(report['warnings'])}")
    for warning in report["warnings"][:12]:
        print(f"  - {warning}")
    if len(report["warnings"]) > 12:
        print(f"  ... {len(report['warnings']) - 12} more warnings")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a dependency-light public-data pilot ingest.")
    subparsers = parser.add_subparsers(dest="source", required=True)
    empiar = subparsers.add_parser("empiar", help="Ingest an EMPIAR entry.")
    empiar.add_argument("entry_id", help="EMPIAR accession number, e.g. 10392.")
    empiar.add_argument("--slug", help="Local dataset directory name.")
    empiar.add_argument("--root", default=str(DEFAULT_ROOT), help=f"Data root. Default: {DEFAULT_ROOT}")
    empiar.add_argument("--download", action="store_true", help="Download remote files into the local data directory.")
    empiar.add_argument("--max-files", type=int, help="Limit downloads to the first N files for smoke testing.")
    empiar.add_argument("--previews", action="store_true", help="Generate dependency-light middle-slice PNG previews.")
    empiar.add_argument("--skip-hash", action="store_true", help="Skip SHA-256 hashes for faster exploratory runs.")
    empiar.add_argument("--refresh-metadata", action="store_true", help="Re-fetch API metadata even if cached.")
    empiar.add_argument("--offline", action="store_true", help="Use cached API metadata and download manifest without contacting EMPIAR.")
    empiar.add_argument(
        "--require-existing-data",
        action="store_true",
        help="Fail if --download is not used and no local data exists.",
    )
    figshare = subparsers.add_parser("figshare", help="Ingest a public Figshare article.")
    figshare.add_argument("article_id", help="Figshare article id, e.g. 7346750.")
    figshare.add_argument("--slug", help="Local dataset directory name.")
    figshare.add_argument("--root", default=str(DEFAULT_ROOT), help=f"Data root. Default: {DEFAULT_ROOT}")
    figshare.add_argument("--download", action="store_true", help="Download remote files into the local data directory.")
    figshare.add_argument("--max-files", type=int, help="Limit downloads to the first N files for smoke testing.")
    figshare.add_argument("--previews", action="store_true", help="Generate dependency-light middle-slice PNG previews.")
    figshare.add_argument("--skip-hash", action="store_true", help="Skip SHA-256/MD5 hashes for faster exploratory runs.")
    figshare.add_argument("--refresh-metadata", action="store_true", help="Re-fetch API metadata even if cached.")
    figshare.add_argument("--offline", action="store_true", help="Use cached article metadata and download manifest without contacting Figshare.")
    figshare.add_argument(
        "--require-existing-data",
        action="store_true",
        help="Fail if --download is not used and no local data exists.",
    )
    index = subparsers.add_parser("index", help="Build a local index across existing pilot dataset outputs.")
    index.add_argument("--root", default=str(DEFAULT_ROOT), help=f"Data root. Default: {DEFAULT_ROOT}")
    convert = subparsers.add_parser("convert", help="Convert one validated pilot TIFF asset into a local OME-Zarr derivative.")
    convert.add_argument("slug", help="Local dataset directory name.")
    convert.add_argument("--root", default=str(DEFAULT_ROOT), help=f"Data root. Default: {DEFAULT_ROOT}")
    convert.add_argument("--asset", help="Relative asset path. Defaults to the smallest ready TIFF asset.")
    convert.add_argument(
        "--chunk-shape",
        default=",".join(str(value) for value in DEFAULT_ZARR_CHUNK_SHAPE),
        help="Zarr chunk shape as z,y,x. Default: 32,256,256.",
    )
    slices = subparsers.add_parser("slices", help="Generate browser-friendly sampled PNG slice caches for ready TIFF/MRC assets.")
    slices.add_argument("slug", help="Local dataset directory name.")
    slices.add_argument("--root", default=str(DEFAULT_ROOT), help=f"Data root. Default: {DEFAULT_ROOT}")
    slices.add_argument("--asset", help="Relative asset path. Defaults to the smallest ready TIFF/MRC asset.")
    slices.add_argument("--all-ready", action="store_true", help="Generate caches for every ready TIFF/MRC asset.")
    slices.add_argument("--max-slices", type=int, default=96, help="Maximum sampled planes to cache. Default: 96.")
    slices.add_argument("--all-slices", action="store_true", help="Cache every source plane instead of sampling.")
    slices.add_argument("--max-width", type=int, default=960, help="Maximum generated PNG width. Default: 960.")
    slices.add_argument("--max-height", type=int, default=760, help="Maximum generated PNG height. Default: 760.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if shutil.which("python3") is None:
        print("python3 not found; this script requires Python 3.11+.", file=sys.stderr)
        return 2
    if args.source == "empiar":
        return run_empiar(args)
    if args.source == "figshare":
        return run_figshare(args)
    if args.source == "index":
        json_path, html_path = write_pilot_index(Path(args.root).expanduser())
        print(f"Pilot index JSON: {json_path}")
        print(f"Pilot index HTML: {html_path}")
        return 0
    if args.source == "convert":
        return run_convert(args)
    if args.source == "slices":
        return run_slices(args)
    parser.error(f"Unsupported source: {args.source}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
