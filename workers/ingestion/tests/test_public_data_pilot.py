from __future__ import annotations

import csv
import gzip
import importlib.util
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "public_data_pilot.py"
SPEC = importlib.util.spec_from_file_location("public_data_pilot", MODULE_PATH)
assert SPEC and SPEC.loader
pilot = importlib.util.module_from_spec(SPEC)
sys.modules["public_data_pilot"] = pilot
SPEC.loader.exec_module(pilot)


class PublicDataPilotTests(unittest.TestCase):
    def write_test_mrc(self, path: Path) -> None:
        header = bytearray(1024)
        struct.pack_into("<4i", header, 0, 2, 2, 3, 1)
        header[208:212] = b"MAP "
        planes = [
            [0, 10, 20, 30],
            [30, 20, 10, 0],
            [0, 0, 100, 400],
        ]
        payload = b"".join(struct.pack("<4h", *plane) for plane in planes)
        path.write_bytes(bytes(header) + payload)

    def test_offline_metadata_uses_cached_api_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            metadata_dir = Path(temp_dir)
            (metadata_dir / "empiar-1-api.json").write_text(json.dumps({"EMPIAR-1": {"title": "cached"}}))
            with (metadata_dir / "download-manifest.tsv").open("w", newline="") as output:
                writer = csv.DictWriter(output, fieldnames=["relative_path", "url"], delimiter="\t")
                writer.writeheader()
                writer.writerow({"relative_path": "data/example.tif", "url": "https://example.test/example.tif"})

            api_data, remote_files = pilot.fetch_empiar_metadata("1", metadata_dir, refresh=True, offline=True)

        self.assertEqual(api_data["EMPIAR-1"]["title"], "cached")
        self.assertEqual(remote_files, [pilot.RemoteFile("data/example.tif", "https://example.test/example.tif")])

    def test_tiff_imagej_scale_is_available_when_api_scale_is_missing(self) -> None:
        row = {
            "relative_path": "cell.tif",
            "format": "TIFF",
            "size_bytes": 10,
            "sha256": "abc",
            "tiff_width": 4,
            "tiff_height": 3,
            "tiff_slices": 2,
            "tiff_pixel_x_nm": "20",
            "tiff_pixel_y_nm": "20",
            "tiff_pixel_z_nm": "10",
            "api_details": "",
        }
        api_data = {"EMPIAR-1": {"title": "test", "citation": [{"details": ""}]}}

        manifest = pilot.build_normalized_manifest(api_data, "1", [row], Path("download-manifest.tsv"))

        scale = manifest["assets"][0]["physical_voxel_size_nm"]
        self.assertEqual(scale, {"x": 20.0, "y": 20.0, "z": 10.0, "source": "tiff_imagej_metadata"})

    def test_curated_asset_scale_wins_over_header_scale(self) -> None:
        row = {
            "relative_path": "cell.mrc",
            "format": "MRC",
            "size_bytes": 10,
            "sha256": "abc",
            "mrc_nx": 4,
            "mrc_ny": 3,
            "mrc_nz": 2,
            "mrc_voxel_x_nm": "0.1",
            "mrc_voxel_y_nm": "0.1",
            "mrc_voxel_z_nm": "0.1",
            "api_details": "Voxels are 10nm x 10nm x 20nm.",
        }
        api_data = {"EMPIAR-1": {"title": "test", "citation": [{"details": ""}]}}

        manifest = pilot.build_normalized_manifest(api_data, "1", [row], Path("download-manifest.tsv"))

        scale = manifest["assets"][0]["physical_voxel_size_nm"]
        self.assertEqual(scale, {"x": 10.0, "y": 10.0, "z": 20.0, "source": "asset_api_details"})
        header_scale = manifest["assets"][0]["header_voxel_size_nm"]
        self.assertEqual(header_scale, {"x": "0.1", "y": "0.1", "z": "0.1", "source": "mrc_header"})

    def test_validation_flags_default_mrc_physical_scale(self) -> None:
        row = {
            "relative_path": "cell.mrc",
            "format": "MRC",
            "size_bytes": 10,
            "mrc_map": "MAP ",
            "mrc_nx": 4,
            "mrc_ny": 3,
            "mrc_nz": 2,
            "mrc_mx": 4,
            "mrc_my": 3,
            "mrc_mz": 2,
            "mrc_cella_x_a": "4",
            "mrc_voxel_x_nm": "0.1",
            "mrc_voxel_y_nm": "0.1",
            "mrc_voxel_z_nm": "0.1",
        }

        report = pilot.validate_manifest({"EMPIAR-1": {}}, "1", [row], [])

        self.assertTrue(
            any("header physical scale is likely default" in warning for warning in report["warnings"]),
            report["warnings"],
        )

    def test_validation_flags_collection_level_imageset_counts(self) -> None:
        rows = [
            {
                "relative_path": "a.tif",
                "format": "TIFF",
                "size_bytes": 10,
                "api_name": "collection",
                "api_num_images": "500",
                "tiff_slices": "100",
                "tiff_pixel_x_nm": "20",
                "tiff_pixel_y_nm": "20",
            },
            {
                "relative_path": "b.tif",
                "format": "TIFF",
                "size_bytes": 10,
                "api_name": "collection",
                "api_num_images": "500",
                "tiff_slices": "101",
                "tiff_pixel_x_nm": "20",
                "tiff_pixel_y_nm": "20",
            },
        ]

        report = pilot.validate_manifest({"EMPIAR-1": {}}, "1", rows, [])

        self.assertTrue(
            any("collection-level metadata" in warning for warning in report["warnings"]),
            report["warnings"],
        )

    def test_imagej_resolution_to_nm_scale(self) -> None:
        imagej = {"unit": "nm", "spacing": "20"}

        scale = pilot.tiff_scale_nm((1, 20), (1, 20), 1, imagej)

        self.assertEqual(scale, (20.0, 20.0, 20.0))

    def test_asset_state_manifest_marks_clean_assets_validated(self) -> None:
        normalized = {
            "source": "EMPIAR",
            "entry_id": "1",
            "entry_doi": "10.6019/EMPIAR-1",
            "title": "test",
            "dataset_size": "1 KB",
            "experiment_type": "FIB-SEM",
            "assets": [
                {
                    "relative_path": "cell.tif",
                    "format": "TIFF",
                    "size_bytes": 10,
                    "sha256": "abc",
                    "dimensions": {"x": 4, "y": 3, "z": 2},
                    "physical_voxel_size_nm": {"x": 20.0, "y": 20.0, "z": 10.0, "source": "tiff_imagej_metadata"},
                    "header_voxel_size_nm": {"x": "", "y": "", "z": "", "source": ""},
                }
            ],
        }
        inventory_rows = [{"relative_path": "cell.tif", "format": "TIFF"}]
        previews = [pilot.PreviewRecord("cell.tif", "TIFF", "/tmp/preview.png", 4, 3, 2, "uint8", 1)]
        remotes = [pilot.RemoteFile("cell.tif", "https://example.test/cell.tif")]

        manifest = pilot.build_asset_state_manifest(Path("/tmp/scion-data"), normalized, inventory_rows, remotes, previews)

        asset = manifest["assets"][0]
        self.assertEqual(asset["source_asset"]["state"], "indexed")
        self.assertEqual(asset["mirrored_asset"]["state"], "mirrored")
        self.assertEqual(asset["validated_volume"]["state"], "validated")
        self.assertEqual(asset["streamable_derivative"]["state"], "not_started")

    def test_curated_scale_makes_default_mrc_header_warning_nonblocking(self) -> None:
        normalized = {
            "source": "EMPIAR",
            "entry_id": "1",
            "entry_doi": "10.6019/EMPIAR-1",
            "title": "test",
            "dataset_size": "1 KB",
            "experiment_type": "FIB-SEM",
            "assets": [
                {
                    "relative_path": "cell.mrc",
                    "format": "MRC",
                    "size_bytes": 10,
                    "sha256": "abc",
                    "dimensions": {"x": 4, "y": 3, "z": 2},
                    "physical_voxel_size_nm": {"x": 10.0, "y": 10.0, "z": 20.0, "source": "asset_api_details"},
                    "header_voxel_size_nm": {"x": "0.1", "y": "0.1", "z": "0.1", "source": "mrc_header"},
                }
            ],
        }
        inventory_rows = [
            {
                "relative_path": "cell.mrc",
                "format": "MRC",
                "mrc_nx": 4,
                "mrc_mx": 4,
                "mrc_cella_x_a": "4",
            }
        ]
        previews = [pilot.PreviewRecord("cell.mrc", "MRC", "/tmp/preview.png", 4, 3, 2, 1, 1)]
        remotes = [pilot.RemoteFile("cell.mrc", "https://example.test/cell.mrc")]

        manifest = pilot.build_asset_state_manifest(Path("/tmp/scion-data"), normalized, inventory_rows, remotes, previews)

        volume = manifest["assets"][0]["validated_volume"]
        self.assertEqual(volume["state"], "validated")
        self.assertEqual(volume["blockers"], [])
        self.assertEqual(volume["review_notes"], ["mrc_header_physical_scale_likely_default"])

    def test_trakem2_calibration_extracts_nm_scale(self) -> None:
        xml = (
            '<trakem2><t2_calibration pixelWidth="0.0035" pixelHeight="0.0035" '
            'pixelDepth="0.07" unit="µm" /><t2_layer oid="1" thickness="20.0"></t2_layer></trakem2>'
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "cell.xml.gz"
            with gzip.open(path, "wt", encoding="latin-1") as output:
                output.write(xml)

            parsed = pilot.parse_trakem2_calibration(path)

        self.assertEqual(parsed["pixel_x_nm"], "3.5")
        self.assertEqual(parsed["pixel_y_nm"], "3.5")
        self.assertEqual(parsed["pixel_z_nm"], "70")
        self.assertEqual(parsed["z_source"], "trakem2_calibration")

    def test_trakem2_layer_thickness_resolves_equal_xy_z_calibration(self) -> None:
        xml = (
            '<trakem2><t2_calibration pixelWidth="0.002584214995670485" '
            'pixelHeight="0.002584214995670485" pixelDepth="0.002584214995670485" unit="µm" />'
            '<t2_layer oid="1" thickness="30.957176606894006"></t2_layer></trakem2>'
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "cell.xml.gz"
            with gzip.open(path, "wt", encoding="latin-1") as output:
                output.write(xml)

            parsed = pilot.parse_trakem2_calibration(path)

        self.assertEqual(parsed["pixel_x_nm"], "2.58421")
        self.assertEqual(parsed["raw_pixel_z_nm"], "2.58421")
        self.assertEqual(parsed["pixel_z_nm"], "80")
        self.assertEqual(parsed["layer_thickness"], "30.9572")
        self.assertEqual(parsed["z_source"], "trakem2_calibration_times_layer_thickness")

    def test_figshare_manifest_can_use_trakem2_scale(self) -> None:
        row = {
            "relative_path": "cell.tif",
            "format": "TIFF",
            "size_bytes": 10,
            "sha256": "abc",
            "tiff_width": 4,
            "tiff_height": 3,
            "tiff_slices": 2,
            "trakem2_pixel_x_nm": "3.5",
            "trakem2_pixel_y_nm": "3.5",
            "trakem2_pixel_z_nm": "70",
            "trakem2_z_source": "trakem2_calibration",
            "api_details": "",
        }
        article_data = {"title": "test", "doi": "10.6084/test", "files": [], "published_date": "2019-01-01T00:00:00Z"}

        manifest = pilot.build_normalized_figshare_manifest(article_data, "1", [row], Path("download-manifest.tsv"))

        scale = manifest["assets"][0]["physical_voxel_size_nm"]
        self.assertEqual(scale, {"x": 3.5, "y": 3.5, "z": 70.0, "source": "trakem2_calibration"})

    def test_trakem2_suspicious_z_spacing_is_warned(self) -> None:
        row = {
            "relative_path": "cell.tif",
            "format": "TIFF",
            "size_bytes": 10,
            "trakem2_pixel_z_nm": "15",
        }

        warning = pilot.trakem2_z_spacing_warning(row)

        self.assertEqual(warning, "trakem2_z_spacing_suspicious:15nm")

    def test_conversion_readiness_splits_ready_blocked_and_sidecars(self) -> None:
        root = Path("/tmp/scion-pilot")
        manifest = {
            "pipeline_version": "test",
            "dataset": {"source": "Figshare", "entry_id": "1", "title": "test"},
            "assets": [
                {
                    "mirrored_asset": {
                        "local_path": str(root / "data" / "ready.tif"),
                        "format": "TIFF",
                        "size_bytes": 10,
                        "sha256": "a",
                    },
                    "validated_volume": {
                        "state": "validated",
                        "dimensions": {"x": 4, "y": 3, "z": 2},
                        "physical_voxel_size_nm": {"x": 1, "y": 1, "z": 10, "source": "test"},
                        "preview_path": "/tmp/ready.png",
                        "warnings": [],
                    },
                },
                {
                    "mirrored_asset": {
                        "local_path": str(root / "data" / "blocked.tif"),
                        "format": "TIFF",
                        "size_bytes": 20,
                        "sha256": "b",
                    },
                    "validated_volume": {
                        "state": "needs_review",
                        "dimensions": {"x": 4, "y": 3, "z": 2},
                        "physical_voxel_size_nm": {"x": 1, "y": 1, "z": "", "source": ""},
                        "preview_path": "",
                        "warnings": ["missing_fixture_warning"],
                    },
                },
                {
                    "mirrored_asset": {
                        "local_path": str(root / "data" / "sidecar.xml.gz"),
                        "format": "GZIP",
                        "size_bytes": 5,
                        "sha256": "c",
                    },
                    "validated_volume": {
                        "state": "not_applicable",
                        "dimensions": {"x": "", "y": "", "z": ""},
                        "physical_voxel_size_nm": {"x": "", "y": "", "z": "", "source": ""},
                        "preview_path": "",
                        "warnings": [],
                    },
                },
            ],
        }

        readiness = pilot.build_conversion_readiness_manifest(root, manifest)

        self.assertEqual(readiness["summary"]["ready_assets"], 1)
        self.assertEqual(readiness["summary"]["blocked_assets"], 1)
        self.assertEqual(readiness["summary"]["sidecar_assets"], 1)
        self.assertEqual(readiness["ready_assets"][0]["relative_path"], "ready.tif")
        self.assertIn("missing_physical_voxel_size", readiness["blocked_assets"][0]["blockers"])
        self.assertIn("missing_preview", readiness["blocked_assets"][0]["blockers"])

    def test_write_pilot_index_builds_readiness_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset = root / "example"
            metadata = dataset / "metadata"
            metadata.mkdir(parents=True)
            (dataset / "derived").mkdir()
            asset_state = {
                "pipeline_version": "test",
                "dataset": {"source": "EMPIAR", "entry_id": "1", "title": "test", "dataset_size": "1 KB"},
                "assets": [
                    {
                        "mirrored_asset": {
                            "local_path": str(dataset / "data" / "cell.tif"),
                            "format": "TIFF",
                            "size_bytes": 10,
                            "sha256": "abc",
                        },
                        "validated_volume": {
                            "state": "validated",
                            "dimensions": {"x": 4, "y": 3, "z": 2},
                            "physical_voxel_size_nm": {"x": 1, "y": 1, "z": 10, "source": "test"},
                            "preview_path": str(dataset / "derived" / "cell.png"),
                            "warnings": [],
                        },
                    }
                ],
            }
            report = {"file_count": 1, "total_gib": 0.001, "warnings": [], "preview_count": 1, "formats": ["TIFF"]}
            (metadata / "asset-state-manifest.json").write_text(json.dumps(asset_state))
            (metadata / "validation-report.json").write_text(json.dumps(report))

            json_path, html_path = pilot.write_pilot_index(root)

            self.assertTrue(json_path.exists())
            self.assertTrue(html_path.exists())
            self.assertTrue((metadata / "conversion-readiness-manifest.json").exists())
            self.assertTrue((metadata / "curation-review-queue.tsv").exists())

    def test_parse_chunk_shape_requires_three_positive_axes(self) -> None:
        self.assertEqual(pilot.parse_chunk_shape("4,64,128"), (4, 64, 128))
        with self.assertRaises(ValueError):
            pilot.parse_chunk_shape("4,64")
        with self.assertRaises(ValueError):
            pilot.parse_chunk_shape("4,0,64")

    def test_safe_derivative_name_removes_path_and_tiff_suffix(self) -> None:
        self.assertEqual(
            pilot.safe_derivative_name("Electron-microscopy-data/Symbiotic_cells/Symbiotic-cell&40plastids.tif"),
            "Electron-microscopy-data__Symbiotic_cells__Symbiotic-cell_40plastids",
        )

    def test_sample_slice_indices_preserves_bounds_when_sampling(self) -> None:
        self.assertEqual(pilot.sample_slice_indices(5, 10), [0, 1, 2, 3, 4])
        self.assertEqual(pilot.sample_slice_indices(10, 4), [0, 3, 6, 9])
        self.assertEqual(pilot.sample_slice_indices(10, 1), [5])
        self.assertEqual(pilot.sample_slice_indices(3, 2, all_slices=True), [0, 1, 2])

    def test_mrc_slice_reader_extracts_requested_plane(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "cell.mrc"
            self.write_test_mrc(path)

            image, width, height, depth, mode = pilot.mrc_slice_u8(path, 2)

        self.assertEqual((width, height, depth, mode), (2, 2, 3, 1))
        self.assertEqual(len(image), 4)

    def test_write_mrc_slice_cache_builds_manifest_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "data"
            data_dir.mkdir()
            source = data_dir / "cell.mrc"
            self.write_test_mrc(source)
            asset = {
                "relative_path": "cell.mrc",
                "size_bytes": source.stat().st_size,
                "sha256": "abc",
                "format": "MRC",
                "physical_voxel_size_nm": {"x": 10, "y": 10, "z": 20, "source": "test"},
            }

            cache = pilot.write_mrc_slice_cache(root, source, asset, max_slices=2, all_slices=False, max_width=10, max_height=10)

        self.assertEqual(cache["source_format"], "MRC")
        self.assertEqual(cache["source_dtype"], "int16")
        self.assertEqual(cache["source_shape_zyx"], [3, 2, 2])
        self.assertEqual(cache["sampling"]["cached_slices"], 2)
        self.assertEqual(len(cache["frames"]), 2)

    def test_select_slice_assets_can_include_mrc_and_tiff(self) -> None:
        readiness = {
            "ready_assets": [
                {"relative_path": "a.mrc", "format": "MRC", "size_bytes": 20},
                {"relative_path": "b.tif", "format": "TIFF", "size_bytes": 10},
                {"relative_path": "sidecar.xml.gz", "format": "GZIP", "size_bytes": 1},
            ]
        }

        selected = pilot.select_slice_assets(readiness, requested_asset=None, all_ready=True)

        self.assertEqual([asset["relative_path"] for asset in selected], ["a.mrc", "b.tif"])

    def test_update_slice_manifest_replaces_cache_for_same_asset(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "metadata").mkdir()

            first = {"source_relative_path": "cell.tif", "frames": [{"z_index": 0}]}
            second = {"source_relative_path": "cell.tif", "frames": [{"z_index": 1}]}
            manifest = pilot.update_slice_manifest(root, {"title": "test"}, first)
            pilot.write_slice_manifest(root, manifest)
            manifest = pilot.update_slice_manifest(root, {"title": "test"}, second)

        self.assertEqual(len(manifest["caches"]), 1)
        self.assertEqual(manifest["caches"][0]["frames"], [{"z_index": 1}])


if __name__ == "__main__":
    unittest.main()
