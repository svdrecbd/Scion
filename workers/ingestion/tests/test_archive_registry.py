from __future__ import annotations

import csv
import hashlib
import io
import importlib.util
import json
import struct
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


INGESTION_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = INGESTION_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


scanner = load_module("archive_scanner_for_registry_tests", "archive_scanner.py")
registry = load_module("archive_registry", "archive_registry.py")


class ArchiveRegistryTests(unittest.TestCase):
    def write_test_tiff(self, path: Path, pixels: bytes = b"\x00\x40\x80\xff") -> None:
        width = 2
        height = 2
        entries = [
            (256, 4, 1, width),
            (257, 4, 1, height),
            (258, 3, 1, 8),
            (259, 3, 1, 1),
            (262, 3, 1, 1),
            (273, 4, 1, 0),
            (277, 3, 1, 1),
            (278, 4, 1, height),
            (279, 4, 1, len(pixels)),
        ]
        data_offset = 8 + 2 + len(entries) * 12 + 4
        encoded = bytearray(b"II" + struct.pack("<H", 42) + struct.pack("<I", 8))
        encoded.extend(struct.pack("<H", len(entries)))
        for tag, value_type, count, value in entries:
            if tag == 273:
                value = data_offset
            raw_value = struct.pack("<H", value) + b"\x00\x00" if value_type == 3 else struct.pack("<I", value)
            encoded.extend(struct.pack("<HHI", tag, value_type, count) + raw_value)
        encoded.extend(struct.pack("<I", 0))
        encoded.extend(pixels)
        path.write_bytes(bytes(encoded))

    def write_test_mrc(self, path: Path) -> None:
        header = bytearray(1024)
        struct.pack_into("<4i", header, 0, 4, 3, 2, 6)
        struct.pack_into("<3i", header, 28, 4, 3, 2)
        struct.pack_into("<3f", header, 40, 80.0, 60.0, 100.0)
        header[208:212] = b"MAP "
        path.write_bytes(bytes(header) + b"\x00" * 48)

    def write_test_zarr(self, path: Path) -> None:
        path.mkdir(parents=True)
        (path / ".zarray").write_text(
            json.dumps(
                {
                    "zarr_format": 2,
                    "shape": [6, 5, 4],
                    "chunks": [3, 2, 2],
                    "dtype": "<u2",
                    "compressor": None,
                    "filters": None,
                    "order": "C",
                }
            )
        )
        (path / "0.0.0").write_bytes(b"\x00" * 24)

    def write_test_hdf5(self, path: Path) -> None:
        path.write_bytes(b"\x89HDF\r\n\x1a\n" + b"\x00" * 64)

    def write_public_data_bundle(self, root: Path) -> None:
        slug = "fixture-public-dataset"
        data_dir = root / slug / "data"
        derivative_dir = root / slug / "derived" / "ome-zarr" / "cell.ome.zarr"
        metadata_dir = root / slug / "metadata"
        data_dir.mkdir(parents=True)
        (derivative_dir / "0").mkdir(parents=True)
        metadata_dir.mkdir(parents=True)

        source_bytes = b"source-volume"
        source_path = data_dir / "cell.tif"
        source_path.write_bytes(source_bytes)
        source_digest = hashlib.sha256(source_bytes).hexdigest()

        (derivative_dir / ".zgroup").write_text(json.dumps({"zarr_format": 2}))
        (derivative_dir / ".zattrs").write_text(json.dumps({"multiscales": []}))
        (derivative_dir / "0" / ".zarray").write_text(
            json.dumps(
                {
                    "zarr_format": 2,
                    "shape": [3, 5, 7],
                    "chunks": [1, 5, 7],
                    "dtype": "|u1",
                    "compressor": None,
                    "filters": None,
                    "order": "C",
                }
            )
        )
        (derivative_dir / "0" / "0.0.0").write_bytes(b"\x01" * 35)
        derivative_bytes = sum(path.stat().st_size for path in derivative_dir.rglob("*") if path.is_file())

        dataset = {
            "source": "Fixture",
            "entry_id": "fixture-1",
            "entry_doi": "10.0000/fixture",
            "experiment_type": "FIB-SEM",
            "title": "Fixture public dataset",
            "dataset_size": "12 bytes",
        }
        (root / "pilot-index.json").write_text(
            json.dumps(
                {
                    "pipeline_version": "public-data-pilot-test",
                    "datasets": [
                        {
                            "slug": slug,
                            "dataset": dataset,
                            "readiness": {"ready_assets": 1, "blocked_assets": 0, "sidecar_assets": 0},
                            "readiness_href": f"{slug}/metadata/conversion-readiness-manifest.json",
                            "validation_href": f"{slug}/metadata/validation-report.json",
                            "advisory_href": f"{slug}/metadata/advisory-findings.json",
                        }
                    ],
                }
            )
        )
        (metadata_dir / "conversion-readiness-manifest.json").write_text(
            json.dumps(
                {
                    "dataset": dataset,
                    "summary": {
                        "ready_assets": 1,
                        "blocked_assets": 0,
                        "sidecar_assets": 0,
                        "status": "ready_for_conversion_trial",
                        "target_format": "OME-Zarr",
                        "total_assets": 1,
                    },
                    "ready_assets": [
                        {
                            "conversion_target": "OME-Zarr",
                            "dimensions": {"x": 7, "y": 5, "z": 3},
                            "format": "TIFF",
                            "local_path": str(source_path),
                            "physical_voxel_size_nm": {"x": 4, "y": 4, "z": 8, "source": "fixture"},
                            "preview_path": "",
                            "readiness": "ready_for_conversion_trial",
                            "relative_path": "cell.tif",
                            "review_notes": [],
                            "sha256": source_digest,
                            "size_bytes": len(source_bytes),
                        }
                    ],
                    "blocked_assets": [],
                    "sidecar_assets": [],
                }
            )
        )
        (metadata_dir / "derivative-manifest.json").write_text(
            json.dumps(
                {
                    "dataset": dataset,
                    "pipeline_version": "public-data-pilot-test",
                    "updated_at": "2026-06-09T00:00:00Z",
                    "derivatives": [
                        {
                            "array_path": "0",
                            "byte_size": derivative_bytes,
                            "chunk_count_actual": 1,
                            "chunk_count_expected": 1,
                            "chunks_zyx": [1, 5, 7],
                            "conversion_tool": "fixture",
                            "converted_at": "2026-06-09T00:00:00Z",
                            "dtype": "uint8",
                            "format": "OME-Zarr",
                            "ome_ngff_version": "0.4",
                            "output_path": str(derivative_dir),
                            "physical_voxel_size_nm": {"x": 4, "y": 4, "z": 8, "source": "fixture"},
                            "shape_zyx": [3, 5, 7],
                            "source_local_path": str(source_path),
                            "source_relative_path": "cell.tif",
                            "source_sha256": source_digest,
                            "source_size_bytes": len(source_bytes),
                            "validation": {"status": "passed", "checks": {"all_chunks_present": True}},
                            "zarr_format": 2,
                        }
                    ],
                }
            )
        )

    def read_jsonl(self, path: Path) -> list[dict]:
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

    def make_scan(self, temp_dir: str) -> tuple[Path, Path]:
        root = Path(temp_dir) / "archive"
        scan_dir = Path(temp_dir) / "scan"
        (root / "raw").mkdir(parents=True)
        (root / "figures").mkdir()
        self.write_test_tiff(root / "raw" / "cell.tif")
        self.write_test_mrc(root / "raw" / "cell.mrc")
        self.write_test_zarr(root / "raw" / "cell.zarr")
        self.write_test_hdf5(root / "raw" / "cell.h5")
        (root / "figures" / "figure.png").write_bytes(b"png")
        scanner.scan_archive(root, scan_dir, archive_id="fixture-archive", checksum_algorithm="sha256")
        return root, scan_dir

    def test_import_scan_builds_private_registry_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            _, scan_dir = self.make_scan(temp_dir)
            registry_dir = Path(temp_dir) / "registry"

            summary = registry.build_private_registry(scan_dir, registry_dir, registry_id="fixture-registry")

            self.assertEqual(summary["schema"], "cell-anatomy-private-archive-registry")
            self.assertEqual(summary["registry_id"], "fixture-registry")
            self.assertGreaterEqual(summary["asset_count"], 6)
            self.assertEqual(summary["logical_asset_count"], 1)
            self.assertGreaterEqual(summary["volume_candidate_count"], 4)
            self.assertTrue((registry_dir / "private-registry.json").exists())
            self.assertTrue((registry_dir / "private-registry-assets.jsonl").exists())
            self.assertTrue((registry_dir / "private-registry-search-index.jsonl").exists())
            self.assertTrue((registry_dir / "private-registry-review-queue.csv").exists())
            self.assertTrue((registry_dir / "private-registry-volume-candidates.csv").exists())

            assets = self.read_jsonl(registry_dir / "private-registry-assets.jsonl")
            by_path = {asset["relative_path"]: asset for asset in assets}
            self.assertIn("raw/cell.tif", by_path)
            self.assertIn("raw/cell.h5", by_path)
            self.assertIn("raw/cell.zarr", by_path)

            tiff = by_path["raw/cell.tif"]
            self.assertEqual(tiff["checksum"]["algorithm"], "sha256")
            self.assertEqual(tiff["metadata"]["format"], "TIFF")
            self.assertIn("missing_voxel_size", tiff["review"]["gap_codes"])
            self.assertFalse(tiff["status"]["allowed_operations"]["can_backup_to_cloud"])
            self.assertFalse(tiff["readiness"]["project_ready"])

            hdf5 = by_path["raw/cell.h5"]
            self.assertEqual(hdf5["metadata"]["format"], "HDF5")
            self.assertIn("hdf5_internal_metadata_pending", hdf5["review"]["gap_codes"])
            self.assertIn("missing_dimensions", hdf5["readiness"]["blockers"])

            zarr = by_path["raw/cell.zarr"]
            self.assertEqual(zarr["path_type"], "directory_volume")
            self.assertEqual(zarr["metadata"]["format"], "Zarr")
            self.assertIn("missing_composite_checksum", zarr["readiness"]["blockers"])

            search_entries = self.read_jsonl(registry_dir / "private-registry-search-index.jsonl")
            self.assertEqual(len(search_entries), summary["asset_count"])
            self.assertTrue(any("raw/cell.tif" in entry["search_text"] for entry in search_entries))

            with (registry_dir / "private-registry-review-queue.csv").open() as source:
                review_rows = list(csv.DictReader(source))
            review_paths = {row["relative_path"] for row in review_rows}
            self.assertIn("raw/cell.tif", review_paths)
            self.assertIn("raw/cell.h5", review_paths)
            self.assertIn("raw/cell.zarr", review_paths)

            with (registry_dir / "private-registry-volume-candidates.csv").open() as source:
                candidate_rows = list(csv.DictReader(source))
            candidate_paths = {row["relative_path"] for row in candidate_rows}
            self.assertIn("raw/cell.mrc", candidate_paths)
            self.assertIn("raw/cell.zarr", candidate_paths)

    def test_import_scan_cli_prints_machine_readable_status(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            _, scan_dir = self.make_scan(temp_dir)
            registry_dir = Path(temp_dir) / "registry"

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = registry.main(
                    [
                        "import-scan",
                        str(scan_dir),
                        "--output-dir",
                        str(registry_dir),
                        "--registry-id",
                        "cli-registry",
                    ]
                )

            self.assertEqual(exit_code, 0)
            status = json.loads(stdout.getvalue())
            self.assertEqual(status["status"], "ok")
            self.assertEqual(status["registry_id"], "cli-registry")
            self.assertGreaterEqual(status["asset_count"], 6)
            summary = json.loads((registry_dir / "private-registry.json").read_text())
            self.assertEqual(summary["registry_id"], "cli-registry")

    def test_import_public_data_marks_converted_derivatives_project_ready(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "public-data"
            output_dir = Path(temp_dir) / "registry"
            self.write_public_data_bundle(root)

            summary = registry.build_public_data_registry(root, output_dir, registry_id="public-registry")

            self.assertEqual(summary["registry_id"], "public-registry")
            self.assertEqual(summary["asset_count"], 2)
            self.assertEqual(summary["file_asset_count"], 1)
            self.assertEqual(summary["logical_asset_count"], 1)
            self.assertEqual(summary["project_ready_count"], 1)
            self.assertEqual(summary["volume_candidate_count"], 2)

            assets = self.read_jsonl(output_dir / "private-registry-assets.jsonl")
            by_path = {asset["relative_path"]: asset for asset in assets}
            source = by_path["fixture-public-dataset/data/cell.tif"]
            derivative = by_path["fixture-public-dataset/derived/ome-zarr/cell.ome.zarr"]

            self.assertEqual(source["checksum"]["algorithm"], "sha256")
            self.assertEqual(source["status"]["rights_status"], "public")
            self.assertTrue(source["status"]["allowed_operations"]["can_convert"])
            self.assertTrue(source["readiness"]["metadata_ready"])
            self.assertFalse(source["readiness"]["project_ready"])
            self.assertNotIn("blocked_missing_metadata", source["readiness"]["blockers"])

            self.assertEqual(derivative["checksum"]["algorithm"], "sha256-tree-v1")
            self.assertEqual(derivative["metadata"]["format"], "Zarr")
            self.assertEqual(derivative["metadata"]["dimensions"], {"x": 7, "y": 5, "z": 3})
            self.assertTrue(derivative["status"]["allowed_operations"]["can_view_in_caos"])
            self.assertTrue(derivative["readiness"]["project_ready"])
            self.assertEqual(derivative["readiness"]["blockers"], [])

            with (output_dir / "private-registry-volume-candidates.csv").open() as source_handle:
                candidate_rows = list(csv.DictReader(source_handle))
            self.assertEqual({row["relative_path"] for row in candidate_rows}, set(by_path))

    def test_import_public_data_cli_prints_machine_readable_status(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "public-data"
            output_dir = Path(temp_dir) / "registry"
            self.write_public_data_bundle(root)

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = registry.main(
                    [
                        "import-public-data",
                        str(root),
                        "--output-dir",
                        str(output_dir),
                        "--registry-id",
                        "public-cli-registry",
                    ]
                )

            self.assertEqual(exit_code, 0)
            status = json.loads(stdout.getvalue())
            self.assertEqual(status["status"], "ok")
            self.assertEqual(status["registry_id"], "public-cli-registry")
            self.assertEqual(status["asset_count"], 2)


if __name__ == "__main__":
    unittest.main()
