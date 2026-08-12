from __future__ import annotations

import csv
import hashlib
import io
import importlib.util
import json
import os
import struct
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


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
            self.assertTrue((output / "scan-progress.jsonl").exists())
            self.assertTrue((output / "scan-checkpoint.json").exists())

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

            progress = self.read_jsonl(output / "scan-progress.jsonl")
            self.assertEqual(progress[0]["event"], "scan_started")
            self.assertEqual(progress[-1]["phase"], "completed")
            checkpoint = json.loads((output / "scan-checkpoint.json").read_text())
            self.assertEqual(checkpoint["event"], "scan_finished")
            self.assertEqual(checkpoint["file_count"], summary["file_count"])

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

    def test_interrupted_scan_preserves_last_complete_artifacts_and_reuses_disk_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "archive"
            output = Path(temp_dir) / "out"
            root.mkdir()
            (root / "stable.bin").write_bytes(b"stable")
            first = scanner.scan_archive(
                root,
                output,
                archive_id="fixture-archive",
                checksum_algorithm="sha256",
            )
            self.assertEqual(first["file_count"], 1)
            complete_manifest = (output / "file-manifest.jsonl").read_text()

            (root / "new.bin").write_bytes(b"new")

            def interrupted_walk(*_args, **_kwargs):
                yield str(root), [], ["new.bin"]
                raise RuntimeError("simulated interruption")

            with patch.object(scanner.os, "walk", interrupted_walk):
                with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                    scanner.scan_archive(
                        root,
                        output,
                        archive_id="fixture-archive",
                        checksum_algorithm="sha256",
                        resume_checksums=True,
                    )

            self.assertEqual((output / "file-manifest.jsonl").read_text(), complete_manifest)
            self.assertTrue((output / "file-manifest.jsonl.inprogress").exists())
            failed_checkpoint = json.loads((output / "scan-checkpoint.json").read_text())
            self.assertEqual(failed_checkpoint["phase"], "failed")
            self.assertTrue((output / "scan-state.sqlite").exists())

            resumed = scanner.scan_archive(
                root,
                output,
                archive_id="fixture-archive",
                checksum_algorithm="sha256",
                resume_checksums=True,
            )
            self.assertEqual(resumed["checksum"]["files_hashed"], 0)
            self.assertEqual(resumed["checksum"]["files_reused"], 2)
            self.assertEqual(
                {row["relative_path"] for row in self.read_jsonl(output / "file-manifest.jsonl")},
                {"new.bin", "stable.bin"},
            )
            self.assertFalse((output / "file-manifest.jsonl.inprogress").exists())
            events = [row["event"] for row in self.read_jsonl(output / "scan-progress.jsonl")]
            self.assertIn("scan_failed", events)
            self.assertEqual(events[-1], "scan_finished")

    def test_resume_rejects_changed_source_identity_and_rehashes_replaced_inode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "archive"
            other_root = Path(temp_dir) / "other-archive"
            output = Path(temp_dir) / "out"
            root.mkdir()
            other_root.mkdir()
            source = root / "cell.bin"
            source.write_bytes(b"alpha")
            scanner.scan_archive(root, output, archive_id="fixture-archive", checksum_algorithm="sha256")

            with self.assertRaisesRegex(ValueError, "source root changed"):
                scanner.scan_archive(
                    other_root,
                    output,
                    archive_id="fixture-archive",
                    checksum_algorithm="sha256",
                    resume_checksums=True,
                )

            original_stat = source.stat()
            replacement = root / "replacement.bin"
            replacement.write_bytes(b"omega")
            replacement.replace(source)
            os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))

            resumed = scanner.scan_archive(
                root,
                output,
                archive_id="fixture-archive",
                checksum_algorithm="sha256",
                resume_checksums=True,
            )
            self.assertEqual(resumed["checksum"]["files_hashed"], 1)
            self.assertEqual(resumed["checksum"]["files_reused"], 0)

    def test_scan_rejects_output_inside_source_and_concurrent_writer(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "archive"
            output = Path(temp_dir) / "out"
            root.mkdir()
            output.mkdir()
            (root / "cell.bin").write_bytes(b"alpha")

            with self.assertRaisesRegex(ValueError, "outside the archive root"):
                scanner.scan_archive(root, root / "scan-output", archive_id="fixture-archive")

            lock = scanner.ExclusiveFileLock(output / "scan.lock", "test scan")
            try:
                with self.assertRaisesRegex(RuntimeError, "already using"):
                    scanner.scan_archive(root, output, archive_id="fixture-archive")
            finally:
                lock.close()

    def test_preflight_reports_safety_and_resume_blockers_without_scanning(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "archive"
            output = Path(temp_dir) / "out"
            root.mkdir()
            (root / "cell.bin").write_bytes(b"alpha")

            ready = scanner.scan_preflight(
                root,
                output,
                archive_id="fixture-archive",
                checksum_algorithm="sha256",
                resume_checksums=True,
            )
            self.assertEqual(ready["status"], "ready")
            self.assertTrue(any("hash every file" in warning for warning in ready["warnings"]))
            self.assertFalse(output.exists())

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = scanner.main(
                    [
                        "scan",
                        str(root),
                        "--output-dir",
                        str(root / "nested-output"),
                        "--archive-id",
                        "fixture-archive",
                        "--preflight-only",
                    ]
                )
            self.assertEqual(exit_code, 2)
            blocked = json.loads(stdout.getvalue())
            self.assertEqual(blocked["status"], "blocked")
            self.assertTrue(any("outside the archive root" in item for item in blocked["blockers"]))

    def test_scan_progress_interval_writes_live_checkpoints(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "archive"
            output = Path(temp_dir) / "out"
            root.mkdir()
            for index in range(3):
                (root / f"file-{index}.txt").write_text(f"hello {index}")

            scanner.scan_archive(
                root,
                output,
                archive_id="fixture-archive",
                progress_interval_files=1,
                progress_interval_seconds=0,
            )

            progress = self.read_jsonl(output / "scan-progress.jsonl")
            checkpoint_events = [row for row in progress if row["event"] == "progress_checkpoint"]
            self.assertEqual(len(checkpoint_events), 3)
            self.assertEqual(progress[-1]["event"], "scan_finished")
            checkpoint = json.loads((output / "scan-checkpoint.json").read_text())
            self.assertEqual(checkpoint["phase"], "completed")
            self.assertEqual(checkpoint["file_count"], 3)

    def test_compare_scan_outputs_reports_copy_digest_mismatches(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source_root = Path(temp_dir) / "source"
            target_root = Path(temp_dir) / "target"
            source_scan = Path(temp_dir) / "source-scan"
            target_scan = Path(temp_dir) / "target-scan"
            verification = Path(temp_dir) / "verification"
            source_root.mkdir()
            target_root.mkdir()
            (source_root / "cell.bin").write_bytes(b"alpha")
            (target_root / "cell.bin").write_bytes(b"alpha")

            scanner.scan_archive(source_root, source_scan, archive_id="source", checksum_algorithm="sha256")
            scanner.scan_archive(target_root, target_scan, archive_id="target", checksum_algorithm="sha256")

            passed = scanner.compare_scan_outputs(
                source_scan,
                target_scan,
                verification,
                require_checksums=True,
            )
            self.assertTrue(passed["passed"])
            self.assertEqual(passed["verification_level"], "checksum")

            (target_root / "cell.bin").write_bytes(b"omega")
            scanner.scan_archive(target_root, target_scan, archive_id="target", checksum_algorithm="sha256")
            failed = scanner.compare_scan_outputs(
                source_scan,
                target_scan,
                verification,
                require_checksums=True,
            )

            self.assertFalse(failed["passed"])
            self.assertEqual(failed["counts"]["checksum_digest_mismatches"], 1)
            self.assertTrue((verification / "copy-verification-report.json").exists())
            self.assertFalse((verification / ".copy-verification-state.sqlite").exists())
            with (verification / "copy-verification-mismatches.csv").open() as source:
                mismatches = list(csv.DictReader(source))
            self.assertEqual(mismatches[0]["issue_type"], "checksum_digest_mismatch")

    def test_copy_verification_streams_large_cardinality_through_disk_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source_scan = Path(temp_dir) / "source-scan"
            target_scan = Path(temp_dir) / "target-scan"
            verification = Path(temp_dir) / "verification"
            source_scan.mkdir()
            target_scan.mkdir()
            record_count = 2500

            for scan_dir, archive_id in ((source_scan, "source"), (target_scan, "target")):
                (scan_dir / "inventory-summary.json").write_text(
                    json.dumps(
                        {
                            "archive_id": archive_id,
                            "root": f"/{archive_id}",
                            "bytes_total": record_count,
                        }
                    )
                )
                with (
                    (scan_dir / "file-manifest.jsonl").open("w") as manifest,
                    (scan_dir / "checksums.jsonl").open("w") as checksums,
                ):
                    for index in range(record_count):
                        relative = f"batch/{index:06d}.bin"
                        digest = hashlib.sha256(relative.encode()).hexdigest()
                        manifest.write(
                            json.dumps(
                                {
                                    "relative_path": relative,
                                    "path_type": "file",
                                    "size_bytes": 1,
                                }
                            )
                            + "\n"
                        )
                        checksums.write(
                            json.dumps(
                                {
                                    "relative_path": relative,
                                    "algorithm": "sha256",
                                    "digest": digest,
                                }
                            )
                            + "\n"
                        )

            report = scanner.compare_scan_outputs(
                source_scan,
                target_scan,
                verification,
                require_checksums=True,
            )

            self.assertTrue(report["passed"])
            self.assertEqual(report["counts"]["common_paths"], record_count)
            self.assertEqual(report["counts"]["checksum_compared"], record_count)
            self.assertEqual(report["counts"]["issue_count"], 0)
            self.assertFalse((verification / ".copy-verification-state.sqlite").exists())

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
