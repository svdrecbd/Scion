import assert from "node:assert/strict";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, "..");
const tempRoot = join(desktopRoot, ".tmp");
const tempDir = join(tempRoot, "private-registry-tests");
const sourcePath = join(desktopRoot, "src", "private-registry.ts");
const outputPath = join(tempDir, "private-registry.mjs");

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

const registry = await import(pathToFileURL(outputPath).href);
await rm(tempDir, { force: true, recursive: true });
await rmdir(tempRoot).catch(() => undefined);

const summary = {
  schema: "cell-anatomy-private-archive-registry",
  schema_version: 1,
  registry_builder: "private-registry-import-v0.1",
  registry_id: "fixture-registry",
  created_at: "2026-06-04T12:00:00Z",
  source_scan: {
    scan_dir: "/tmp/scan",
    archive_id: "fixture-archive",
    root: "/tmp/archive",
    scanner: "archive-scanner-v0.2",
    file_count: 2,
    bytes_total: 1040,
  },
  asset_count: 2,
  file_asset_count: 1,
  logical_asset_count: 1,
  bytes_total: 1040,
  volume_candidate_count: 2,
  review_queue_count: 2,
  metadata_gap_count: 1,
  checksum_record_count: 1,
  duplicate_asset_count: 0,
  project_ready_count: 0,
  output_dir: "/tmp/registry",
};

const allowedOperations = {
  can_store_locally: true,
  can_backup_to_cloud: false,
  can_convert: false,
  can_view_in_caos: false,
  can_share_with_collaborators: false,
  can_publish_derivatives: false,
  can_release_publicly: false,
};

const tiffAsset = {
  schema: "cell-anatomy-private-archive-asset",
  schema_version: 1,
  registry_id: "fixture-registry",
  asset_id: "fixture-asset-tiff",
  archive_id: "fixture-archive",
  relative_path: "raw/cell.tif",
  name: "cell.tif",
  path_type: "file",
  extension: ".tif",
  likely_role: "raw_volume_candidate",
  size_bytes: 1024,
  modified_at: "2026-06-04T12:00:00Z",
  source: {
    root: "/tmp/archive",
    relative_path: "raw/cell.tif",
    link_target: "",
  },
  checksum: {
    algorithm: "sha256",
    digest: "f".repeat(64),
    duplicate_of: "",
    computed_at: "2026-06-04T12:00:00Z",
    reused_from_previous_run: false,
  },
  metadata: {
    status: "readable",
    format: "TIFF",
    dimensions: { x: 2, y: 2 },
    dtype: "uint8",
    voxel_size_nm: null,
    metadata_source: "tiff_ifd",
    source_metadata_path: "raw/cell.tif",
    warning: "",
  },
  status: {
    asset_status: "discovered",
    fixity_status: "checksummed",
    publication_status: "unknown",
    triage_status: "unknown",
    rights_status: "unknown",
    classification_status: "unreviewed",
    blocked_states: ["blocked_permission"],
    review_required: true,
    review_notes: ["scanner_seeded_status"],
    allowed_operations: allowedOperations,
  },
  volume_candidate: {
    is_candidate: true,
    source_metadata_path: "raw/cell.tif",
    candidate_status: "readable",
  },
  review: {
    gap_count: 1,
    gap_codes: ["missing_voxel_size"],
    gap_severities: ["review"],
    recommended_actions: ["Find authoritative calibration."],
  },
  readiness: {
    metadata_ready: false,
    has_checksum: true,
    is_volume_candidate: true,
    conversion_ready: false,
    project_ready: false,
    blockers: ["blocked_permission", "missing_voxel_size"],
  },
};

const zarrAsset = {
  ...tiffAsset,
  asset_id: "fixture-asset-zarr",
  relative_path: "raw/cell.zarr",
  name: "cell.zarr",
  path_type: "directory_volume",
  extension: ".zarr",
  size_bytes: 16,
  checksum: {
    algorithm: "",
    digest: "",
    duplicate_of: "",
    computed_at: "",
    reused_from_previous_run: false,
  },
  metadata: {
    status: "readable",
    format: "Zarr",
    dimensions: { x: 4, y: 5, z: 6 },
    shape: [6, 5, 4],
    chunks: [3, 2, 2],
    dtype: "<u2",
    voxel_size_nm: null,
    metadata_source: "zarr_array_metadata",
    source_metadata_path: "raw/cell.zarr/.zarray",
    warning: "",
  },
  volume_candidate: {
    is_candidate: true,
    source_metadata_path: "raw/cell.zarr/.zarray",
    candidate_status: "readable",
  },
  review: {
    gap_count: 0,
    gap_codes: [],
    gap_severities: [],
    recommended_actions: [],
  },
  readiness: {
    metadata_ready: false,
    has_checksum: false,
    is_volume_candidate: true,
    conversion_ready: false,
    project_ready: false,
    blockers: ["blocked_permission", "missing_composite_checksum"],
  },
};

