import assert from "node:assert/strict";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, "..");
const tempRoot = join(desktopRoot, ".tmp");
const tempDir = join(tempRoot, "caos-project-tests");
const sourcePath = join(desktopRoot, "src", "caos-project.ts");
const outputPath = join(tempDir, "caos-project.mjs");

await rm(tempDir, { force: true, recursive: true });
await mkdir(tempDir, { recursive: true });

const source = await readFile(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: sourcePath,
});

await writeFile(outputPath, transpiled.outputText);

const caos = await import(pathToFileURL(outputPath).href);
await rm(tempDir, { force: true, recursive: true });
await rmdir(tempRoot).catch(() => undefined);

const clone = (value) => JSON.parse(JSON.stringify(value));

const derivative = {
  source_relative_path: "volumes/sample.ome.zarr",
  source_local_path: "/data/source/sample.ome.zarr",
  source_sha256: "f".repeat(64),
  source_size_bytes: 4096,
  output_path: "/data/derived/sample.ome.zarr",
  format: "ome-zarr",
  ome_ngff_version: "0.4",
  zarr_format: 2,
  array_path: "0",
  shape_zyx: [6, 5, 4],
  chunks_zyx: [3, 2, 2],
  dtype: "uint16",
  byte_size: 4096,
  physical_voxel_size_nm: { x: 8, y: 8, z: 30, source: "test" },
  validation: { status: "ready", summary: "Fixture volume." },
  archiveStatus: {
    registryId: "fixture-registry",
    assetId: "fixture-asset",
    archiveId: "fixture-archive",
    relativePath: "volumes/sample.ome.zarr",
    worksetId: "fixture-workset",
    worksetTitle: "Fixture Workset",
    assetStatus: "discovered",
    fixityStatus: "checksummed",
    publicationStatus: "unknown",
    triageStatus: "unknown",
    rightsStatus: "unknown",
    classificationStatus: "unreviewed",
    reviewRequired: true,
    blockers: ["blocked_permission"],
    metadataGapCodes: ["missing_voxel_size"],
    allowedOperations: {
      can_store_locally: true,
      can_backup_to_cloud: false,
      can_convert: false,
      can_view_in_caos: false,
    },
  },
};

const dataset = {
  slug: "fixture-dataset",
  title: "Fixture Dataset",
  source: "Fixture",
  entryId: "FX-1",
  experimentType: "Whole Cell",
  derivatives: [derivative],
  findings: [],
};

const view = {
  mode: "orthogonal",
  axis: "z",
  slice: 2,
  xSlice: 3,
  ySlice: 2,
  zSlice: 1,
  minContrast: 0,
  maxContrast: 4095,
  colormap: 1,
  logScale: false,
  downsample: 4,
  pitch: 0.25,
  yaw: 0.5,
  alphaScale: 0.15,
};

const measurement = {
  id: "measurement_1",
  label: "M1",
  note: "Fixture measurement.",
  datasetSlug: dataset.slug,
  assetPath: derivative.source_relative_path,
  axis: "z",
  slice: 2,
  start: { x: 0, y: 1, z: 2 },
  end: { x: 3, y: 4, z: 2 },
  distanceUm: 0.041,
  createdAt: "2026-06-04T12:00:00.000Z",
};

const roi = {
  id: "roi_1",
  label: "R1",
  kind: "box",
  category: "mitochondria",
  datasetSlug: dataset.slug,
  assetPath: derivative.source_relative_path,
  axis: "z",
  slice: 2,
  start: { x: 0, y: 1, z: 2 },
  end: { x: 3, y: 4, z: 2 },
  color: "rgba(31, 111, 135, 0.96)",
  createdAt: "2026-06-04T12:01:00.000Z",
  note: "Fixture ROI.",
};

const job = {
  id: "job_1",
  datasetSlug: dataset.slug,
  assetPath: derivative.source_relative_path,
  title: "Project Audit",
  kind: "project-audit",
  status: "completed",
  createdAt: "2026-06-04T12:02:00.000Z",
  summary: "Fixture audit.",
  result: {
    dataset: dataset.slug,
    measurements: 1,
    rois: 1,
  },
};

