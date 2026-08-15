from __future__ import annotations

import importlib.util
import json
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


pipeline = load_module("segmentation_pipeline", "segmentation_pipeline.py")


class SegmentationPipelineTests(unittest.TestCase):
    def write_zarr(
        self,
        path: Path,
        values: list[int],
        *,
        shape: tuple[int, int, int] = (2, 3, 4),
        chunks: tuple[int, int, int] = (1, 2, 3),
        dtype: str = "|u1",
    ) -> None:
        path.mkdir()
        (path / "0").mkdir()
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
                                        {"type": "scale", "scale": [5.0, 2.0, 2.0]}
                                    ],
                                }
                            ],
                        }
                    ]
                }
            )
        )
        (path / "0" / ".zarray").write_text(
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
                    "dimension_separator": ".",
                }
            )
        )
        index = lambda z, y, x: z * shape[1] * shape[2] + y * shape[2] + x
        for name, bounds in pipeline.chunk_specs(shape, chunks):
            z0, z1, y0, y1, x0, x1 = bounds
            raw = bytes(
                values[index(z, y, x)]
                for z in range(z0, z1)
                for y in range(y0, y1)
                for x in range(x0, x1)
            )
            (path / "0" / name).write_bytes(raw)

    def read_labels(self, path: Path) -> list[int]:
        metadata = pipeline.load_zarr(path)
        result: list[int] = []
        shape = metadata["shape"]
        dense = [0] * (shape[0] * shape[1] * shape[2])
        for name, bounds in pipeline.chunk_specs(shape, metadata["chunks"]):
            z0, z1, y0, y1, x0, x1 = bounds
            raw = (metadata["array_dir"] / name).read_bytes()
            cursor = 0
            for z in range(z0, z1):
                for y in range(y0, y1):
                    for x in range(x0, x1):
                        dense[z * shape[1] * shape[2] + y * shape[2] + x] = raw[cursor]
                        cursor += 1
        result.extend(dense)
        return result

    def test_threshold_is_immutable_viewable_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            source = base / "cell.ome.zarr"
            values = list(range(24))
            self.write_zarr(source, values)

            first = pipeline.run_threshold_segmentation(
                source,
                task="cell",
                threshold=10,
                operator="ge",
                label_name="cell body",
            )
            second = pipeline.run_threshold_segmentation(
                source,
                task="cell",
                threshold=10,
                operator="ge",
                label_name="cell body",
            )

            output = Path(first["output_path"])
            self.assertEqual(first["validation"]["status"], "passed")
            self.assertEqual(first["qc"]["foreground_voxels"], 14)
            self.assertAlmostEqual(first["qc"]["foreground_fraction"], 14 / 24)
            self.assertEqual(first["qc"]["foreground_bbox_zyx_inclusive"], [0, 0, 0, 1, 2, 3])
            self.assertTrue(first["human_review_required"])
            self.assertFalse(first["validated_for_clinical_use"])
            self.assertEqual(self.read_labels(output), [0] * 10 + [1] * 14)
            self.assertTrue(second["reused"])
            manifest = json.loads(Path(first["manifest_path"]).read_text())
            self.assertEqual(manifest["schema"], "cell-anatomy-segmentation-manifest")
            self.assertEqual(len(manifest["segmentations"]), 1)
            self.assertEqual(manifest["segmentations"][0]["segmentation_id"], first["segmentation_id"])

    def test_threshold_resume_reuses_verified_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "tooth.ome.zarr"
            self.write_zarr(source, list(range(24)))
            original = pipeline.threshold_chunk
            calls = 0

            def interrupted(values, threshold, operator):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("fixture interruption")
                return original(values, threshold, operator)

            with patch.object(pipeline, "threshold_chunk", side_effect=interrupted):
                with self.assertRaisesRegex(OSError, "fixture interruption"):
                    pipeline.run_threshold_segmentation(source, task="tooth", threshold=12)

            staging = next(source.parent.glob(f"{source.name}.caos-segmentations/.*.inprogress"))
            checkpoint = json.loads((staging / ".segmentation-checkpoint.json").read_text())
            self.assertEqual(len(checkpoint["completed_chunk_sha256"]), 1)
            result = pipeline.run_threshold_segmentation(source, task="tooth", threshold=12)
            self.assertEqual(result["resume"]["reused"], 1)
            self.assertEqual(result["resume"]["total"], 8)

    def test_source_drift_invalidates_existing_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "cell.ome.zarr"
            self.write_zarr(source, list(range(24)))
            pipeline.run_threshold_segmentation(source, task="cell", threshold=10)
            chunk = source / "0" / "0.0.0"
            chunk.write_bytes(bytes([99]) + chunk.read_bytes()[1:])
            with self.assertRaisesRegex(ValueError, "existing_segmentation_source_checksum_mismatch"):
                pipeline.run_threshold_segmentation(source, task="cell", threshold=10)

    def test_degenerate_candidate_and_unsupported_compression_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "cell.ome.zarr"
            self.write_zarr(source, [0] * 24)
            with self.assertRaisesRegex(ValueError, "degenerate_segmentation_candidate"):
                pipeline.run_threshold_segmentation(source, task="cell", threshold=1)
            config_path = source / "0" / ".zarray"
            config = json.loads(config_path.read_text())
            config["compressor"] = {"id": "zlib"}
            config_path.write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError, "compressed_or_filtered_zarr_not_supported"):
                pipeline.run_threshold_segmentation(source, task="cell", threshold=1)

    def test_external_model_labels_enter_same_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            source = base / "jaw.ome.zarr"
            labels = base / "model.labels.zarr"
            self.write_zarr(source, list(range(24)))
            expected = [0] * 8 + [1] * 8 + [0] * 8
            self.write_zarr(labels, expected)
            result = pipeline.register_label_segmentation(
                source,
                labels,
                task="tooth",
                model_id="fixture-tooth-net",
                model_version="sha256:abc123",
                expected_source_sha256=pipeline.source_array_checksum(pipeline.load_zarr(source))["digest"],
                label_name="tooth",
            )
            self.assertEqual(result["method"], "external-model-labels-v1")
            self.assertEqual(result["model"]["id"], "fixture-tooth-net")
            self.assertEqual(result["qc"]["foreground_voxels"], 8)
            self.assertEqual(self.read_labels(Path(result["output_path"])), expected)
            with self.assertRaisesRegex(ValueError, "external_labels_source_checksum_mismatch"):
                pipeline.register_label_segmentation(
                    source,
                    labels,
                    task="tooth",
                    model_id="fixture-tooth-net",
                    model_version="sha256:def456",
                    expected_source_sha256="0" * 64,
                )

    def test_evaluation_emits_exact_metrics_and_acceptance_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            prediction = base / "prediction.labels.zarr"
            truth = base / "truth.labels.zarr"
            predicted_values = [0] * 7 + [1] * 8 + [0] * 9
            truth_values = [0] * 8 + [1] * 8 + [0] * 8
            self.write_zarr(prediction, predicted_values)
            self.write_zarr(truth, truth_values)

            report = pipeline.evaluate_segmentation(
                prediction,
                truth,
                truth_id="annotated-case-001-v1",
                min_dice=0.8,
                min_iou=0.7,
                min_recall=0.8,
                max_false_positive_rate=0.1,
            )
            self.assertEqual(
                report["confusion"],
                {
                    "true_positive": 7,
                    "false_positive": 1,
                    "false_negative": 1,
                    "true_negative": 15,
                },
            )
            self.assertAlmostEqual(report["metrics"]["dice"], 0.875)
            self.assertAlmostEqual(report["metrics"]["iou"], 7 / 9)
            self.assertAlmostEqual(report["metrics"]["recall"], 0.875)
            self.assertAlmostEqual(report["metrics"]["false_positive_rate"], 1 / 16)
            self.assertEqual(report["acceptance_gate"]["status"], "passed")
            self.assertTrue(report["promotion"]["eligible_from_this_evaluation"])
            self.assertTrue(Path(report["output_path"]).is_file())

            failed_gate = pipeline.evaluate_segmentation(
                prediction,
                truth,
                truth_id="annotated-case-001-v1",
                min_dice=0.9,
            )
            self.assertEqual(failed_gate["acceptance_gate"]["status"], "failed")
            self.assertFalse(failed_gate["promotion"]["eligible_from_this_evaluation"])


if __name__ == "__main__":
    unittest.main()
