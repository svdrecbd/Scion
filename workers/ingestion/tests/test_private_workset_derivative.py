from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


INGESTION_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = INGESTION_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


scanner = load_module("archive_scanner_for_derivative_tests", "archive_scanner.py")
registry = load_module("archive_registry_for_derivative_tests", "archive_registry.py")
factory = load_module("private_workset_derivative", "private_workset_derivative.py")


class PrivateWorksetDerivativeTests(unittest.TestCase):
    def write_test_tiff(
        self,
        path: Path,
        pixels: bytes = b"\x00\x40\x80\xff",
        *,
        photometric: int = 1,
    ) -> None:
        width = 2
        height = 2
        entries = [
            (256, 4, 1, width),
            (257, 4, 1, height),
            (258, 3, 1, 8),
            (259, 3, 1, 1),
            (262, 3, 1, photometric),
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

    def write_test_mrc(self, path: Path, *, mode: int = 6) -> None:
        nx, ny, nz = 4, 3, 2
        header = bytearray(1024)
        struct.pack_into("<4i", header, 0, nx, ny, nz, mode)
        struct.pack_into("<3i", header, 28, nx, ny, nz)
        struct.pack_into("<3f", header, 40, 80.0, 60.0, 100.0)
        header[208:212] = b"MAP "
        if mode == 6:
            payload = struct.pack("<24H", *range(24))
        elif mode == 1:
            payload = struct.pack("<24h", *range(-12, 12))
        elif mode == 2:
            payload = struct.pack("<24f", *(float(value) for value in range(24)))
        else:
            payload = bytes(range(24))
        path.write_bytes(bytes(header) + payload)

    def write_manual_workset(
        self,
        base: Path,
        source_path: Path,
        *,
        source_format: str,
        dtype: str,
        dimensions: dict[str, int],
        asset_id: str = "fixture-asset",
    ) -> Path:
        workset_dir = base / "workset"
        workset_dir.mkdir()
        digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
        workset = {
            "schema": "cell-anatomy-archive-workset",
            "schema_version": 1,
            "workset_id": "fixture-workset",
            "title": "Fixture Workset",
            "source_registry": {
                "registry_id": "fixture-registry",
                "archive_id": "fixture-archive",
                "archive_root": str(source_path.parent),
            },
        }
        asset = {
            "schema": "cell-anatomy-archive-workset-asset",
            "schema_version": 1,
            "asset_id": asset_id,
            "registry_id": "fixture-registry",
            "archive_id": "fixture-archive",
            "relative_path": source_path.name,
            "path_type": "file",
            "size_bytes": source_path.stat().st_size,
            "source": {"root": str(source_path.parent), "relative_path": source_path.name},
            "checksum": {"algorithm": "sha256", "digest": digest},
            "metadata": {
                "status": "readable",
                "format": source_format,
                "dtype": dtype,
                "dimensions": dimensions,
                "voxel_size_nm": {"x": 2.0, "y": 2.0, "z": 5.0, "source": "fixture"},
            },
            "status": {"allowed_operations": {"can_convert": True}},
            "readiness": {"metadata_ready": True, "conversion_ready": True, "blockers": []},
            "review": {"recommended_actions": []},
            "promotion": {"blocked_operations": [], "intended_operations": ["convert"]},
        }
        (workset_dir / "workset.json").write_text(json.dumps(workset))
        (workset_dir / "workset-assets.jsonl").write_text(json.dumps(asset) + "\n")
        return workset_dir

    def test_tiff_conversion_is_immutable_valid_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            source = base / "cell.tif"
            self.write_test_tiff(source)
            workset = self.write_manual_workset(
                base,
                source,
                source_format="TIFF",
                dtype="uint8",
                dimensions={"x": 2, "y": 2, "z": 1},
            )

            first = factory.convert_workset_asset(workset, asset_id="fixture-asset", chunk_shape=(1, 2, 2))
            second = factory.convert_workset_asset(workset, asset_id="fixture-asset", chunk_shape=(1, 2, 2))

            output = Path(first["output_path"])
            self.assertEqual(first["validation"]["status"], "passed")
            self.assertFalse(first["reused"])
            self.assertTrue(second["reused"])
            self.assertEqual((output / "0" / "0.0.0").read_bytes(), b"\x00\x40\x80\xff")
            self.assertEqual(json.loads((output / "0" / ".zarray").read_text())["dtype"], "|u1")
            self.assertTrue((output / "caos-provenance.json").exists())
            self.assertFalse(any(path.name.endswith(".inprogress") for path in (workset / "derivatives").iterdir()))
            manifest = json.loads((workset / "workset-derivatives.json").read_text())
            self.assertEqual(len(manifest["derivatives"]), 1)
            with self.assertRaisesRegex(ValueError, "asset_derivative_recipe_already_registered"):
                factory.convert_workset_asset(workset, asset_id="fixture-asset", chunk_shape=(1, 1, 1))
            (output / "0" / "0.0.0").write_bytes(b"\xff\x40\x80\xff")
            with self.assertRaisesRegex(ValueError, "existing_derivative_checksum_mismatch"):
                factory.convert_workset_asset(workset, asset_id="fixture-asset", chunk_shape=(1, 2, 2))

    def test_mrc_conversion_resumes_completed_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            source = base / "cell.mrc"
            self.write_test_mrc(source)
            workset = self.write_manual_workset(
                base,
                source,
                source_format="MRC",
                dtype="uint16",
                dimensions={"x": 4, "y": 3, "z": 2},
            )
            original_reader = factory.source_reader
            shape, dtype, transform, read_plane = original_reader("MRC", source)
            reads = 0

            def interrupted_plane(index: int) -> bytes:
                nonlocal reads
                reads += 1
                if reads > 1:
                    raise OSError("simulated interruption")
                return read_plane(index)

            with patch.object(factory, "source_reader", return_value=(shape, dtype, transform, interrupted_plane)):
                with self.assertRaises(OSError):
                    factory.convert_workset_asset(workset, asset_id="fixture-asset", chunk_shape=(1, 3, 4))

            staging = next((workset / "derivatives").glob("*.inprogress"))
            checkpoint = json.loads((staging / ".conversion-checkpoint.json").read_text())
            self.assertEqual(len(checkpoint["completed_chunks"]), 1)
            self.assertEqual(len(checkpoint["completed_chunk_sha256"]), 1)
            completed_chunk = staging / "0" / checkpoint["completed_chunks"][0]
            completed_chunk.write_bytes(b"\xff" * completed_chunk.stat().st_size)

            result = factory.convert_workset_asset(workset, asset_id="fixture-asset", chunk_shape=(1, 3, 4))
            self.assertEqual(result["validation"]["status"], "passed")
            self.assertEqual(result["resume"]["reused"], 0)
            self.assertEqual(result["resume"]["written"], 2)
            self.assertEqual(result["value_transform"]["kind"], "identity")
            self.assertFalse(staging.exists())

    def test_white_is_zero_tiff_is_reversibly_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            source = base / "cell.tif"
            self.write_test_tiff(source, photometric=0)
            workset = self.write_manual_workset(
                base,
                source,
                source_format="TIFF",
                dtype="uint8",
                dimensions={"x": 2, "y": 2, "z": 1},
            )
            result = factory.convert_workset_asset(
                workset,
                asset_id="fixture-asset",
                chunk_shape=(1, 2, 2),
            )
            chunk = Path(result["output_path"]) / "0" / "0.0.0"
            self.assertEqual(chunk.read_bytes(), b"\xff\xbf\x7f\x00")
            self.assertEqual(result["value_transform"]["kind"], "unsigned_inversion")
            self.assertTrue(result["value_transform"]["reversible"])

    def test_signed_mrc_is_reversibly_offset_and_float_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            signed = base / "signed.mrc"
            self.write_test_mrc(signed, mode=1)
            signed_workset = self.write_manual_workset(
                base,
                signed,
                source_format="MRC",
                dtype="int16",
                dimensions={"x": 4, "y": 3, "z": 2},
            )
            result = factory.convert_workset_asset(signed_workset, asset_id="fixture-asset", chunk_shape=(1, 3, 4))
            self.assertEqual(result["value_transform"]["offset"], 32768)
            self.assertTrue(result["value_transform"]["reversible"])

        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            float_mrc = base / "float.mrc"
            self.write_test_mrc(float_mrc, mode=2)
            float_workset = self.write_manual_workset(
                base,
                float_mrc,
                source_format="MRC",
                dtype="float32",
                dimensions={"x": 4, "y": 3, "z": 2},
            )
            with self.assertRaisesRegex(ValueError, "unsupported_mrc_float32"):
                factory.convert_workset_asset(float_workset, asset_id="fixture-asset", chunk_shape=(1, 3, 4))

    def test_source_checksum_drift_is_rejected_before_conversion(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            source = base / "cell.tif"
            self.write_test_tiff(source)
            workset = self.write_manual_workset(
                base,
                source,
                source_format="TIFF",
                dtype="uint8",
                dimensions={"x": 2, "y": 2, "z": 1},
            )
            source.write_bytes(source.read_bytes()[:-1] + b"\x01")
            with self.assertRaisesRegex(ValueError, "source_sha256_mismatch"):
                factory.convert_workset_asset(workset, asset_id="fixture-asset")
            self.assertFalse((workset / "derivatives").exists())

    def test_source_identity_drift_during_conversion_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            source = base / "cell.tif"
            self.write_test_tiff(source)
            workset = self.write_manual_workset(
                base,
                source,
                source_format="TIFF",
                dtype="uint8",
                dimensions={"x": 2, "y": 2, "z": 1},
            )
            shape, dtype, transform, read_plane = factory.source_reader("TIFF", source)

            def mutating_plane(index: int) -> bytes:
                raw = read_plane(index)
                payload = source.read_bytes()
                source.write_bytes(payload[:-1] + bytes([payload[-1] ^ 0x01]))
                return raw

            with patch.object(factory, "source_reader", return_value=(shape, dtype, transform, mutating_plane)):
                with self.assertRaisesRegex(ValueError, "source_changed_during_conversion"):
                    factory.convert_workset_asset(workset, asset_id="fixture-asset", chunk_shape=(1, 2, 2))
            self.assertFalse((workset / "workset-derivatives.json").exists())

    def test_hdf5_has_a_typed_real_fixture_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            source = base / "cell.h5"
            source.write_bytes(b"\x89HDF\r\n\x1a\n")
            workset = self.write_manual_workset(
                base,
                source,
                source_format="HDF5",
                dtype="uint16",
                dimensions={"x": 2, "y": 2, "z": 2},
            )
            with self.assertRaisesRegex(ValueError, "hdf5_layout_pending_real_archive_fixture"):
                factory.convert_workset_asset(workset, asset_id="fixture-asset")

    def test_golden_archive_runs_scan_registry_promotion_conversion_and_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            archive = base / "archive"
            scan_dir = base / "scan"
            registry_dir = base / "registry"
            curated_dir = base / "curated"
            workset_dir = base / "workset"
            (archive / "raw").mkdir(parents=True)
            self.write_test_mrc(archive / "raw" / "candidate.mrc")

            scanner.scan_archive(archive, scan_dir, archive_id="golden-archive", checksum_algorithm="sha256")
            registry.build_private_registry(scan_dir, registry_dir, registry_id="golden-registry")
            overlay = base / "status-overlay.csv"
            with overlay.open("w", newline="") as output:
                writer = csv.DictWriter(
                    output,
                    fieldnames=[
                        "relative_path",
                        "rights_status",
                        "triage_status",
                        "publication_status",
                        "blocked_states",
                        "review_required",
                        "can_view_in_caos",
                        "can_convert",
                    ],
                )
                writer.writeheader()
                writer.writerow(
                    {
                        "relative_path": "raw/candidate.mrc",
                        "rights_status": "internal_use",
                        "triage_status": "candidate",
                        "publication_status": "unpublished",
                        "blocked_states": "none",
                        "review_required": "false",
                        "can_view_in_caos": "true",
                        "can_convert": "true",
                    }
                )
            registry.apply_status_overlay(registry_dir, overlay, curated_dir, registry_id="golden-curated")
            workset = registry.build_workset(
                curated_dir,
                workset_dir,
                registry.WorksetSelection(
                    workset_id="golden-pilot",
                    title="Golden Pilot",
                    path_prefixes=["raw/candidate.mrc"],
                    intended_operations=["inspect", "convert"],
                ),
            )
            self.assertEqual(workset["summary"]["conversion_ready_count"], 1)

            result = factory.convert_workset_asset(
                workset_dir,
                relative_path="raw/candidate.mrc",
                chunk_shape=(1, 3, 4),
            )
            queue = factory.queue_payload(workset_dir)

            self.assertEqual(result["validation"]["status"], "passed")
            self.assertEqual(result["source_sha256"], hashlib.sha256((archive / "raw" / "candidate.mrc").read_bytes()).hexdigest())
            self.assertEqual(result["archiveStatus"]["assetId"], result["asset_id"])
            self.assertEqual(result["archiveStatus"]["worksetId"], "golden-pilot")
            self.assertEqual(
                queue["datasets"][0]["slug"],
                "private-workset:golden-archive:golden-pilot",
            )
            self.assertEqual(queue["datasets"][0]["assets"][0]["index_status"], "indexed")
            self.assertIsNone(queue["datasets"][0]["assets"][0]["convert_command"])
            self.assertTrue(Path(result["output_path"]).is_dir())


if __name__ == "__main__":
    unittest.main()