const readyOperations = {
  ...allowedOperations,
  can_view_in_caos: true,
};

const projectReadyZarrAsset = {
  ...zarrAsset,
  asset_id: "fixture-asset-ready-zarr",
  relative_path: "derived/cell.ome.zarr",
  name: "cell.ome.zarr",
  size_bytes: 24,
  checksum: {
    algorithm: "sha256-tree-v1",
    digest: "a".repeat(64),
    duplicate_of: "",
    computed_at: "2026-06-04T12:00:00Z",
    reused_from_previous_run: false,
  },
  metadata: {
    ...zarrAsset.metadata,
    dtype: "uint8",
    voxel_size_nm: { x: 4, y: 4, z: 8, source: "fixture" },
    metadata_source: "public_data_derivative_manifest",
    source_metadata_path: "derived/cell.ome.zarr/0/.zarray",
  },
  status: {
    ...zarrAsset.status,
    asset_status: "project_ready",
    fixity_status: "composite_checksummed",
    publication_status: "published",
    triage_status: "converted",
    rights_status: "public",
    classification_status: "public_data_pilot_derivative",
    blocked_states: [],
    review_required: false,
    review_notes: ["public_data_derivative_manifest"],
    allowed_operations: readyOperations,
  },
  readiness: {
    metadata_ready: true,
    has_checksum: true,
    is_volume_candidate: true,
    conversion_ready: false,
    project_ready: true,
    blockers: [],
  },
};

const conversionCandidateAsset = {
  ...tiffAsset,
  asset_id: "fixture-asset-convert-source",
  relative_path: "data/cell.tif",
  status: {
    ...tiffAsset.status,
    asset_status: "validated",
    publication_status: "published",
    triage_status: "validated",
    rights_status: "public",
    classification_status: "public_data_pilot",
    review_required: false,
    review_notes: ["public_data_manifest"],
    allowed_operations: {
      ...allowedOperations,
      can_convert: true,
    },
  },
  metadata: {
    ...tiffAsset.metadata,
    dimensions: { x: 4, y: 5, z: 6 },
    voxel_size_nm: { x: 4, y: 4, z: 8, source: "fixture" },
    metadata_source: "public_data_conversion_readiness_manifest",
  },
  review: {
    gap_count: 0,
    gap_codes: [],
    gap_severities: [],
    recommended_actions: [],
  },
  readiness: {
    metadata_ready: true,
    has_checksum: true,
    is_volume_candidate: true,
    conversion_ready: false,
    project_ready: false,
    blockers: ["blocked_permission"],
  },
};

const searchEntry = {
  schema: "cell-anatomy-private-archive-search-entry",
  schema_version: 1,
  asset_id: "fixture-asset-tiff",
  archive_id: "fixture-archive",
  relative_path: "raw/cell.tif",
  title: "cell.tif",
  search_text: "fixture-archive raw/cell.tif tiff",
  format: "TIFF",
  likely_role: "raw_volume_candidate",
  project_ready: false,
  volume_candidate: true,
};

test("private registry bundle parses summary, assets, search, and review sets", () => {
  const parsed = registry.parsePrivateArchiveRegistryBundle({
    summaryContents: JSON.stringify(summary),
    assetsContents: `${JSON.stringify(tiffAsset)}\n${JSON.stringify(zarrAsset)}\n`,
    searchContents: `${JSON.stringify(searchEntry)}\n`,
  });

  assert.equal(parsed.summary.registry_id, "fixture-registry");
  assert.equal(parsed.assets.length, 2);
  assert.equal(parsed.searchEntries.length, 1);
  assert.equal(parsed.volumeCandidates.length, 2);
  assert.equal(parsed.reviewAssets.length, 2);
  assert.equal(registry.privateRegistryAssetStatusLabel(parsed.assets[0]), "Needs Review");
});