const buildFixtureSnapshot = () =>
  caos.buildCaosProjectSnapshot({
    projectName: "Fixture Project",
    projectNote: "Validated fixture.",
    dataset,
    derivative,
    view,
    measurements: [measurement],
    rois: [roi],
    jobs: [job],
    exports: [{ exportedAt: "2026-06-04T12:03:00.000Z", view }],
    existingProjectId: "project_fixture",
    createdAt: "2026-06-04T11:59:00.000Z",
  });

test("CAOS project snapshot builds, serializes, parses, and preserves core state", () => {
  const snapshot = buildFixtureSnapshot();
  const serialized = caos.serializeCaosProjectSnapshot(snapshot);
  const parsed = caos.parseCaosProjectSnapshot(serialized);

  assert.equal(parsed.schema, caos.CAOS_PROJECT_SCHEMA);
  assert.equal(parsed.schemaVersion, caos.CAOS_PROJECT_SCHEMA_VERSION);
  assert.equal(parsed.project.id, "project_fixture");
  assert.equal(parsed.volumes[0].sourceSha256, derivative.source_sha256);
  assert.equal(parsed.volumes[0].sourceSizeBytes, derivative.source_size_bytes);
  assert.equal(parsed.volumes[0].archiveStatus.registryId, "fixture-registry");
  assert.equal(parsed.volumes[0].archiveStatus.worksetId, "fixture-workset");
  assert.equal(parsed.volumes[0].archiveStatus.worksetTitle, "Fixture Workset");
  assert.equal(parsed.volumes[0].archiveStatus.rightsStatus, "unknown");
  assert.deepEqual(parsed.volumes[0].archiveStatus.blockers, ["blocked_permission"]);
  assert.equal(parsed.measurements[0].id, measurement.id);
  assert.equal(parsed.rois[0].id, roi.id);
  assert.equal(parsed.jobs[0].id, job.id);
  assert.deepEqual(parsed.active.view, view);
  assert.ok(parsed.integrity.volumeFingerprints.includes(parsed.integrity.activeVolumeFingerprint));
});

test("CAOS validation rejects active volume fingerprint drift", () => {
  const tampered = clone(buildFixtureSnapshot());
  tampered.volumes[0].shapeZyx = [9, 5, 4];

  assert.throws(
    () => caos.validateCaosProjectSnapshot(tampered),
    /activeVolumeFingerprint does not match/
  );
});

test("CAOS archive status does not affect source volume fingerprint", () => {
  const first = buildFixtureSnapshot();
  const second = clone(first);
  second.volumes[0].archiveStatus.rightsStatus = "restricted";
  second.volumes[0].archiveStatus.blockers = ["blocked_permission", "blocked_quality"];

  assert.equal(first.integrity.activeVolumeFingerprint, second.integrity.activeVolumeFingerprint);
  assert.doesNotThrow(() => caos.validateCaosProjectSnapshot(second));
});

test("CAOS validation rejects out-of-bounds measurement coordinates", () => {
  const tampered = clone(buildFixtureSnapshot());
  tampered.measurements[0].start.x = 99;

  assert.throws(
    () => caos.validateCaosProjectSnapshot(tampered),
    /measurements\[0\]\.start\.x is outside/
  );
});

test("CAOS validation rejects unsupported schema versions", () => {
  const tampered = clone(buildFixtureSnapshot());
  tampered.schemaVersion = 999;

  assert.throws(
    () => caos.validateCaosProjectSnapshot(tampered),
    /Unsupported project schema version/
  );
});

