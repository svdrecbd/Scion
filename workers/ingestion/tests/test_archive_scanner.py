from __future__ import annotations

import csv
import io
import importlib.util
import json
import struct
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "archive_scanner.py"
SPEC = importlib.util.spec_from_file_location("archive_scanner", MODULE_PATH)
assert SPEC and SPEC.loader
scanner = importlib.util.module_from_spec(SPEC)
sys.modules["archive_scanner"] = scanner
SPEC.loader.exec_module(scanner)


class ArchiveScannerTests(unittest.TestCase):
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

    def write_test_ome_zarr(self, path: Path) -> None:
        array = path / "0"
        array.mkdir(parents=True)
        (path / ".zgroup").write_text(json.dumps({"zarr_format": 2}))
        (path / ".zattrs").write_text(
            json.dumps(
                {
                    "multiscales": [
                        {
                            "version": "0.4",
                            "axes": [
                                {"name": "z", "type": "space", "unit": "nanometer"},
                                {"name": "y", "type": "space", "unit": "nanometer"},
                                {"name": "x", "type": "space", "unit": "nanometer"},
                            ],
                            "datasets": [
                                {
                                    "path": "0",
                                    "coordinateTransformations": [
                                        {"type": "scale", "scale": [30, 20, 10]},
                                    ],
                                },
                            ],
                        },
                    ],
                }
            )
        )
        (array / ".zarray").write_text(
            json.dumps(
                {
                    "zarr_format": 2,
                    "shape": [6, 5, 4],
                    "chunks": [3, 2, 2],
                    "dtype": "|u1",
                    "compressor": None,
                    "filters": None,
                    "order": "C",
                }
            )
        )
        (array / ".zattrs").write_text(json.dumps({}))
        (array / "0.0.0").write_bytes(b"\x00" * 24)

    def write_test_hdf5(self, path: Path) -> None:
        path.write_bytes(b"\x89HDF\r\n\x1a\n" + b"\x00" * 64)

    def read_jsonl(self, path: Path) -> list[dict]:
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

    def test_scan_writes_inventory_metadata_and_checksum_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "archive"
            output = Path(temp_dir) / "out"
            (root / "published" / "figures").mkdir(parents=True)
            (root / "raw").mkdir()
            (root / "metadata").mkdir()
            self.write_test_tiff(root / "raw" / "cell.tif")
            self.write_test_mrc(root / "raw" / "cell.mrc")
            self.write_test_zarr(root / "raw" / "cell.zarr")
            self.write_test_hdf5(root / "raw" / "cell.h5")
            (root / "published" / "figures" / "figure.png").write_bytes(b"png")
            (root / "metadata" / "notes.csv").write_text("sample,status\ncell,published\n")
            (root / "raw" / "duplicate-a.bin").write_bytes(b"same")
            (root / "raw" / "duplicate-b.bin").write_bytes(b"same")

            summary = scanner.scan_archive(
                root,
                output,
                archive_id="fixture-archive",
                checksum_algorithm="sha256",
                largest_file_limit=5,
            )

            self.assertEqual(summary["archive_id"], "fixture-archive")
            self.assertGreaterEqual(summary["file_count"], 8)
            self.assertEqual(summary["checksum"]["duplicate_files"], 1)
            self.assertTrue((output / "file-manifest.jsonl").exists())
            self.assertTrue((output / "inventory-summary.json").exists())
            self.assertTrue((output / "metadata-extraction.jsonl").exists())
            self.assertTrue((output / "volume-candidates.csv").exists())
            self.assertTrue((output / "metadata-gaps.csv").exists())
            self.assertTrue((output / "asset-status-ledger.jsonl").exists())
            self.assertTrue((output / "checksums.jsonl").exists())
            self.assertTrue((output / "fixity-run.json").exists())

            manifest = self.read_jsonl(output / "file-manifest.jsonl")
            by_path = {row["relative_path"]: row for row in manifest}
            self.assertEqual(by_path["raw/cell.tif"]["likely_role"], "raw_volume_candidate")
            self.assertEqual(by_path["published/figures/figure.png"]["likely_role"], "derived_or_analysis_output")
            self.assertEqual(by_path["metadata/notes.csv"]["likely_role"], "tabular_metadata_or_measurements")

            checksums = self.read_jsonl(output / "checksums.jsonl")
            duplicate_rows = [row for row in checksums if row["duplicate_of"]]
            self.assertEqual(len(duplicate_rows), 1)
            self.assertEqual(duplicate_rows[0]["duplicate_of"], "raw/duplicate-a.bin")
            self.assertTrue(all("modified_at" in row for row in checksums))

            ledger = self.read_jsonl(output / "asset-status-ledger.jsonl")
            self.assertEqual(len(ledger), summary["file_count"])
            status_by_path = {row["relative_path"]: row for row in ledger}
            hdf5_status = status_by_path["raw/cell.h5"]
            self.assertEqual(hdf5_status["fixity_status"], "checksummed")
            self.assertEqual(hdf5_status["rights_status"], "unknown")
            self.assertFalse(hdf5_status["allowed_operations"]["can_backup_to_cloud"])
            self.assertFalse(hdf5_status["allowed_operations"]["can_convert"])

            with (output / "metadata-gaps.csv").open() as source:
                gaps = list(csv.DictReader(source))
            gap_codes = {(row["relative_path"], row["gap_code"]) for row in gaps}
            self.assertIn(("raw/cell.tif", "missing_z_dimension"), gap_codes)
            self.assertIn(("raw/cell.tif", "missing_voxel_size"), gap_codes)
            self.assertIn(("raw/cell.h5", "hdf5_internal_metadata_pending"), gap_codes)
            self.assertIn(("raw/cell.h5", "missing_dimensions"), gap_codes)

    def test_metadata_extractors_emit_volume_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "archive"
            output = Path(temp_dir) / "out"
            (root / "raw").mkdir(parents=True)
            self.write_test_tiff(root / "raw" / "cell.tif")
            self.write_test_mrc(root / "raw" / "cell.mrc")
            self.write_test_zarr(root / "raw" / "cell.zarr")

            scanner.scan_archive(root, output, archive_id="fixture-archive")

            metadata = self.read_jsonl(output / "metadata-extraction.jsonl")
            formats = {row["format"]: row for row in metadata}
            self.assertEqual(formats["TIFF"]["dimensions"], {"x": 2, "y": 2})
            self.assertEqual(formats["MRC"]["dimensions"], {"x": 4, "y": 3, "z": 2})
            self.assertEqual(formats["MRC"]["dtype"], "uint16")
            self.assertEqual(formats["Zarr"]["dimensions"], {"x": 4, "y": 5, "z": 6})
            self.assertEqual(formats["Zarr"]["asset_relative_path"], "raw/cell.zarr")

            with (output / "volume-candidates.csv").open() as source:
                candidates = list(csv.DictReader(source))
            candidate_paths = {row["relative_path"] for row in candidates}
            self.assertIn("raw/cell.tif", candidate_paths)
            self.assertIn("raw/cell.mrc", candidate_paths)
            self.assertIn("raw/cell.zarr", candidate_paths)

    def test_ome_zarr_metadata_uses_top_level_store_and_voxel_size(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "archive"
            output = Path(temp_dir) / "out"
            self.write_test_ome_zarr(root / "derived" / "cell.ome.zarr")

            scanner.scan_archive(root, output, archive_id="fixture-archive")

            metadata = self.read_jsonl(output / "metadata-extraction.jsonl")
            self.assertEqual(len(metadata), 1)
            zarr = metadata[0]
            self.assertEqual(zarr["format"], "Zarr")
            self.assertEqual(zarr["asset_relative_path"], "derived/cell.ome.zarr")
            self.assertEqual(zarr["dimensions"], {"x": 4, "y": 5, "z": 6})
            self.assertEqual(zarr["metadata_source"], "ome_ngff_zarr_array_metadata")
            self.assertEqual(zarr["ome_ngff_version"], "0.4")
            self.assertEqual(zarr["ome_zarr_array_path"], "0")
            self.assertEqual(
                zarr["voxel_size_nm"],
                {"x": 10.0, "y": 20.0, "z": 30.0, "source": "ome_ngff_multiscales"},
            )

            with (output / "volume-candidates.csv").open() as source:
                candidates = list(csv.DictReader(source))
            self.assertEqual({row["relative_path"] for row in candidates}, {"derived/cell.ome.zarr"})

            with (output / "metadata-gaps.csv").open() as source:
                gaps = list(csv.DictReader(source))
            self.assertNotIn("missing_voxel_size", {row["gap_code"] for row in gaps})

    def test_resume_checksums_reuses_matching_records(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "archive"
            output = Path(temp_dir) / "out"
            root.mkdir()
            (root / "duplicate-a.bin").write_bytes(b"same")
            (root / "duplicate-b.bin").write_bytes(b"same")

            first = scanner.scan_archive(root, output, archive_id="fixture-archive", checksum_algorithm="sha256")
            self.assertEqual(first["checksum"]["files_hashed"], 2)
            self.assertEqual(first["checksum"]["files_reused"], 0)

            second = scanner.scan_archive(
                root,
                output,
                archive_id="fixture-archive",
                checksum_algorithm="sha256",
                resume_checksums=True,
            )

            self.assertEqual(second["checksum"]["files_hashed"], 0)
            self.assertEqual(second["checksum"]["files_reused"], 2)
            self.assertEqual(second["checksum"]["records_written"], 2)
            self.assertEqual(second["checksum"]["duplicate_files"], 1)
            checksums = self.read_jsonl(output / "checksums.jsonl")
            self.assertTrue(all(row["reused_from_previous_run"] for row in checksums))
            duplicate_rows = [row for row in checksums if row["duplicate_of"]]
            self.assertEqual(duplicate_rows[0]["duplicate_of"], "duplicate-a.bin")

    def test_cli_scan_command_prints_machine_readable_status(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "archive"
            output = Path(temp_dir) / "out"
            root.mkdir()
            (root / "notes.txt").write_text("hello")

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = scanner.main(["scan", str(root), "--output-dir", str(output), "--archive-id", "cli-fixture"])

            self.assertEqual(exit_code, 0)
            status = json.loads(stdout.getvalue())
            self.assertEqual(status["status"], "ok")
            summary = json.loads((output / "inventory-summary.json").read_text())
            self.assertEqual(summary["archive_id"], "cli-fixture")
            self.assertEqual(summary["file_count"], 1)


if __name__ == "__main__":
    unittest.main()