test("private registry bundle exposes project-ready and conversion-queue assets", () => {
  const parsed = registry.parsePrivateArchiveRegistryBundle({
    summaryContents: JSON.stringify({
      ...summary,
      asset_count: 2,
      file_asset_count: 1,
      logical_asset_count: 1,
      volume_candidate_count: 2,
      review_queue_count: 1,
      project_ready_count: 1,
    }),
    assetsContents: `${JSON.stringify(conversionCandidateAsset)}\n${JSON.stringify(projectReadyZarrAsset)}\n`,
  });

  assert.equal(parsed.projectReadyAssets.length, 1);
  assert.equal(parsed.projectReadyAssets[0].relative_path, "derived/cell.ome.zarr");
  assert.equal(parsed.conversionQueueAssets.length, 1);
  assert.equal(parsed.conversionQueueAssets[0].relative_path, "data/cell.tif");
  assert.equal(registry.privateRegistryAssetStatusLabel(parsed.projectReadyAssets[0]), "Project Ready");
  assert.equal(registry.privateRegistryAssetStatusLabel(parsed.conversionQueueAssets[0]), "Ready To Convert");
});

test("private registry bundle rejects mismatched asset registry ids", () => {
  const badAsset = { ...tiffAsset, registry_id: "other-registry" };

  assert.throws(
    () =>
      registry.parsePrivateArchiveRegistryBundle({
        summaryContents: JSON.stringify(summary),
        assetsContents: `${JSON.stringify(badAsset)}\n`,
      }),
    /do not all match/
  );
});

test("private registry bundle rejects dangling search entries", () => {
  const badSearch = { ...searchEntry, asset_id: "missing-asset" };

  assert.throws(
    () =>
      registry.parsePrivateArchiveRegistryBundle({
        summaryContents: JSON.stringify(summary),
        assetsContents: `${JSON.stringify(tiffAsset)}\n`,
        searchContents: `${JSON.stringify(badSearch)}\n`,
      }),
    /missing asset/
  );
});

test("project-ready registry asset resolves a loaded derivative by exact local path", () => {
  const derivative = {
    source_relative_path: "volumes/cell.ome.zarr",
    source_local_path: "/tmp/source/cell.mrc",
    source_sha256: "b".repeat(64),
    source_size_bytes: 4096,
    output_path: "/tmp/archive/derived/cell.ome.zarr",
  };
  const dataset = { slug: "fixture-dataset", derivatives: [derivative] };

  const resolved = registry.resolvePrivateRegistryProjectAsset(projectReadyZarrAsset, [dataset]);

  assert.equal(resolved.status, "ready");
  assert.equal(resolved.dataset.slug, "fixture-dataset");
  assert.equal(resolved.derivative, derivative);
  assert.equal(resolved.matchedBy, "local-path");
});

test("project-ready registry asset resolution prefers archive identity and rejects ambiguity", () => {
  const identityDerivative = {
    source_relative_path: "other/location.ome.zarr",
    output_path: "/other/location.ome.zarr",
    archiveStatus: {
      registryId: projectReadyZarrAsset.registry_id,
      assetId: projectReadyZarrAsset.asset_id,
    },
  };
  const identity = registry.resolvePrivateRegistryProjectAsset(projectReadyZarrAsset, [
    { slug: "identity-dataset", derivatives: [identityDerivative] },
    {
      slug: "path-dataset",
      derivatives: [
        {
          source_relative_path: projectReadyZarrAsset.relative_path,
          output_path: "/tmp/archive/derived/cell.ome.zarr",
        },
      ],
    },
  ]);
  assert.equal(identity.status, "ready");
  assert.equal(identity.dataset.slug, "identity-dataset");
  assert.equal(identity.matchedBy, "archive-identity");

  const ambiguous = registry.resolvePrivateRegistryProjectAsset(projectReadyZarrAsset, [
    {
      slug: "duplicate-dataset",
      derivatives: [
        { source_relative_path: projectReadyZarrAsset.relative_path },
        { source_relative_path: projectReadyZarrAsset.relative_path },
      ],
    },
  ]);
  assert.equal(ambiguous.status, "ambiguous");
  assert.match(ambiguous.summary, /More than one/);
});

test("registry project seed carries workset and archive provenance", () => {
  const seed = registry.buildPrivateRegistryProjectSeed(projectReadyZarrAsset, {
    workset_id: "pilot-workset",
    title: "Pilot Workset",
  });

  assert.equal(seed.name, "Pilot Workset — cell");
  assert.match(seed.note, /pilot-workset/);
  assert.equal(seed.archiveStatus.registryId, projectReadyZarrAsset.registry_id);
  assert.equal(seed.archiveStatus.assetId, projectReadyZarrAsset.asset_id);
  assert.equal(seed.archiveStatus.worksetId, "pilot-workset");
  assert.equal(seed.archiveStatus.allowedOperations.can_view_in_caos, true);
});

test("registry project resolution blocks assets that are not actually project-ready", () => {
  const resolved = registry.resolvePrivateRegistryProjectAsset(conversionCandidateAsset, []);

  assert.equal(resolved.status, "blocked");
  assert.match(resolved.summary, /not cleared and ready/);
});