test("CAOS stable signature ignores generated timestamps but detects state changes", () => {
  const first = clone(buildFixtureSnapshot());
  const second = clone(first);
  second.project.updatedAt = "2026-06-04T13:00:00.000Z";
  second.integrity.generatedAt = "2026-06-04T13:00:00.000Z";
  second.notes[0].id = "note_later";
  second.notes[0].updatedAt = "2026-06-04T13:00:00.000Z";

  assert.equal(caos.caosProjectStableSignature(first), caos.caosProjectStableSignature(second));

  second.active.view.xSlice = 2;
  assert.notEqual(caos.caosProjectStableSignature(first), caos.caosProjectStableSignature(second));
});

test("CAOS build preserves scoped notes and updates the editable project note in place", () => {
  const existingNotes = [
    {
      id: "view_note_1",
      scope: "view",
      text: "Keep this view-scoped note.",
      createdAt: "2026-06-04T11:50:00.000Z",
      updatedAt: "2026-06-04T11:50:00.000Z",
    },
    {
      id: "project_note_1",
      scope: "project",
      text: "Old project note.",
      createdAt: "2026-06-04T11:51:00.000Z",
      updatedAt: "2026-06-04T11:51:00.000Z",
    },
    {
      id: "volume_note_1",
      scope: "volume",
      text: "Keep this volume-scoped note.",
      createdAt: "2026-06-04T11:52:00.000Z",
      updatedAt: "2026-06-04T11:52:00.000Z",
    },
  ];

  const snapshot = caos.buildCaosProjectSnapshot({
    projectName: "Fixture Project",
    projectNote: "Updated project note.",
    dataset,
    derivative,
    view,
    notes: existingNotes,
    existingProjectId: "project_fixture",
    createdAt: "2026-06-04T11:59:00.000Z",
  });

  assert.deepEqual(snapshot.notes.map((note) => note.id), [
    "view_note_1",
    "project_note_1",
    "volume_note_1",
  ]);
  assert.equal(snapshot.notes[1].text, "Updated project note.");
  assert.equal(snapshot.notes[1].createdAt, "2026-06-04T11:51:00.000Z");
  assert.notEqual(snapshot.notes[1].updatedAt, "2026-06-04T11:51:00.000Z");
});

test("CAOS scoped record replacement removes stale records for project volumes only", () => {
  const staleSameVolume = {
    ...measurement,
    id: "stale_same_volume",
  };
  const unrelatedVolume = {
    ...measurement,
    id: "unrelated_volume",
    datasetSlug: "other-dataset",
    assetPath: "other-volume.ome.zarr",
  };
  const incoming = {
    ...measurement,
    id: "incoming_measurement",
  };

  const replaced = caos.replaceVolumeScopedRecords(
    [staleSameVolume, unrelatedVolume],
    [incoming],
    [{ datasetSlug: dataset.slug, assetPath: derivative.source_relative_path }],
    10
  );

  assert.deepEqual(replaced.map((item) => item.id), ["incoming_measurement", "unrelated_volume"]);
});

test("CAOS active volume resolver accepts matching indexed volume", () => {
  const snapshot = buildFixtureSnapshot();
  const resolved = caos.resolveCaosProjectActiveVolume(snapshot, [dataset]);

  assert.equal(resolved.status, "ready");
  assert.equal(resolved.dataset.slug, dataset.slug);
  assert.equal(resolved.derivative.source_relative_path, derivative.source_relative_path);
});

test("CAOS active volume resolver reports missing local volume", () => {
  const snapshot = buildFixtureSnapshot();
  const resolved = caos.resolveCaosProjectActiveVolume(snapshot, []);

  assert.equal(resolved.status, "missing-volume");
  assert.match(resolved.summary, /not available/);
});

test("CAOS active volume resolver reports fingerprint mismatch", () => {
  const snapshot = buildFixtureSnapshot();
  const changedDataset = clone(dataset);
  changedDataset.derivatives[0].shape_zyx = [7, 5, 4];
  const resolved = caos.resolveCaosProjectActiveVolume(snapshot, [changedDataset]);

  assert.equal(resolved.status, "fingerprint-mismatch");
  assert.match(resolved.summary, /fingerprint/);
  assert.notEqual(resolved.expectedFingerprint, resolved.indexedFingerprint);
});
