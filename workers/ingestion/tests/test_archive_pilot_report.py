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


INGESTION_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = INGESTION_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


scanner = load_module("archive_scanner_for_pilot_report_tests", "archive_scanner.py")
registry = load_module("archive_registry_for_pilot_report_tests", "archive_registry.py")
pilot_report = load_module("archive_pilot_report", "archive_pilot_report.py")


class ArchivePilotReportTests(unittest.TestCase):
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

    def make_registry(self, temp_dir: str) -> Path:
        root = Path(temp_dir) / "archive"
        scan_dir = Path(temp_dir) / "scan"
        registry_dir = Path(temp_dir) / "registry"
        (root / "raw").mkdir(parents=True)
        (root / "published" / "figures").mkdir(parents=True)
        self.write_test_tiff(root / "raw" / "cell.tif")
        self.write_test_mrc(root / "raw" / "cell.mrc")
        self.write_test_zarr(root / "raw" / "cell.zarr")
        self.write_test_hdf5(root / "raw" / "cell.h5")
        (root / "published" / "figures" / "figure.png").write_bytes(b"png")

        scanner.scan_archive(root, scan_dir, archive_id="fixture-archive", checksum_algorithm="sha256")
        registry.build_private_registry(scan_dir, registry_dir, registry_id="fixture-registry")
        return registry_dir

    def test_report_writes_json_markdown_and_review_tables(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_dir = self.make_registry(temp_dir)
            output_dir = Path(temp_dir) / "pilot"

            report = pilot_report.build_report(
                registry_dir,
                output_dir,
                pilot_report.PilotSelection(
                    pilot_id="pilot-candidate",
                    title="Candidate Pilot",
                    kind="candidate",
                    path_prefixes=["raw/"],
                    volume_candidates_only=True,
                ),
            )

            self.assertEqual(report["schema"], "cell-anatomy-archive-pilot-report")
            self.assertEqual(report["selection"]["pilot_id"], "pilot-candidate")
            self.assertEqual(report["summary"]["selected_asset_count"], 4)
            self.assertEqual(report["summary"]["volume_candidate_count"], 4)
            self.assertEqual(report["summary"]["project_ready_count"], 0)
            self.assertIn("rights_unknown", {finding["code"] for finding in report["findings"]})
            self.assertIn("metadata_gaps", {finding["code"] for finding in report["findings"]})
            self.assertTrue((output_dir / "pilot-report.json").exists())
            self.assertTrue((output_dir / "pilot-report.md").exists())
            self.assertTrue((output_dir / "pilot-assets.csv").exists())
            self.assertTrue((output_dir / "pilot-review-queue.csv").exists())

            markdown = (output_dir / "pilot-report.md").read_text()
            self.assertIn("# Candidate Pilot", markdown)
            self.assertIn("## Metadata Gaps", markdown)
            self.assertIn("raw/cell.tif", markdown)

            with (output_dir / "pilot-assets.csv").open() as source:
                rows = list(csv.DictReader(source))
            paths = {row["relative_path"] for row in rows}
            self.assertEqual(paths, {"raw/cell.tif", "raw/cell.mrc", "raw/cell.h5", "raw/cell.zarr"})
            zarr = next(row for row in rows if row["relative_path"] == "raw/cell.zarr")
            self.assertIn("missing_composite_checksum", zarr["blockers"])

    def test_report_cli_prints_machine_readable_status(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_dir = self.make_registry(temp_dir)
            output_dir = Path(temp_dir) / "pilot"

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = pilot_report.main(
                    [
                        "report",
                        str(registry_dir),
                        "--output-dir",
                        str(output_dir),
                        "--pilot-id",
                        "pilot-cli",
                        "--title",
                        "CLI Pilot",
                        "--kind",
                        "candidate",
                        "--path-prefix",
                        "raw/",
                        "--volume-candidates-only",
                    ]
                )

            self.assertEqual(exit_code, 0)
            status = json.loads(stdout.getvalue())
            self.assertEqual(status["status"], "ok")
            self.assertEqual(status["pilot_id"], "pilot-cli")
            self.assertEqual(status["selected_asset_count"], 4)

    def test_volume_candidates_only_can_select_candidates_without_extra_selector(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_dir = self.make_registry(temp_dir)
            output_dir = Path(temp_dir) / "pilot"

            report = pilot_report.build_report(
                registry_dir,
                output_dir,
                pilot_report.PilotSelection(
                    pilot_id="pilot-volumes",
                    title="Volume Candidates",
                    kind="candidate",
                    volume_candidates_only=True,
                ),
            )

            self.assertEqual(report["summary"]["selected_asset_count"], 4)
            self.assertEqual(report["summary"]["volume_candidate_count"], 4)
            self.assertEqual(report["summary"]["selected_asset_count"], report["summary"]["volume_candidate_count"])

    def test_report_requires_explicit_selector_or_all_flag(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_dir = self.make_registry(temp_dir)
            output_dir = Path(temp_dir) / "pilot"

            with self.assertRaisesRegex(ValueError, "selector"):
                pilot_report.build_report(
                    registry_dir,
                    output_dir,
                    pilot_report.PilotSelection(
                        pilot_id="bad-pilot",
                        title="Bad Pilot",
                        kind="custom",
                    ),
                )


if __name__ == "__main__":
    unittest.main()