test("private workset bundle normalizes promoted assets into bounded registry view", () => {
  const workset = {
    schema: "cell-anatomy-archive-workset",
    schema_version: 1,
    workset_builder: "archive-workset-promote-v0.1",
    generated_at: "2026-06-10T12:00:00Z",
    workset_id: "pilot-workset",
    title: "Pilot Workset",
    source_registry: {
      registry_dir: "/tmp/registry",
      registry_id: "fixture-registry-curated",
      archive_id: "fixture-archive",
      archive_root: "/tmp/archive",
      asset_count: 100,
    },
    selection: {
      asset_ids: [],
      path_prefixes: ["raw/"],
      queries: [],
      all_assets: false,
      volume_candidates_only: true,
      limit: null,
    },
    promotion_rule: {
      selected_asset_count: 1,
      selected_assets_artifact: "workset-assets.jsonl",
      selected_assets_preview: [{ asset_id: "fixture-workset-asset", relative_path: "raw/cell.mrc" }],
      intended_operations: ["review", "convert"],
      destination_workset_dir: "/tmp/workset",
      notes: ["fixture"],
    },
    summary: {
      selected_asset_count: 1,
      selected_bytes_total: 1024,
      checksum_record_count: 1,
      metadata_ready_count: 1,
      conversion_ready_count: 1,
      project_ready_count: 0,
      dataset_mode_ready_count: 1,
      rights_status_counts: { internal_use: 1 },
      triage_status_counts: { candidate: 1 },
      publication_status_counts: { unpublished: 1 },
      format_counts: { MRC: 1 },
      blocker_counts: {},
      blocked_operation_counts: {},
    },
    findings: [],
    artifacts: {
      json: "workset.json",
      assets_jsonl: "workset-assets.jsonl",
      assets_csv: "workset-assets.csv",
      review_queue_csv: "workset-review-queue.csv",
    },
    output_dir: "/tmp/workset",
  };
  const worksetAsset = {
    schema: "cell-anatomy-archive-workset-asset",
    schema_version: 1,
    workset_builder: "archive-workset-promote-v0.1",
    promoted_at: "2026-06-10T12:00:00Z",
    asset_id: "fixture-workset-asset",
    registry_id: "fixture-registry-curated",
    archive_id: "fixture-archive",
    relative_path: "raw/cell.mrc",
    path_type: "file",
    likely_role: "raw_volume_candidate",
    size_bytes: 1024,
    source: {
      root: "/tmp/archive",
      relative_path: "raw/cell.mrc",
    },
    checksum: {
      algorithm: "sha256",
      digest: "b".repeat(64),
      duplicate_of: "",
      computed_at: "2026-06-10T12:00:00Z",
    },
    metadata: {
      status: "readable",
      format: "MRC",
      dimensions: { x: 4, y: 5, z: 6 },
      dtype: "uint16",
      voxel_size_nm: { x: 2, y: 2, z: 4, source: "fixture" },
      metadata_source: "mrc_header",
    },
    status: {
      asset_status: "validated",
      fixity_status: "checksummed",
      publication_status: "unpublished",
      triage_status: "candidate",
      rights_status: "internal_use",
      blocked_states: [],
      allowed_operations: {
        ...allowedOperations,
        can_convert: true,
        can_view_in_caos: true,
      },
    },
    readiness: {
      metadata_ready: true,
      has_checksum: true,
      is_volume_candidate: true,
      conversion_ready: true,
      project_ready: false,
      blockers: [],
    },
    review: {
      gap_count: 0,
      gap_codes: [],
      recommended_actions: [],
    },
    promotion: {
      intended_operations: ["review", "convert"],
      blocked_operations: [],
      can_enter_dataset_mode: true,
    },
  };

  const parsed = registry.parsePrivateWorksetBundle({
    worksetContents: JSON.stringify(workset),
    assetsContents: `${JSON.stringify(worksetAsset)}\n`,
  });

  assert.equal(parsed.workset.workset_id, "pilot-workset");
  assert.equal(parsed.registry.summary.asset_count, 1);
  assert.equal(parsed.registry.summary.registry_id, "fixture-registry-curated");
  assert.equal(parsed.registry.conversionQueueAssets.length, 1);
  assert.equal(parsed.registry.conversionQueueAssets[0].relative_path, "raw/cell.mrc");
  assert.equal(parsed.registry.assets[0].status.classification_status, "unreviewed");
  assert.equal(parsed.registry.assets[0].volume_candidate.candidate_status, "promoted_workset_candidate");
});
