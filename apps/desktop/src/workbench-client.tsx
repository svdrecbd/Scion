import React, { useState, useEffect, useMemo, useRef } from "react";
import { WorkbenchLogo } from "./brand";
import {
  buildCaosProjectSnapshot,
  caosProjectStableSignature,
  parseCaosProjectSnapshot,
  replaceVolumeScopedRecords,
  resolveCaosProjectActiveVolume,
  serializeCaosProjectSnapshot,
  type CaosProjectNote,
  type CaosProjectSnapshot,
  type CaosViewState,
  type CaosArchiveStatus,
} from "./caos-project";
import {
  parseCaosHandoff,
  resolveCaosHandoffDataset,
  verifyCaosHandoffIntegrity,
  type CaosHandoff,
  type CaosHandoffResolution,
} from "./caos-handoff";
import {
  buildPrivateRegistryProjectSeed,
  parsePrivateRegistryAssetsJsonl,
  parsePrivateArchiveRegistryBundle,
  parsePrivateRegistrySummary,
  parsePrivateWorksetBundle,
  privateRegistryAssetStatusLabel,
  resolvePrivateRegistryProjectAsset,
  type PrivateArchiveRegistryIndex,
  type PrivateRegistryAsset,
  type PrivateRegistrySummary,
  type PrivateWorksetSummary,
} from "./private-registry";
import { MeasurementOverlay, OrthogonalViewer, RoiOverlay, VolumetricViewer, VoxelPoint } from "./volumetric-viewer";
import { fetchVolumeEngine } from "./volume-client";

type CompatibilityReport = {
  status: string;
  summary?: string;
  array_path?: string;
  checks?: Record<string, boolean>;
};

type OpenLocalResponse = {
  success?: boolean;
  slug?: string;
  error?: string;
  persisted?: boolean;
  registry_path?: string;
  persistence_error?: string | null;
  compatibility?: CompatibilityReport;
};

type AccountUser = {
  user_id: string;
  primary_email: string;
};

type AccountDevice = {
  device_id: string;
  device_name: string;
  platform?: string | null;
  expires_at: string;
  last_seen_at?: string | null;
};

type DevicePairing = {
  user_code: string;
  device_code: string;
  verification_uri: string;
  expires_at: string;
  interval_seconds: number;
};

type DevicePairPollResponse = {
  status: "pending" | "approved" | "expired";
  device_token?: string | null;
  user?: AccountUser | null;
  device?: AccountDevice | null;
};

type DeviceMeResponse = {
  authenticated: boolean;
  user?: AccountUser | null;
  device?: AccountDevice | null;
};

type RecentLocalDataset = {
  path: string;
  slug: string;
  title: string;
  sourcePath: string;
  arrayPath?: string;
  dtype?: string;
  shape_zyx?: number[];
  status?: string;
  lastOpenedAt: string;
};

type RecentCaosProject = {
  path: string;
  name: string;
  projectId: string;
  datasetSlug: string;
  assetPath: string;
  updatedAt: string;
  lastOpenedAt: string;
};

type NativeCaosProjectFile = {
  path: string;
  contents: string;
};

type NativeCaosHandoffFile = {
  path: string;
  contents: string;
};

type NativeSavedCaosProjectFile = {
  path: string;
};

type NativeSavedViewSnapshotFiles = {
  pngPath: string;
  metadataPath: string;
};

type NativePrivateRegistryFile = {
  path: string;
  summaryContents: string;
  assetsContents: string;
  searchContents?: string | null;
  reviewQueueContents?: string | null;
  volumeCandidatesContents?: string | null;
};

type NativePrivateRegistryIndexFile = {
  path: string;
  summaryContents: string;
};

type NativePrivateWorksetFile = {
  path: string;
  worksetContents: string;
  assetsContents: string;
};

type PrivateRegistryIndexSection = "project_ready" | "conversion_queue" | "review";

type NativePrivateRegistryIndexQuery = {
  registryPath: string;
  section: PrivateRegistryIndexSection;
  query: string;
  queueFilter: PrivateRegistryQueueFilter;
  offset: number;
  limit: number;
  matchedKeys?: string[];
};

type NativePrivateRegistryIndexQueryResult = {
  registryPath: string;
  section: PrivateRegistryIndexSection;
  query: string;
  queueFilter: PrivateRegistryQueueFilter;
  offset: number;
  limit: number;
  totalCount: number;
  assetsContents: string;
  indexBackend?: string;
  indexPath?: string;
  indexRebuilt?: boolean;
};

type PrivateRegistryAssetPage = {
  assets: PrivateRegistryAsset[];
  totalCount: number;
  offset: number;
  limit: number;
  loading: boolean;
  error: string | null;
};

type WorkbenchSessionSnapshot = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  datasetSlug: string;
  datasetTitle?: string;
  assetPath: string;
  sourcePath?: string;
  viewMode: "orthogonal" | "2d" | "3d";
  axis: "z" | "y" | "x";
  slice: number;
  xSlice: number;
  ySlice: number;
  zSlice: number;
  minContrast: number;
  maxContrast: number;
  colormap: number;
  logScale: boolean;
  downsample: number;
  pitch: number;
  yaw: number;
  alphaScale: number;
  note: string;
  measurements?: MeasurementRecord[];
  rois?: RoiRecord[];
};

type ImportStatus = {
  kind: "opening" | "ready" | "warning" | "error";
  summary: string;
  path?: string;
  slug?: string;
  persisted?: boolean;
  registryPath?: string;
  report?: CompatibilityReport | null;
};

type ProjectRecoveryStatus = {
  kind: "warning" | "error";
  summary: string;
  path?: string;
  action?: "open-local-folder" | "retry-project-open";
  actionPath?: string;
};

type MeasurementRecord = MeasurementOverlay & {
  datasetSlug: string;
  assetPath: string;
  createdAt: string;
};

type MeasurementDraft = {
  point: VoxelPoint;
  axis: "z" | "y" | "x";
  slice: number;
};

type RoiRecord = RoiOverlay & {
  datasetSlug: string;
  assetPath: string;
  createdAt: string;
  note: string;
};

type RoiDraft = {
  kind: "box";
  point: VoxelPoint;
  axis: "z" | "y" | "x";
  slice: number;
};

type LocalJobRecord = {
  id: string;
  datasetSlug: string;
  assetPath: string;
  title: string;
  kind: "project-audit" | "roi-inventory" | "histogram";
  status: "completed";
  createdAt: string;
  summary: string;
  result: Record<string, unknown>;
};

type IndexQueueAsset = {
  relative_path: string;
  format: string;
  size_bytes?: number | string | null;
  validated_state: string;
  streamable_state: string;
  slice_cache_state?: string;
  index_status: "indexed" | "ready_for_conversion" | "slice_cache_ready" | "sidecar" | "needs_review" | string;
  dimensions?: Record<string, number | string> | null;
  warnings?: string[];
  blockers?: string[];
  review_notes?: string[];
  derivative?: Record<string, unknown> | null;
  convert_command?: string | null;
  slice_command?: string | null;
};

type IndexQueueDataset = {
  slug: string;
  archive_id?: string;
  workset_id?: string;
  dataset?: {
    source?: string;
    entry_id?: string;
    title?: string;
    experiment_type?: string;
  };
  readiness?: {
    total_assets?: number;
    ready_assets?: number;
    blocked_assets?: number;
    sidecar_assets?: number;
    status?: string;
  } | null;
  derivative_count: number;
  assets: IndexQueueAsset[];
};

type IndexQueueResponse = {
  root: string;
  root_exists: boolean;
  summary: {
    datasets: number;
    assets: number;
    indexed: number;
    ready_for_conversion: number;
    ready_for_slice_cache: number;
    slice_cache_indexed?: number;
    blocked: number;
    sidecars: number;
  };
  datasets: IndexQueueDataset[];
};

type IndexJobRecord = {
  id: string;
  kind: "convert" | "slices" | string;
  dataset_slug: string;
  asset_relative_path: string;
  status: "queued" | "running" | "cancel_requested" | "completed" | "failed" | "cancelled" | string;
  created_at_ms: number;
  started_at_ms?: number | null;
  finished_at_ms?: number | null;
  exit_code?: number | null;
  pid?: number | null;
  command: string[];
  command_display: string;
  log: string[];
  error?: string | null;
};

type IndexJobsResponse = {
  jobs: IndexJobRecord[];
};

type IndexJobResponse = {
  job: IndexJobRecord | null;
  error?: string;
};

type IndexBatchPlanItem = {
  kind: "convert" | "slices" | string;
  dataset_slug: string;
  dataset_title: string;
  asset_relative_path: string;
  registry_asset_id?: string;
  registry_relative_path?: string;
  format?: string | null;
  size_bytes?: number | string | null;
  dimensions?: Record<string, number | string> | null;
  index_status: string;
  existing_job_status?: string | null;
  command_display: string;
  start_request: {
    kind: "convert" | "slices" | string;
    dataset_slug: string;
    asset_relative_path: string;
  };
};

type IndexBatchPlanResponse = {
  plan_id: string;
  created_at_ms: number;
  source?: "pilot-index" | "private-registry" | string;
  registry_id?: string | null;
  root: string;
  kind: "convert" | "slices" | string;
  dataset_slug?: string | null;
  total_limit: number;
  per_dataset_limit: number;
  retry_failed: boolean;
  skip_completed: boolean;
  summary: {
    candidate_count: number;
    planned_count: number;
    skipped_active: number;
    skipped_completed: number;
    skipped_previous_failed: number;
    skipped_limit: number;
    datasets: number;
  };
  items: IndexBatchPlanItem[];
  checkpoint: Record<string, unknown>;
};

type IndexBatchRunSummary = {
  total: number;
  pending: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
};

type IndexBatchRunItem = {
  kind: "convert" | "slices" | string;
  dataset_slug: string;
  dataset_title: string;
  asset_relative_path: string;
  command_display: string;
  status: "pending" | "queued" | "running" | "cancel_requested" | "completed" | "failed" | "cancelled" | string;
  job_id?: string | null;
  existing_job_status?: string | null;
  started_at_ms?: number | null;
  finished_at_ms?: number | null;
  error?: string | null;
};

type IndexBatchRunRecord = {
  id: string;
  plan_id: string;
  kind: "convert" | "slices" | string;
  root?: string | null;
  status: "queued" | "running" | "cancel_requested" | "paused" | "completed" | "failed" | "cancelled" | string;
  concurrency: number;
  created_at_ms: number;
  updated_at_ms: number;
  finished_at_ms?: number | null;
  checkpoint_path: string;
  summary: IndexBatchRunSummary;
  items: IndexBatchRunItem[];
  log: string[];
  error?: string | null;
};

type IndexBatchRunsResponse = {
  runs: IndexBatchRunRecord[];
};

type IndexBatchRunResponse = {
  run: IndexBatchRunRecord | null;
  error?: string;
};

type IndexQueueAssetMatch = {
  dataset: IndexQueueDataset;
  asset: IndexQueueAsset;
};

type PrivateRegistryQueueFilter = "all" | "ready" | "review" | "matched";

export type PackagedDataset = {
  slug: string;
  title: string;
  source: string;
  entryId: string;
  experimentType: string;
  derivatives: Array<{
    source_relative_path: string;
    source_local_path: string;
    source_sha256: string;
    source_size_bytes: number;
    output_path: string;
    format: string;
    ome_ngff_version: string;
    zarr_format: number;
    array_path: string;
    shape_zyx: number[];
    chunks_zyx: number[];
    dtype: string;
    byte_size: number;
    physical_voxel_size_nm: Record<string, string | number>;
    validation?: CompatibilityReport;
    archiveStatus?: CaosArchiveStatus;
    role?: "segmentation_labels" | string;
    segmentation_id?: string;
    source_volume_relative_path?: string;
    task?: "cell" | "tooth" | "custom" | string;
    label_name?: string;
    method?: string;
    review_state?: string;
    human_review_required?: boolean;
    validated_for_clinical_use?: boolean;
    qc?: {
      status?: string;
      foreground_voxels?: number;
      foreground_fraction?: number;
      foreground_bbox_zyx_inclusive?: number[] | null;
      checks?: Record<string, boolean>;
    };
  }>;
  findings: Array<{
    finding_id: string;
    dataset_slug: string;
    asset_relative_path: string;
    severity: string;
    category: string;
    code: string;
    summary: string;
    impact: string;
    recommended_action: string;
    public_notice_candidate: boolean;
    review_status: string;
  }>;
};

type WorkbenchClientProps = {
  datasets: PackagedDataset[];
};

const clampIndex = (value: number, max: number) => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.round(value), Math.max(0, max - 1)));
};

const derivativeDefaultContrastMax = (
  derivative: PackagedDataset["derivatives"][number] | null | undefined
) => {
  if (derivative?.role === "segmentation_labels") return 1;
  return derivative?.dtype.includes("16") || derivative?.dtype === "uint16" ? 4095 : 255;
};

const parseNumberParam = (value: string | null, fallback: number) => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseAxisParam = (value: string | null): "z" | "y" | "x" => {
  return value === "x" || value === "y" || value === "z" ? value : "z";
};

const parseViewModeParam = (value: string | null): "orthogonal" | "2d" | "3d" => {
  return value === "orthogonal" || value === "2d" || value === "3d" ? value : "orthogonal";
};

const DEVICE_TOKEN_STORAGE_KEY = "cellAnatomyWorkbenchDeviceToken";
const RECENT_LOCAL_DATASETS_STORAGE_KEY = "cellAnatomyWorkbenchRecentLocalDatasets";
const RECENT_CAOS_PROJECTS_STORAGE_KEY = "cellAnatomyWorkbenchRecentCaosProjects";
const LAST_CAOS_PROJECT_PATH_STORAGE_KEY = "cellAnatomyWorkbenchLastCaosProjectPath";
const ACTIVE_CAOS_HANDOFF_STORAGE_KEY = "cellAnatomyWorkbenchActiveAtlasHandoff";
const WORKBENCH_SESSIONS_STORAGE_KEY = "cellAnatomyWorkbenchSessions";
const WORKBENCH_DRAFT_NOTE_STORAGE_KEY = "cellAnatomyWorkbenchDraftNote";
const WORKBENCH_MEASUREMENTS_STORAGE_KEY = "cellAnatomyWorkbenchMeasurements";
const WORKBENCH_ROIS_STORAGE_KEY = "cellAnatomyWorkbenchRois";
const WORKBENCH_JOBS_STORAGE_KEY = "cellAnatomyWorkbenchJobs";
const WORKBENCH_MIRROR_MODE_STORAGE_KEY = "cellAnatomyWorkbenchMirrorMode";
const MAX_RECENT_LOCAL_DATASETS = 8;
const MAX_RECENT_CAOS_PROJECTS = 8;
const MAX_WORKBENCH_SESSIONS = 12;
const MAX_WORKBENCH_MEASUREMENTS = 80;
const MAX_WORKBENCH_ROIS = 120;
const MAX_WORKBENCH_JOBS = 40;

const INDEX_STATUS_LABELS: Record<string, string> = {
  indexed: "Loadable",
  ready_for_conversion: "Ready to Convert",
  slice_cache_ready: "Slice Cache Ready",
  slice_cache_indexed: "Slice Cache Indexed",
  sidecar: "Sidecar",
  needs_review: "Needs Review",
};

const indexStatusTone = (status: string) => {
  if (status === "indexed") return "var(--atlas-blue-dark)";
  if (status === "ready_for_conversion" || status === "slice_cache_ready" || status === "slice_cache_indexed") return "var(--atlas-blue)";
  if (status === "sidecar") return "var(--accent-foreground)";
  return "var(--atlas-orange)";
};

const INDEX_JOB_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  cancel_requested: "Cancelling",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const indexJobKindLabel = (kind: string) => {
  if (kind === "convert") return "Convert";
  if (kind === "slices") return "Slice Cache";
  if (kind === "segment") return "Segmentation";
  return kind;
};

const PRIVATE_REGISTRY_QUEUE_FILTER_LABELS: Record<PrivateRegistryQueueFilter, string> = {
  all: "All",
  ready: "Ready",
  review: "Review",
  matched: "Matched",
};

const PRIVATE_REGISTRY_PAGE_LIMITS: Record<PrivateRegistryIndexSection, number> = {
  project_ready: 4,
  conversion_queue: 8,
  review: 3,
};

const emptyPrivateRegistryAssetPage = (limit: number): PrivateRegistryAssetPage => ({
  assets: [],
  totalCount: 0,
  offset: 0,
  limit,
  loading: false,
  error: null,
});

const indexJobStatusTone = (status: string) => {
  if (status === "completed") return "var(--atlas-blue-dark)";
  if (status === "running" || status === "queued" || status === "cancel_requested") return "var(--atlas-blue)";
  if (status === "paused") return "var(--accent-foreground)";
  if (status === "failed" || status === "cancelled") return "var(--atlas-orange)";
  return "var(--accent-foreground)";
};

const readStoredArray = <T,>(key: string): T[] => {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(key);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeStoredArray = <T,>(key: string, value: T[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local persistence is helpful but should never block viewing data.
  }
};

const readStoredString = (key: string) => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
};

const writeStoredString = (key: string, value: string) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Local persistence is helpful but should never block viewing data.
  }
};

const removeStoredValue = (key: string) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Local persistence is helpful but should never block viewing data.
  }
};

const readStoredCaosHandoff = (): CaosHandoff | null => {
  const value = readStoredString(ACTIVE_CAOS_HANDOFF_STORAGE_KEY);
  if (!value) return null;
  try {
    return parseCaosHandoff(value);
  } catch {
    removeStoredValue(ACTIVE_CAOS_HANDOFF_STORAGE_KEY);
    return null;
  }
};

const formatDateTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
};

const formatJobTime = (value?: number | null) => {
  if (!value) return "Pending";
  return formatDateTime(new Date(value).toISOString());
};

const formatShape = (shape?: number[]) => {
  if (!shape || shape.length === 0) return "unknown shape";
  return shape.join(" x ");
};

const formatDistance = (distanceUm: number) => {
  if (!Number.isFinite(distanceUm)) return "unknown";
  if (distanceUm < 1) return `${(distanceUm * 1000).toFixed(1)} nm`;
  if (distanceUm < 100) return `${distanceUm.toFixed(3)} µm`;
  return `${distanceUm.toFixed(1)} µm`;
};

const formatBytes = (value: number | string | null | undefined) => {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown size";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
};

const formatDimensions = (dimensions?: Record<string, number | string> | null) => {
  if (!dimensions) return "dimensions unknown";
  const x = dimensions.x ?? dimensions.width;
  const y = dimensions.y ?? dimensions.height;
  const z = dimensions.z ?? dimensions.depth;
  if (x && y && z) return `${z} x ${y} x ${x} voxels`;
  const entries = Object.entries(dimensions).filter(([, value]) => value !== "" && value != null);
  return entries.length
    ? entries.map(([key, value]) => `${key} ${value}`).join(" | ")
    : "dimensions unknown";
};

const formatVoxelPoint = (point: VoxelPoint) =>
  `X${point.x + 1},Y${point.y + 1},Z${point.z + 1}`;

const formatPathBasename = (value: string | null | undefined) => {
  if (!value) return "No file path";
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || value;
};

const normalizeLocalPath = (value: string | null | undefined) =>
  (value || "")
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

const privateWorksetDatasetSlug = (archiveId: string, worksetId: string) =>
  `private-workset:${archiveId || "archive"}:${worksetId}`;

const registryAssetReviewBlockers = (asset: PrivateRegistryAsset) =>
  asset.readiness.blockers.filter((blocker) => blocker !== "blocked_permission");

const registryIndexQueueKeys = (asset: PrivateRegistryAsset) => {
  const keys = new Set<string>();
  const rawPaths = [asset.relative_path, asset.source.relative_path]
    .map((path) => normalizeLocalPath(path).replace(/^\//, ""))
    .filter(Boolean);

  for (const path of rawPaths) {
    if (asset.archive_id && asset.workset_id) {
      keys.add(`${privateWorksetDatasetSlug(asset.archive_id, asset.workset_id)}\n${path}`);
    }
    const parts = path.split("/").filter(Boolean);
    if (parts.length > 1) {
      const [datasetSlug, ...rest] = parts;
      const datasetRelativePath = rest.join("/");
      if (datasetRelativePath) {
        keys.add(`${datasetSlug}\n${datasetRelativePath}`);
      }
      keys.add(`${datasetSlug}\n${path}`);
    }
    if (asset.archive_id) {
      keys.add(`${asset.archive_id}\n${path}`);
    }
  }

  return keys;
};

const buildIndexQueueAssetLookup = (queue: IndexQueueResponse | null) => {
  const lookup = new Map<string, IndexQueueAssetMatch>();
  if (!queue) return lookup;

  for (const dataset of queue.datasets) {
    for (const asset of dataset.assets) {
      const relativePath = normalizeLocalPath(asset.relative_path).replace(/^\//, "");
      const match = { dataset, asset };
      lookup.set(`${dataset.slug}\n${relativePath}`, match);
      lookup.set(`${dataset.slug}\n${dataset.slug}/${relativePath}`, match);
    }
  }

  return lookup;
};

const buildIndexQueueMatchKeys = (queue: IndexQueueResponse | null) => {
  if (!queue) return [];
  const keys = new Set<string>();
  for (const dataset of queue.datasets) {
    for (const asset of dataset.assets) {
      const relativePath = normalizeLocalPath(asset.relative_path).replace(/^\//, "");
      if (!relativePath) continue;
      keys.add(`${dataset.slug}\n${relativePath}`);
      keys.add(`${dataset.slug}\n${dataset.slug}/${relativePath}`);
    }
  }
  return Array.from(keys);
};

const findRegistryIndexQueueMatch = (
  asset: PrivateRegistryAsset,
  lookup: Map<string, IndexQueueAssetMatch>
) => {
  for (const key of registryIndexQueueKeys(asset)) {
    const match = lookup.get(key);
    if (match) return match;
  }
  return null;
};

const registryAssetSearchText = (asset: PrivateRegistryAsset, searchEntryText = "") =>
  [
    searchEntryText,
    asset.relative_path,
    asset.name,
    asset.metadata.format,
    asset.metadata.dtype,
    asset.likely_role,
    asset.status.asset_status,
    asset.status.triage_status,
    asset.status.rights_status,
    asset.review.gap_codes.join(" "),
    asset.readiness.blockers.join(" "),
  ]
    .join(" ")
    .toLowerCase();

const csvEscape = (value: string | number | null | undefined) => {
  const raw = value == null ? "" : String(value);
  if (!/[",\n\r]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, "\"\"")}"`;
};

const sanitizeFileSegment = (value: string) =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "workbench";

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not encode PNG export data."));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read PNG export data."));
    reader.readAsDataURL(blob);
  });

const EXPORT_TEXT_LAYER_SELECTOR =
  ".viewer-overlay-label, .scale-bar-wrap, .workbench-stage-readout, .stage-load-serial, .stage-overlay.error";
const EXPORT_BOX_LAYER_SELECTOR =
  ".viewer-crosshair-line, .scale-bar-line, .viewer-overlay-label, .workbench-stage-readout, .stage-load-serial, .stage-overlay.error";

const cssPixelValue = (value: string) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isTransparentColor = (value: string) =>
  !value ||
  value === "transparent" ||
  value === "rgba(0, 0, 0, 0)" ||
  value === "rgba(0,0,0,0)";

const isExportElementVisible = (element: HTMLElement | SVGElement) => {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    cssPixelValue(style.opacity || "1") > 0
  );
};

const drawCssBox = (
  context: CanvasRenderingContext2D,
  element: HTMLElement,
  panelRect: DOMRect,
  scale: number
) => {
  if (!isExportElementVisible(element)) return;

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const x = Math.round((rect.left - panelRect.left) * scale);
  const y = Math.round((rect.top - panelRect.top) * scale);
  const width = Math.round(rect.width * scale);
  const height = Math.round(rect.height * scale);
  if (width <= 0 || height <= 0) return;

  context.save();
  context.globalAlpha = Math.max(0, Math.min(1, cssPixelValue(style.opacity || "1")));

  if (style.boxShadow && style.boxShadow !== "none") {
    context.fillStyle = "rgba(0, 0, 0, 0.42)";
    context.fillRect(x - scale, y - scale, width + 2 * scale, height + 2 * scale);
  }

  if (!isTransparentColor(style.backgroundColor)) {
    context.fillStyle = style.backgroundColor;
    context.fillRect(x, y, width, height);
  }

  const drawBorder = (side: "Top" | "Right" | "Bottom" | "Left") => {
    const borderWidth = cssPixelValue(style[`border${side}Width` as keyof CSSStyleDeclaration] as string) * scale;
    const borderStyle = style[`border${side}Style` as keyof CSSStyleDeclaration] as string;
    const borderColor = style[`border${side}Color` as keyof CSSStyleDeclaration] as string;
    if (borderWidth <= 0 || borderStyle === "none" || isTransparentColor(borderColor)) return;

    context.fillStyle = borderColor;
    if (side === "Top") context.fillRect(x, y, width, borderWidth);
    if (side === "Right") context.fillRect(x + width - borderWidth, y, borderWidth, height);
    if (side === "Bottom") context.fillRect(x, y + height - borderWidth, width, borderWidth);
    if (side === "Left") context.fillRect(x, y, borderWidth, height);
  };

  drawBorder("Top");
  drawBorder("Right");
  drawBorder("Bottom");
  drawBorder("Left");
  context.restore();
};

const canvasFontFromStyle = (style: CSSStyleDeclaration, scale: number) => {
  const fontSize = Math.max(1, cssPixelValue(style.fontSize) * scale);
  const fontStyle = style.fontStyle && style.fontStyle !== "normal" ? `${style.fontStyle} ` : "";
  const fontVariant = style.fontVariant && style.fontVariant !== "normal" ? `${style.fontVariant} ` : "";
  const fontWeight = style.fontWeight || "400";
  const fontFamily = style.fontFamily || "Arial, sans-serif";
  return `${fontStyle}${fontVariant}${fontWeight} ${fontSize}px ${fontFamily}`;
};

const normalizeTextForTransform = (text: string, style: CSSStyleDeclaration) => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (style.textTransform === "uppercase") return collapsed.toUpperCase();
  if (style.textTransform === "lowercase") return collapsed.toLowerCase();
  return collapsed;
};

type ClientClipRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const intersectClientRect = (a: ClientClipRect, b: ClientClipRect): ClientClipRect | null => {
  const rect = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return rect.right > rect.left && rect.bottom > rect.top ? rect : null;
};

const textNodeClipRect = (root: HTMLElement, parent: HTMLElement): ClientClipRect | null => {
  const rootRect = root.getBoundingClientRect();
  let clip: ClientClipRect | null = {
    left: rootRect.left,
    top: rootRect.top,
    right: rootRect.right,
    bottom: rootRect.bottom,
  };

  let element: HTMLElement | null = parent;
  while (element && clip) {
    const style = window.getComputedStyle(element);
    const clipsX = style.overflowX !== "visible";
    const clipsY = style.overflowY !== "visible";
    if (element === root || clipsX || clipsY) {
      const rect = element.getBoundingClientRect();
      clip = intersectClientRect(clip, {
        left: clipsX || element === root ? rect.left : Number.NEGATIVE_INFINITY,
        top: clipsY || element === root ? rect.top : Number.NEGATIVE_INFINITY,
        right: clipsX || element === root ? rect.right : Number.POSITIVE_INFINITY,
        bottom: clipsY || element === root ? rect.bottom : Number.POSITIVE_INFINITY,
      });
    }
    if (element === root) break;
    element = element.parentElement;
  }

  return clip;
};

const drawTextNodeLayer = (
  context: CanvasRenderingContext2D,
  root: HTMLElement,
  panelRect: DOMRect,
  scale: number
) => {
  if (!isExportElementVisible(root)) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const range = document.createRange();
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (parent) {
      const style = window.getComputedStyle(parent);
      if (style.display !== "none" && style.visibility !== "hidden" && !isTransparentColor(style.color)) {
        const text = normalizeTextForTransform(node.textContent || "", style);
        if (text) {
          range.selectNodeContents(node);
          const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
          const rect = rects[0];
          const clipRect = textNodeClipRect(root, parent);
          if (rect && clipRect && intersectClientRect(clipRect, rect)) {
            const x = (rect.left - panelRect.left) * scale;
            const y = (rect.top - panelRect.top) * scale;
            const clipX = (clipRect.left - panelRect.left) * scale;
            const clipY = (clipRect.top - panelRect.top) * scale;
            const clipWidth = (clipRect.right - clipRect.left) * scale;
            const clipHeight = (clipRect.bottom - clipRect.top) * scale;

            context.save();
            context.beginPath();
            context.rect(clipX, clipY, clipWidth, clipHeight);
            context.clip();
            context.globalAlpha = Math.max(0, Math.min(1, cssPixelValue(style.opacity || "1")));
            context.font = canvasFontFromStyle(style, scale);
            context.fillStyle = style.color;
            context.textBaseline = "top";
            if (style.textShadow && style.textShadow !== "none") {
              context.shadowColor = "rgba(0, 0, 0, 0.82)";
              context.shadowBlur = 3 * scale;
              context.shadowOffsetY = scale;
            }
            context.fillText(text, x, y);
            context.restore();
          }
        }
      }
    }
    node = walker.nextNode();
  }
  range.detach();
};

const loadImageFromUrl = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not rasterize SVG overlay."));
    image.src = url;
  });

const drawSvgLayer = async (
  context: CanvasRenderingContext2D,
  svg: SVGSVGElement,
  panelRect: DOMRect,
  scale: number
) => {
  if (!isExportElementVisible(svg)) return;

  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));

  const serialized = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImageFromUrl(url);
    context.drawImage(
      image,
      Math.round((rect.left - panelRect.left) * scale),
      Math.round((rect.top - panelRect.top) * scale),
      width,
      height
    );
  } finally {
    URL.revokeObjectURL(url);
  }
};

const drawWorkbenchExportOverlays = async (
  context: CanvasRenderingContext2D,
  panel: HTMLElement,
  panelRect: DOMRect,
  scale: number
) => {
  const crosshairLines = Array.from(panel.querySelectorAll<HTMLElement>(".viewer-crosshair-line"));
  crosshairLines.forEach((element) => drawCssBox(context, element, panelRect, scale));

  const svgLayers = Array.from(panel.querySelectorAll<SVGSVGElement>(".viewer-annotation-overlay"));
  for (const svg of svgLayers) {
    await drawSvgLayer(context, svg, panelRect, scale);
  }

  const boxLayers = Array.from(panel.querySelectorAll<HTMLElement>(EXPORT_BOX_LAYER_SELECTOR)).filter(
    (element) => !element.classList.contains("viewer-crosshair-line")
  );
  boxLayers.forEach((element) => drawCssBox(context, element, panelRect, scale));

  const textLayers = Array.from(panel.querySelectorAll<HTMLElement>(EXPORT_TEXT_LAYER_SELECTOR));
  textLayers.forEach((element) => drawTextNodeLayer(context, element, panelRect, scale));
};

const getDesktopEnv = () =>
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {};

const getAccountApiBaseUrl = () =>
  (getDesktopEnv().VITE_SCION_API_BASE_URL || "http://127.0.0.1:8000/api").replace(/\/$/, "");

const getAtlasBaseUrl = () =>
  (getDesktopEnv().VITE_SCION_ATLAS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

const formatVolumeRuntimeError = (error: unknown) => {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Volume engine request timed out.";
  }
  if (error instanceof TypeError) {
    return "Volume engine is not reachable at 127.0.0.1:8080.";
  }
  return error instanceof Error ? error.message : "Volume engine request failed.";
};

async function volumeJson<T>(path: string, init?: RequestInit, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchVolumeEngine(path, {
      ...init,
      signal: init?.signal || controller.signal,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers || {}),
      },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || payload?.detail || `${response.status} ${response.statusText}`);
    }
    return payload as T;
  } catch (error) {
    throw new Error(formatVolumeRuntimeError(error));
  } finally {
    window.clearTimeout(timeout);
  }
}

async function accountJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getAccountApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.detail || `${response.status} ${response.statusText}`);
  }
  return payload as T;
}

export function WorkbenchClient({ datasets }: WorkbenchClientProps) {
  const [queryString, setQueryString] = useState(() =>
    typeof window === "undefined" ? "" : window.location.search
  );
  const searchParams = useMemo(() => new URLSearchParams(queryString), [queryString]);

  // 1. Local datasets state to merge custom loaded Zarr folders dynamically
  const [localDatasets, setLocalDatasets] = useState<PackagedDataset[]>(datasets);
  const [isTauri, setIsTauri] = useState(false);
  const [openingLocal, setOpeningLocal] = useState(false);
  const [localOpenReport, setLocalOpenReport] = useState<CompatibilityReport | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [projectRecoveryStatus, setProjectRecoveryStatus] = useState<ProjectRecoveryStatus | null>(null);
  const [recentLocalDatasets, setRecentLocalDatasets] = useState<RecentLocalDataset[]>(() =>
    readStoredArray<RecentLocalDataset>(RECENT_LOCAL_DATASETS_STORAGE_KEY)
  );
  const [recentCaosProjects, setRecentCaosProjects] = useState<RecentCaosProject[]>(() =>
    readStoredArray<RecentCaosProject>(RECENT_CAOS_PROJECTS_STORAGE_KEY)
  );
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState(() => `project_${Date.now()}`);
  const [currentProjectCreatedAt, setCurrentProjectCreatedAt] = useState(() =>
    new Date().toISOString()
  );
  const [currentProjectNotes, setCurrentProjectNotes] = useState<CaosProjectNote[]>([]);
  const [currentProjectExports, setCurrentProjectExports] = useState<unknown[]>([]);
  const [savedCaosProjectSignature, setSavedCaosProjectSignature] = useState<string | null>(null);
  const [activeAtlasHandoff, setActiveAtlasHandoff] = useState<CaosHandoff | null>(() => readStoredCaosHandoff());
  const [activeAtlasHandoffPath, setActiveAtlasHandoffPath] = useState<string | null>(null);
  const [atlasHandoffStatus, setAtlasHandoffStatus] = useState<string | null>(null);
  const [atlasHandoffError, setAtlasHandoffError] = useState<string | null>(null);
  const initialProjectSignatureRef = useRef(false);
  const restoredLastProjectRef = useRef(false);
  const [savedSessions, setSavedSessions] = useState<WorkbenchSessionSnapshot[]>(() =>
    readStoredArray<WorkbenchSessionSnapshot>(WORKBENCH_SESSIONS_STORAGE_KEY)
  );
  const [sessionName, setSessionName] = useState("");
  const [sessionNote, setSessionNote] = useState(() =>
    readStoredString(WORKBENCH_DRAFT_NOTE_STORAGE_KEY)
  );
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<MeasurementRecord[]>(() =>
    readStoredArray<MeasurementRecord>(WORKBENCH_MEASUREMENTS_STORAGE_KEY)
  );
  const [measurementMode, setMeasurementMode] = useState(false);
  const [measurementDraft, setMeasurementDraft] = useState<MeasurementDraft | null>(null);
  const [measurementStatus, setMeasurementStatus] = useState("Measurement mode off.");
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  const [rois, setRois] = useState<RoiRecord[]>(() =>
    readStoredArray<RoiRecord>(WORKBENCH_ROIS_STORAGE_KEY)
  );
  const [roiTool, setRoiTool] = useState<"off" | "point" | "box">("off");
  const [roiDraft, setRoiDraft] = useState<RoiDraft | null>(null);
  const [roiStatus, setRoiStatus] = useState("ROI tool off.");
  const [selectedRoiId, setSelectedRoiId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<LocalJobRecord[]>(() =>
    readStoredArray<LocalJobRecord>(WORKBENCH_JOBS_STORAGE_KEY)
  );
  const caosProjectInputRef = useRef<HTMLInputElement | null>(null);
  const caosHandoffInputRef = useRef<HTMLInputElement | null>(null);
  const nativeCommandHandlerRef = useRef<(command: string) => void>(() => {});
  const [indexQueue, setIndexQueue] = useState<IndexQueueResponse | null>(null);
  const [indexQueueLoading, setIndexQueueLoading] = useState(false);
  const [indexQueueError, setIndexQueueError] = useState<string | null>(null);
  const [indexQueueStatus, setIndexQueueStatus] = useState<string | null>(null);
  const [indexJobs, setIndexJobs] = useState<IndexJobRecord[]>([]);
  const [indexJobsLoading, setIndexJobsLoading] = useState(false);
  const [segmentationTask, setSegmentationTask] = useState<"cell" | "tooth">("cell");
  const [segmentationThreshold, setSegmentationThreshold] = useState(128);
  const [segmentationOperator, setSegmentationOperator] = useState<"ge" | "gt" | "le" | "lt">("ge");
  const [segmentationLabelName, setSegmentationLabelName] = useState("cell");
  const [segmentationLoading, setSegmentationLoading] = useState(false);
  const [segmentationStatus, setSegmentationStatus] = useState<string | null>(null);
  const [segmentationError, setSegmentationError] = useState<string | null>(null);
  const [indexBatchPlan, setIndexBatchPlan] = useState<IndexBatchPlanResponse | null>(null);
  const [indexBatchScope, setIndexBatchScope] = useState<"active" | "all">("active");
  const [indexBatchTotalLimit, setIndexBatchTotalLimit] = useState(3);
  const [indexBatchPerDatasetLimit, setIndexBatchPerDatasetLimit] = useState(1);
  const [indexBatchConcurrency, setIndexBatchConcurrency] = useState(1);
  const [indexBatchRetryFailed, setIndexBatchRetryFailed] = useState(false);
  const [indexBatchRuns, setIndexBatchRuns] = useState<IndexBatchRunRecord[]>([]);
  const [indexBatchRunsLoading, setIndexBatchRunsLoading] = useState(false);
  const [indexBatchLoading, setIndexBatchLoading] = useState(false);
  const [indexBatchStatus, setIndexBatchStatus] = useState<string | null>(null);
  const [indexBatchError, setIndexBatchError] = useState<string | null>(null);
  const completedIndexJobIds = useRef<Set<string>>(new Set());
  const [privateRegistry, setPrivateRegistry] = useState<PrivateArchiveRegistryIndex | null>(null);
  const [privateRegistrySummary, setPrivateRegistrySummary] = useState<PrivateRegistrySummary | null>(null);
  const [privateWorksetSummary, setPrivateWorksetSummary] = useState<PrivateWorksetSummary | null>(null);
  const [privateRegistryNativePath, setPrivateRegistryNativePath] = useState<string | null>(null);
  const [privateRegistryPath, setPrivateRegistryPath] = useState<string | null>(null);
  const [privateRegistryStatus, setPrivateRegistryStatus] = useState<string | null>(null);
  const [privateRegistryError, setPrivateRegistryError] = useState<string | null>(null);
  const [privateRegistryQuery, setPrivateRegistryQuery] = useState("");
  const [privateRegistryQueueFilter, setPrivateRegistryQueueFilter] = useState<PrivateRegistryQueueFilter>("all");
  const [privateRegistrySelectedConversionAssetIds, setPrivateRegistrySelectedConversionAssetIds] = useState<string[]>([]);
  const [privateRegistryProjectPage, setPrivateRegistryProjectPage] = useState<PrivateRegistryAssetPage>(() =>
    emptyPrivateRegistryAssetPage(PRIVATE_REGISTRY_PAGE_LIMITS.project_ready)
  );
  const [privateRegistryConversionPage, setPrivateRegistryConversionPage] = useState<PrivateRegistryAssetPage>(() =>
    emptyPrivateRegistryAssetPage(PRIVATE_REGISTRY_PAGE_LIMITS.conversion_queue)
  );
  const [privateRegistryReviewPage, setPrivateRegistryReviewPage] = useState<PrivateRegistryAssetPage>(() =>
    emptyPrivateRegistryAssetPage(PRIVATE_REGISTRY_PAGE_LIMITS.review)
  );
  const [accountUser, setAccountUser] = useState<AccountUser | null>(null);
  const [accountDevice, setAccountDevice] = useState<AccountDevice | null>(null);
  const [pairing, setPairing] = useState<DevicePairing | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountStatus, setAccountStatus] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [mirrorMode, setMirrorMode] = useState(() =>
    readStoredString(WORKBENCH_MIRROR_MODE_STORAGE_KEY) === "true"
  );

  useEffect(() => {
    setLocalDatasets(datasets);
  }, [datasets]);

  useEffect(() => {
    writeStoredString(WORKBENCH_DRAFT_NOTE_STORAGE_KEY, sessionNote);
  }, [sessionNote]);

  useEffect(() => {
    writeStoredArray(WORKBENCH_MEASUREMENTS_STORAGE_KEY, measurements);
  }, [measurements]);

  useEffect(() => {
    writeStoredArray(WORKBENCH_ROIS_STORAGE_KEY, rois);
  }, [rois]);

  useEffect(() => {
    writeStoredArray(WORKBENCH_JOBS_STORAGE_KEY, jobs);
  }, [jobs]);

  useEffect(() => {
    writeStoredString(WORKBENCH_MIRROR_MODE_STORAGE_KEY, mirrorMode ? "true" : "false");
  }, [mirrorMode]);

  useEffect(() => {
    if (activeAtlasHandoff) {
      writeStoredString(ACTIVE_CAOS_HANDOFF_STORAGE_KEY, JSON.stringify(activeAtlasHandoff));
    } else {
      removeStoredValue(ACTIVE_CAOS_HANDOFF_STORAGE_KEY);
    }
  }, [activeAtlasHandoff]);

  useEffect(() => {
    if (!activeAtlasHandoff) return;
    let cancelled = false;
    verifyCaosHandoffIntegrity(activeAtlasHandoff)
      .then((valid) => {
        if (cancelled || valid) return;
        setActiveAtlasHandoff(null);
        setActiveAtlasHandoffPath(null);
        setAtlasHandoffStatus(null);
        setAtlasHandoffError("Stored Atlas handoff fingerprint verification failed and the context was removed.");
      })
      .catch((error) => {
        if (!cancelled) {
          setAtlasHandoffError(error instanceof Error ? error.message : "Could not verify stored Atlas handoff.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeAtlasHandoff]);

  const atlasHandoffResolution: CaosHandoffResolution<PackagedDataset> | null = useMemo(
    () => activeAtlasHandoff ? resolveCaosHandoffDataset(activeAtlasHandoff, localDatasets) : null,
    [activeAtlasHandoff, localDatasets],
  );

  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
      setIsTauri(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;

    let active = true;
    let unlisten: (() => void) | null = null;

    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<string>("caos-native-command", (event) => {
          nativeCommandHandlerRef.current(event.payload);
        })
      )
      .then((cleanup) => {
        if (active) {
          unlisten = cleanup;
        } else {
          cleanup();
        }
      })
      .catch((error) => {
        console.warn("Failed to register native command listener.", error);
      });

    return () => {
      active = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const loadAccountDevice = async () => {
    const token = window.localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY);
    if (!token) {
      setAccountUser(null);
      setAccountDevice(null);
      return;
    }

    const payload = await accountJson<DeviceMeResponse>("/auth/devices/me", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (payload.authenticated && payload.user && payload.device) {
      setAccountUser(payload.user);
      setAccountDevice(payload.device);
    } else {
      window.localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY);
      setAccountUser(null);
      setAccountDevice(null);
    }
  };

  useEffect(() => {
    loadAccountDevice().catch(() => {
      window.localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY);
      setAccountUser(null);
      setAccountDevice(null);
    });
  }, []);

  useEffect(() => {
    if (!pairing) return;
    let cancelled = false;
    const intervalMs = Math.max(1, pairing.interval_seconds || 3) * 1000;

    const poll = async () => {
      try {
        const payload = await accountJson<DevicePairPollResponse>("/auth/devices/pairing/poll", {
          method: "POST",
          body: JSON.stringify({ device_code: pairing.device_code }),
        });
        if (cancelled) return;
        if (payload.status === "approved" && payload.device_token && payload.user && payload.device) {
          window.localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, payload.device_token);
          setAccountUser(payload.user);
          setAccountDevice(payload.device);
          setPairing(null);
          setAccountStatus("Workbench connected to your account.");
          setAccountError(null);
        } else if (payload.status === "expired") {
          setPairing(null);
          setAccountError("Pairing code expired. Start a new connection.");
        }
      } catch (error) {
        if (!cancelled) {
          setAccountError(error instanceof Error ? error.message : "Pairing check failed.");
        }
      }
    };

    void poll();
    const interval = window.setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [pairing]);

  useEffect(() => {
    const syncFromLocation = () => setQueryString(window.location.search);
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, []);

  // 2. Initial State from datasets list
  const defaultDataset = localDatasets[0] || null;
  const defaultDerivative = defaultDataset?.derivatives[0] || null;

  // 3. State values synchronized with URL (with standard defaults)
  const currentDatasetSlug = searchParams.get("dataset") || defaultDataset?.slug || "";
  const currentAssetPath = searchParams.get("asset") || defaultDerivative?.source_relative_path || "";
  const currentAxis = parseAxisParam(searchParams.get("axis"));
  const currentSlice = parseNumberParam(searchParams.get("slice"), 0);
  const currentMinContrast = parseNumberParam(searchParams.get("minContrast"), 0);
  const currentMaxContrast = parseNumberParam(searchParams.get("maxContrast"), 255);
  const currentColormap = Math.max(0, Math.min(2, Math.round(parseNumberParam(searchParams.get("colormap"), 0))));
  const currentLogScale = searchParams.get("logScale") === "true";

  // Viewer mode and downsample states
  const currentViewMode = parseViewModeParam(searchParams.get("viewMode"));
  const currentDownsample = Math.max(1, Math.round(parseNumberParam(searchParams.get("downsample"), 4)));

  // Interactive 3D variables stored locally to avoid Next.js routing freezes during high-frequency drag/scroll actions
  const [localPitch, setLocalPitch] = useState(0.0);
  const [localYaw, setLocalYaw] = useState(0.0);
  const [localAlphaScale, setLocalAlphaScale] = useState(0.15);

  // Stateful navigation tabs
  const [activeTab, setActiveTab] = useState<"telemetry" | "image-notes" | "jobs" | "planner">("telemetry");

  // Calibrated coordinate probe state
  const [activeProbe, setActiveProbe] = useState<{ px: number; py: number; pz: number; xUm: number; yUm: number; zUm: number; val: number } | null>(null);
  const [viewerStreaming, setViewerStreaming] = useState(false);
  const viewerLoadingSources = useRef<Record<string, boolean>>({});

  const setViewerLoadingSource = (source: string, loading: boolean) => {
    viewerLoadingSources.current = {
      ...viewerLoadingSources.current,
      [source]: loading,
    };
    setViewerStreaming(Object.values(viewerLoadingSources.current).some(Boolean));
  };

  // Logarithmic SVG Voxel Intensity Histogram state
  const [histogramData, setHistogramData] = useState<number[]>(() => new Array(256).fill(0));

  // High-performance uniform sampler for dynamic histogram updates
  const handleSliceLoaded = (data: Uint8Array | Uint16Array) => {
    const histogram = new Array(256).fill(0);
    if (data.length === 0) return;
    const step = Math.max(1, Math.floor(data.length / 10000));
    
    let maxVal = 255;
    if (data instanceof Uint16Array) {
      maxVal = 65535;
    }
    
    for (let i = 0; i < data.length; i += step) {
      const val = data[i];
      const bin = data instanceof Uint16Array
        ? Math.min(255, Math.floor((val / maxVal) * 255))
        : Math.min(255, val);
      histogram[bin]++;
    }
    setHistogramData(histogram);
  };

  // Experiment planner states connecting to the local Rust sidecar
  const [planningOrganelles, setPlanningOrganelles] = useState("nucleus,mitochondria");
  const [planningRes, setPlanningRes] = useState<number>(100);
  const [planningSample, setPlanningSample] = useState<number>(10);
  const [planningCellType, setPlanningCellType] = useState("hiPSC");
  const [planningResult, setPlanningResult] = useState<any>(null);
  const [planningLoading, setPlanningLoading] = useState(false);
  const [planningError, setPlanningError] = useState<string | null>(null);

  const fetchPlanningResult = async () => {
    if (planningLoading) return;
    if (!planningOrganelles.trim()) {
      setPlanningResult(null);
      setPlanningError("Enter at least one organelle marker.");
      return;
    }
    setPlanningLoading(true);
    setPlanningError(null);
    try {
      const url = `/api/datasets/analytics/plan?organelles=${encodeURIComponent(planningOrganelles)}&res=${planningRes}&ss=${planningSample}&cell_type=${encodeURIComponent(planningCellType)}`;
      const res = await fetchVolumeEngine(url);
      if (!res.ok) {
        throw new Error(`Plan API error: ${res.status}`);
      }
      const data = await res.json();
      setPlanningResult(data);
    } catch (err: any) {
      setPlanningError(err.message || "Failed to load plan analytics.");
    } finally {
      setPlanningLoading(false);
    }
  };

  const maxBinValue = useMemo(() => {
    return Math.max(1, ...histogramData);
  }, [histogramData]);

  const svgPath = useMemo(() => {
    if (histogramData.length === 0) return "";
    const width = 300;
    const height = 80;
    const points = histogramData.map((val, idx) => {
      const x = (idx / 255) * width;
      const logVal = Math.log1p(val);
      const logMax = Math.log1p(maxBinValue);
      const y = height - (logVal / logMax) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M 0,${height} L ${points.join(" L ")} L ${width},${height} Z`;
  }, [histogramData, maxBinValue]);

  const urlPitch = Number(searchParams.get("pitch") || 0.0);
  const urlYaw = Number(searchParams.get("yaw") || 0.0);
  const urlAlphaScale = Number(searchParams.get("alphaScale") || 0.15);

  // Synchronize local states when URL changes externally or during load
  useEffect(() => {
    setLocalPitch(urlPitch);
  }, [urlPitch]);

  useEffect(() => {
    setLocalYaw(urlYaw);
  }, [urlYaw]);

  useEffect(() => {
    setLocalAlphaScale(urlAlphaScale);
  }, [urlAlphaScale]);

  // Debounced URL updates for pitch and yaw (400ms inactivity timeout)
  useEffect(() => {
    const handler = setTimeout(() => {
      const uPitch = Number(searchParams.get("pitch") || 0.0);
      const uYaw = Number(searchParams.get("yaw") || 0.0);
      if (Math.abs(localPitch - uPitch) > 0.005 || Math.abs(localYaw - uYaw) > 0.005) {
        updateUrlParams({
          pitch: localPitch.toFixed(3),
          yaw: localYaw.toFixed(3),
        });
      }
    }, 400);
    return () => clearTimeout(handler);
  }, [localPitch, localYaw]);

  // Debounced URL updates for alpha opacity scale
  useEffect(() => {
    const handler = setTimeout(() => {
      const uAlpha = Number(searchParams.get("alphaScale") || 0.15);
      if (Math.abs(localAlphaScale - uAlpha) > 0.001) {
        updateUrlParams({
          alphaScale: localAlphaScale.toFixed(3),
        });
      }
    }, 400);
    return () => clearTimeout(handler);
  }, [localAlphaScale]);

  const focusDatasetDerivative = (
    slug: string,
    targetDeriv: PackagedDataset["derivatives"][number] | undefined | null
  ) => {
    const maxVal = derivativeDefaultContrastMax(targetDeriv);
    updateUrlParams({
      dataset: slug,
      asset: targetDeriv ? targetDeriv.source_relative_path : null,
      axis: "z",
      slice: 0,
      zSlice: targetDeriv ? Math.floor(targetDeriv.shape_zyx[0] / 2) : 0,
      ySlice: targetDeriv ? Math.floor(targetDeriv.shape_zyx[1] / 2) : 0,
      xSlice: targetDeriv ? Math.floor(targetDeriv.shape_zyx[2] / 2) : 0,
      viewMode: "orthogonal",
      minContrast: 0,
      maxContrast: maxVal,
      colormap: 0,
      logScale: false,
    });
  };

  const applyAtlasHandoff = async (contents: string, path: string | null = null) => {
    setAtlasHandoffError(null);
    setAtlasHandoffStatus("Verifying Atlas handoff...");
    try {
      const handoff = parseCaosHandoff(contents);
      if (!(await verifyCaosHandoffIntegrity(handoff))) {
        throw new Error("Atlas handoff fingerprint verification failed. The record may have changed or been edited.");
      }
      if (handoff.requirements.raw_data_included || handoff.requirements.automatic_download_allowed) {
        throw new Error("This Workbench only accepts metadata-only handoffs that do not authorize automatic data download.");
      }

      setActiveAtlasHandoff(handoff);
      setActiveAtlasHandoffPath(path);
      const resolution = resolveCaosHandoffDataset(handoff, localDatasets);
      if (resolution.status === "ready") {
        const derivative = resolution.dataset.derivatives[0];
        focusDatasetDerivative(resolution.dataset.slug, derivative);
        setActiveTab("telemetry");
        setAtlasHandoffStatus(
          `Verified Atlas handoff and opened ${resolution.dataset.slug} by ${resolution.matchedBy}.`,
        );
      } else {
        setActiveTab("image-notes");
        setAtlasHandoffStatus(resolution.summary);
      }
    } catch (error) {
      setAtlasHandoffError(error instanceof Error ? error.message : "Could not import Atlas handoff.");
      setAtlasHandoffStatus(null);
    }
  };

  const openAtlasHandoffNative = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const file = await invoke<NativeCaosHandoffFile | null>("open_caos_handoff_file");
      if (file) await applyAtlasHandoff(file.contents, file.path);
    } catch (error) {
      setAtlasHandoffError(error instanceof Error ? error.message : "Could not open Atlas handoff.");
    }
  };

  const importAtlasHandoff = async (file: File | null) => {
    if (!file) return;
    try {
      await applyAtlasHandoff(await file.text(), null);
    } finally {
      if (caosHandoffInputRef.current) caosHandoffInputRef.current.value = "";
    }
  };

  const openMatchedAtlasHandoffDataset = () => {
    if (!atlasHandoffResolution || atlasHandoffResolution.status !== "ready") return;
    focusDatasetDerivative(
      atlasHandoffResolution.dataset.slug,
      atlasHandoffResolution.dataset.derivatives[0],
    );
    setActiveTab("telemetry");
    setAtlasHandoffStatus(`Opened the loaded match for ${activeAtlasHandoff?.dataset.title || "Atlas handoff"}.`);
  };

  const clearAtlasHandoff = () => {
    setActiveAtlasHandoff(null);
    setActiveAtlasHandoffPath(null);
    setAtlasHandoffStatus("Atlas handoff context cleared.");
    setAtlasHandoffError(null);
  };

  const resolveLoadedDerivativeForRegistryAsset = (asset: PrivateRegistryAsset) =>
    resolvePrivateRegistryProjectAsset(asset, localDatasets);

  const findLoadedDerivativeForRegistryAsset = (asset: PrivateRegistryAsset) => {
    const resolution = resolveLoadedDerivativeForRegistryAsset(asset);
    return resolution.status === "ready" ? resolution : null;
  };

  const openRegistryProjectReadyAsset = (asset: PrivateRegistryAsset) => {
    const resolution = resolveLoadedDerivativeForRegistryAsset(asset);
    if (resolution.status !== "ready") {
      setPrivateRegistryStatus(resolution.summary);
      return;
    }
    focusDatasetDerivative(resolution.dataset.slug, resolution.derivative);
    setActiveTab("telemetry");
    setPrivateRegistryStatus(`Opened ${formatPathBasename(asset.relative_path)} from ${resolution.dataset.slug}.`);
  };

  const createCaosProjectFromRegistryAsset = async (asset: PrivateRegistryAsset) => {
    const resolution = resolveLoadedDerivativeForRegistryAsset(asset);
    if (resolution.status !== "ready") {
      setPrivateRegistryStatus(resolution.summary);
      return;
    }
    if (!(await confirmDiscardProjectChanges())) return;

    const seed = buildPrivateRegistryProjectSeed(asset, privateWorksetSummary);
    const derivative = {
      ...resolution.derivative,
      archiveStatus: {
        ...resolution.derivative.archiveStatus,
        ...seed.archiveStatus,
      },
    };
    const [zMax, yMax, xMax] = derivative.shape_zyx.map((value) => Math.max(1, value));
    const zSlice = Math.floor(zMax / 2);
    const ySlice = Math.floor(yMax / 2);
    const xSlice = Math.floor(xMax / 2);
    const view: CaosViewState = {
      mode: "orthogonal",
      axis: "z",
      slice: zSlice,
      xSlice,
      ySlice,
      zSlice,
      minContrast: 0,
      maxContrast: derivative.dtype.includes("16") ? 4095 : 255,
      colormap: 0,
      logScale: false,
      downsample: 1,
      pitch: 0,
      yaw: 0,
      alphaScale: 0.15,
    };
    const createdAt = new Date().toISOString();
    const snapshot = buildCaosProjectSnapshot({
      projectName: seed.name,
      projectNote: seed.note,
      dataset: resolution.dataset,
      derivative,
      view,
      existingProjectId: `project_${Date.parse(createdAt)}`,
      createdAt,
    });

    try {
      let path: string | null = null;
      if (isTauri) {
        const { invoke } = await import("@tauri-apps/api/core");
        const saved = await invoke<NativeSavedCaosProjectFile | null>("save_caos_project_file", {
          request: {
            path: null,
            contents: serializeCaosProjectSnapshot(snapshot),
            defaultFilename: `${sanitizeFileSegment(snapshot.project.name)}.caos-project.json`,
            forceDialog: true,
          },
        });
        if (!saved) {
          setPrivateRegistryStatus("Project creation canceled; the current CAOS project was not changed.");
          return;
        }
        path = saved.path;
      }

      applyCaosProjectSnapshot(snapshot, path, "Created");
      setPrivateRegistryStatus(
        `${path ? "Created and saved" : "Created"} CAOS project “${snapshot.project.name}” from ${formatPathBasename(asset.relative_path)}.`
      );
      setActiveTab("image-notes");
    } catch (error) {
      setPrivateRegistryStatus(error instanceof Error ? error.message : "Could not create the CAOS project.");
    }
  };

  const openLocalPath = async (path: string) => {
    if (openingLocal) return;
    try {
      setOpeningLocal(true);
      setImportStatus({
        kind: "opening",
        path,
        summary: "Scanning local Zarr metadata and compatibility checks.",
      });

      const result = await volumeJson<OpenLocalResponse>(
        `/api/volume/open-local?path=${encodeURIComponent(path)}`,
        undefined,
        15000
      );
      if (result.success && result.slug) {
        const freshData = await volumeJson<PackagedDataset[]>("/api/volume/workbench-data");
        setLocalDatasets(freshData);

        const targetDataset = freshData.find((d) => d.slug === result.slug);
        const targetDeriv = targetDataset?.derivatives[0];
        const report = targetDeriv?.validation ||
          (result.persistence_error
            ? { status: "warning", summary: result.persistence_error }
            : null);
        setLocalOpenReport(report);

        const sourcePath = targetDeriv?.source_local_path || targetDeriv?.output_path || path;
        const recentEntry: RecentLocalDataset = {
          path,
          slug: result.slug,
          title: targetDataset?.title || result.slug,
          sourcePath,
          arrayPath: targetDeriv?.array_path,
          dtype: targetDeriv?.dtype,
          shape_zyx: targetDeriv?.shape_zyx,
          status: report?.status || "ready",
          lastOpenedAt: new Date().toISOString(),
        };
        setRecentLocalDatasets((previous) => {
          const next = [
            recentEntry,
            ...previous.filter((item) => item.path !== recentEntry.path && item.slug !== recentEntry.slug),
          ].slice(0, MAX_RECENT_LOCAL_DATASETS);
          writeStoredArray(RECENT_LOCAL_DATASETS_STORAGE_KEY, next);
          return next;
        });

        setImportStatus({
          kind: result.persistence_error || report?.status === "warning" ? "warning" : "ready",
          path,
          slug: result.slug,
          persisted: result.persisted,
          registryPath: result.registry_path,
          report,
          summary:
            result.persistence_error ||
            report?.summary ||
            `${targetDataset?.title || result.slug} is ready for inspection.`,
        });

        focusDatasetDerivative(result.slug, targetDeriv);
      } else {
        const report = result.compatibility || { status: "unsupported", summary: result.error || "Local data open failed." };
        setLocalOpenReport(report);
        setImportStatus({
          kind: "error",
          path,
          report,
          summary: result.error || report.summary || "Local data open failed.",
        });
      }
    } catch (error) {
      console.error("Error opening directory picker:", error);
      setImportStatus({
        kind: "error",
        path,
        summary: error instanceof Error
          ? error.message
          : "Directory selection failed. Please ensure the volume engine sidecar is running.",
      });
    } finally {
      setOpeningLocal(false);
    }
  };

  const handleOpenLocalDirectory = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke<string | null>("select_local_directory");
      if (!path) return;
      await openLocalPath(path);
    } catch (error) {
      console.error("Error opening directory picker:", error);
      setImportStatus({
        kind: "error",
        summary: "Directory selection failed. Please ensure the native Workbench shell is running.",
      });
    }
  };

  const handleLocalDrop = async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
    const textPath = event.dataTransfer.getData("text/plain");
    const path = file?.path || textPath;
    if (!path) {
      setImportStatus({
        kind: "warning",
        summary: isTauri
          ? "Drop did not include a readable local path. Use Open Local Zarr Folder instead."
          : "Drag/drop import requires the native Workbench shell. Browser preview cannot read local folder paths.",
      });
      return;
    }
    await openLocalPath(path);
  };

  const handleStartPairing = async () => {
    if (accountBusy) return;
    setAccountBusy(true);
    setAccountStatus(null);
    setAccountError(null);
    try {
      const payload = await accountJson<DevicePairing>("/auth/devices/pairing/start", {
        method: "POST",
        body: JSON.stringify({
          device_name: "Cell Anatomy Workbench",
          platform: navigator.platform || "desktop",
        }),
      });
      setPairing(payload);
      const verificationUrl = `${getAtlasBaseUrl()}${payload.verification_uri}`;
      setAccountStatus(`Open ${verificationUrl} and approve code ${payload.user_code}.`);
      window.open(verificationUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Could not start account pairing.");
    } finally {
      setAccountBusy(false);
    }
  };

  const handleDisconnectAccount = async () => {
    if (accountBusy) return;
    setAccountBusy(true);
    setAccountStatus(null);
    setAccountError(null);
    const token = window.localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY);
    try {
      if (token) {
        await accountJson("/auth/devices/me", {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      }
      window.localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY);
      setAccountUser(null);
      setAccountDevice(null);
      setPairing(null);
      setAccountStatus("Workbench disconnected from this account.");
    } catch (error) {
      window.localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY);
      setAccountUser(null);
      setAccountDevice(null);
      setPairing(null);
      setAccountError(error instanceof Error ? error.message : "Disconnected locally, but remote revoke failed.");
    } finally {
      setAccountBusy(false);
    }
  };

  // Callback to handle drag rotations inside VolumetricViewer canvas
  const handleRotationChange = (pitch: number, yaw: number) => {
    setLocalPitch(pitch);
    setLocalYaw(yaw);
  };

  // 3. Resolve active objects
  const activeDataset = useMemo(() => {
    return localDatasets.find((d) => d.slug === currentDatasetSlug) || defaultDataset;
  }, [localDatasets, currentDatasetSlug, defaultDataset]);

  const activeDerivative = useMemo(() => {
    if (!activeDataset) return null;
    return (
      activeDataset.derivatives.find((d) => d.source_relative_path === currentAssetPath) ||
      activeDataset.derivatives[0] ||
      null
    );
  }, [activeDataset, currentAssetPath]);
  const activeVolumeKey =
    activeDataset && activeDerivative
      ? `${activeDataset.slug}::${activeDerivative.source_relative_path}`
      : "";
  const lastActiveVolumeKeyRef = useRef(activeVolumeKey);
  const activeVolumeFileCount = activeDataset?.derivatives.length || 0;

  // Voxel shapes: Z, Y, X
  const zMax = activeDerivative?.shape_zyx[0] || 1;
  const yMax = activeDerivative?.shape_zyx[1] || 1;
  const xMax = activeDerivative?.shape_zyx[2] || 1;
  const currentZSlice = clampIndex(Number(searchParams.get("zSlice") ?? Math.floor(zMax / 2)), zMax);
  const currentYSlice = clampIndex(Number(searchParams.get("ySlice") ?? Math.floor(yMax / 2)), yMax);
  const currentXSlice = clampIndex(Number(searchParams.get("xSlice") ?? Math.floor(xMax / 2)), xMax);
  const [orthogonalDraft, setOrthogonalDraft] = useState(() => ({
    x: currentXSlice,
    y: currentYSlice,
    z: currentZSlice,
  }));
  const [orthogonalCommitted, setOrthogonalCommitted] = useState(() => ({
    x: currentXSlice,
    y: currentYSlice,
    z: currentZSlice,
  }));

  useEffect(() => {
    const next = { x: currentXSlice, y: currentYSlice, z: currentZSlice };
    setOrthogonalDraft(next);
    setOrthogonalCommitted(next);
  }, [currentDatasetSlug, currentAssetPath, currentXSlice, currentYSlice, currentZSlice, xMax, yMax, zMax]);

  useEffect(() => {
    if (lastActiveVolumeKeyRef.current === activeVolumeKey) return;
    lastActiveVolumeKeyRef.current = activeVolumeKey;

    setMeasurementDraft(null);
    setSelectedMeasurementId(null);
    setRoiDraft(null);
    setSelectedRoiId(null);
    setActiveProbe(null);
    setHistogramData(new Array(256).fill(0));
    viewerLoadingSources.current = {};
    setViewerStreaming(false);
    setMeasurementStatus(measurementMode ? "Click a start point on any 2D plane." : "Measurement mode off.");
    setRoiStatus(
      roiTool === "point"
        ? "Point ROI tool active. Click a 2D plane."
        : roiTool === "box"
        ? "Box ROI tool active. Click two corners on the same 2D plane."
        : "ROI tool off."
    );
  }, [activeVolumeKey, measurementMode, roiTool]);

  const orthogonalQueued =
    orthogonalDraft.x !== orthogonalCommitted.x ||
    orthogonalDraft.y !== orthogonalCommitted.y ||
    orthogonalDraft.z !== orthogonalCommitted.z;

  // Clamp current slice based on active axis limits
  const maxSlicesForAxis = useMemo(() => {
    if (currentAxis === "z") return zMax;
    if (currentAxis === "y") return yMax;
    return xMax;
  }, [currentAxis, zMax, yMax, xMax]);
  const currentClampedSlice = clampIndex(currentSlice, maxSlicesForAxis);

  // Keep state updated in case parameters go out of bounds
  useEffect(() => {
    if (currentSlice < 0 || currentSlice >= maxSlicesForAxis) {
      updateUrlParams({ slice: Math.max(0, maxSlicesForAxis - 1) });
    }
  }, [currentSlice, maxSlicesForAxis]);

  // Voxel dimensions for rendering and metric calculation
  const voxelSizeZ = Number(activeDerivative?.physical_voxel_size_nm?.z || 1);
  const voxelSizeY = Number(activeDerivative?.physical_voxel_size_nm?.y || 1);
  const voxelSizeX = Number(activeDerivative?.physical_voxel_size_nm?.x || 1);

  // 4. Update url helper
  const updateUrlParams = (updates: Record<string, string | number | boolean | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined || val === null || val === "") {
        params.delete(key);
      } else {
        params.set(key, String(val));
      }
    }
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`
    );
    setQueryString(window.location.search);
  };

  useEffect(() => {
    if (currentViewMode !== "orthogonal" || !orthogonalQueued) return;

    const next = {
      x: clampIndex(orthogonalDraft.x, xMax),
      y: clampIndex(orthogonalDraft.y, yMax),
      z: clampIndex(orthogonalDraft.z, zMax),
    };

    const handler = window.setTimeout(() => {
      setOrthogonalCommitted(next);
      updateUrlParams({
        xSlice: next.x,
        ySlice: next.y,
        zSlice: next.z,
      });
    }, 140);

    return () => window.clearTimeout(handler);
  }, [currentViewMode, orthogonalQueued, orthogonalDraft.x, orthogonalDraft.y, orthogonalDraft.z, xMax, yMax, zMax]);

  // Switch Dataset
  const handleDatasetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const slug = e.target.value;
    const targetDataset = localDatasets.find((d) => d.slug === slug);
    const targetDeriv = targetDataset?.derivatives[0];
    
    // Choose sensible default limits based on voxel types
    const maxVal = derivativeDefaultContrastMax(targetDeriv);

    updateUrlParams({
      dataset: slug,
      asset: targetDeriv ? targetDeriv.source_relative_path : null,
      axis: "z",
      slice: 0,
      zSlice: targetDeriv ? Math.floor(targetDeriv.shape_zyx[0] / 2) : 0,
      ySlice: targetDeriv ? Math.floor(targetDeriv.shape_zyx[1] / 2) : 0,
      xSlice: targetDeriv ? Math.floor(targetDeriv.shape_zyx[2] / 2) : 0,
      viewMode: "orthogonal",
      minContrast: 0,
      maxContrast: maxVal,
      colormap: 0,
      logScale: false,
    });
  };

  // Switch Asset File within Dataset
  const handleAssetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const path = e.target.value;
    const targetDeriv = activeDataset?.derivatives.find((d) => d.source_relative_path === path);
    const maxVal = derivativeDefaultContrastMax(targetDeriv);

    updateUrlParams({
      asset: path,
      slice: 0,
      zSlice: targetDeriv ? Math.floor(targetDeriv.shape_zyx[0] / 2) : 0,
      ySlice: targetDeriv ? Math.floor(targetDeriv.shape_zyx[1] / 2) : 0,
      xSlice: targetDeriv ? Math.floor(targetDeriv.shape_zyx[2] / 2) : 0,
      minContrast: 0,
      maxContrast: maxVal,
    });
  };

  // Dynamic Metadata callbacks from VolumetricViewer
  const [maxPossibleIntensity, setMaxPossibleIntensity] = useState(255);
  const handleLoadedMetadata = ({ maxPossible }: { maxPossible: number }) => {
    setMaxPossibleIntensity(maxPossible);
    // If contrast boundaries are currently at the default 255 but the loaded dataset is 65535, adjust automatically.
    if (currentMaxContrast === 255 && maxPossible > 255) {
      updateUrlParams({ maxContrast: maxPossible });
    }
  };

  const handleOrthogonalSliceChange = (next: { x?: number; y?: number; z?: number }) => {
    setOrthogonalDraft((prev) => ({
      x: next.x === undefined ? prev.x : clampIndex(next.x, xMax),
      y: next.y === undefined ? prev.y : clampIndex(next.y, yMax),
      z: next.z === undefined ? prev.z : clampIndex(next.z, zMax),
    }));
  };

  // Metric computations
  const totalVolumeUm3 = useMemo(() => {
    if (!activeDerivative) return 0;
    const totalVoxels = zMax * yMax * xMax;
    const voxelVolNm3 = voxelSizeZ * voxelSizeY * voxelSizeX;
    return (totalVoxels * voxelVolNm3) / 1e9; // 1 micrometer^3 = 10^9 nanometer^3
  }, [activeDerivative, zMax, yMax, xMax, voxelSizeZ, voxelSizeY, voxelSizeX]);

  const activeSliceAreaUm2 = useMemo(() => {
    if (!activeDerivative) return 0;
    let widthNm = 0;
    let heightNm = 0;
    if (currentAxis === "z") {
      widthNm = xMax * voxelSizeX;
      heightNm = yMax * voxelSizeY;
    } else if (currentAxis === "y") {
      widthNm = xMax * voxelSizeX;
      heightNm = zMax * voxelSizeZ;
    } else {
      widthNm = yMax * voxelSizeY;
      heightNm = zMax * voxelSizeZ;
    }
    return (widthNm * heightNm) / 1e6; // 1 micrometer^2 = 10^6 nanometer^2
  }, [currentAxis, activeDerivative, zMax, yMax, xMax, voxelSizeZ, voxelSizeY, voxelSizeX]);

  // Group findings related to active asset or active dataset
  const activeFindings = useMemo(() => {
    if (!activeDataset) return [];
    return activeDataset.findings.filter(
      (f) =>
        !f.asset_relative_path ||
        f.asset_relative_path === activeDerivative?.source_relative_path
    );
  }, [activeDataset, activeDerivative]);
  const activeMeasurements = useMemo(() => {
    if (!activeDataset || !activeDerivative) return [];
    return measurements
      .filter(
        (measurement) =>
          measurement.datasetSlug === activeDataset.slug &&
          measurement.assetPath === activeDerivative.source_relative_path
      )
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  }, [measurements, activeDataset, activeDerivative]);
  const activeRois = useMemo(() => {
    if (!activeDataset || !activeDerivative) return [];
    return rois
      .filter(
        (roi) =>
          roi.datasetSlug === activeDataset.slug &&
          roi.assetPath === activeDerivative.source_relative_path
      )
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  }, [rois, activeDataset, activeDerivative]);
  const activeJobs = useMemo(() => {
    if (!activeDataset || !activeDerivative) return [];
    return jobs
      .filter(
        (job) =>
          job.datasetSlug === activeDataset.slug &&
          job.assetPath === activeDerivative.source_relative_path
      )
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  }, [jobs, activeDataset, activeDerivative]);
  const visibleIndexQueueDatasets = useMemo(() => {
    if (!indexQueue) return [];
    const active = activeDataset
      ? indexQueue.datasets.find((dataset) => dataset.slug === activeDataset.slug)
      : null;
    if (!active) return indexQueue.datasets;
    return [
      active,
      ...indexQueue.datasets.filter((dataset) => dataset.slug !== active.slug),
    ];
  }, [indexQueue, activeDataset]);
  const activeIndexQueueDataset = useMemo(() => {
    if (!indexQueue || !activeDataset) return null;
    return indexQueue.datasets.find((dataset) => dataset.slug === activeDataset.slug) || null;
  }, [indexQueue, activeDataset]);
  const activeReadyConversionCount = useMemo(() => {
    if (!activeIndexQueueDataset) return 0;
    return activeIndexQueueDataset.assets.filter((asset) => Boolean(asset.convert_command)).length;
  }, [activeIndexQueueDataset]);
  const indexQueueAssetLookup = useMemo(() => buildIndexQueueAssetLookup(indexQueue), [indexQueue]);
  const indexQueueMatchKeys = useMemo(() => buildIndexQueueMatchKeys(indexQueue), [indexQueue]);
  const activePrivateRegistrySummary = privateRegistrySummary || privateRegistry?.summary || null;
  const privateRegistryUsesNativeIndex = Boolean(privateRegistryNativePath);
  const privateRegistrySearchTextByAssetId = useMemo(() => {
    const lookup = new Map<string, string>();
    if (!privateRegistry) return lookup;
    for (const entry of privateRegistry.searchEntries) {
      lookup.set(entry.asset_id, `${entry.search_text} ${entry.title} ${entry.format}`.toLowerCase());
    }
    return lookup;
  }, [privateRegistry]);
  const privateRegistryQueryTokens = useMemo(
    () => privateRegistryQuery.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [privateRegistryQuery]
  );
  const privateRegistryAssetMatchesQuery = (asset: PrivateRegistryAsset) => {
    if (privateRegistryQueryTokens.length === 0) return true;
    const searchText = registryAssetSearchText(
      asset,
      privateRegistrySearchTextByAssetId.get(asset.asset_id) || ""
    );
    return privateRegistryQueryTokens.every((token) => searchText.includes(token));
  };
  const findIndexQueueAssetForRegistryAsset = (asset: PrivateRegistryAsset) =>
    findRegistryIndexQueueMatch(asset, indexQueueAssetLookup);
  const privateRegistryFilteredProjectReadyAssets = useMemo(() => {
    if (privateRegistryUsesNativeIndex) return privateRegistryProjectPage.assets;
    if (!privateRegistry) return [];
    return privateRegistry.projectReadyAssets.filter(privateRegistryAssetMatchesQuery);
  }, [privateRegistryUsesNativeIndex, privateRegistryProjectPage.assets, privateRegistry, privateRegistryQueryTokens, privateRegistrySearchTextByAssetId]);
  const privateRegistryFilteredConversionQueueAssets = useMemo(() => {
    if (privateRegistryUsesNativeIndex) return privateRegistryConversionPage.assets;
    if (!privateRegistry) return [];
    return privateRegistry.conversionQueueAssets.filter((asset) => {
      if (!privateRegistryAssetMatchesQuery(asset)) return false;
      const reviewBlockers = registryAssetReviewBlockers(asset);
      if (privateRegistryQueueFilter === "ready") return reviewBlockers.length === 0;
      if (privateRegistryQueueFilter === "review") return reviewBlockers.length > 0 || asset.status.review_required;
      if (privateRegistryQueueFilter === "matched") return Boolean(findIndexQueueAssetForRegistryAsset(asset));
      return true;
    });
  }, [privateRegistryUsesNativeIndex, privateRegistryConversionPage.assets, privateRegistry, privateRegistryQueryTokens, privateRegistrySearchTextByAssetId, privateRegistryQueueFilter, indexQueueAssetLookup]);
  const privateRegistrySelectedConversionAssetSet = useMemo(
    () => new Set(privateRegistrySelectedConversionAssetIds),
    [privateRegistrySelectedConversionAssetIds]
  );
  const privateRegistrySelectedConversionAssets = useMemo(
    () =>
      privateRegistryFilteredConversionQueueAssets.filter((asset) =>
        privateRegistrySelectedConversionAssetSet.has(asset.asset_id)
      ),
    [privateRegistryFilteredConversionQueueAssets, privateRegistrySelectedConversionAssetSet]
  );
  const privateRegistryMatchedVisibleConversionCount = useMemo(
    () =>
      privateRegistryFilteredConversionQueueAssets.filter((asset) => {
        const match = findIndexQueueAssetForRegistryAsset(asset);
        return Boolean(match?.asset.convert_command);
      }).length,
    [privateRegistryFilteredConversionQueueAssets, indexQueueAssetLookup]
  );
  const privateRegistryFilteredReviewAssets = useMemo(() => {
    if (privateRegistryUsesNativeIndex) return privateRegistryReviewPage.assets;
    if (!privateRegistry) return [];
    return privateRegistry.reviewAssets.filter(privateRegistryAssetMatchesQuery);
  }, [privateRegistryUsesNativeIndex, privateRegistryReviewPage.assets, privateRegistry, privateRegistryQueryTokens, privateRegistrySearchTextByAssetId]);
  const privateRegistryProjectReadyTotal = privateRegistryUsesNativeIndex
    ? privateRegistryProjectPage.totalCount
    : privateRegistryFilteredProjectReadyAssets.length;
  const privateRegistryConversionQueueTotal = privateRegistryUsesNativeIndex
    ? privateRegistryConversionPage.totalCount
    : privateRegistryFilteredConversionQueueAssets.length;
  const privateRegistryReviewTotal = privateRegistryUsesNativeIndex
    ? privateRegistryReviewPage.totalCount
    : privateRegistryFilteredReviewAssets.length;
  const visibleIndexJobs = useMemo(() => indexJobs.slice(0, 6), [indexJobs]);
  const visibleIndexBatchRuns = useMemo(() => indexBatchRuns.slice(0, 3), [indexBatchRuns]);
  const findIndexJob = (kind: "convert" | "slices", datasetSlug: string, assetPath: string) =>
    indexJobs.find(
      (job) =>
        job.kind === kind &&
        job.dataset_slug === datasetSlug &&
        job.asset_relative_path === assetPath
    );
  const activeValidation = activeDerivative?.validation;
  const activeValidationChecks = useMemo(
    () => Object.entries(activeValidation?.checks || {}),
    [activeValidation]
  );
  const activeValidationOk =
    activeValidation?.status === "ready" || activeValidation?.status === "passed";
  const activeValidationColor =
    activeValidationOk
      ? "var(--atlas-blue-dark)"
      : activeValidation?.status === "warning"
      ? "var(--atlas-orange)"
      : "var(--atlas-orange)";
  const streamState = viewerStreaming ? "STREAMING" : orthogonalQueued ? "QUEUED" : "READY";
  const visibleImportReport = importStatus?.report || localOpenReport;
  const visibleImportChecks = Object.entries(visibleImportReport?.checks || {});
  const importStatusColor =
    importStatus?.kind === "ready" || visibleImportReport?.status === "ready" || visibleImportReport?.status === "passed"
      ? "var(--atlas-blue-dark)"
      : "var(--atlas-orange)";
  const defaultSessionName = activeDataset
    ? `${activeDataset.slug} ${currentViewMode} Z${currentZSlice + 1} Y${currentYSlice + 1} X${currentXSlice + 1}`
    : "Workbench Session";

  const saveCurrentSession = () => {
    if (!activeDataset || !activeDerivative) return;

    const now = new Date().toISOString();
    const name = sessionName.trim() || defaultSessionName;
    const existing = savedSessions.find((session) => session.name.toLowerCase() === name.toLowerCase());
    const snapshot: WorkbenchSessionSnapshot = {
      id: existing?.id || `session_${Date.now()}`,
      name,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      datasetSlug: activeDataset.slug,
      datasetTitle: activeDataset.title,
      assetPath: activeDerivative.source_relative_path,
      sourcePath: activeDerivative.source_local_path || activeDerivative.output_path,
      viewMode: currentViewMode,
      axis: currentAxis,
      slice: currentClampedSlice,
      xSlice: currentXSlice,
      ySlice: currentYSlice,
      zSlice: currentZSlice,
      minContrast: currentMinContrast,
      maxContrast: currentMaxContrast,
      colormap: currentColormap,
      logScale: currentLogScale,
      downsample: currentDownsample,
      pitch: localPitch,
      yaw: localYaw,
      alphaScale: localAlphaScale,
      note: sessionNote,
      measurements: activeMeasurements,
      rois: activeRois,
    };

    setSavedSessions((previous) => {
      const next = [
        snapshot,
        ...previous.filter((session) => session.id !== snapshot.id),
      ]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, MAX_WORKBENCH_SESSIONS);
      writeStoredArray(WORKBENCH_SESSIONS_STORAGE_KEY, next);
      return next;
    });
    setSessionName("");
    setSessionStatus(`Saved "${name}".`);
  };

  const restoreSession = (session: WorkbenchSessionSnapshot) => {
    const datasetExists = localDatasets.some((dataset) => dataset.slug === session.datasetSlug);
    if (!datasetExists) {
      setSessionStatus(`Cannot restore "${session.name}" until its dataset is available.`);
      setImportStatus({
        kind: "warning",
        path: session.sourcePath,
        summary: session.sourcePath
          ? "This saved session references a local dataset. Reopen that source path from Recent Local Data, then restore again."
          : "This saved session references a dataset that is not currently indexed.",
      });
      return;
    }

    updateUrlParams({
      dataset: session.datasetSlug,
      asset: session.assetPath,
      viewMode: session.viewMode,
      axis: session.axis,
      slice: session.slice,
      xSlice: session.xSlice,
      ySlice: session.ySlice,
      zSlice: session.zSlice,
      minContrast: session.minContrast,
      maxContrast: session.maxContrast,
      colormap: session.colormap,
      logScale: session.logScale,
      downsample: session.downsample,
      pitch: session.pitch.toFixed(3),
      yaw: session.yaw.toFixed(3),
      alphaScale: session.alphaScale.toFixed(3),
    });
    setLocalPitch(session.pitch);
    setLocalYaw(session.yaw);
    setLocalAlphaScale(session.alphaScale);
    setSessionNote(session.note || "");
    setSessionName(session.name);
    if (session.measurements?.length) {
      setMeasurements((previous) => {
        const incomingIds = new Set(session.measurements?.map((measurement) => measurement.id));
        return [
          ...(session.measurements || []),
          ...previous.filter((measurement) => !incomingIds.has(measurement.id)),
        ].slice(0, MAX_WORKBENCH_MEASUREMENTS);
      });
    }
    if (session.rois?.length) {
      setRois((previous) => {
        const incomingIds = new Set(session.rois?.map((roi) => roi.id));
        return [
          ...(session.rois || []),
          ...previous.filter((roi) => !incomingIds.has(roi.id)),
        ].slice(0, MAX_WORKBENCH_ROIS);
      });
    }
    setSessionStatus(`Restored "${session.name}".`);
  };

  const deleteSession = (sessionId: string) => {
    setSavedSessions((previous) => {
      const next = previous.filter((session) => session.id !== sessionId);
      writeStoredArray(WORKBENCH_SESSIONS_STORAGE_KEY, next);
      return next;
    });
    setSessionStatus("Saved session removed.");
  };

  const distanceBetweenPointsUm = (start: VoxelPoint, end: VoxelPoint) => {
    const dx = (end.x - start.x) * voxelSizeX;
    const dy = (end.y - start.y) * voxelSizeY;
    const dz = (end.z - start.z) * voxelSizeZ;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) / 1000;
  };

  const nextMeasurementLabel = () => {
    const highest = activeMeasurements.reduce((max, measurement) => {
      const match = /^M(\d+)$/i.exec(String(measurement.label || "").trim());
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `M${highest + 1}`;
  };

  const measurementCenterPoint = (measurement: MeasurementRecord) => ({
    x: clampIndex((measurement.start.x + measurement.end.x) / 2, xMax),
    y: clampIndex((measurement.start.y + measurement.end.y) / 2, yMax),
    z: clampIndex((measurement.start.z + measurement.end.z) / 2, zMax),
  });

  const toggleMeasurementMode = () => {
    const nextMode = !measurementMode;
    if (nextMode) {
      setRoiTool("off");
      setRoiDraft(null);
      setRoiStatus("ROI tool off.");
      if (currentViewMode === "3d") {
        updateUrlParams({ viewMode: "2d" });
      }
    }
    setMeasurementMode(nextMode);
    setMeasurementDraft(null);
    setMeasurementStatus(nextMode ? "Click a start point on any 2D plane." : "Measurement mode off.");
  };

  const handleMeasurementPoint = (
    point: VoxelPoint,
    context: { axis: "z" | "y" | "x"; slice: number }
  ) => {
    if (!activeDataset || !activeDerivative) return;

    if (
      !measurementDraft ||
      measurementDraft.axis !== context.axis ||
      measurementDraft.slice !== context.slice
    ) {
      setMeasurementDraft({ point, ...context });
      setMeasurementStatus(`Start point set on ${context.axis.toUpperCase()} slice ${context.slice + 1}. Click an end point.`);
      return;
    }

    const distanceUm = distanceBetweenPointsUm(measurementDraft.point, point);
    const createdAt = new Date().toISOString();
    const nextMeasurement: MeasurementRecord = {
      id: `measurement_${Date.now()}`,
      label: nextMeasurementLabel(),
      datasetSlug: activeDataset.slug,
      assetPath: activeDerivative.source_relative_path,
      axis: context.axis,
      slice: context.slice,
      start: measurementDraft.point,
      end: point,
      distanceUm,
      createdAt,
      note: "",
    };

    setMeasurements((previous) => [nextMeasurement, ...previous].slice(0, MAX_WORKBENCH_MEASUREMENTS));
    setSelectedMeasurementId(nextMeasurement.id);
    setMeasurementDraft(null);
    setMeasurementStatus(`Saved ${nextMeasurement.label}: ${formatDistance(distanceUm)}.`);
  };

  const deleteMeasurement = (measurementId: string) => {
    setMeasurements((previous) => previous.filter((measurement) => measurement.id !== measurementId));
    setSelectedMeasurementId((current) => (current === measurementId ? null : current));
    setMeasurementStatus("Measurement removed.");
  };

  const updateMeasurement = (measurementId: string, updates: { label?: string; note?: string }) => {
    setMeasurements((previous) =>
      previous.map((measurement) =>
        measurement.id === measurementId
          ? {
              ...measurement,
              label: updates.label === undefined ? measurement.label : updates.label.slice(0, 40),
              note: updates.note === undefined ? measurement.note : updates.note.slice(0, 240),
            }
          : measurement
      )
    );
  };

  const jumpToMeasurement = (measurement: MeasurementRecord) => {
    const center = measurementCenterPoint(measurement);
    updateUrlParams({
      dataset: measurement.datasetSlug,
      asset: measurement.assetPath,
      viewMode: currentViewMode === "3d" ? "2d" : currentViewMode,
      axis: measurement.axis,
      slice: measurement.slice,
      xSlice: center.x,
      ySlice: center.y,
      zSlice: center.z,
    });
    setSelectedMeasurementId(measurement.id);
    setActiveTab("telemetry");
    setMeasurementStatus(`Jumped to ${measurement.label || "measurement"} on ${measurement.axis.toUpperCase()} slice ${measurement.slice + 1}.`);
  };

  const undoLastMeasurement = () => {
    const lastMeasurement = activeMeasurements[0];
    if (!lastMeasurement) return;
    deleteMeasurement(lastMeasurement.id);
    setMeasurementStatus(`Removed ${lastMeasurement.label || "latest measurement"}.`);
  };

  const clearMeasurementDraft = () => {
    setMeasurementDraft(null);
    setMeasurementStatus(measurementMode ? "Draft cleared. Click a start point." : "Measurement draft cleared.");
  };

  const exportMeasurementsCsv = () => {
    if (!activeMeasurements.length) {
      setMeasurementStatus("No active measurements to export.");
      return;
    }

    const header = [
      "label",
      "distance_um",
      "axis",
      "slice_index_1based",
      "start_x_1based",
      "start_y_1based",
      "start_z_1based",
      "end_x_1based",
      "end_y_1based",
      "end_z_1based",
      "dataset_slug",
      "asset_path",
      "created_at",
      "note",
    ];
    const rows = activeMeasurements.map((measurement) => [
      measurement.label,
      measurement.distanceUm.toFixed(6),
      measurement.axis,
      measurement.slice + 1,
      measurement.start.x + 1,
      measurement.start.y + 1,
      measurement.start.z + 1,
      measurement.end.x + 1,
      measurement.end.y + 1,
      measurement.end.z + 1,
      measurement.datasetSlug,
      measurement.assetPath,
      measurement.createdAt,
      measurement.note || "",
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
    const name = sanitizeFileSegment(activeDataset?.slug || "workbench-measurements");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob(new Blob([`${csv}\n`], { type: "text/csv;charset=utf-8" }), `${name}-${stamp}.measurements.csv`);
    setMeasurementStatus(`Exported ${activeMeasurements.length} measurements as CSV.`);
  };

  const clearActiveMeasurements = () => {
    if (!activeDataset || !activeDerivative) return;
    setMeasurements((previous) =>
      previous.filter(
        (measurement) =>
          measurement.datasetSlug !== activeDataset.slug ||
          measurement.assetPath !== activeDerivative.source_relative_path
      )
    );
    setMeasurementDraft(null);
    setSelectedMeasurementId(null);
    setMeasurementStatus("Cleared measurements for the active volume.");
  };

  const nextRoiLabel = () => {
    const highest = activeRois.reduce((max, roi) => {
      const match = /^R(\d+)$/i.exec(String(roi.label || "").trim());
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `R${highest + 1}`;
  };

  const roiCenterPoint = (roi: RoiRecord) => ({
    x: clampIndex(((roi.end?.x ?? roi.start.x) + roi.start.x) / 2, xMax),
    y: clampIndex(((roi.end?.y ?? roi.start.y) + roi.start.y) / 2, yMax),
    z: clampIndex(((roi.end?.z ?? roi.start.z) + roi.start.z) / 2, zMax),
  });

  const toggleRoiTool = (tool: "point" | "box") => {
    const nextTool = roiTool === tool ? "off" : tool;
    setRoiTool(nextTool);
    setRoiDraft(null);
    if (nextTool !== "off") {
      setMeasurementMode(false);
      setMeasurementDraft(null);
      setMeasurementStatus("Measurement mode off.");
      if (currentViewMode === "3d") {
        updateUrlParams({ viewMode: "2d" });
      }
    }
    setRoiStatus(
      nextTool === "point"
        ? "Point ROI tool active. Click a 2D plane."
        : nextTool === "box"
        ? "Box ROI tool active. Click two corners on the same 2D plane."
        : "ROI tool off."
    );
  };

  const saveRoi = (roi: Omit<RoiRecord, "id" | "label" | "datasetSlug" | "assetPath" | "createdAt" | "note">) => {
    if (!activeDataset || !activeDerivative) return null;
    const createdAt = new Date().toISOString();
    const nextRoi: RoiRecord = {
      ...roi,
      id: `roi_${Date.now()}`,
      label: nextRoiLabel(),
      datasetSlug: activeDataset.slug,
      assetPath: activeDerivative.source_relative_path,
      createdAt,
      note: "",
    };
    setRois((previous) => [nextRoi, ...previous].slice(0, MAX_WORKBENCH_ROIS));
    setSelectedRoiId(nextRoi.id);
    return nextRoi;
  };

  const handleRoiPoint = (point: VoxelPoint, context: { axis: "z" | "y" | "x"; slice: number }) => {
    if (!activeDataset || !activeDerivative || roiTool === "off") return;

    if (roiTool === "point") {
      const nextRoi = saveRoi({
        kind: "point",
        category: "unknown",
        axis: context.axis,
        slice: context.slice,
        start: point,
        color: "rgba(31, 111, 135, 0.96)",
      });
      if (nextRoi) setRoiStatus(`Saved ${nextRoi.label} point ROI at ${formatVoxelPoint(point)}.`);
      return;
    }

    if (!roiDraft || roiDraft.axis !== context.axis || roiDraft.slice !== context.slice) {
      setRoiDraft({ kind: "box", point, ...context });
      setRoiStatus(`Box start set on ${context.axis.toUpperCase()} slice ${context.slice + 1}. Click opposite corner.`);
      return;
    }

    const nextRoi = saveRoi({
      kind: "box",
      category: "unknown",
      axis: context.axis,
      slice: context.slice,
      start: roiDraft.point,
      end: point,
      color: "rgba(31, 111, 135, 0.96)",
    });
    setRoiDraft(null);
    if (nextRoi) setRoiStatus(`Saved ${nextRoi.label} box ROI.`);
  };

  const updateRoi = (roiId: string, updates: { label?: string; category?: string; note?: string }) => {
    setRois((previous) =>
      previous.map((roi) =>
        roi.id === roiId
          ? {
              ...roi,
              label: updates.label === undefined ? roi.label : updates.label.slice(0, 40),
              category: updates.category === undefined ? roi.category : updates.category.slice(0, 40),
              note: updates.note === undefined ? roi.note : updates.note.slice(0, 280),
            }
          : roi
      )
    );
  };

  const deleteRoi = (roiId: string) => {
    setRois((previous) => previous.filter((roi) => roi.id !== roiId));
    setSelectedRoiId((current) => (current === roiId ? null : current));
    setRoiStatus("ROI removed.");
  };

  const jumpToRoi = (roi: RoiRecord) => {
    const center = roiCenterPoint(roi);
    updateUrlParams({
      dataset: roi.datasetSlug,
      asset: roi.assetPath,
      viewMode: currentViewMode === "3d" ? "2d" : currentViewMode,
      axis: roi.axis,
      slice: roi.slice,
      xSlice: center.x,
      ySlice: center.y,
      zSlice: center.z,
    });
    setSelectedRoiId(roi.id);
    setActiveTab("telemetry");
    setRoiStatus(`Jumped to ${roi.label || "ROI"} on ${roi.axis.toUpperCase()} slice ${roi.slice + 1}.`);
  };

  const exportRoisJson = () => {
    if (!activeRois.length) {
      setRoiStatus("No active ROIs to export.");
      return;
    }
    const name = sanitizeFileSegment(activeDataset?.slug || "workbench-rois");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob(
      new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), rois: activeRois }, null, 2)], {
        type: "application/json",
      }),
      `${name}-${stamp}.rois.json`
    );
    setRoiStatus(`Exported ${activeRois.length} ROIs.`);
  };

  const clearRoiDraft = () => {
    setRoiDraft(null);
    setRoiStatus(roiTool === "box" ? "Draft cleared. Click a box start point." : "ROI draft cleared.");
  };

  const clearActiveRois = () => {
    if (!activeDataset || !activeDerivative) return;
    setRois((previous) =>
      previous.filter(
        (roi) =>
          roi.datasetSlug !== activeDataset.slug ||
          roi.assetPath !== activeDerivative.source_relative_path
      )
    );
    setRoiDraft(null);
    setSelectedRoiId(null);
    setRoiStatus("Cleared ROIs for the active volume.");
  };

  const addCompletedJob = (job: Omit<LocalJobRecord, "id" | "datasetSlug" | "assetPath" | "status" | "createdAt">) => {
    if (!activeDataset || !activeDerivative) return;
    const nextJob: LocalJobRecord = {
      ...job,
      id: `job_${Date.now()}`,
      datasetSlug: activeDataset.slug,
      assetPath: activeDerivative.source_relative_path,
      status: "completed",
      createdAt: new Date().toISOString(),
    };
    setJobs((previous) => [nextJob, ...previous].slice(0, MAX_WORKBENCH_JOBS));
    setActiveTab("jobs");
    setSessionStatus(`Completed job: ${nextJob.title}.`);
  };

  const runProjectAuditJob = () => {
    addCompletedJob({
      title: "Project Audit",
      kind: "project-audit",
      summary: `${activeMeasurements.length} measurements, ${activeRois.length} ROIs, ${savedSessions.length} saved views indexed for this workspace.`,
      result: {
        dataset: activeDataset?.slug,
        asset: activeDerivative?.source_relative_path,
        view: currentViewMetadata().view,
        dimensions: { z: zMax, y: yMax, x: xMax },
        voxelSizeNm: { z: voxelSizeZ, y: voxelSizeY, x: voxelSizeX },
        measurements: activeMeasurements.length,
        rois: activeRois.length,
        savedSessions: savedSessions.length,
        validationStatus: activeValidation?.status || "unknown",
      },
    });
  };

  const runRoiInventoryJob = () => {
    addCompletedJob({
      title: "ROI Inventory",
      kind: "roi-inventory",
      summary: `${activeRois.length} active ROIs summarized for downstream analysis.`,
      result: {
        rois: activeRois.map((roi) => ({
          id: roi.id,
          label: roi.label,
          kind: roi.kind,
          category: roi.category,
          axis: roi.axis,
          slice: roi.slice + 1,
          start: roi.start,
          end: roi.end || null,
          center: roiCenterPoint(roi),
          note: roi.note,
        })),
      },
    });
  };

  const runHistogramJob = () => {
    const total = histogramData.reduce((sum, value) => sum + value, 0);
    const maxBin = histogramData.reduce(
      (best, value, index) => (value > best.count ? { index, count: value } : best),
      { index: 0, count: 0 }
    );
    let cumulative = 0;
    const medianBin = histogramData.findIndex((value) => {
      cumulative += value;
      return cumulative >= total / 2;
    });
    addCompletedJob({
      title: "Loaded Buffer Histogram",
      kind: "histogram",
      summary: `${total.toLocaleString()} sampled voxels summarized; peak bin ${maxBin.index}.`,
      result: {
        viewMode: currentViewMode,
        axis: currentAxis,
        slice: currentClampedSlice + 1,
        totalSamples: total,
        peakBin: maxBin.index,
        peakCount: maxBin.count,
        medianBin: medianBin < 0 ? null : medianBin,
        bins: histogramData,
      },
    });
  };

  const exportJobJson = (job: LocalJobRecord) => {
    const name = sanitizeFileSegment(`${activeDataset?.slug || "caos"}-${job.title}`);
    downloadBlob(
      new Blob([JSON.stringify(job, null, 2)], { type: "application/json" }),
      `${name}.job.json`
    );
  };

  const deleteJob = (jobId: string) => {
    setJobs((previous) => previous.filter((job) => job.id !== jobId));
  };

  const loadIndexQueue = async () => {
    setIndexQueueLoading(true);
    setIndexQueueError(null);
    try {
      const payload = await volumeJson<IndexQueueResponse>("/api/volume/index-queue");
      setIndexQueue(payload);
      setIndexQueueStatus(
        payload.root_exists
          ? `Scanned ${payload.summary.assets} assets across ${payload.summary.datasets} datasets.`
          : `Public data root not found: ${payload.root}`
      );
      return payload;
    } catch (error) {
      setIndexQueueError(error instanceof Error ? error.message : "Index queue scan failed.");
      return null;
    } finally {
      setIndexQueueLoading(false);
    }
  };

  const setPrivateRegistryPage = (
    section: PrivateRegistryIndexSection,
    updater: (previous: PrivateRegistryAssetPage) => PrivateRegistryAssetPage
  ) => {
    if (section === "project_ready") {
      setPrivateRegistryProjectPage(updater);
    } else if (section === "conversion_queue") {
      setPrivateRegistryConversionPage(updater);
    } else {
      setPrivateRegistryReviewPage(updater);
    }
  };

  const queryPrivateRegistryNativePage = async (
    registryPath: string,
    section: PrivateRegistryIndexSection,
    options?: {
      query?: string;
      queueFilter?: PrivateRegistryQueueFilter;
      offset?: number;
      silent?: boolean;
    }
  ) => {
    const limit = PRIVATE_REGISTRY_PAGE_LIMITS[section];
    const query = options?.query ?? privateRegistryQuery;
    const queueFilter = section === "conversion_queue" ? (options?.queueFilter ?? privateRegistryQueueFilter) : "all";
    const offset = Math.max(0, options?.offset ?? 0);
    if (!options?.silent) {
      setPrivateRegistryPage(section, (previous) => ({ ...previous, loading: true, error: null }));
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const payload = await invoke<NativePrivateRegistryIndexQueryResult>("query_private_registry_index", {
        request: {
          registryPath,
          section,
          query,
          queueFilter,
          offset,
          limit,
          matchedKeys: queueFilter === "matched" ? indexQueueMatchKeys : undefined,
        } satisfies NativePrivateRegistryIndexQuery,
      });
      const assets = payload.assetsContents.trim()
        ? parsePrivateRegistryAssetsJsonl(payload.assetsContents)
        : [];
      setPrivateRegistryPage(section, () => ({
        assets,
        totalCount: payload.totalCount,
        offset: payload.offset,
        limit: payload.limit,
        loading: false,
        error: null,
      }));
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not query ${section} registry page.`;
      setPrivateRegistryPage(section, (previous) => ({ ...previous, loading: false, error: message }));
      if (!options?.silent) {
        setPrivateRegistryError(message);
      }
      return null;
    }
  };

  const refreshPrivateRegistryNativePages = async (
    registryPath = privateRegistryNativePath,
    options?: { query?: string; queueFilter?: PrivateRegistryQueueFilter; silent?: boolean }
  ) => {
    if (!registryPath) return [];
    const projectReady = await queryPrivateRegistryNativePage(registryPath, "project_ready", options);
    const conversionQueue = await queryPrivateRegistryNativePage(registryPath, "conversion_queue", options);
    const review = await queryPrivateRegistryNativePage(registryPath, "review", options);
    return [projectReady, conversionQueue, review].filter(Boolean);
  };

  const openPrivateRegistryNative = async () => {
    if (!isTauri) {
      setPrivateRegistryError("Private registry import is available in the desktop Workbench.");
      return;
    }
    setPrivateRegistryError(null);
    setPrivateRegistryStatus("Opening private registry...");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const file = await invoke<NativePrivateRegistryIndexFile | null>("open_private_registry_index_file");
      if (!file) {
        setPrivateRegistryStatus(null);
        return;
      }
      const summary = parsePrivateRegistrySummary(file.summaryContents);
      setPrivateRegistry(null);
      setPrivateRegistrySummary(summary);
      setPrivateWorksetSummary(null);
      setPrivateRegistryNativePath(file.path);
      setPrivateRegistryPath(file.path);
      setPrivateRegistryQuery("");
      setPrivateRegistryQueueFilter("all");
      setPrivateRegistrySelectedConversionAssetIds([]);
      setPrivateRegistryStatus(
        `Loaded ${summary.asset_count} registry assets from ${summary.registry_id}. Preparing SQLite/FTS index.`
      );
      setActiveTab("jobs");
      const results = await refreshPrivateRegistryNativePages(file.path, { query: "", queueFilter: "all" });
      const indexPath = results[0]?.indexPath;
      setPrivateRegistryStatus(
        `Loaded ${summary.asset_count} registry assets from ${summary.registry_id} using SQLite/FTS${indexPath ? ` (${formatPathBasename(indexPath)})` : ""}.`
      );
    } catch (error) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const file = await invoke<NativePrivateRegistryFile | null>("open_private_registry_file");
        if (!file) {
          setPrivateRegistryStatus(null);
          return;
        }
        const parsed = parsePrivateArchiveRegistryBundle({
          summaryContents: file.summaryContents,
          assetsContents: file.assetsContents,
          searchContents: file.searchContents,
        });
        setPrivateRegistry(parsed);
        setPrivateRegistrySummary(parsed.summary);
        setPrivateWorksetSummary(null);
        setPrivateRegistryNativePath(null);
        setPrivateRegistryPath(file.path);
        setPrivateRegistryQuery("");
        setPrivateRegistryQueueFilter("all");
        setPrivateRegistrySelectedConversionAssetIds([]);
        setPrivateRegistryStatus(
          `Loaded ${parsed.summary.asset_count} registry assets from ${parsed.summary.registry_id}.`
        );
        setActiveTab("jobs");
      } catch (fallbackError) {
        setPrivateRegistryError(fallbackError instanceof Error ? fallbackError.message : error instanceof Error ? error.message : "Private registry import failed.");
        setPrivateRegistryStatus(null);
      }
    }
  };

  const openPrivateWorksetNative = async () => {
    if (!isTauri) {
      setPrivateRegistryError("Workset import is available in the desktop Workbench.");
      return;
    }
    setPrivateRegistryError(null);
    setPrivateRegistryStatus("Opening promoted workset...");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const file = await invoke<NativePrivateWorksetFile | null>("open_private_workset_file");
      if (!file) {
        setPrivateRegistryStatus(null);
        return;
      }
      const parsed = parsePrivateWorksetBundle({
        worksetContents: file.worksetContents,
        assetsContents: file.assetsContents,
      });
      await volumeJson<{ success: boolean }>("/api/volume/private-worksets/register", {
        method: "POST",
        body: JSON.stringify({ workset_path: file.path }),
      });
      const freshQueue = await volumeJson<IndexQueueResponse>("/api/volume/index-queue");
      setPrivateRegistry(parsed.registry);
      setPrivateRegistrySummary(parsed.registry.summary);
      setPrivateWorksetSummary(parsed.workset);
      setPrivateRegistryNativePath(null);
      setPrivateRegistryPath(file.path);
      setPrivateRegistryQuery("");
      setPrivateRegistryQueueFilter("all");
      setPrivateRegistrySelectedConversionAssetIds([]);
      setPrivateRegistryProjectPage(emptyPrivateRegistryAssetPage(PRIVATE_REGISTRY_PAGE_LIMITS.project_ready));
      setPrivateRegistryConversionPage(emptyPrivateRegistryAssetPage(PRIVATE_REGISTRY_PAGE_LIMITS.conversion_queue));
      setPrivateRegistryReviewPage(emptyPrivateRegistryAssetPage(PRIVATE_REGISTRY_PAGE_LIMITS.review));
      setIndexQueue(freshQueue);
      setPrivateRegistryStatus(
        `Loaded workset ${parsed.workset.workset_id} with ${parsed.workset.summary.selected_asset_count} selected asset${parsed.workset.summary.selected_asset_count === 1 ? "" : "s"}; its authorized conversion queue is registered with the local engine.`
      );
    } catch (error) {
      setPrivateRegistryError(error instanceof Error ? error.message : "Workset import failed.");
      setPrivateRegistryStatus(null);
    }
  };

  const renderPrivateRegistryPager = (section: PrivateRegistryIndexSection, page: PrivateRegistryAssetPage) => {
    if (!privateRegistryNativePath || page.totalCount <= page.limit) return null;
    const start = page.totalCount === 0 ? 0 : page.offset + 1;
    const end = Math.min(page.totalCount, page.offset + page.assets.length);
    const previousOffset = Math.max(0, page.offset - page.limit);
    const nextOffset = page.offset + page.limit;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          className="button"
          disabled={page.loading || page.offset === 0}
          onClick={() => {
            if (section === "conversion_queue") setPrivateRegistrySelectedConversionAssetIds([]);
            void queryPrivateRegistryNativePage(privateRegistryNativePath, section, { offset: previousOffset });
          }}
          style={{ padding: "4px 6px", fontSize: 9 }}
        >
          Prev
        </button>
        <span className="muted" style={{ textAlign: "center", fontSize: 9.5, fontFamily: "var(--font-display)" }}>
          {page.loading ? "Loading" : `${start}-${end} / ${page.totalCount}`}
        </span>
        <button
          type="button"
          className="button"
          disabled={page.loading || nextOffset >= page.totalCount}
          onClick={() => {
            if (section === "conversion_queue") setPrivateRegistrySelectedConversionAssetIds([]);
            void queryPrivateRegistryNativePage(privateRegistryNativePath, section, { offset: nextOffset });
          }}
          style={{ padding: "4px 6px", fontSize: 9 }}
        >
          Next
        </button>
      </div>
    );
  };

  useEffect(() => {
    if (!privateRegistryNativePath) return;
    const handle = window.setTimeout(() => {
      void refreshPrivateRegistryNativePages(privateRegistryNativePath, {
        query: privateRegistryQuery,
        queueFilter: privateRegistryQueueFilter,
        silent: true,
      });
    }, 200);
    return () => window.clearTimeout(handle);
  }, [privateRegistryNativePath, privateRegistryQuery, privateRegistryQueueFilter, indexQueueMatchKeys]);

  const refreshWorkbenchData = async () => {
    setIndexQueueLoading(true);
    setIndexQueueError(null);
    try {
      const freshData = await volumeJson<PackagedDataset[]>("/api/volume/workbench-data");
      setLocalDatasets(freshData);
      const payload = await volumeJson<IndexQueueResponse>("/api/volume/index-queue");
      setIndexQueue(payload);
      setIndexQueueStatus(`Refreshed Workbench data: ${freshData.length} datasets available.`);
    } catch (error) {
      setIndexQueueError(error instanceof Error ? error.message : "Workbench refresh failed.");
    } finally {
      setIndexQueueLoading(false);
    }
  };

  const loadIndexJobs = async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setIndexJobsLoading(true);
    }
    try {
      const payload = await volumeJson<IndexJobsResponse>("/api/volume/index-jobs");
      setIndexJobs(payload.jobs);

      const newlyCompleted = payload.jobs.filter(
        (job) => job.status === "completed" && !completedIndexJobIds.current.has(job.id)
      );
      if (newlyCompleted.length > 0) {
        newlyCompleted.forEach((job) => completedIndexJobIds.current.add(job.id));
        const freshData = await volumeJson<PackagedDataset[]>("/api/volume/workbench-data");
        const freshQueue = await volumeJson<IndexQueueResponse>("/api/volume/index-queue");
        setLocalDatasets(freshData);
        setIndexQueue(freshQueue);
        setIndexQueueStatus(`Completed ${newlyCompleted.length} index job${newlyCompleted.length === 1 ? "" : "s"} and refreshed Workbench data.`);
        if (newlyCompleted.some((job) => job.kind === "segment")) {
          setSegmentationStatus("Segmentation completed and passed artifact validation. Select the new LABEL asset to inspect it.");
          setSegmentationError(null);
        }
      }
    } catch (error) {
      if (!options?.silent) {
        setIndexQueueError(error instanceof Error ? error.message : "Index job refresh failed.");
      }
    } finally {
      if (!options?.silent) {
        setIndexJobsLoading(false);
      }
    }
  };

  const postIndexJob = async (
    kind: "convert" | "slices",
    datasetSlug: string,
    assetRelativePath: string
  ) => {
    const payload = await volumeJson<IndexJobResponse>("/api/volume/index-jobs", {
      method: "POST",
      body: JSON.stringify({
        kind,
        dataset_slug: datasetSlug,
        asset_relative_path: assetRelativePath,
      }),
    });
    if (payload.job) {
      setIndexJobs((previous) => [payload.job!, ...previous.filter((job) => job.id !== payload.job!.id)]);
    }
    return payload.job;
  };

  const startSegmentationCandidate = async () => {
    if (!activeDataset || !activeDerivative) return;
    if (activeDerivative.role === "segmentation_labels") {
      setSegmentationError("Select the source intensity volume before starting segmentation.");
      return;
    }
    setSegmentationLoading(true);
    setSegmentationError(null);
    setSegmentationStatus("Starting local segmentation candidate.");
    try {
      const payload = await volumeJson<IndexJobResponse>("/api/volume/segmentation-jobs", {
        method: "POST",
        body: JSON.stringify({
          dataset_slug: activeDataset.slug,
          asset_relative_path: activeDerivative.source_relative_path,
          task: segmentationTask,
          threshold: segmentationThreshold,
          operator: segmentationOperator,
          label_name: segmentationLabelName.trim() || segmentationTask,
        }),
      });
      if (payload.job) {
        setIndexJobs((previous) => [payload.job!, ...previous.filter((job) => job.id !== payload.job!.id)]);
        setSegmentationStatus("Segmentation is running locally. A passed candidate label volume will appear in the asset selector when complete.");
      }
    } catch (error) {
      setSegmentationError(error instanceof Error ? error.message : "Could not start segmentation.");
      setSegmentationStatus(null);
    } finally {
      setSegmentationLoading(false);
    }
  };

  const loadIndexBatchRuns = async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setIndexBatchRunsLoading(true);
    }
    try {
      const payload = await volumeJson<IndexBatchRunsResponse>("/api/volume/index-batch-runs");
      setIndexBatchRuns(payload.runs);
    } catch (error) {
      if (!options?.silent) {
        setIndexBatchError(error instanceof Error ? error.message : "Could not load batch runs.");
      }
    } finally {
      if (!options?.silent) {
        setIndexBatchRunsLoading(false);
      }
    }
  };

  const startIndexJob = async (kind: "convert" | "slices", dataset: IndexQueueDataset, asset: IndexQueueAsset) => {
    setIndexJobsLoading(true);
    setIndexQueueError(null);
    try {
      const job = await postIndexJob(kind, dataset.slug, asset.relative_path);
      if (job) {
        setIndexQueueStatus(`Started ${kind === "convert" ? "conversion" : "slice-cache"} job for ${asset.relative_path}.`);
      }
    } catch (error) {
      setIndexQueueError(error instanceof Error ? error.message : "Could not start index job.");
    } finally {
      setIndexJobsLoading(false);
    }
  };

  const loadIndexBatchPlan = async () => {
    setIndexBatchLoading(true);
    setIndexBatchError(null);
    setIndexBatchStatus(null);
    try {
      const datasetSlug = indexBatchScope === "active" ? activeDataset?.slug || null : null;
      if (indexBatchScope === "active" && !datasetSlug) {
        setIndexBatchError("Select an active dataset before planning an active-dataset batch.");
        return;
      }
      const payload = await volumeJson<IndexBatchPlanResponse>("/api/volume/index-batch-plan", {
        method: "POST",
        body: JSON.stringify({
          kind: "convert",
          dataset_slug: datasetSlug,
          total_limit: Math.max(1, Math.min(50, Math.round(indexBatchTotalLimit))),
          per_dataset_limit: Math.max(1, Math.min(50, Math.round(indexBatchPerDatasetLimit))),
          retry_failed: indexBatchRetryFailed,
          skip_completed: true,
        }),
      });
      setIndexBatchPlan(payload);
      setIndexBatchStatus(
        `Planned ${payload.summary.planned_count} of ${payload.summary.candidate_count} conversion candidates.`
      );
    } catch (error) {
      setIndexBatchError(error instanceof Error ? error.message : "Could not build conversion batch plan.");
      setIndexBatchPlan(null);
    } finally {
      setIndexBatchLoading(false);
    }
  };

  const togglePrivateRegistryConversionSelection = (assetId: string) => {
    setPrivateRegistrySelectedConversionAssetIds((previous) =>
      previous.includes(assetId)
        ? previous.filter((id) => id !== assetId)
        : [...previous, assetId]
    );
  };

  const selectVisibleMatchedRegistryConversions = () => {
    const matchedIds = privateRegistryFilteredConversionQueueAssets
      .filter((asset) => Boolean(findIndexQueueAssetForRegistryAsset(asset)?.asset.convert_command))
      .map((asset) => asset.asset_id);
    setPrivateRegistrySelectedConversionAssetIds(matchedIds);
    setPrivateRegistryStatus(
      matchedIds.length
        ? `Selected ${matchedIds.length} matched conversion asset${matchedIds.length === 1 ? "" : "s"} from the visible registry page.`
        : "No visible conversion assets are matched to sidecar conversion commands."
    );
  };

  const buildRegistryConversionBatchPlan = async () => {
    if (privateRegistrySelectedConversionAssetIds.length === 0) {
      setIndexBatchStatus("Select registry conversion assets before building a registry batch plan.");
      return;
    }

    setIndexBatchLoading(true);
    setIndexBatchError(null);
    setIndexBatchStatus(null);
    try {
      let queue = indexQueue;
      if (!queue) {
        setPrivateRegistryStatus("Scanning sidecar index queue before planning selected registry conversions.");
        queue = await loadIndexQueue();
      }
      if (!queue) {
        setIndexBatchError("Scan the sidecar index queue before planning selected registry conversions.");
        return;
      }

      const lookup = buildIndexQueueAssetLookup(queue);
      const selectedAssets = privateRegistryFilteredConversionQueueAssets.filter((asset) =>
        privateRegistrySelectedConversionAssetIds.includes(asset.asset_id)
      );
      const totalLimit = Math.max(1, Math.min(50, Math.round(indexBatchTotalLimit)));
      const perDatasetLimit = Math.max(1, Math.min(50, Math.round(indexBatchPerDatasetLimit)));
      const planId = `registry_batch_plan_${Date.now()}`;
      const createdAt = Date.now();
      const plannedItems: IndexBatchPlanItem[] = [];
      const datasetCounts = new Map<string, number>();
      let skippedActive = 0;
      let skippedCompleted = 0;
      let skippedPreviousFailed = 0;
      let skippedLimit = 0;
      let skippedUnmatched = 0;

      for (const asset of selectedAssets) {
        const match = findRegistryIndexQueueMatch(asset, lookup);
        if (!match?.asset.convert_command) {
          skippedUnmatched += 1;
          continue;
        }

        const existingJob = findIndexJob("convert", match.dataset.slug, match.asset.relative_path);
        const existingStatus = existingJob?.status || null;
        if (existingStatus && ["queued", "running", "cancel_requested"].includes(existingStatus)) {
          skippedActive += 1;
          continue;
        }
        if (existingStatus === "completed") {
          skippedCompleted += 1;
          continue;
        }
        if (existingStatus && ["failed", "cancelled"].includes(existingStatus) && !indexBatchRetryFailed) {
          skippedPreviousFailed += 1;
          continue;
        }

        const datasetCount = datasetCounts.get(match.dataset.slug) || 0;
        if (plannedItems.length >= totalLimit || datasetCount >= perDatasetLimit) {
          skippedLimit += 1;
          continue;
        }

        datasetCounts.set(match.dataset.slug, datasetCount + 1);
        plannedItems.push({
          kind: "convert",
          dataset_slug: match.dataset.slug,
          dataset_title: match.dataset.dataset?.title || asset.archive_id || match.dataset.slug,
          asset_relative_path: match.asset.relative_path,
          registry_asset_id: asset.asset_id,
          registry_relative_path: asset.relative_path,
          format: asset.metadata.format || match.asset.format || null,
          size_bytes: asset.size_bytes || match.asset.size_bytes || null,
          dimensions: asset.metadata.dimensions || match.asset.dimensions || null,
          index_status: match.asset.index_status,
          existing_job_status: existingStatus,
          command_display: match.asset.convert_command,
          start_request: {
            kind: "convert",
            dataset_slug: match.dataset.slug,
            asset_relative_path: match.asset.relative_path,
          },
        });
      }

      const plan: IndexBatchPlanResponse = {
        plan_id: planId,
        created_at_ms: createdAt,
        source: "private-registry",
        registry_id: activePrivateRegistrySummary?.registry_id || null,
        root: queue.root || activePrivateRegistrySummary?.source_scan.root || "",
        kind: "convert",
        dataset_slug: null,
        total_limit: totalLimit,
        per_dataset_limit: perDatasetLimit,
        retry_failed: indexBatchRetryFailed,
        skip_completed: true,
        summary: {
          candidate_count: selectedAssets.length,
          planned_count: plannedItems.length,
          skipped_active: skippedActive,
          skipped_completed: skippedCompleted,
          skipped_previous_failed: skippedPreviousFailed,
          skipped_limit: skippedLimit,
          datasets: datasetCounts.size,
        },
        items: plannedItems,
        checkpoint: {
          schema: "cell-anatomy-index-batch-plan",
          schema_version: 1,
          source: "private-registry-conversion-selection",
          plan_id: planId,
          registry_id: activePrivateRegistrySummary?.registry_id || null,
          kind: "convert",
          total_limit: totalLimit,
          per_dataset_limit: perDatasetLimit,
          retry_failed: indexBatchRetryFailed,
          skip_completed: true,
          selected_registry_asset_ids: selectedAssets.map((asset) => asset.asset_id),
          skipped_unmatched: skippedUnmatched,
          planned_keys: plannedItems.map((item) => ({
            dataset_slug: item.dataset_slug,
            asset_relative_path: item.asset_relative_path,
            registry_asset_id: item.registry_asset_id,
          })),
        },
      };

      setIndexBatchPlan(plan);
      setIndexBatchStatus(
        `Planned ${plannedItems.length} selected registry conversion${plannedItems.length === 1 ? "" : "s"} from ${selectedAssets.length} selected asset${selectedAssets.length === 1 ? "" : "s"}${skippedUnmatched ? `; ${skippedUnmatched} unmatched or missing commands` : ""}.`
      );
      setActiveTab("jobs");
    } catch (error) {
      setIndexBatchError(error instanceof Error ? error.message : "Could not build registry conversion batch plan.");
      setIndexBatchPlan(null);
    } finally {
      setIndexBatchLoading(false);
    }
  };

  const exportIndexBatchPlan = () => {
    if (!indexBatchPlan) return;
    const name = sanitizeFileSegment(`${indexBatchPlan.kind}-${indexBatchPlan.plan_id}`);
    downloadBlob(
      new Blob([JSON.stringify(indexBatchPlan, null, 2)], { type: "application/json" }),
      `${name}.batch-plan.json`
    );
    setIndexBatchStatus("Exported conversion batch plan checkpoint.");
  };

  const startIndexBatchRun = async () => {
    if (!indexBatchPlan || indexBatchPlan.items.length === 0) {
      setIndexBatchStatus("Build a non-empty conversion batch plan first.");
      return;
    }
    setIndexBatchLoading(true);
    setIndexBatchError(null);
    try {
      const payload = await volumeJson<IndexBatchRunResponse>("/api/volume/index-batch-runs", {
        method: "POST",
        body: JSON.stringify({
          plan: indexBatchPlan,
          concurrency: Math.max(1, Math.min(8, Math.round(indexBatchConcurrency))),
        }),
      });
      if (payload.run) {
        setIndexBatchRuns((previous) => [payload.run!, ...previous.filter((run) => run.id !== payload.run!.id)]);
        setIndexBatchStatus(
          `Started batch run with ${payload.run.summary.total} planned item${payload.run.summary.total === 1 ? "" : "s"} at concurrency ${payload.run.concurrency}.`
        );
      }
      await loadIndexBatchRuns({ silent: true });
      await loadIndexJobs({ silent: true });
    } catch (error) {
      setIndexBatchError(error instanceof Error ? error.message : "Could not start planned conversion run.");
    } finally {
      setIndexBatchLoading(false);
    }
  };

  const cancelIndexBatchRun = async (run: IndexBatchRunRecord) => {
    setIndexBatchRunsLoading(true);
    setIndexBatchError(null);
    try {
      const payload = await volumeJson<IndexBatchRunResponse>(`/api/volume/index-batch-runs/${encodeURIComponent(run.id)}/cancel`, {
        method: "POST",
      });
      if (payload.run) {
        setIndexBatchRuns((previous) => previous.map((existing) => existing.id === payload.run!.id ? payload.run! : existing));
        setIndexBatchStatus(`Cancellation requested for batch run ${run.id}.`);
      }
      await loadIndexBatchRuns({ silent: true });
      await loadIndexJobs({ silent: true });
    } catch (error) {
      setIndexBatchError(error instanceof Error ? error.message : "Could not cancel batch run.");
    } finally {
      setIndexBatchRunsLoading(false);
    }
  };

  const resumeIndexBatchRun = async (run: IndexBatchRunRecord) => {
    setIndexBatchRunsLoading(true);
    setIndexBatchError(null);
    try {
      const payload = await volumeJson<IndexBatchRunResponse>(`/api/volume/index-batch-runs/${encodeURIComponent(run.id)}/resume`, {
        method: "POST",
        body: JSON.stringify({ retry_failed: indexBatchRetryFailed }),
      });
      if (payload.run) {
        setIndexBatchRuns((previous) => [payload.run!, ...previous.filter((existing) => existing.id !== payload.run!.id)]);
        setIndexBatchStatus(`Resumed batch run ${run.id}.`);
      }
      await loadIndexBatchRuns({ silent: true });
      await loadIndexJobs({ silent: true });
    } catch (error) {
      setIndexBatchError(error instanceof Error ? error.message : "Could not resume batch run.");
    } finally {
      setIndexBatchRunsLoading(false);
    }
  };

  const startRegistryConversionAsset = async (asset: PrivateRegistryAsset) => {
    setActiveTab("jobs");
    let match = findIndexQueueAssetForRegistryAsset(asset);
    if (!match) {
      setIndexQueueStatus(`Scanning index queue for ${asset.relative_path}.`);
      const freshQueue = await loadIndexQueue();
      match = freshQueue
        ? findRegistryIndexQueueMatch(asset, buildIndexQueueAssetLookup(freshQueue))
        : null;
    }
    if (!match) {
      setIndexQueueStatus(`No sidecar conversion match for ${asset.relative_path}.`);
      return;
    }
    if (!match.asset.convert_command) {
      setIndexQueueStatus(`${asset.relative_path} is present in the index queue but has no conversion command.`);
      return;
    }
    await startIndexJob("convert", match.dataset, match.asset);
  };

  const startNextActiveConversion = async () => {
    setActiveTab("jobs");
    if (!activeIndexQueueDataset) {
      setIndexQueueStatus("Scan the local root first, then run the next conversion.");
      await loadIndexQueue();
      return;
    }

    const nextAsset = activeIndexQueueDataset.assets.find((asset) => {
      if (!asset.convert_command) return false;
      const existing = findIndexJob("convert", activeIndexQueueDataset.slug, asset.relative_path);
      return !existing || !["queued", "running", "cancel_requested"].includes(existing.status);
    });
    if (!nextAsset) {
      setIndexQueueStatus(`No ready conversion jobs for ${activeIndexQueueDataset.slug}.`);
      return;
    }
    await startIndexJob("convert", activeIndexQueueDataset, nextAsset);
  };

  const cancelIndexJob = async (job: IndexJobRecord) => {
    setIndexJobsLoading(true);
    setIndexQueueError(null);
    try {
      await volumeJson<IndexJobResponse>(`/api/volume/index-jobs/${encodeURIComponent(job.id)}/cancel`, {
        method: "POST",
      });
      setIndexQueueStatus(`Cancellation requested for ${job.asset_relative_path}.`);
      await loadIndexJobs({ silent: true });
    } catch (error) {
      setIndexQueueError(error instanceof Error ? error.message : "Could not cancel index job.");
    } finally {
      setIndexJobsLoading(false);
    }
  };

  const retryIndexJob = async (job: IndexJobRecord) => {
    setIndexJobsLoading(true);
    setIndexQueueError(null);
    try {
      const payload = await volumeJson<IndexJobResponse>(`/api/volume/index-jobs/${encodeURIComponent(job.id)}/retry`, {
        method: "POST",
      });
      if (payload.job) {
        setIndexJobs((previous) => [payload.job!, ...previous.filter((existing) => existing.id !== payload.job!.id)]);
        setIndexQueueStatus(`Retried ${indexJobKindLabel(job.kind).toLowerCase()} job for ${job.asset_relative_path}.`);
      }
    } catch (error) {
      setIndexQueueError(error instanceof Error ? error.message : "Could not retry index job.");
    } finally {
      setIndexJobsLoading(false);
    }
  };

  const copyIndexCommand = async (command: string) => {
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(command);
      setIndexQueueStatus("Command copied.");
      setIndexQueueError(null);
    } catch {
      setIndexQueueError("Could not copy command.");
    }
  };

  useEffect(() => {
    if (activeTab === "jobs" && !indexQueue && !indexQueueLoading) {
      void loadIndexQueue();
    }
  }, [activeTab, indexQueue, indexQueueLoading]);

  useEffect(() => {
    if (activeTab !== "jobs") return;
    void loadIndexJobs({ silent: true });
    void loadIndexBatchRuns({ silent: true });
    const interval = window.setInterval(() => {
      void loadIndexJobs({ silent: true });
      void loadIndexBatchRuns({ silent: true });
    }, 2500);
    return () => window.clearInterval(interval);
  }, [activeTab]);

  const currentViewMetadata = () => ({
    exportedAt: new Date().toISOString(),
    dataset: activeDataset
      ? {
          slug: activeDataset.slug,
          title: activeDataset.title,
          source: activeDataset.source,
          entryId: activeDataset.entryId,
          experimentType: activeDataset.experimentType,
        }
      : null,
    asset: activeDerivative
      ? {
          source_relative_path: activeDerivative.source_relative_path,
          source_local_path: activeDerivative.source_local_path,
          output_path: activeDerivative.output_path,
          format: activeDerivative.format,
          array_path: activeDerivative.array_path,
          dtype: activeDerivative.dtype,
          shape_zyx: activeDerivative.shape_zyx,
          chunks_zyx: activeDerivative.chunks_zyx,
          byte_size: activeDerivative.byte_size,
          physical_voxel_size_nm: activeDerivative.physical_voxel_size_nm,
          validation: activeDerivative.validation || null,
        }
      : null,
    view: {
      mode: currentViewMode,
      axis: currentAxis,
      slice: currentClampedSlice,
      xSlice: currentXSlice,
      ySlice: currentYSlice,
      zSlice: currentZSlice,
      minContrast: currentMinContrast,
      maxContrast: currentMaxContrast,
      colormap: currentColormap,
      logScale: currentLogScale,
      downsample: currentDownsample,
      pitch: localPitch,
      yaw: localYaw,
      alphaScale: localAlphaScale,
      probe: activeProbe,
    },
    measurements: activeMeasurements,
    rois: activeRois,
    jobs: activeJobs,
    indexBatchPlan: indexBatchPlan
      ? {
          plan_id: indexBatchPlan.plan_id,
          created_at_ms: indexBatchPlan.created_at_ms,
          source: indexBatchPlan.source || "pilot-index",
          registry_id: indexBatchPlan.registry_id || null,
          kind: indexBatchPlan.kind,
          dataset_slug: indexBatchPlan.dataset_slug,
          summary: indexBatchPlan.summary,
          checkpoint: indexBatchPlan.checkpoint,
        }
      : null,
    indexBatchRuns: indexBatchRuns.slice(0, 5).map((run) => ({
      id: run.id,
      plan_id: run.plan_id,
      status: run.status,
      concurrency: run.concurrency,
      summary: run.summary,
      checkpoint_path: run.checkpoint_path,
      updated_at_ms: run.updated_at_ms,
      error: run.error,
    })),
    note: sessionNote,
  });

  const currentCaosViewState = (): CaosViewState => ({
    mode: currentViewMode,
    axis: currentAxis,
    slice: currentClampedSlice,
    xSlice: currentXSlice,
    ySlice: currentYSlice,
    zSlice: currentZSlice,
    minContrast: currentMinContrast,
    maxContrast: currentMaxContrast,
    colormap: currentColormap,
    logScale: currentLogScale,
    downsample: currentDownsample,
    pitch: localPitch,
    yaw: localYaw,
    alphaScale: localAlphaScale,
  });

  const currentCaosProjectSnapshot = useMemo(() => {
    if (!activeDataset || !activeDerivative) return null;
    try {
      return buildCaosProjectSnapshot({
        projectName: sessionName.trim() || defaultSessionName,
        projectNote: sessionNote,
        dataset: activeDataset,
        derivative: activeDerivative,
        view: {
          mode: currentViewMode,
          axis: currentAxis,
          slice: currentClampedSlice,
          xSlice: currentXSlice,
          ySlice: currentYSlice,
          zSlice: currentZSlice,
          minContrast: currentMinContrast,
          maxContrast: currentMaxContrast,
          colormap: currentColormap,
          logScale: currentLogScale,
          downsample: currentDownsample,
          pitch: localPitch,
          yaw: localYaw,
          alphaScale: localAlphaScale,
        },
        notes: currentProjectNotes,
        measurements: activeMeasurements,
        rois: activeRois,
        jobs: activeJobs,
        exports: currentProjectExports,
        existingProjectId: currentProjectId,
        createdAt: currentProjectCreatedAt,
      });
    } catch {
      return null;
    }
  }, [
    activeDataset,
    activeDerivative,
    sessionName,
    defaultSessionName,
    sessionNote,
    currentViewMode,
    currentAxis,
    currentSlice,
    maxSlicesForAxis,
    currentXSlice,
    currentYSlice,
    currentZSlice,
    currentMinContrast,
    currentMaxContrast,
    currentColormap,
    currentLogScale,
    currentDownsample,
    localPitch,
    localYaw,
    localAlphaScale,
    activeMeasurements,
    activeRois,
    activeJobs,
    currentProjectNotes,
    currentProjectExports,
    currentProjectId,
    currentProjectCreatedAt,
  ]);

  const currentCaosProjectSignature = useMemo(
    () => (currentCaosProjectSnapshot ? caosProjectStableSignature(currentCaosProjectSnapshot) : ""),
    [currentCaosProjectSnapshot]
  );
  const currentProjectDirty =
    Boolean(savedCaosProjectSignature && currentCaosProjectSignature) &&
    savedCaosProjectSignature !== currentCaosProjectSignature;
  const currentProjectDisplayName =
    currentCaosProjectSnapshot?.project.name || sessionName.trim() || defaultSessionName;
  const currentProjectSaveState = !currentProjectPath
    ? "Unsaved"
    : currentProjectDirty
    ? "Modified"
    : "Saved";
  const currentProjectSaveStateColor = !currentProjectPath
    ? "var(--accent-foreground)"
    : currentProjectDirty
    ? "var(--atlas-orange)"
    : "var(--atlas-blue-dark)";

  useEffect(() => {
    if (initialProjectSignatureRef.current || !currentCaosProjectSignature) return;
    initialProjectSignatureRef.current = true;
    setSavedCaosProjectSignature(currentCaosProjectSignature);
  }, [currentCaosProjectSignature]);

  const exportCurrentViewPng = async () => {
    const panel = document.querySelector<HTMLElement>(".cockpit-panel-center");
    const canvases = Array.from(panel?.querySelectorAll<HTMLCanvasElement>("canvas") || []);
    if (!panel || canvases.length === 0) {
      setSessionStatus("No rendered canvas is available to export.");
      return;
    }

    const panelRect = panel.getBoundingClientRect();
    const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(panelRect.width * scale));
    output.height = Math.max(1, Math.round(panelRect.height * scale));
    const context = output.getContext("2d");
    if (!context) {
      setSessionStatus("Could not prepare screenshot canvas.");
      return;
    }

    context.fillStyle = "#050505";
    context.fillRect(0, 0, output.width, output.height);

    for (const canvas of canvases) {
      const rect = canvas.getBoundingClientRect();
      const x = Math.round((rect.left - panelRect.left) * scale);
      const y = Math.round((rect.top - panelRect.top) * scale);
      const width = Math.round(rect.width * scale);
      const height = Math.round(rect.height * scale);
      try {
        context.drawImage(canvas, x, y, width, height);
      } catch {
        // Keep exporting remaining canvases if one surface cannot be copied.
      }
    }

    try {
      await drawWorkbenchExportOverlays(context, panel, panelRect, scale);
    } catch (error) {
      console.error("Workbench overlay export failed:", error);
      setSessionStatus("Exported view canvases, but one overlay layer could not be composited.");
    }

    const name = sanitizeFileSegment(activeDataset?.slug || "workbench-view");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    output.toBlob((blob) => {
      if (!blob) {
        setSessionStatus("Could not export current view PNG.");
        return;
      }
      void (async () => {
        const pngFilename = `${name}-${stamp}.png`;
        const metadataText = JSON.stringify(currentViewMetadata(), null, 2);
        if (isTauri) {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const saved = await invoke<NativeSavedViewSnapshotFiles>("save_view_snapshot_files", {
              request: {
                defaultFilename: pngFilename,
                pngDataUrl: await blobToDataUrl(blob),
                metadata: metadataText,
              },
            });
            setSessionStatus(
              `Exported current view PNG and metadata JSON to ${formatPathBasename(saved.pngPath)}.`
            );
            return;
          } catch (error) {
            console.error("Native view export failed:", error);
            setSessionStatus(error instanceof Error ? error.message : "Native view export failed.");
          }
        }
        downloadBlob(blob, pngFilename);
        downloadBlob(new Blob([metadataText], { type: "application/json" }), `${name}-${stamp}.view.json`);
        if (!isTauri) {
          setSessionStatus("Exported current view PNG and metadata JSON.");
        }
      })();
    }, "image/png");
  };

  const copyCoordinateLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setSessionStatus("Coordinate link copied.");
    } catch {
      setSessionStatus("Could not copy coordinate link.");
    }
  };

  const openJobsPanel = () => {
    setActiveTab("jobs");
    void loadIndexQueue();
    void loadIndexJobs({ silent: true });
  };

  const applyScoutPreset = (preset: "dense" | "context" | "boundary") => {
    const high = Math.max(1, maxPossibleIntensity);
    if (preset === "dense") {
      setLocalAlphaScale(0.24);
      updateUrlParams({
        viewMode: "3d",
        minContrast: Math.round(high * 0.55),
        maxContrast: high,
        colormap: 1,
        logScale: false,
        alphaScale: "0.240",
      });
      setSessionStatus("Scout preset applied: dense structures.");
      return;
    }
    if (preset === "boundary") {
      setLocalAlphaScale(0.14);
      updateUrlParams({
        viewMode: "3d",
        minContrast: Math.round(high * 0.18),
        maxContrast: Math.round(high * 0.82),
        colormap: 2,
        logScale: true,
        alphaScale: "0.140",
      });
      setSessionStatus("Scout preset applied: boundary search.");
      return;
    }
    setLocalAlphaScale(0.065);
    updateUrlParams({
      viewMode: "3d",
      minContrast: 0,
      maxContrast: high,
      colormap: 0,
      logScale: false,
      alphaScale: "0.065",
    });
    setSessionStatus("Scout preset applied: context shell.");
  };

  const exportProjectBundle = () => {
    const bundle = {
      schema: "cell-anatomy-workbench-project-bundle-v1",
      exportedAt: new Date().toISOString(),
      currentView: currentViewMetadata(),
      measurements,
      rois,
      jobs,
      recentLocalDatasets,
      savedSessions,
      importStatus,
      projectRecoveryStatus,
      atlasHandoff: activeAtlasHandoff
        ? {
            path: activeAtlasHandoffPath,
            handoff: activeAtlasHandoff,
            resolution: atlasHandoffResolution?.status || "pending",
          }
        : null,
      localOpenReport,
      indexBatchPlan: indexBatchPlan
        ? {
            plan_id: indexBatchPlan.plan_id,
            created_at_ms: indexBatchPlan.created_at_ms,
            source: indexBatchPlan.source || "pilot-index",
            registry_id: indexBatchPlan.registry_id || null,
            kind: indexBatchPlan.kind,
            dataset_slug: indexBatchPlan.dataset_slug,
            summary: indexBatchPlan.summary,
            checkpoint: indexBatchPlan.checkpoint,
          }
        : null,
      indexBatchRuns: indexBatchRuns.slice(0, 10).map((run) => ({
        id: run.id,
        plan_id: run.plan_id,
        status: run.status,
        concurrency: run.concurrency,
        summary: run.summary,
        checkpoint_path: run.checkpoint_path,
        updated_at_ms: run.updated_at_ms,
        error: run.error,
      })),
      privateRegistry: activePrivateRegistrySummary
        ? {
            path: privateRegistryPath,
            summary: activePrivateRegistrySummary,
            workset: privateWorksetSummary,
            mode: privateRegistryNativePath ? "native-index" : "bundle",
            reviewAssets: privateRegistryFilteredReviewAssets.slice(0, 200).map((asset) => ({
              asset_id: asset.asset_id,
              relative_path: asset.relative_path,
              status: asset.status,
              readiness: asset.readiness,
              metadata: asset.metadata,
              review: asset.review,
            })),
          }
        : null,
    };
    const name = sanitizeFileSegment(activeDataset?.slug || "workbench-project");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob(
      new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
      `${name}-${stamp}.workbench.json`
    );
    setSessionStatus("Exported Workbench project bundle.");
  };

  const rememberRecentCaosProject = (snapshot: CaosProjectSnapshot, path: string | null) => {
    if (!path) {
      removeStoredValue(LAST_CAOS_PROJECT_PATH_STORAGE_KEY);
      return;
    }

    const recentEntry: RecentCaosProject = {
      path,
      name: snapshot.project.name,
      projectId: snapshot.project.id,
      datasetSlug: snapshot.active.datasetSlug,
      assetPath: snapshot.active.assetPath,
      updatedAt: snapshot.project.updatedAt,
      lastOpenedAt: new Date().toISOString(),
    };

    setRecentCaosProjects((previous) => {
      const next = [
        recentEntry,
        ...previous.filter((item) => item.path !== recentEntry.path),
      ].slice(0, MAX_RECENT_CAOS_PROJECTS);
      writeStoredArray(RECENT_CAOS_PROJECTS_STORAGE_KEY, next);
      return next;
    });
    writeStoredString(LAST_CAOS_PROJECT_PATH_STORAGE_KEY, path);
  };

  const applyCaosProjectSnapshot = (
    snapshot: CaosProjectSnapshot,
    path: string | null,
    actionLabel: "Opened" | "Imported" | "Restored" | "Created"
  ) => {
    const activeVolume = resolveCaosProjectActiveVolume(snapshot, localDatasets);
    if (activeVolume.status === "missing-volume") {
      setProjectRecoveryStatus({
        kind: "warning",
        path: path || undefined,
        summary: activeVolume.summary,
        action: isTauri ? "open-local-folder" : undefined,
      });
      setSessionStatus(`${actionLabel} "${snapshot.project.name}" was not applied because its active volume is not loaded.`);
      if (actionLabel === "Restored" && path && readStoredString(LAST_CAOS_PROJECT_PATH_STORAGE_KEY) === path) {
        removeStoredValue(LAST_CAOS_PROJECT_PATH_STORAGE_KEY);
      }
      return;
    }
    if (activeVolume.status === "fingerprint-mismatch") {
      setProjectRecoveryStatus({
        kind: "warning",
        path: path || undefined,
        summary: activeVolume.summary,
        action: isTauri ? "open-local-folder" : undefined,
      });
      setSessionStatus(`${actionLabel} "${snapshot.project.name}" was not applied because its active volume has changed.`);
      if (actionLabel === "Restored" && path && readStoredString(LAST_CAOS_PROJECT_PATH_STORAGE_KEY) === path) {
        removeStoredValue(LAST_CAOS_PROJECT_PATH_STORAGE_KEY);
      }
      return;
    }

    setCurrentProjectPath(path);
    setCurrentProjectId(snapshot.project.id);
    setCurrentProjectCreatedAt(snapshot.project.createdAt);
    setCurrentProjectNotes(snapshot.notes);
    setCurrentProjectExports(snapshot.exports);
    setProjectRecoveryStatus(null);
    setSavedCaosProjectSignature(caosProjectStableSignature(snapshot));
    initialProjectSignatureRef.current = true;
    setSessionName(snapshot.project.name);
    setSessionNote(snapshot.notes.find((note) => note.scope === "project")?.text || "");
    rememberRecentCaosProject(snapshot, path);
    setMeasurements((previous) =>
      replaceVolumeScopedRecords(previous, snapshot.measurements, snapshot.volumes, MAX_WORKBENCH_MEASUREMENTS)
    );
    setRois((previous) =>
      replaceVolumeScopedRecords(previous, snapshot.rois, snapshot.volumes, MAX_WORKBENCH_ROIS)
    );
    setJobs((previous) =>
      replaceVolumeScopedRecords(previous, snapshot.jobs, snapshot.volumes, MAX_WORKBENCH_JOBS)
    );
    setMeasurementDraft(null);
    setSelectedMeasurementId(null);
    setRoiDraft(null);
    setSelectedRoiId(null);
    setActiveProbe(null);

    const view = snapshot.active.view;
    updateUrlParams({
      dataset: snapshot.active.datasetSlug,
      asset: snapshot.active.assetPath,
      viewMode: view.mode,
      axis: view.axis,
      slice: view.slice,
      xSlice: view.xSlice,
      ySlice: view.ySlice,
      zSlice: view.zSlice,
      minContrast: view.minContrast,
      maxContrast: view.maxContrast,
      colormap: view.colormap,
      logScale: view.logScale,
      downsample: view.downsample,
      pitch: view.pitch.toFixed(3),
      yaw: view.yaw.toFixed(3),
      alphaScale: view.alphaScale.toFixed(3),
    });
    setLocalPitch(view.pitch);
    setLocalYaw(view.yaw);
    setLocalAlphaScale(view.alphaScale);
    setImportStatus(null);
    setSessionStatus(`${actionLabel} CAOS project "${snapshot.project.name}".`);
  };

  const confirmDiscardProjectChanges = async () => {
    if (!currentProjectDirty) return true;
    if (!isTauri) {
      return window.confirm(`${currentProjectDisplayName} has unsaved changes. Discard them and continue?`);
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<boolean>("confirm_discard_project_changes", {
        projectName: currentProjectDisplayName,
      });
    } catch {
      return false;
    }
  };

  const openCaosProjectPath = async (
    path: string,
    options: { skipDirtyCheck?: boolean; actionLabel?: "Opened" | "Restored" } = {}
  ) => {
    if (!options.skipDirtyCheck && !(await confirmDiscardProjectChanges())) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const file = await invoke<NativeCaosProjectFile>("read_caos_project_file", { path });
      const snapshot = parseCaosProjectSnapshot(file.contents);
      applyCaosProjectSnapshot(snapshot, file.path, options.actionLabel || "Opened");
    } catch (error) {
      const summary = error instanceof Error ? error.message : "Could not open CAOS project file.";
      setProjectRecoveryStatus({
        kind: "error",
        path,
        summary,
        action: "retry-project-open",
        actionPath: path,
      });
      setSessionStatus(summary);
      setRecentCaosProjects((previous) => {
        const next = previous.filter((item) => item.path !== path);
        writeStoredArray(RECENT_CAOS_PROJECTS_STORAGE_KEY, next);
        return next;
      });
      if (readStoredString(LAST_CAOS_PROJECT_PATH_STORAGE_KEY) === path) {
        removeStoredValue(LAST_CAOS_PROJECT_PATH_STORAGE_KEY);
      }
    }
  };

  const openCaosProjectNative = async () => {
    if (!(await confirmDiscardProjectChanges())) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const file = await invoke<NativeCaosProjectFile | null>("open_caos_project_file");
      if (!file) return;
      const snapshot = parseCaosProjectSnapshot(file.contents);
      applyCaosProjectSnapshot(snapshot, file.path, "Opened");
    } catch (error) {
      const summary = error instanceof Error ? error.message : "Could not open CAOS project file.";
      setProjectRecoveryStatus({ kind: "error", summary });
      setSessionStatus(summary);
    }
  };

  const saveCaosProjectNative = async (forceDialog: boolean) => {
    if (!currentCaosProjectSnapshot) {
      setSessionStatus("No active volume is available for CAOS project save.");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const contents = serializeCaosProjectSnapshot(currentCaosProjectSnapshot);
      const saved = await invoke<NativeSavedCaosProjectFile | null>("save_caos_project_file", {
        request: {
          path: currentProjectPath,
          contents,
          defaultFilename: `${sanitizeFileSegment(currentCaosProjectSnapshot.project.name)}.caos-project.json`,
          forceDialog,
        },
      });
      if (!saved) return;
      setCurrentProjectPath(saved.path);
      setSavedCaosProjectSignature(caosProjectStableSignature(currentCaosProjectSnapshot));
      rememberRecentCaosProject(currentCaosProjectSnapshot, saved.path);
      setSessionStatus(`Saved CAOS project "${currentCaosProjectSnapshot.project.name}".`);
    } catch (error) {
      setSessionStatus(error instanceof Error ? error.message : "CAOS project save failed.");
    }
  };

  const downloadCaosProject = () => {
    if (!currentCaosProjectSnapshot) {
      setSessionStatus("No active volume is available for CAOS project export.");
      return;
    }

    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadBlob(
        new Blob([serializeCaosProjectSnapshot(currentCaosProjectSnapshot)], { type: "application/json" }),
        `${sanitizeFileSegment(currentCaosProjectSnapshot.project.name)}-${stamp}.caos-project.json`
      );
      setSavedCaosProjectSignature(caosProjectStableSignature(currentCaosProjectSnapshot));
      setSessionStatus("Exported CAOS project file.");
    } catch (error) {
      setSessionStatus(error instanceof Error ? error.message : "CAOS project export failed.");
    }
  };

  const importCaosProject = async (file: File | null) => {
    if (!file) return;
    if (!(await confirmDiscardProjectChanges())) {
      if (caosProjectInputRef.current) {
        caosProjectInputRef.current.value = "";
      }
      return;
    }
    try {
      const snapshot = parseCaosProjectSnapshot(await file.text());
      applyCaosProjectSnapshot(snapshot, null, "Imported");
    } catch (error) {
      const summary = error instanceof Error ? error.message : "CAOS project import failed.";
      setProjectRecoveryStatus({ kind: "error", summary });
      setSessionStatus(summary);
    } finally {
      if (caosProjectInputRef.current) {
        caosProjectInputRef.current.value = "";
      }
    }
  };

  const forgetProjectRecoveryPath = () => {
    const path = projectRecoveryStatus?.path;
    if (path) {
      setRecentCaosProjects((previous) => {
        const next = previous.filter((item) => item.path !== path);
        writeStoredArray(RECENT_CAOS_PROJECTS_STORAGE_KEY, next);
        return next;
      });
      if (readStoredString(LAST_CAOS_PROJECT_PATH_STORAGE_KEY) === path) {
        removeStoredValue(LAST_CAOS_PROJECT_PATH_STORAGE_KEY);
      }
    }
    setProjectRecoveryStatus(null);
    setSessionStatus("Project recovery status cleared.");
  };

  useEffect(() => {
    if (!isTauri || restoredLastProjectRef.current) return;
    const lastPath = readStoredString(LAST_CAOS_PROJECT_PATH_STORAGE_KEY);
    if (!lastPath) return;
    restoredLastProjectRef.current = true;
    void openCaosProjectPath(lastPath, { skipDirtyCheck: true, actionLabel: "Restored" });
  }, [isTauri]);

  nativeCommandHandlerRef.current = (command: string) => {
    switch (command) {
      case "open-local":
        void handleOpenLocalDirectory();
        break;
      case "copy-link":
        void copyCoordinateLink();
        break;
      case "toggle-mirror":
        setMirrorMode((current) => !current);
        break;
      case "toggle-measure":
        toggleMeasurementMode();
        break;
      case "roi-point":
        toggleRoiTool("point");
        break;
      case "roi-box":
        toggleRoiTool("box");
        break;
      case "run-jobs":
        openJobsPanel();
        break;
      case "open-private-registry":
        void openPrivateRegistryNative();
        break;
      case "open-private-workset":
        void openPrivateWorksetNative();
        break;
      case "show-notes":
        setActiveTab("image-notes");
        break;
      case "open-caos":
        void openCaosProjectNative();
        break;
      case "open-caos-handoff":
        void openAtlasHandoffNative();
        break;
      case "save-caos":
        void saveCaosProjectNative(false);
        break;
      case "save-caos-as":
        void saveCaosProjectNative(true);
        break;
      case "save-view":
        saveCurrentSession();
        break;
      case "export-view":
        exportCurrentViewPng();
        break;
      case "export-bundle":
        exportProjectBundle();
        break;
      case "export-caos":
        downloadCaosProject();
        break;
      case "import-caos":
        setActiveTab("image-notes");
        caosProjectInputRef.current?.click();
        break;
      default:
        break;
    }
  };

  return (
    <>
      <header className="cockpit-header workbench-topbar">
        <div className="desktop-brand-mark" aria-label="Cell Anatomy Operating System">
          <WorkbenchLogo />
          <span className="kicker" style={{ margin: 0, fontSize: 9, letterSpacing: 0, color: "var(--atlas-blue-dark)" }}>
            OPERATING SYSTEM
          </span>
        </div>

        <label className="topbar-field topbar-field-dataset">
          <span>Dataset</span>
          <select value={currentDatasetSlug} onChange={handleDatasetChange} className="search-input">
            {localDatasets.map((d) => (
              <option key={d.slug} value={d.slug}>
                {d.entryId ? `[${d.source} ${d.entryId}] ` : ""}{d.slug}
              </option>
            ))}
          </select>
        </label>

        <label className="topbar-field topbar-field-asset">
          <span>
            Volume File · {activeVolumeFileCount === 1 ? "1 Loadable" : `${activeVolumeFileCount} Loadable`}
          </span>
          <select
            value={activeDerivative?.source_relative_path || ""}
            onChange={handleAssetChange}
            disabled={!activeDataset || activeVolumeFileCount === 0}
            className="search-input"
            title={
              activeVolumeFileCount === 1
                ? "This dataset has one converted Workbench-loadable volume file. Use Jobs > Index Queue to convert more local assets."
                : `${activeVolumeFileCount} converted Workbench-loadable volume files are available for this dataset.`
            }
          >
            {activeDataset?.derivatives.map((deriv) => (
              <option key={deriv.source_relative_path} value={deriv.source_relative_path}>
                {deriv.role === "segmentation_labels" ? `[LABEL · ${(deriv.task || "custom").toUpperCase()}] ${deriv.label_name || deriv.segmentation_id}` : deriv.source_relative_path.split("/").pop()}
              </option>
            )) || <option value="">No assets found</option>}
          </select>
        </label>

        {!isTauri ? (
          <div className="topbar-actions" aria-label="Browser preview actions">
            <button
              type="button"
              onClick={copyCoordinateLink}
              className="button topbar-button"
            >
              Copy Link
            </button>
            <button
              type="button"
              onClick={() => setMirrorMode((current) => !current)}
              className="button topbar-button"
              title="Mirror the current Workbench layout horizontally."
            >
              {mirrorMode ? "Standard" : "Mirror"}
            </button>
            <button
              type="button"
              onClick={toggleMeasurementMode}
              className={`button topbar-button ${measurementMode ? "is-active" : ""}`}
            >
              {measurementMode ? "Stop Measure" : "Measure"}
            </button>
            <button
              type="button"
              onClick={() => toggleRoiTool("point")}
              className={`button topbar-button ${roiTool === "point" ? "is-active" : ""}`}
            >
              ROI Point
            </button>
            <button
              type="button"
              onClick={() => toggleRoiTool("box")}
              className={`button topbar-button ${roiTool === "box" ? "is-active" : ""}`}
            >
              ROI Box
            </button>
            <button
              type="button"
              onClick={openJobsPanel}
              className="button topbar-button"
              disabled={!activeDataset}
              title="Open the Jobs panel for analysis and import runs."
            >
              Run
            </button>
            <button
              type="button"
              onClick={saveCurrentSession}
              className="button topbar-button"
              disabled={!activeDataset || !activeDerivative}
            >
              Save View
            </button>
            <button
              type="button"
              onClick={exportCurrentViewPng}
              className="button topbar-button"
            >
              Export View
            </button>
            <button
              type="button"
              onClick={exportProjectBundle}
              className="button topbar-button"
            >
              Bundle
            </button>
          </div>
        ) : null}

        <div className={`stream-serial ${streamState !== "READY" ? "active" : ""}`}>
          <span>{streamState}</span>
          <strong>
            Z{orthogonalDraft.z + 1} Y{orthogonalDraft.y + 1} X{orthogonalDraft.x + 1}
          </strong>
        </div>
      </header>

      <div
        className={`cockpit-grid ${mirrorMode ? "workbench-mirror-mode" : ""}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleLocalDrop}
      >
      {/* 1. Left Column: Selectors, Slicing & Parameter Controls */}
      <aside className="cockpit-panel-left">

        {/* View mode toggle */}
        <div>
          <label className="kicker" style={{ display: "block", marginBottom: 8, fontSize: 11, letterSpacing: 0 }}>
            Viewport Mode
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              onClick={() => updateUrlParams({ viewMode: "orthogonal" })}
              style={{
                width: "100%",
                borderRadius: 0,
                border: "1px solid",
                borderColor: currentViewMode === "orthogonal" ? "var(--foreground)" : "var(--border)",
                background: currentViewMode === "orthogonal" ? "var(--foreground)" : "transparent",
                color: currentViewMode === "orthogonal" ? "var(--background)" : "var(--foreground)",
                padding: "6px 12px",
                fontSize: 11,
                cursor: "pointer",
                transition: "none",
                fontFamily: "var(--font-display)",
              }}
            >
              Orthogonal
            </button>
            <button
              onClick={() => updateUrlParams({ viewMode: "2d" })}
              style={{
                width: "100%",
                borderRadius: 0,
                border: "1px solid",
                borderColor: currentViewMode === "2d" ? "var(--foreground)" : "var(--border)",
                background: currentViewMode === "2d" ? "var(--foreground)" : "transparent",
                color: currentViewMode === "2d" ? "var(--background)" : "var(--foreground)",
                padding: "6px 12px",
                fontSize: 11,
                cursor: "pointer",
                transition: "none",
                fontFamily: "var(--font-display)",
              }}
            >
              Single Plane
            </button>
            <button
              onClick={() => updateUrlParams({ viewMode: "3d" })}
              style={{
                width: "100%",
                borderRadius: 0,
                border: "1px solid",
                borderColor: currentViewMode === "3d" ? "var(--foreground)" : "var(--border)",
                background: currentViewMode === "3d" ? "var(--foreground)" : "transparent",
                color: currentViewMode === "3d" ? "var(--background)" : "var(--foreground)",
                padding: "6px 12px",
                fontSize: 11,
                cursor: "pointer",
                transition: "none",
                fontFamily: "var(--font-display)",
              }}
            >
              Density Preview
            </button>
          </div>
        </div>

        <div
          style={{
            border: "1px solid var(--border)",
            background: "rgba(0, 0, 0, 0.04)",
            padding: "8px 10px",
            fontFamily: "var(--font-display)",
            fontSize: 11,
            lineHeight: 1.35,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <span className="muted" style={{ textTransform: "uppercase", fontSize: 9, fontWeight: 700 }}>
              Local Data
            </span>
            {importStatus ? (
              <strong style={{ color: importStatusColor, textTransform: "uppercase", fontSize: 9 }}>
                {importStatus.kind}
              </strong>
            ) : (
              <strong style={{ color: "var(--accent-foreground)", textTransform: "uppercase", fontSize: 9 }}>
                Drop Ready
              </strong>
            )}
          </div>

          {!isTauri ? (
            <p className="muted" style={{ margin: 0, fontSize: 10.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
              Native Workbench can open or drop local Zarr folders. Browser preview can inspect indexed data but cannot read arbitrary local paths.
            </p>
          ) : null}

          <div
            style={{
              border: "1px dashed var(--border)",
              background: "var(--field-background)",
              padding: "8px",
              fontSize: 10.5,
              color: "var(--accent-foreground)",
            }}
          >
            Drop a supported Zarr folder anywhere in the Workbench window. Current reader supports raw uncompressed 3D Zarr v2 arrays with uint8 or uint16 voxels.
          </div>

          {importStatus ? (
            <div
              style={{
                border: "1px solid var(--border)",
                background: importStatus.kind === "error" ? "rgba(198, 111, 45, 0.08)" : "var(--field-background)",
                padding: "7px 8px",
              }}
            >
              <div style={{ color: "var(--foreground)", overflowWrap: "anywhere" }}>
                {importStatus.summary}
              </div>
              {importStatus.path ? (
                <div className="muted" style={{ marginTop: 4, fontSize: 9.5, overflowWrap: "anywhere" }}>
                  {importStatus.path}
                </div>
              ) : null}
              {importStatus.persisted === false ? (
                <div style={{ marginTop: 4, color: "var(--atlas-orange)", fontSize: 9.5 }}>
                  Registry persistence failed. This dataset may need to be reopened after restart.
                </div>
              ) : null}
              {visibleImportChecks.length > 0 ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 8px", marginTop: 7, fontSize: 9.5 }}>
                  {visibleImportChecks.slice(0, 8).map(([key, ok]) => (
                    <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {key.split("_").join(" ")}
                      </span>
                      <strong style={{ color: ok ? "var(--atlas-blue-dark)" : "var(--atlas-orange)" }}>
                        {ok ? "OK" : "NO"}
                      </strong>
                    </div>
                  ))}
                </div>
              ) : null}
              {importStatus.kind === "error" || importStatus.kind === "warning" ? (
                <div style={{ display: "grid", gridTemplateColumns: importStatus.path ? "1fr 1fr" : "1fr", gap: 6, marginTop: 7 }}>
                  {importStatus.path ? (
                    <button
                      type="button"
                      className="button"
                      onClick={() => void openLocalPath(importStatus.path!)}
                      style={{ padding: "5px 7px", fontSize: 9.5 }}
                    >
                      Retry
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button"
                    onClick={() => setImportStatus(null)}
                    style={{ padding: "5px 7px", fontSize: 9.5 }}
                  >
                    Dismiss
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {recentLocalDatasets.length > 0 ? (
            <div style={{ display: "grid", gap: 5 }}>
              <span className="muted" style={{ textTransform: "uppercase", fontSize: 9, fontWeight: 700 }}>
                Recent Local
              </span>
              {recentLocalDatasets.slice(0, 4).map((item) => (
                <button
                  key={`${item.slug}-${item.path}`}
                  type="button"
                  className="button"
                  disabled={openingLocal}
                  onClick={() => openLocalPath(item.path)}
                  title={item.path}
                  style={{
                    display: "grid",
                    gap: 2,
                    textAlign: "left",
                    width: "100%",
                    padding: "6px 8px",
                    fontSize: 10,
                    background: "var(--field-background)",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.title}
                  </span>
                  <span className="muted" style={{ fontSize: 9, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.dtype || "zarr"} | {formatShape(item.shape_zyx)} | {formatDateTime(item.lastOpenedAt)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div
          style={{
            border: "1px solid var(--border)",
            background: measurementMode ? "rgba(31, 111, 135, 0.08)" : "rgba(0, 0, 0, 0.04)",
            padding: "8px 10px",
            fontFamily: "var(--font-display)",
            fontSize: 11,
            lineHeight: 1.35,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <span className="muted" style={{ textTransform: "uppercase", fontSize: 9, fontWeight: 700 }}>
              Measurements
            </span>
            <strong style={{ color: measurementMode ? "var(--atlas-blue-dark)" : "var(--accent-foreground)", textTransform: "uppercase", fontSize: 9 }}>
              {activeMeasurements.length}
            </strong>
          </div>
          {!isTauri ? (
            <button
              type="button"
              className="button"
              onClick={toggleMeasurementMode}
              style={{ width: "100%", padding: "6px 10px", fontSize: 10, background: measurementMode ? "var(--foreground)" : "var(--button-face)", color: measurementMode ? "var(--background)" : "var(--foreground)" }}
            >
              {measurementMode ? "Stop Measuring" : "Measure Distance"}
            </button>
          ) : null}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button
              type="button"
              className="button"
              onClick={undoLastMeasurement}
              disabled={activeMeasurements.length === 0}
              style={{ padding: "5px 7px", fontSize: 9.5, opacity: activeMeasurements.length === 0 ? 0.55 : 1 }}
            >
              Undo Last
            </button>
            <button
              type="button"
              className="button"
              onClick={exportMeasurementsCsv}
              disabled={activeMeasurements.length === 0}
              style={{ padding: "5px 7px", fontSize: 9.5, opacity: activeMeasurements.length === 0 ? 0.55 : 1 }}
            >
              Export CSV
            </button>
          </div>
          <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
            {measurementStatus}
          </div>
          {measurementDraft ? (
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ color: "var(--atlas-blue-dark)", fontSize: 10, fontWeight: 700 }}>
                Start: {formatVoxelPoint(measurementDraft.point)}
              </div>
              <button
                type="button"
                className="button"
                onClick={clearMeasurementDraft}
                style={{ width: "100%", padding: "5px 8px", fontSize: 10 }}
              >
                Clear Draft
              </button>
            </div>
          ) : null}
          {activeMeasurements.length > 0 ? (
            <button
              type="button"
              className="button"
              onClick={clearActiveMeasurements}
              style={{ width: "100%", padding: "5px 8px", fontSize: 10 }}
            >
              Clear Active Measurements
            </button>
          ) : null}
        </div>

        <div
          style={{
            border: "1px solid var(--border)",
            background: roiTool !== "off" ? "rgba(31, 111, 135, 0.08)" : "rgba(0, 0, 0, 0.04)",
            padding: "8px 10px",
            fontFamily: "var(--font-display)",
            fontSize: 11,
            lineHeight: 1.35,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <span className="muted" style={{ textTransform: "uppercase", fontSize: 9, fontWeight: 700 }}>
              Regions
            </span>
            <strong style={{ color: roiTool !== "off" ? "var(--atlas-blue-dark)" : "var(--accent-foreground)", textTransform: "uppercase", fontSize: 9 }}>
              {activeRois.length}
            </strong>
          </div>
          {!isTauri ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <button
                type="button"
                className="button"
                onClick={() => toggleRoiTool("point")}
                style={{ padding: "5px 7px", fontSize: 9.5, background: roiTool === "point" ? "var(--foreground)" : "var(--button-face)", color: roiTool === "point" ? "var(--background)" : "var(--foreground)" }}
              >
                Point ROI
              </button>
              <button
                type="button"
                className="button"
                onClick={() => toggleRoiTool("box")}
                style={{ padding: "5px 7px", fontSize: 9.5, background: roiTool === "box" ? "var(--foreground)" : "var(--button-face)", color: roiTool === "box" ? "var(--background)" : "var(--foreground)" }}
              >
                Box ROI
              </button>
            </div>
          ) : null}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button
              type="button"
              className="button"
              onClick={exportRoisJson}
              disabled={activeRois.length === 0}
              style={{ padding: "5px 7px", fontSize: 9.5, opacity: activeRois.length === 0 ? 0.55 : 1 }}
            >
              Export JSON
            </button>
            <button
              type="button"
              className="button"
              onClick={clearActiveRois}
              disabled={activeRois.length === 0}
              style={{ padding: "5px 7px", fontSize: 9.5, opacity: activeRois.length === 0 ? 0.55 : 1 }}
            >
              Clear ROIs
            </button>
          </div>
          <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
            {roiStatus}
          </div>
          {roiDraft ? (
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ color: "var(--atlas-blue-dark)", fontSize: 10, fontWeight: 700 }}>
                Start: {formatVoxelPoint(roiDraft.point)}
              </div>
              <button
                type="button"
                className="button"
                onClick={clearRoiDraft}
                style={{ width: "100%", padding: "5px 8px", fontSize: 10 }}
              >
                Clear ROI Draft
              </button>
            </div>
          ) : null}
        </div>

        {/* View-mode conditional controls */}
        {currentViewMode === "3d" ? (
          /* 3D Shader Controls */
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Opacity
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <input
                  type="range"
                  min={0.005}
                  max={0.5}
                  step={0.005}
                  value={localAlphaScale}
                  onChange={(e) => setLocalAlphaScale(Number(e.target.value))}
                  style={{ flex: 1, height: 6, outline: "none", cursor: "pointer", accentColor: "var(--atlas-blue)" }}
                />
                <span style={{ fontFamily: "var(--font-display)", fontSize: 12, width: 45, textAlign: "right" }}>
                  {localAlphaScale.toFixed(3)}
                </span>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Scout Presets
              </span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 5 }}>
                <button
                  type="button"
                  className="button"
                  onClick={() => applyScoutPreset("dense")}
                  style={{ padding: "6px 10px", fontSize: 10.5, textAlign: "left" }}
                >
                  Dense Structures
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => applyScoutPreset("boundary")}
                  style={{ padding: "6px 10px", fontSize: 10.5, textAlign: "left" }}
                >
                  Boundary Search
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => applyScoutPreset("context")}
                  style={{ padding: "6px 10px", fontSize: 10.5, textAlign: "left" }}
                >
                  Context Shell
                </button>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 10.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                Density Preview is now treated as scout space: tune visibility, find a target, then jump back to planes for ROI work.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Downsample
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {([2, 4, 8] as const).map((factor) => {
                  const label = factor === 2 ? "2x (High Detail)" : factor === 4 ? "4x (Medium Detail)" : "8x (Low Detail)";
                  const isSelected = currentDownsample === factor;
                  return (
                    <button
                      key={factor}
                      onClick={() => updateUrlParams({ downsample: factor })}
                      style={{
                        borderRadius: 0,
                        border: "1px solid",
                        borderColor: isSelected ? "var(--foreground)" : "var(--border)",
                        background: isSelected ? "var(--foreground)" : "transparent",
                        color: isSelected ? "var(--background)" : "var(--foreground)",
                        padding: "6px 10px",
                        fontSize: 11,
                        cursor: "pointer",
                        transition: "none",
                        fontFamily: "var(--font-display)",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Color Map
              </span>
              <select
                value={currentColormap}
                onChange={(e) => updateUrlParams({ colormap: Number(e.target.value) })}
                className="search-input"
                style={{ padding: "6px 12px", background: "var(--field-background)", color: "var(--foreground)", border: "1px solid var(--border)", fontSize: 13, outline: "none", cursor: "pointer", fontFamily: "var(--font-display)" }}
              >
                <option value={0}>Grayscale</option>
                <option value={1}>Thermal Heat</option>
                <option value={2}>Viridis (Approx)</option>
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Camera Rotation
              </span>
              <button
                onClick={() => {
                  setLocalPitch(0.0);
                  setLocalYaw(0.0);
                  updateUrlParams({ pitch: "0.000", yaw: "0.000" });
                }}
                style={{
                  width: "100%",
                  borderRadius: 0,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--foreground)",
                  padding: "6px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                  transition: "none",
                  fontFamily: "var(--font-display)",
                }}
              >
                Reset Camera View
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, height: 32 }}>
              <input
                type="checkbox"
                id="logscale-toggle-3d"
                checked={currentLogScale}
                onChange={(e) => updateUrlParams({ logScale: e.target.checked })}
                style={{ cursor: "pointer" }}
              />
              <label htmlFor="logscale-toggle-3d" style={{ fontSize: 12, cursor: "pointer", fontWeight: 600, fontFamily: "var(--font-display)" }}>
                Log Intensity
              </label>
            </div>
          </div>
        ) : currentViewMode === "orthogonal" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                {zMax <= 1 ? "XY Plane Position" : "Linked Orthogonal Position"}
              </span>

              {(zMax <= 1
                ? [
                    { key: "xSlice", label: "X Crosshair", axisLabel: "X", value: orthogonalDraft.x, max: xMax, update: (value: number) => handleOrthogonalSliceChange({ x: value }) },
                    { key: "ySlice", label: "Y Crosshair", axisLabel: "Y", value: orthogonalDraft.y, max: yMax, update: (value: number) => handleOrthogonalSliceChange({ y: value }) },
                  ]
                : [
                    { key: "zSlice", label: "XY Plane", axisLabel: "Z", value: orthogonalDraft.z, max: zMax, update: (value: number) => handleOrthogonalSliceChange({ z: value }) },
                    { key: "ySlice", label: "XZ Plane", axisLabel: "Y", value: orthogonalDraft.y, max: yMax, update: (value: number) => handleOrthogonalSliceChange({ y: value }) },
                    { key: "xSlice", label: "YZ Plane", axisLabel: "X", value: orthogonalDraft.x, max: xMax, update: (value: number) => handleOrthogonalSliceChange({ x: value }) },
                  ]
              ).map((control) => (
                <div key={control.key}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 11, fontFamily: "var(--font-display)" }}>
                    <span className="muted" style={{ fontWeight: 600 }}>{control.label}</span>
                    <span style={{ color: "var(--atlas-blue-dark)", fontWeight: "bold" }}>
                      {control.axisLabel}:{control.value + 1} / {control.max}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, control.max - 1)}
                    value={control.value}
                    onChange={(e) => control.update(Number(e.target.value))}
                    style={{ width: "100%", height: 6, outline: "none", cursor: "pointer", accentColor: "var(--atlas-blue)" }}
                  />
                </div>
              ))}

              <button
                onClick={() => handleOrthogonalSliceChange({ x: Math.floor(xMax / 2), y: Math.floor(yMax / 2), z: Math.floor(zMax / 2) })}
                style={{
                  width: "100%",
                  borderRadius: 0,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--foreground)",
                  padding: "6px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                  transition: "none",
                  fontFamily: "var(--font-display)",
                }}
              >
                Center
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>Color Map</span>
              <select
                value={currentColormap}
                onChange={(e) => updateUrlParams({ colormap: Number(e.target.value) })}
                className="search-input"
                style={{ padding: "6px 12px", background: "var(--field-background)", color: "var(--foreground)", border: "1px solid var(--border)", fontSize: 13, outline: "none", cursor: "pointer", fontFamily: "var(--font-display)" }}
              >
                <option value={0}>Grayscale</option>
                <option value={1}>Thermal Heat</option>
                <option value={2}>Viridis (Approx)</option>
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                id="logscale-toggle-orthogonal"
                checked={currentLogScale}
                onChange={(e) => updateUrlParams({ logScale: e.target.checked })}
                style={{ cursor: "pointer" }}
              />
              <label htmlFor="logscale-toggle-orthogonal" style={{ fontSize: 12, cursor: "pointer", fontWeight: 600, fontFamily: "var(--font-display)" }}>
                Log Intensity
              </label>
            </div>
          </div>
        ) : (
          /* 2D Plane Slicing Controls */
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>Plane</span>
              <div style={{ display: "flex", gap: 4 }}>
                {(["z", "y", "x"] as const).map((ax) => {
                  const label = ax === "z" ? "XY" : ax === "y" ? "XZ" : "YZ";
                  const isSelected = currentAxis === ax;
                  return (
                    <button
                      key={ax}
                      onClick={() => updateUrlParams({ axis: ax, slice: 0 })}
                      className={`compare-toggle-btn ${isSelected ? "selected" : ""}`}
                      style={{ border: "1px solid var(--border)", padding: "6px 12px", fontSize: 12, cursor: "pointer", transition: "none", flex: 1, fontFamily: "var(--font-display)" }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>Color Map</span>
              <select
                value={currentColormap}
                onChange={(e) => updateUrlParams({ colormap: Number(e.target.value) })}
                className="search-input"
                style={{ padding: "6px 12px", background: "var(--field-background)", color: "var(--foreground)", border: "1px solid var(--border)", fontSize: 13, outline: "none", cursor: "pointer", fontFamily: "var(--font-display)" }}
              >
                <option value={0}>Grayscale</option>
                <option value={1}>Thermal Heat</option>
                <option value={2}>Viridis (Approx)</option>
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                id="logscale-toggle-2d"
                checked={currentLogScale}
                onChange={(e) => updateUrlParams({ logScale: e.target.checked })}
                style={{ cursor: "pointer" }}
              />
              <label htmlFor="logscale-toggle-2d" style={{ fontSize: 12, cursor: "pointer", fontWeight: 600, fontFamily: "var(--font-display)" }}>
                Log Intensity
              </label>
            </div>

            {/* Slice Scrub Index Slider */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, fontFamily: "var(--font-display)" }}>
                <span className="muted" style={{ fontWeight: 600 }}>Slice</span>
                <span style={{ color: "var(--atlas-blue-dark)", fontWeight: "bold" }}>
                  {currentClampedSlice + 1} / {maxSlicesForAxis}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={maxSlicesForAxis - 1}
                value={currentClampedSlice}
                onChange={(e) => updateUrlParams({ slice: Number(e.target.value) })}
                style={{ width: "100%", height: 6, outline: "none", cursor: "pointer", accentColor: "var(--atlas-blue)" }}
              />
            </div>
          </div>
        )}

        <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "4px 0" }} />

        {/* Rigorous Contrast Range Slider controls */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 11, fontFamily: "var(--font-display)", fontWeight: 600 }}>
            <span className="muted">Contrast</span>
          </div>
          <span style={{ color: "var(--atlas-orange)", display: "block", fontSize: 10, fontFamily: "var(--font-display)", marginBottom: 12 }}>
            [{currentMinContrast} - {currentMaxContrast}] / {maxPossibleIntensity}
          </span>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span className="muted" style={{ fontSize: 10, fontFamily: "var(--font-display)", fontWeight: 600 }}>Min</span>
                <input
                  type="number"
                  min={0}
                  max={currentMaxContrast}
                  value={currentMinContrast}
                  onChange={(e) => {
                    const val = Math.max(0, Math.min(Number(e.target.value), currentMaxContrast));
                    updateUrlParams({ minContrast: val });
                  }}
                  style={{ width: 64, textAlign: "right", fontSize: 11, background: "var(--field-background)", color: "var(--foreground)", border: "1px solid var(--border)", padding: "2px 4px", fontFamily: "var(--font-display)" }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={maxPossibleIntensity}
                value={currentMinContrast}
                onChange={(e) => {
                  const val = Math.min(Number(e.target.value), currentMaxContrast);
                  updateUrlParams({ minContrast: val });
                }}
                style={{ width: "100%", height: 4, cursor: "pointer", accentColor: "var(--atlas-blue)" }}
              />
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span className="muted" style={{ fontSize: 10, fontFamily: "var(--font-display)", fontWeight: 600 }}>Max</span>
                <input
                  type="number"
                  min={currentMinContrast}
                  max={maxPossibleIntensity}
                  value={currentMaxContrast}
                  onChange={(e) => {
                    const val = Math.max(currentMinContrast, Math.min(Number(e.target.value), maxPossibleIntensity));
                    updateUrlParams({ maxContrast: val });
                  }}
                  style={{ width: 64, textAlign: "right", fontSize: 11, background: "var(--field-background)", color: "var(--foreground)", border: "1px solid var(--border)", padding: "2px 4px", fontFamily: "var(--font-display)" }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={maxPossibleIntensity}
                value={currentMaxContrast}
                onChange={(e) => {
                  const val = Math.max(Number(e.target.value), currentMinContrast);
                  updateUrlParams({ maxContrast: val });
                }}
                style={{ width: "100%", height: 4, cursor: "pointer", accentColor: "var(--atlas-blue)" }}
              />
            </div>
          </div>
        </div>
      </aside>

      {/* 2. Center Column: Fluid centering WebGL2 Volumetric Viewer Stage */}
      <section className="cockpit-panel-center">
        {activeDataset && activeDerivative && currentViewMode === "orthogonal" ? (
          <OrthogonalViewer
            dataset={activeDataset.slug}
            asset={activeDerivative.source_relative_path}
            zMax={zMax}
            yMax={yMax}
            xMax={xMax}
            physicalVoxelSizeNm={activeDerivative.physical_voxel_size_nm}
            xSlice={orthogonalCommitted.x}
            ySlice={orthogonalCommitted.y}
            zSlice={orthogonalCommitted.z}
            minContrast={currentMinContrast}
            maxContrast={currentMaxContrast}
            logScale={currentLogScale}
            colormap={currentColormap}
            onSliceChange={handleOrthogonalSliceChange}
            onLoadedMetadata={handleLoadedMetadata}
            onProbeChange={setActiveProbe}
            onSliceLoaded={handleSliceLoaded}
            onMeasurementPoint={handleMeasurementPoint}
            measurementMode={measurementMode}
            measurements={activeMeasurements}
            measurementDraftPoint={measurementDraft?.point || null}
            roiTool={roiTool}
            rois={activeRois}
            roiDraftPoint={roiDraft?.point || null}
            onRoiPoint={handleRoiPoint}
            onLoadingChange={(loading) => setViewerLoadingSource("orthogonal", loading)}
          />
        ) : activeDataset && activeDerivative ? (
          <VolumetricViewer
            dataset={activeDataset.slug}
            asset={activeDerivative.source_relative_path}
            zMax={zMax}
            yMax={yMax}
            xMax={xMax}
            physicalVoxelSizeNm={activeDerivative.physical_voxel_size_nm}
            axis={currentAxis}
            slice={currentClampedSlice}
            minContrast={currentMinContrast}
            maxContrast={currentMaxContrast}
            logScale={currentLogScale}
            colormap={currentColormap}
            viewMode={currentViewMode === "3d" ? "3d" : "2d"}
            downsample={currentDownsample}
            alphaScale={localAlphaScale}
            pitch={localPitch}
            yaw={localYaw}
            onRotationChange={handleRotationChange}
            onLoadedMetadata={handleLoadedMetadata}
            onProbeChange={setActiveProbe}
            onSliceLoaded={handleSliceLoaded}
            onMeasurementPoint={handleMeasurementPoint}
            measurementMode={measurementMode}
            measurements={activeMeasurements}
            measurementDraftPoint={measurementDraft?.point || null}
            roiTool={roiTool}
            rois={activeRois}
            roiDraftPoint={roiDraft?.point || null}
            onRoiPoint={handleRoiPoint}
            onLoadingChange={(loading) => setViewerLoadingSource("stage", loading)}
          />
        ) : (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#050505" }}>
            <span className="muted" style={{ fontFamily: "var(--font-display)" }}>No indexed volume file.</span>
          </div>
        )}
      </section>

      {/* 3. Right Column: Quantitative Stateful Ledger Panel */}
      <aside className="cockpit-panel-right">
        <div className="figure-plate-header" style={{ marginBottom: 16, paddingBottom: 10 }}>
          <div>
            <span className="kicker" style={{ fontSize: 10, letterSpacing: 0, textTransform: "uppercase" }}>
              {activeDataset?.source} {activeDataset?.entryId}
            </span>
            <h2 style={{ fontSize: 14, fontFamily: "var(--font-body)", fontWeight: 700, margin: "4px 0", lineHeight: 1.25, color: "var(--foreground)" }}>
              {activeDataset?.title}
            </h2>
          </div>
          <div className="figure-number" style={{ color: "var(--atlas-blue-dark)", fontSize: 10 }}>
            Data
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="analytics-tabs-nav">
          <button
            className={`analytics-tab-btn ${activeTab === "telemetry" ? "active" : ""}`}
            onClick={() => setActiveTab("telemetry")}
          >
            Measures
          </button>
          <button
            className={`analytics-tab-btn ${activeTab === "image-notes" ? "active" : ""}`}
            onClick={() => setActiveTab("image-notes")}
          >
            Notes
          </button>
          <button
            className={`analytics-tab-btn ${activeTab === "jobs" ? "active" : ""}`}
            onClick={() => setActiveTab("jobs")}
          >
            Jobs
          </button>
          <button
            className={`analytics-tab-btn ${activeTab === "planner" ? "active" : ""}`}
            onClick={() => setActiveTab("planner")}
          >
            Plan
          </button>
        </div>

        {/* Tab 1: Telemetry */}
        {activeTab === "telemetry" && (
          <div className="tab-pane">
            <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
              <div>
                <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 2, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                  Dimensions
                </span>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 12 }}>
                  {zMax} x {yMax} x {xMax} voxels ({activeDerivative?.dtype || "uint8"})
                </span>
              </div>

              {activeDerivative?.role === "segmentation_labels" ? (
                <div style={{ border: "1px solid rgba(198, 111, 45, 0.48)", background: "rgba(198, 111, 45, 0.08)", padding: "9px 10px", display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", fontFamily: "var(--font-display)" }}>
                    <strong style={{ color: "var(--atlas-orange)", fontSize: 10, textTransform: "uppercase" }}>
                      Segmentation Candidate
                    </strong>
                    <span className="muted" style={{ fontSize: 9, textTransform: "uppercase" }}>
                      {activeDerivative.review_state?.split("_").join(" ") || "review required"}
                    </span>
                  </div>
                  <div style={{ fontSize: 11.5, fontFamily: "var(--font-body)", lineHeight: 1.4 }}>
                    {activeDerivative.label_name || activeDerivative.task || "Label"} · {activeDerivative.method || "registered labels"}
                  </div>
                  <div className="muted" style={{ fontSize: 10, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                    {activeDerivative.qc?.foreground_fraction === undefined
                      ? "QC occupancy is unavailable."
                      : `${(activeDerivative.qc.foreground_fraction * 100).toFixed(3)}% foreground (${(activeDerivative.qc.foreground_voxels || 0).toLocaleString()} voxels).`} Human review is required; this result is not validated for clinical use.
                  </div>
                </div>
              ) : null}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 2, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                    Volume
                  </span>
                  <strong style={{ fontSize: 12.5, color: "var(--atlas-blue-dark)", fontFamily: "var(--font-display)" }}>
                    {totalVolumeUm3.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} µm³
                  </strong>
                </div>
                <div>
                  <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 2, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                    Slice
                  </span>
                  <strong style={{ fontSize: 12.5, color: "var(--atlas-blue-dark)", fontFamily: "var(--font-display)" }}>
                    {activeSliceAreaUm2.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} µm²
                  </strong>
                </div>
              </div>

              <div>
                <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 2, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                  Voxel Size
                </span>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 11.5 }}>
                  dx: {voxelSizeX} nm | dy: {voxelSizeY} nm | dz: {voxelSizeZ} nm
                </span>
              </div>

              {activeValidation ? (
                <div>
                  <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 4, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                    Data Compatibility
                  </span>
                  <div style={{ background: "rgba(0, 0, 0, 0.1)", border: "1px solid var(--border)", padding: "8px 10px", fontFamily: "var(--font-display)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: activeValidation.summary ? 5 : 0 }}>
                      <strong style={{ color: activeValidationColor, fontSize: 10, textTransform: "uppercase" }}>
                        {activeValidation.status}
                      </strong>
                      <span className="muted" style={{ fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        Array {activeDerivative?.array_path || activeDerivative?.source_relative_path || "."}
                      </span>
                    </div>
                    {activeValidation.summary ? (
                      <p className="muted" style={{ margin: "0 0 7px", fontSize: 11, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                        {activeValidation.summary}
                      </p>
                    ) : null}
                    {activeValidationChecks.length > 0 ? (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 8px", fontSize: 9.5 }}>
                        {activeValidationChecks.slice(0, 8).map(([key, ok]) => (
                          <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                            <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {key.split("_").join(" ")}
                            </span>
                            <strong style={{ color: ok ? "var(--atlas-blue-dark)" : "var(--atlas-orange)" }}>
                              {ok ? "OK" : "NO"}
                            </strong>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                    Measurements
                  </span>
                  {activeMeasurements.length > 0 ? (
                    <button
                      type="button"
                      className="button"
                      onClick={exportMeasurementsCsv}
                      style={{ padding: "4px 7px", fontSize: 9 }}
                    >
                      Export CSV
                    </button>
                  ) : null}
                </div>
                {activeMeasurements.length > 0 ? (
                  <div style={{ display: "grid", gap: 7, maxHeight: 360, overflow: "auto", paddingRight: 2 }}>
                    {activeMeasurements.map((measurement) => (
                      <div
                        key={measurement.id}
                        style={{
                          display: "grid",
                          gap: 7,
                          background: selectedMeasurementId === measurement.id ? "rgba(31, 111, 135, 0.12)" : "rgba(0, 0, 0, 0.1)",
                          border: selectedMeasurementId === measurement.id ? "1px solid rgba(31, 111, 135, 0.45)" : "1px solid var(--border)",
                          padding: "7px 9px",
                          fontFamily: "var(--font-display)",
                        }}
                      >
                        <div style={{ display: "grid", gridTemplateColumns: "minmax(52px, 72px) 1fr auto auto", gap: 6, alignItems: "center" }}>
                          <input
                            aria-label={`Measurement label ${measurement.id}`}
                            value={measurement.label}
                            onChange={(event) => updateMeasurement(measurement.id, { label: event.target.value })}
                            style={{
                              width: "100%",
                              minWidth: 0,
                              border: "1px solid var(--border)",
                              background: "var(--field-background)",
                              color: "var(--foreground)",
                              padding: "4px 5px",
                              fontSize: 10,
                              fontFamily: "var(--font-display)",
                              fontWeight: 700,
                            }}
                          />
                          <strong style={{ display: "block", fontSize: 11, color: "var(--atlas-blue-dark)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {formatDistance(measurement.distanceUm)}
                          </strong>
                          <button
                            type="button"
                            className="button"
                            onClick={() => jumpToMeasurement(measurement)}
                            style={{ padding: "4px 6px", fontSize: 9 }}
                          >
                            Jump
                          </button>
                          <button
                            type="button"
                            className="button"
                            onClick={() => deleteMeasurement(measurement.id)}
                            style={{ padding: "4px 6px", fontSize: 9 }}
                          >
                            Delete
                          </button>
                        </div>
                        <span className="muted" style={{ display: "block", fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {measurement.axis.toUpperCase()} slice {measurement.slice + 1} | {formatVoxelPoint(measurement.start)} to {formatVoxelPoint(measurement.end)}
                        </span>
                        <textarea
                          aria-label={`Measurement note ${measurement.id}`}
                          value={measurement.note || ""}
                          onChange={(event) => updateMeasurement(measurement.id, { note: event.target.value })}
                          placeholder="Measurement note"
                          rows={2}
                          style={{
                            width: "100%",
                            resize: "vertical",
                            minHeight: 42,
                            border: "1px solid var(--border)",
                            background: "var(--field-background)",
                            color: "var(--foreground)",
                            padding: "6px 7px",
                            fontSize: 10.5,
                            fontFamily: "var(--font-body)",
                            lineHeight: 1.35,
                            boxSizing: "border-box",
                          }}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                    Enable Measure Distance, then click two points on a 2D plane to save calibrated distances.
                  </p>
                )}
              </div>

              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                    Regions
                  </span>
                  {activeRois.length > 0 ? (
                    <button
                      type="button"
                      className="button"
                      onClick={exportRoisJson}
                      style={{ padding: "4px 7px", fontSize: 9 }}
                    >
                      Export JSON
                    </button>
                  ) : null}
                </div>
                {activeRois.length > 0 ? (
                  <div style={{ display: "grid", gap: 7, maxHeight: 340, overflow: "auto", paddingRight: 2 }}>
                    {activeRois.map((roi) => (
                      <div
                        key={roi.id}
                        style={{
                          display: "grid",
                          gap: 7,
                          background: selectedRoiId === roi.id ? "rgba(31, 111, 135, 0.12)" : "rgba(0, 0, 0, 0.1)",
                          border: selectedRoiId === roi.id ? "1px solid rgba(31, 111, 135, 0.45)" : "1px solid var(--border)",
                          padding: "7px 9px",
                          fontFamily: "var(--font-display)",
                        }}
                      >
                        <div style={{ display: "grid", gridTemplateColumns: "minmax(52px, 70px) minmax(72px, 1fr) auto auto", gap: 6, alignItems: "center" }}>
                          <input
                            aria-label={`ROI label ${roi.id}`}
                            value={roi.label}
                            onChange={(event) => updateRoi(roi.id, { label: event.target.value })}
                            style={{
                              width: "100%",
                              minWidth: 0,
                              border: "1px solid var(--border)",
                              background: "var(--field-background)",
                              color: "var(--foreground)",
                              padding: "4px 5px",
                              fontSize: 10,
                              fontFamily: "var(--font-display)",
                              fontWeight: 700,
                            }}
                          />
                          <input
                            aria-label={`ROI category ${roi.id}`}
                            value={roi.category}
                            onChange={(event) => updateRoi(roi.id, { category: event.target.value })}
                            style={{
                              width: "100%",
                              minWidth: 0,
                              border: "1px solid var(--border)",
                              background: "var(--field-background)",
                              color: "var(--foreground)",
                              padding: "4px 5px",
                              fontSize: 10,
                              fontFamily: "var(--font-display)",
                            }}
                          />
                          <button
                            type="button"
                            className="button"
                            onClick={() => jumpToRoi(roi)}
                            style={{ padding: "4px 6px", fontSize: 9 }}
                          >
                            Jump
                          </button>
                          <button
                            type="button"
                            className="button"
                            onClick={() => deleteRoi(roi.id)}
                            style={{ padding: "4px 6px", fontSize: 9 }}
                          >
                            Delete
                          </button>
                        </div>
                        <span className="muted" style={{ display: "block", fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {roi.kind.toUpperCase()} | {roi.axis.toUpperCase()} slice {roi.slice + 1} | {formatVoxelPoint(roi.start)}{roi.end ? ` to ${formatVoxelPoint(roi.end)}` : ""}
                        </span>
                        <textarea
                          aria-label={`ROI note ${roi.id}`}
                          value={roi.note || ""}
                          onChange={(event) => updateRoi(roi.id, { note: event.target.value })}
                          placeholder="ROI note"
                          rows={2}
                          style={{
                            width: "100%",
                            resize: "vertical",
                            minHeight: 42,
                            border: "1px solid var(--border)",
                            background: "var(--field-background)",
                            color: "var(--foreground)",
                            padding: "6px 7px",
                            fontSize: 10.5,
                            fontFamily: "var(--font-body)",
                            lineHeight: 1.35,
                            boxSizing: "border-box",
                          }}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                    Use ROI Point or ROI Box on a 2D plane to define anatomy targets that jobs and exports can reference.
                  </p>
                )}
              </div>

              <div>
                <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 2, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                  Probe
                </span>
                {activeProbe ? (
                  <div style={{ background: "rgba(0, 0, 0, 0.15)", padding: "8px 12px", border: "1px solid var(--border)" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11, fontFamily: "var(--font-display)" }}>
                      <div>
                        <span style={{ color: "var(--accent-foreground)" }}>Pixel:</span>
                        <span style={{ marginLeft: 4 }}>({activeProbe.px}, {activeProbe.py}, {activeProbe.pz})</span>
                      </div>
                      <div>
                        <span style={{ color: "var(--accent-foreground)" }}>Value:</span>
                        <span style={{ marginLeft: 4, fontWeight: "bold", color: "var(--atlas-orange)" }}>{activeProbe.val}</span>
                      </div>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11, fontFamily: "var(--font-display)", borderTop: "1px solid var(--border)", paddingTop: 4 }}>
                      <span style={{ color: "var(--accent-foreground)" }}>Physical Position:</span>
                      <div style={{ color: "var(--foreground)", fontWeight: "bold", fontSize: 11.5, marginTop: 2 }}>
                        X: {activeProbe.xUm.toFixed(3)} µm | Y: {activeProbe.yUm.toFixed(3)} µm | Z: {activeProbe.zUm.toFixed(3)} µm
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontStyle: "italic", fontSize: 12, color: "var(--accent-foreground)", padding: "4px 0", fontFamily: "var(--font-body)" }}>
                    Hover cursor over WebGL2 slice canvas to probe calibrated physical values.
                  </div>
                )}
              </div>

              <div>
                <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                  Histogram
                </span>
                <div style={{ background: "#050505", border: "1px solid var(--border)", padding: 8, position: "relative" }}>
                  {histogramData.every(x => x === 0) ? (
                    <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontFamily: "var(--font-display)", color: "#666" }}>
                      Loading histogram buffers...
                    </div>
                  ) : (
                    <svg width="100%" height="80" viewBox="0 0 300 80" preserveAspectRatio="none" style={{ display: "block" }}>
                      <line x1="75" y1="0" x2="75" y2="80" stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" />
                      <line x1="150" y1="0" x2="150" y2="80" stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" />
                      <line x1="225" y1="0" x2="225" y2="80" stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" />
                      <line x1="0" y1="40" x2="300" y2="40" stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" />
                      <path
                        d={svgPath}
                        fill="rgba(22, 139, 179, 0.25)"
                        stroke="var(--atlas-blue)"
                        strokeWidth="1.5"
                      />
                    </svg>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "var(--font-display)", color: "#888", marginTop: 4 }}>
                    <span>0 (Low)</span>
                    <span>{maxPossibleIntensity} (High)</span>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
              <h3 className="kicker" style={{ fontSize: 10, marginBottom: 8, letterSpacing: 0 }}>
                Reuse Notes
              </h3>

              {activeFindings.length === 0 ? (
                <p className="muted" style={{ margin: 0, fontSize: 11.5, fontStyle: "italic", fontFamily: "var(--font-body)" }}>
                  No calibration findings or caveats indexed for this volume. Direct measurements carry full standard error.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {activeFindings.map((finding) => {
                    const isCritical = finding.severity.toLowerCase() === "critical";
                    const isWarning = finding.severity.toLowerCase() === "warning" || finding.severity.toLowerCase() === "review";
                    
                    let bg = "rgba(0,0,0,0.02)";
                    let borderCol = "var(--border)";
                    let titleCol = "var(--foreground)";
                    if (isCritical) {
                      bg = "rgba(198, 111, 45, 0.04)";
                      borderCol = "rgba(198, 111, 45, 0.3)";
                      titleCol = "var(--atlas-orange)";
                    } else if (isWarning) {
                      bg = "rgba(22, 139, 179, 0.03)";
                      borderCol = "rgba(22, 139, 179, 0.3)";
                      titleCol = "var(--atlas-blue-dark)";
                    }

                    return (
                      <article
                        key={finding.finding_id}
                        className="panel"
                        style={{
                          background: bg,
                          border: `1px solid ${borderCol}`,
                          padding: "10px 14px",
                          fontSize: 12,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0, fontWeight: "bold", color: titleCol, fontFamily: "var(--font-display)" }}>
                            {finding.severity} · {finding.category}
                          </span>
                          <span style={{ fontSize: 9, fontFamily: "var(--font-display)", color: "#666" }}>
                            {finding.finding_id}
                          </span>
                        </div>
                        <strong style={{ display: "block", fontSize: 11, marginBottom: 4, fontFamily: "var(--font-display)" }}>
                          {finding.asset_relative_path ? finding.asset_relative_path.split("/").pop() : "Dataset-level calibration"}
                        </strong>
                        <p className="muted" style={{ margin: "0 0 6px 0", lineHeight: 1.4, fontSize: 11.5, fontFamily: "var(--font-body)" }}>
                          {finding.summary}
                        </p>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Image notes */}
        {activeTab === "image-notes" && (
          <div className="tab-pane">
            <div>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Workbench Session
              </span>
              <div style={{ display: "grid", gap: 8, fontSize: 11.5, fontFamily: "var(--font-display)", background: "rgba(0,0,0,0.1)", padding: "10px 12px", border: "1px solid var(--border)" }}>
                <div style={{ display: "grid", gap: 7, border: "1px solid var(--border)", background: "var(--field-background)", padding: "8px 9px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <span className="muted" style={{ textTransform: "uppercase", fontSize: 9, fontWeight: 700 }}>
                      Atlas Handoff
                    </span>
                    <strong
                      style={{
                        color: atlasHandoffResolution?.status === "ready" ? "var(--atlas-blue-dark)" : activeAtlasHandoff ? "var(--atlas-orange)" : "var(--accent-foreground)",
                        textTransform: "uppercase",
                        fontSize: 9,
                      }}
                    >
                      {atlasHandoffResolution?.status || "None"}
                    </strong>
                  </div>
                  {activeAtlasHandoff ? (
                    <>
                      <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                        <strong style={{ fontSize: 10.5, lineHeight: 1.35 }}>
                          {activeAtlasHandoff.dataset.title}
                        </strong>
                        <span className="muted" style={{ fontSize: 9.5, lineHeight: 1.35 }}>
                          {activeAtlasHandoff.dataset.cell_type} | {activeAtlasHandoff.dataset.modality} | {activeAtlasHandoff.dataset.year}
                        </span>
                        <span className="muted" title={activeAtlasHandoffPath || undefined} style={{ fontSize: 9, overflowWrap: "anywhere" }}>
                          {activeAtlasHandoffPath ? formatPathBasename(activeAtlasHandoffPath) : activeAtlasHandoff.dataset.dataset_id}
                        </span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                        {atlasHandoffResolution?.status === "ready" ? (
                          <button type="button" className="button" onClick={openMatchedAtlasHandoffDataset} style={{ padding: "5px 7px", fontSize: 9.5 }}>
                            Open Match
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="button"
                            onClick={() => isTauri ? void handleOpenLocalDirectory() : undefined}
                            disabled={!isTauri}
                            style={{ padding: "5px 7px", fontSize: 9.5 }}
                          >
                            Open Local Data
                          </button>
                        )}
                        <button type="button" className="button" onClick={clearAtlasHandoff} style={{ padding: "5px 7px", fontSize: 9.5 }}>
                          Clear
                        </button>
                      </div>
                      {activeAtlasHandoff.asset_candidates.length > 0 ? (
                        <div style={{ display: "grid", gap: 3, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                          {activeAtlasHandoff.asset_candidates.slice(0, 3).map((candidate) => (
                            <a
                              key={candidate.locator_url}
                              href={candidate.locator_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="muted"
                              style={{ fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            >
                              {candidate.repository || "Repository"}{candidate.accession ? ` ${candidate.accession}` : ""}
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button"
                      onClick={() => isTauri ? void openAtlasHandoffNative() : caosHandoffInputRef.current?.click()}
                      style={{ padding: "6px 8px", fontSize: 9.5 }}
                    >
                      Open Atlas Handoff
                    </button>
                  )}
                  {atlasHandoffStatus ? (
                    <div style={{ color: "var(--atlas-blue-dark)", fontSize: 9.5, lineHeight: 1.35 }}>
                      {atlasHandoffStatus}
                    </div>
                  ) : null}
                  {atlasHandoffError ? (
                    <div style={{ color: "var(--atlas-orange)", fontSize: 9.5, lineHeight: 1.35 }}>
                      {atlasHandoffError}
                    </div>
                  ) : null}
                </div>
                <input
                  ref={caosHandoffInputRef}
                  type="file"
                  accept="application/json,.json,.caos-handoff"
                  onChange={(event) => void importAtlasHandoff(event.target.files?.[0] || null)}
                  style={{ display: "none" }}
                />
                {isTauri ? (
                  <div style={{ display: "grid", gap: 7, border: "1px solid var(--border)", background: "var(--field-background)", padding: "8px 9px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                      <span className="muted" style={{ textTransform: "uppercase", fontSize: 9, fontWeight: 700 }}>
                        CAOS Project
                      </span>
                      <strong style={{ color: currentProjectSaveStateColor, textTransform: "uppercase", fontSize: 9 }}>
                        {currentProjectSaveState}
                      </strong>
                    </div>
                    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {currentProjectDisplayName}
                      </span>
                      <span className="muted" title={currentProjectPath || undefined} style={{ fontSize: 9, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {currentProjectPath ? formatPathBasename(currentProjectPath) : "Unsaved local project"}
                      </span>
                    </div>
                    {projectRecoveryStatus ? (
                      <div
                        style={{
                          borderTop: "1px solid var(--border)",
                          paddingTop: 7,
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        <div style={{ color: projectRecoveryStatus.kind === "error" ? "var(--atlas-orange)" : "var(--foreground)", fontSize: 9.5, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                          {projectRecoveryStatus.summary}
                        </div>
                        {projectRecoveryStatus.path ? (
                          <div className="muted" style={{ fontSize: 9, overflowWrap: "anywhere" }}>
                            {projectRecoveryStatus.path}
                          </div>
                        ) : null}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                          {projectRecoveryStatus.action === "open-local-folder" ? (
                            <button
                              type="button"
                              className="button"
                              onClick={() => void handleOpenLocalDirectory()}
                              style={{ padding: "5px 7px", fontSize: 9.5 }}
                            >
                              Open Volume
                            </button>
                          ) : projectRecoveryStatus.action === "retry-project-open" && projectRecoveryStatus.actionPath ? (
                            <button
                              type="button"
                              className="button"
                              onClick={() =>
                                void openCaosProjectPath(projectRecoveryStatus.actionPath!, {
                                  skipDirtyCheck: true,
                                  actionLabel: "Opened",
                                })
                              }
                              style={{ padding: "5px 7px", fontSize: 9.5 }}
                            >
                              Retry
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="button"
                              onClick={() => setProjectRecoveryStatus(null)}
                              style={{ padding: "5px 7px", fontSize: 9.5 }}
                            >
                              Dismiss
                            </button>
                          )}
                          <button
                            type="button"
                            className="button"
                            onClick={forgetProjectRecoveryPath}
                            style={{ padding: "5px 7px", fontSize: 9.5 }}
                          >
                            Forget
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {recentCaosProjects.length > 0 ? (
                      <div style={{ display: "grid", gap: 5, borderTop: "1px solid var(--border)", paddingTop: 7 }}>
                        <span className="muted" style={{ textTransform: "uppercase", fontSize: 9, fontWeight: 700 }}>
                          Recent Projects
                        </span>
                        {recentCaosProjects.slice(0, 3).map((project) => (
                          <button
                            key={project.path}
                            type="button"
                            className="button"
                            onClick={() => void openCaosProjectPath(project.path)}
                            title={project.path}
                            style={{
                              display: "grid",
                              gap: 2,
                              textAlign: "left",
                              width: "100%",
                              padding: "6px 8px",
                              fontSize: 10,
                              background: "rgba(0, 0, 0, 0.02)",
                            }}
                          >
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {project.name}
                            </span>
                            <span className="muted" style={{ fontSize: 9, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {project.datasetSlug} | {formatDateTime(project.lastOpenedAt)}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <input
                  className="search-input"
                  type="text"
                  value={sessionName}
                  onChange={(event) => setSessionName(event.target.value)}
                  placeholder={defaultSessionName}
                  style={{ width: "100%", padding: "6px 8px", fontSize: 11 }}
                />
                <textarea
                  className="search-input"
                  value={sessionNote}
                  onChange={(event) => setSessionNote(event.target.value)}
                  placeholder="Add local notes for this view, sample prep, artifact, or coordinate."
                  rows={4}
                  style={{
                    width: "100%",
                    resize: "vertical",
                    minHeight: 78,
                    padding: "7px 8px",
                    fontSize: 11,
                    lineHeight: 1.4,
                    fontFamily: "var(--font-body)",
                  }}
                />
                {isTauri ? (
                  <button
                    type="button"
                    className="button"
                    disabled={!sessionNote && !sessionName}
                    onClick={() => {
                      setSessionName("");
                      setSessionNote("");
                      setSessionStatus("Draft cleared.");
                    }}
                    style={{ padding: "6px 10px", fontSize: 10 }}
                  >
                    Clear Draft
                  </button>
                ) : (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <button
                        type="button"
                        className="button"
                        disabled={!activeDataset || !activeDerivative}
                        onClick={saveCurrentSession}
                        style={{ padding: "6px 10px", fontSize: 10 }}
                      >
                        Save View
                      </button>
                      <button
                        type="button"
                        className="button"
                        disabled={!sessionNote && !sessionName}
                        onClick={() => {
                          setSessionName("");
                          setSessionNote("");
                          setSessionStatus("Draft cleared.");
                        }}
                        style={{ padding: "6px 10px", fontSize: 10 }}
                      >
                        Clear Draft
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <button
                        type="button"
                        className="button"
                        disabled={!activeDataset || !activeDerivative}
                        onClick={exportCurrentViewPng}
                        style={{ padding: "6px 10px", fontSize: 10 }}
                      >
                        Export View
                      </button>
                      <button
                        type="button"
                        className="button"
                        disabled={!activeDataset || !activeDerivative}
                        onClick={exportProjectBundle}
                        style={{ padding: "6px 10px", fontSize: 10 }}
                      >
                        Export Bundle
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <button
                        type="button"
                        className="button"
                        disabled={!activeDataset || !activeDerivative}
                        onClick={downloadCaosProject}
                        style={{ padding: "6px 10px", fontSize: 10 }}
                      >
                        Export CAOS
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={() => caosProjectInputRef.current?.click()}
                        style={{ padding: "6px 10px", fontSize: 10 }}
                      >
                        Import CAOS
                      </button>
                    </div>
                  </>
                )}
                <input
                  ref={caosProjectInputRef}
                  type="file"
                  accept="application/json,.json,.caos"
                  onChange={(event) => void importCaosProject(event.target.files?.[0] || null)}
                  style={{ display: "none" }}
                />

                {sessionStatus ? (
                  <div style={{ color: "var(--atlas-blue-dark)", fontSize: 10, lineHeight: 1.35 }}>
                    {sessionStatus}
                  </div>
                ) : null}

                {savedSessions.length > 0 ? (
                  <div style={{ display: "grid", gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <span className="muted" style={{ textTransform: "uppercase", fontSize: 9, fontWeight: 700 }}>
                      Saved Views
                    </span>
                    {savedSessions.slice(0, 5).map((session) => (
                      <div
                        key={session.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr auto",
                          gap: 8,
                          alignItems: "center",
                          border: "1px solid var(--border)",
                          background: "var(--field-background)",
                          padding: "7px 8px",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => restoreSession(session)}
                          className="button"
                          title={session.sourcePath || session.datasetSlug}
                          style={{
                            border: "none",
                            background: "transparent",
                            padding: 0,
                            textAlign: "left",
                            minWidth: 0,
                            cursor: "pointer",
                          }}
                        >
                          <span style={{ display: "block", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {session.name}
                          </span>
                          <span className="muted" style={{ display: "block", fontSize: 9, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {session.datasetSlug} | {session.viewMode} | {formatDateTime(session.updatedAt)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => deleteSession(session.id)}
                          style={{ padding: "4px 6px", fontSize: 9 }}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: 11, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                    Saved views stay local on this machine and capture the dataset, slice coordinates, contrast, rendering mode, and note draft.
                  </p>
                )}
              </div>
            </div>

            <div>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 4, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Notes
              </span>
              <h3 style={{ fontSize: "1.05rem", fontWeight: "bold", margin: "0 0 8px 0", fontFamily: "var(--font-display)" }}>
                Feature analysis not connected
              </h3>
              <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                This workbench currently exposes raw volume navigation, calibrated probe values, and sidecar-backed corpus planning. Learned image embeddings or similarity rankings should only appear here after a real model pipeline is wired into the sidecar.
              </p>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Account
              </span>
              <div style={{ display: "grid", gap: 8, fontSize: 11.5, fontFamily: "var(--font-display)", background: "rgba(0,0,0,0.1)", padding: "10px 12px", border: "1px solid var(--border)" }}>
                {accountUser && accountDevice ? (
                  <>
                    <div>
                      <div style={{ color: "var(--accent-foreground)", fontSize: 9, fontWeight: 700, textTransform: "uppercase" }}>
                        Connected
                      </div>
                      <div style={{ marginTop: 2, fontWeight: 700, overflowWrap: "anywhere" }}>
                        {accountUser.primary_email}
                      </div>
                      <div style={{ color: "#888", fontSize: 9, marginTop: 2 }}>
                        {accountDevice.device_name} | Expires {new Date(accountDevice.expires_at).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="button"
                      disabled={accountBusy}
                      onClick={handleDisconnectAccount}
                      style={{ width: "100%", padding: "6px 10px", fontSize: 10 }}
                    >
                      Disconnect Account
                    </button>
                  </>
                ) : pairing ? (
                  <>
                    <div>
                      <div style={{ color: "var(--accent-foreground)", fontSize: 9, fontWeight: 700, textTransform: "uppercase" }}>
                        Pairing Code
                      </div>
                      <div style={{ marginTop: 4, fontSize: 20, fontWeight: 700, letterSpacing: 1, color: "var(--atlas-blue-dark)" }}>
                        {pairing.user_code}
                      </div>
                      <div style={{ color: "#888", fontSize: 9, marginTop: 4 }}>
                        Approve this code in Atlas. Workbench will finish connecting automatically.
                      </div>
                    </div>
                    <button
                      type="button"
                      className="button"
                      disabled={accountBusy}
                      onClick={() => {
                        const verificationUrl = `${getAtlasBaseUrl()}${pairing.verification_uri}`;
                        navigator.clipboard?.writeText(verificationUrl);
                        window.open(verificationUrl, "_blank", "noopener,noreferrer");
                      }}
                      style={{ width: "100%", padding: "6px 10px", fontSize: 10 }}
                    >
                      Open Atlas Approval
                    </button>
                  </>
                ) : (
                  <>
                    <p className="muted" style={{ margin: 0, lineHeight: 1.45, fontFamily: "var(--font-body)" }}>
                      Connect an account to sync saved Workbench state later. Local volume data stays on this machine.
                    </p>
                    <button
                      type="button"
                      className="button"
                      disabled={accountBusy}
                      onClick={handleStartPairing}
                      style={{ width: "100%", padding: "6px 10px", fontSize: 10 }}
                    >
                      {accountBusy ? "Starting..." : "Connect Account"}
                    </button>
                  </>
                )}
                {accountStatus ? (
                  <div style={{ color: "var(--atlas-blue-dark)", fontSize: 10, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                    {accountStatus}
                  </div>
                ) : null}
                {accountError ? (
                  <div style={{ color: "var(--atlas-orange)", fontSize: 10, lineHeight: 1.35 }}>
                    {accountError}
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Current File
              </span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12, fontFamily: "var(--font-display)", background: "rgba(0,0,0,0.15)", padding: "10px 12px", border: "1px solid var(--border)" }}>
                <div>
                  <div style={{ color: "var(--accent-foreground)", fontSize: 9, fontFamily: "var(--font-display)", fontWeight: 600 }}>ACTIVE DATASET</div>
                  <div style={{ fontWeight: "bold", marginTop: 2, overflowWrap: "anywhere" }}>{activeDataset?.slug}</div>
                  <div style={{ color: "#888", fontSize: 9, marginTop: 1 }}>{activeDataset?.source} {activeDataset?.entryId}</div>
                </div>
                <div>
                  <div style={{ color: "var(--accent-foreground)", fontSize: 9, fontFamily: "var(--font-display)", fontWeight: 600 }}>ACTIVE ASSET</div>
                  <div style={{ fontWeight: "bold", marginTop: 2, overflowWrap: "anywhere" }}>{activeDerivative?.source_relative_path.split("/").pop()}</div>
                  <div style={{ color: "#888", fontSize: 9, marginTop: 1 }}>{activeDerivative?.dtype} | {zMax} x {yMax} x {xMax}</div>
                </div>
              </div>
              {activeDerivative?.source_local_path || activeDerivative?.output_path ? (
                <div style={{ marginTop: 8, fontSize: 10.5, fontFamily: "var(--font-display)", color: "var(--accent-foreground)", overflowWrap: "anywhere" }}>
                  <strong style={{ color: "var(--foreground)", textTransform: "uppercase", fontSize: 9 }}>Source Path:</strong>{" "}
                  {activeDerivative.source_local_path || activeDerivative.output_path}
                </div>
              ) : null}
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Next Hook
              </span>
              <p className="muted" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                The correct next step is a sidecar endpoint that returns model name, version, feature vector metadata, and ranked matches from actual indexed data. Until then, this panel stays descriptive instead of presenting fabricated similarity scores.
              </p>
            </div>
          </div>
        )}

        {/* Tab 3: Local Jobs */}
        {activeTab === "jobs" && (
          <div className="tab-pane">
            <div>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 4, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Jobs
              </span>
              <h3 style={{ fontSize: "1.05rem", fontWeight: "bold", margin: "0 0 8px 0", fontFamily: "var(--font-display)" }}>
                Local Analysis Queue
              </h3>
              <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                Run exportable local jobs against the current CAOS project state. These are deterministic workspace artifacts, not account-backed cloud jobs.
              </p>
            </div>

            <div style={{ display: "grid", gap: 9, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 8 }}>
                <div>
                  <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", fontFamily: "var(--font-display)", fontWeight: 600 }}>
                    Segmentation
                  </span>
                  <strong style={{ display: "block", fontSize: 12, color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                    Candidate Label Volume
                  </strong>
                </div>
                <span style={{ color: "var(--atlas-orange)", fontSize: 9, fontFamily: "var(--font-display)", fontWeight: 700, textTransform: "uppercase" }}>
                  Review Required
                </span>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 10.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                Run the deterministic threshold baseline to exercise the full label pipeline. It is a plumbing baseline, not a validated tooth or cell model.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
                <label style={{ display: "grid", gap: 3, fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                  <span className="muted" style={{ textTransform: "uppercase" }}>Task</span>
                  <select
                    className="search-input"
                    value={segmentationTask}
                    onChange={(event) => {
                      const task = event.target.value as "cell" | "tooth";
                      setSegmentationTask(task);
                      setSegmentationLabelName(task);
                    }}
                    style={{ width: "100%", padding: "5px 7px", fontSize: 10 }}
                  >
                    <option value="cell">Cell</option>
                    <option value="tooth">Tooth</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 3, fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                  <span className="muted" style={{ textTransform: "uppercase" }}>Operator</span>
                  <select
                    className="search-input"
                    value={segmentationOperator}
                    onChange={(event) => setSegmentationOperator(event.target.value as "ge" | "gt" | "le" | "lt")}
                    style={{ width: "100%", padding: "5px 7px", fontSize: 10 }}
                  >
                    <option value="ge">Intensity ≥</option>
                    <option value="gt">Intensity &gt;</option>
                    <option value="le">Intensity ≤</option>
                    <option value="lt">Intensity &lt;</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 3, fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                  <span className="muted" style={{ textTransform: "uppercase" }}>Threshold</span>
                  <input
                    className="search-input"
                    type="number"
                    min={0}
                    max={maxPossibleIntensity}
                    value={segmentationThreshold}
                    onChange={(event) => setSegmentationThreshold(Number(event.target.value))}
                    style={{ width: "100%", padding: "5px 7px", fontSize: 10 }}
                  />
                </label>
                <label style={{ display: "grid", gap: 3, fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                  <span className="muted" style={{ textTransform: "uppercase" }}>Label</span>
                  <input
                    className="search-input"
                    value={segmentationLabelName}
                    maxLength={80}
                    onChange={(event) => setSegmentationLabelName(event.target.value)}
                    style={{ width: "100%", padding: "5px 7px", fontSize: 10 }}
                  />
                </label>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => void startSegmentationCandidate()}
                disabled={segmentationLoading || !activeDataset || !activeDerivative || activeDerivative.role === "segmentation_labels" || !Number.isFinite(segmentationThreshold)}
                style={{ width: "100%", padding: "7px 10px", fontSize: 10.5 }}
              >
                {segmentationLoading ? "Starting…" : "Run Candidate Segmentation"}
              </button>
              {segmentationStatus ? (
                <div style={{ color: "var(--atlas-blue-dark)", fontSize: 10, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>{segmentationStatus}</div>
              ) : null}
              {segmentationError ? (
                <div style={{ color: "var(--atlas-orange)", fontSize: 10, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>{segmentationError}</div>
              ) : null}
            </div>

            <div style={{ display: "grid", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                    Import
                  </span>
                  <strong style={{ display: "block", fontSize: 12, color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                    Index Queue
                  </strong>
                </div>
                <button type="button" className="button" onClick={loadIndexQueue} disabled={indexQueueLoading} style={{ padding: "5px 8px", fontSize: 9.5 }}>
                  {indexQueueLoading ? "Scanning" : "Scan"}
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 7 }}>
                <button
                  type="button"
                  className="button"
                  onClick={startNextActiveConversion}
                  disabled={indexJobsLoading || !activeReadyConversionCount}
                  title={activeReadyConversionCount ? `${activeReadyConversionCount} ready conversions for the active dataset.` : "No ready conversions for the active dataset."}
                  style={{ padding: "6px 8px", fontSize: 9.5 }}
                >
                  Run Next
                </button>
                <button type="button" className="button" onClick={refreshWorkbenchData} disabled={indexQueueLoading} style={{ padding: "6px 8px", fontSize: 9.5 }}>
                  Refresh Data
                </button>
                <button type="button" className="button" onClick={openPrivateRegistryNative} disabled={!isTauri} style={{ padding: "6px 8px", fontSize: 9.5 }}>
                  Registry
                </button>
                <button type="button" className="button" onClick={openPrivateWorksetNative} disabled={!isTauri} style={{ padding: "6px 8px", fontSize: 9.5 }}>
                  Workset
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => setIndexQueue(null)}
                  disabled={indexQueueLoading || !indexQueue}
                  style={{ padding: "6px 8px", fontSize: 9.5 }}
                >
                  Clear View
                </button>
              </div>

              <p className="muted" style={{ margin: 0, fontSize: 10.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                Volume File counts converted loadable volumes. Ready assets show here first, then appear in the selector after conversion finishes.
              </p>

              {indexQueueError && (
                <p style={{ margin: 0, color: "var(--atlas-orange)", fontSize: 11, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                  {indexQueueError}
                </p>
              )}
              {indexQueueStatus && (
                <p className="muted" style={{ margin: 0, fontSize: 11, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                  {indexQueueStatus}
                </p>
              )}

              <div style={{ display: "grid", gap: 8, border: "1px solid var(--border)", background: "rgba(0, 0, 0, 0.06)", padding: "8px 9px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "start" }}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: "block", fontSize: 11, color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                      Batch Conversion Plan
                    </strong>
                    <span className="muted" style={{ display: "block", fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {indexBatchPlan ? indexBatchPlan.plan_id : "No plan loaded"}
                    </span>
                  </div>
                  <span style={{ color: indexBatchPlan?.summary.planned_count ? "var(--atlas-blue-dark)" : "var(--accent-foreground)", fontSize: 9.5, fontFamily: "var(--font-display)", fontWeight: 700 }}>
                    {indexBatchPlan?.summary.planned_count ?? 0}
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
                  {(["active", "all"] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      className="button"
                      onClick={() => setIndexBatchScope(scope)}
                      style={{
                        padding: "5px 6px",
                        fontSize: 9,
                        background: indexBatchScope === scope ? "var(--atlas-blue)" : undefined,
                        color: indexBatchScope === scope ? "white" : undefined,
                      }}
                    >
                      {scope === "active" ? "Active Dataset" : "All Datasets"}
                    </button>
                  ))}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 7 }}>
                  <label className="muted" style={{ display: "grid", gap: 3, fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                    Total Cap
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={indexBatchTotalLimit}
                      onChange={(event) => setIndexBatchTotalLimit(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}
                      style={{ border: "1px solid var(--border)", padding: "5px 6px", fontSize: 10, fontFamily: "var(--font-display)" }}
                    />
                  </label>
                  <label className="muted" style={{ display: "grid", gap: 3, fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                    Per Dataset
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={indexBatchPerDatasetLimit}
                      onChange={(event) => setIndexBatchPerDatasetLimit(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}
                      style={{ border: "1px solid var(--border)", padding: "5px 6px", fontSize: 10, fontFamily: "var(--font-display)" }}
                    />
                  </label>
                  <label className="muted" style={{ display: "grid", gap: 3, fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                    Concurrency
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={indexBatchConcurrency}
                      onChange={(event) => setIndexBatchConcurrency(Math.max(1, Math.min(8, Number(event.target.value) || 1)))}
                      style={{ border: "1px solid var(--border)", padding: "5px 6px", fontSize: 10, fontFamily: "var(--font-display)" }}
                    />
                  </label>
                </div>

                <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                  <input
                    type="checkbox"
                    checked={indexBatchRetryFailed}
                    onChange={(event) => setIndexBatchRetryFailed(event.target.checked)}
                  />
                  Retry failed or cancelled jobs
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
                  <button type="button" className="button" onClick={loadIndexBatchPlan} disabled={indexBatchLoading || indexBatchRunsLoading} style={{ padding: "5px 6px", fontSize: 9 }}>
                    {indexBatchLoading ? "Planning" : "Plan"}
                  </button>
                  <button type="button" className="button" onClick={startIndexBatchRun} disabled={indexBatchLoading || indexBatchRunsLoading || !indexBatchPlan?.items.length} style={{ padding: "5px 6px", fontSize: 9 }}>
                    Start Run
                  </button>
                  <button type="button" className="button" onClick={exportIndexBatchPlan} disabled={!indexBatchPlan} style={{ padding: "5px 6px", fontSize: 9 }}>
                    Export
                  </button>
                </div>

                {indexBatchError ? (
                  <p style={{ margin: 0, color: "var(--atlas-orange)", fontSize: 10, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                    {indexBatchError}
                  </p>
                ) : null}
                {indexBatchStatus ? (
                  <p className="muted" style={{ margin: 0, fontSize: 10, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                    {indexBatchStatus}
                  </p>
                ) : null}

                {indexBatchPlan ? (
                  <div style={{ display: "grid", gap: 7 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
                      {[
                        ["Candidates", indexBatchPlan.summary.candidate_count],
                        ["Planned", indexBatchPlan.summary.planned_count],
                        ["Active", indexBatchPlan.summary.skipped_active],
                        ["Done", indexBatchPlan.summary.skipped_completed],
                        ["Retry", indexBatchPlan.summary.skipped_previous_failed],
                        ["Limit", indexBatchPlan.summary.skipped_limit],
                      ].map(([label, value]) => (
                        <div key={label} style={{ border: "1px solid var(--border)", background: "rgba(255, 255, 255, 0.16)", padding: "5px 6px", fontFamily: "var(--font-display)" }}>
                          <span className="muted" style={{ display: "block", fontSize: 8.5, textTransform: "uppercase", letterSpacing: 0 }}>
                            {label}
                          </span>
                          <strong style={{ display: "block", fontSize: 11, color: "var(--atlas-blue-dark)" }}>
                            {value}
                          </strong>
                        </div>
                      ))}
                    </div>
                    {indexBatchPlan.items.slice(0, 5).map((item) => (
                      <div key={`${item.dataset_slug}-${item.asset_relative_path}`} style={{ display: "grid", gap: 4, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                        <strong style={{ display: "block", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-display)" }}>
                          {item.asset_relative_path}
                        </strong>
                        <span className="muted" style={{ display: "block", fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.dataset_slug} | {item.format || "unknown"} | {formatBytes(item.size_bytes)} | {formatDimensions(item.dimensions)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {visibleIndexBatchRuns.length > 0 ? (
                  <div style={{ display: "grid", gap: 7, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <strong style={{ display: "block", fontSize: 10.5, color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                        Recent Runs
                      </strong>
                      <button type="button" className="button" onClick={() => loadIndexBatchRuns()} disabled={indexBatchRunsLoading} style={{ padding: "4px 6px", fontSize: 8.5 }}>
                        {indexBatchRunsLoading ? "Refreshing" : "Refresh"}
                      </button>
                    </div>
                    {visibleIndexBatchRuns.map((run) => {
                      const runActive = ["queued", "running", "cancel_requested"].includes(run.status);
                      const canResume = ["paused", "failed", "cancelled"].includes(run.status) && run.summary.completed < run.summary.total;
                      return (
                        <div key={run.id} style={{ display: "grid", gap: 5, borderTop: "1px solid var(--border)", paddingTop: 7 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "start" }}>
                            <div style={{ minWidth: 0 }}>
                              <strong style={{ display: "block", fontSize: 10.5, color: "var(--atlas-blue-dark)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-display)" }}>
                                {run.kind === "convert" ? "Convert" : "Slice Cache"} batch | {run.plan_id}
                              </strong>
                              <span className="muted" style={{ display: "block", fontSize: 9.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {run.summary.completed}/{run.summary.total} done | {run.summary.running} active | {run.summary.failed} failed | c{run.concurrency}
                              </span>
                            </div>
                            <span style={{ color: indexJobStatusTone(run.status), fontSize: 9.5, fontFamily: "var(--font-display)", fontWeight: 700 }}>
                              {INDEX_JOB_STATUS_LABELS[run.status] || run.status}
                            </span>
                          </div>
                          <span className="muted" style={{ display: "block", fontSize: 8.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {run.checkpoint_path}
                          </span>
                          {(runActive || canResume) ? (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {runActive ? (
                                <button type="button" className="button" onClick={() => cancelIndexBatchRun(run)} disabled={run.status === "cancel_requested" || indexBatchRunsLoading} style={{ padding: "4px 6px", fontSize: 8.8 }}>
                                  Cancel
                                </button>
                              ) : null}
                              {canResume ? (
                                <button type="button" className="button" onClick={() => resumeIndexBatchRun(run)} disabled={indexBatchRunsLoading} style={{ padding: "4px 6px", fontSize: 8.8 }}>
                                  Resume
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              {indexQueue && (
                <div style={{ display: "grid", gap: 9 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                    {[
                      ["Datasets", indexQueue.summary.datasets],
                      ["Assets", indexQueue.summary.assets],
                      ["Loadable", indexQueue.summary.indexed],
                      ["Convert", indexQueue.summary.ready_for_conversion],
                      ["Slices", indexQueue.summary.ready_for_slice_cache],
                      ["Cached", indexQueue.summary.slice_cache_indexed || 0],
                      ["Review", indexQueue.summary.blocked],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        style={{
                          border: "1px solid var(--border)",
                          background: "rgba(0, 0, 0, 0.06)",
                          padding: "6px 7px",
                          minWidth: 0,
                          fontFamily: "var(--font-display)",
                        }}
                      >
                        <span className="muted" style={{ display: "block", fontSize: 8.5, textTransform: "uppercase", letterSpacing: 0 }}>
                          {label}
                        </span>
                        <strong style={{ display: "block", fontSize: 12, color: "var(--atlas-blue-dark)" }}>
                          {value}
                        </strong>
                      </div>
                    ))}
                  </div>

                  {!indexQueue.root_exists ? (
                    <p className="muted" style={{ margin: 0, fontSize: 11, lineHeight: 1.45, fontFamily: "var(--font-body)" }}>
                      The local public data root is not present at {indexQueue.root}.
                    </p>
                  ) : visibleIndexQueueDatasets.length > 0 ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      {visibleIndexQueueDatasets.slice(0, 4).map((dataset) => (
                        <div
                          key={dataset.slug}
                          style={{
                            display: "grid",
                            gap: 7,
                            border: "1px solid var(--border)",
                            background: "rgba(0, 0, 0, 0.08)",
                            padding: "8px 9px",
                          }}
                        >
                          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "start" }}>
                            <div style={{ minWidth: 0 }}>
                              <strong style={{ display: "block", fontSize: 11, color: "var(--atlas-blue-dark)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-display)" }}>
                                {dataset.dataset?.title || dataset.slug}
                              </strong>
                              <span className="muted" style={{ display: "block", fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {dataset.slug} | {dataset.assets.length} assets | {dataset.derivative_count} loadable volumes
                              </span>
                            </div>
                            <span style={{ color: dataset.readiness?.blocked_assets ? "var(--atlas-orange)" : "var(--atlas-blue-dark)", fontSize: 9.5, fontFamily: "var(--font-display)", fontWeight: 700 }}>
                              {dataset.readiness?.status || "scanned"}
                            </span>
                          </div>

                          <div style={{ display: "grid", gap: 6 }}>
                            {dataset.assets.slice(0, 6).map((asset) => {
                              const convertJob = findIndexJob("convert", dataset.slug, asset.relative_path);
                              const sliceJob = findIndexJob("slices", dataset.slug, asset.relative_path);
                              const convertBusy = convertJob && ["queued", "running", "cancel_requested"].includes(convertJob.status);
                              const sliceBusy = sliceJob && ["queued", "running", "cancel_requested"].includes(sliceJob.status);
                              return (
                                <div
                                  key={asset.relative_path}
                                  style={{
                                    display: "grid",
                                    gap: 6,
                                    borderTop: "1px solid var(--border)",
                                    paddingTop: 7,
                                  }}
                                >
                                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "start" }}>
                                    <div style={{ minWidth: 0 }}>
                                      <span style={{ display: "block", fontSize: 10.5, color: "var(--foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-display)", fontWeight: 700 }}>
                                        {asset.relative_path}
                                      </span>
                                      <span className="muted" style={{ display: "block", fontSize: 9.5, lineHeight: 1.35 }}>
                                        {asset.format || "unknown"} | {formatBytes(asset.size_bytes)} | {formatDimensions(asset.dimensions)}
                                      </span>
                                    </div>
                                    <span style={{ color: indexStatusTone(asset.index_status), fontSize: 9.5, whiteSpace: "nowrap", fontFamily: "var(--font-display)", fontWeight: 700 }}>
                                      {INDEX_STATUS_LABELS[asset.index_status] || asset.index_status}
                                    </span>
                                  </div>

                                  {(asset.blockers?.length || asset.warnings?.length || asset.review_notes?.length) ? (
                                    <p className="muted" style={{ margin: 0, fontSize: 9.5, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                                      {(asset.blockers?.length || 0)} blockers | {(asset.warnings?.length || 0)} warnings | {(asset.review_notes?.length || 0)} notes
                                    </p>
                                  ) : null}

                                  {(convertJob || sliceJob) && (
                                    <p className="muted" style={{ margin: 0, fontSize: 9.5, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                                      Latest job: {convertJob ? `convert ${INDEX_JOB_STATUS_LABELS[convertJob.status] || convertJob.status}` : ""}{convertJob && sliceJob ? " | " : ""}{sliceJob ? `slices ${INDEX_JOB_STATUS_LABELS[sliceJob.status] || sliceJob.status}` : ""}
                                    </p>
                                  )}

                                  {(asset.convert_command || asset.slice_command) && (
                                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                      {asset.convert_command && (
                                        <>
                                          <button type="button" className="button" disabled={Boolean(convertBusy || indexJobsLoading)} onClick={() => startIndexJob("convert", dataset, asset)} style={{ padding: "4px 6px", fontSize: 9 }}>
                                            {convertBusy ? "Converting" : "Run Convert"}
                                          </button>
                                          <button type="button" className="button" onClick={() => copyIndexCommand(asset.convert_command!)} style={{ padding: "4px 6px", fontSize: 9 }}>
                                            Copy
                                          </button>
                                        </>
                                      )}
                                      {asset.slice_command && (
                                        <>
                                          <button type="button" className="button" disabled={Boolean(sliceBusy || indexJobsLoading)} onClick={() => startIndexJob("slices", dataset, asset)} style={{ padding: "4px 6px", fontSize: 9 }}>
                                            {sliceBusy ? "Caching" : "Run Slices"}
                                          </button>
                                          <button type="button" className="button" onClick={() => copyIndexCommand(asset.slice_command!)} style={{ padding: "4px 6px", fontSize: 9 }}>
                                            Copy
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted" style={{ margin: 0, fontSize: 11, lineHeight: 1.45, fontFamily: "var(--font-body)" }}>
                      No pilot manifests were found under {indexQueue.root}.
                    </p>
                  )}
                </div>
              )}
            </div>

            {(activePrivateRegistrySummary || privateRegistryStatus || privateRegistryError) ? (
              <div style={{ display: "grid", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "start" }}>
                  <div style={{ minWidth: 0 }}>
                    <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                      {privateWorksetSummary ? "Promoted Workset" : "Local Registry"}
                    </span>
                    <strong style={{ display: "block", fontSize: 12, color: "var(--foreground)", fontFamily: "var(--font-display)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {privateWorksetSummary?.title || activePrivateRegistrySummary?.registry_id || "Registry"}
                    </strong>
                    {privateWorksetSummary ? (
                      <span className="muted" title={privateWorksetSummary.workset_id} style={{ display: "block", fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {privateWorksetSummary.workset_id} from {privateWorksetSummary.source_registry.registry_id || "registry"}
                      </span>
                    ) : null}
                    {privateRegistryPath ? (
                      <span className="muted" title={privateRegistryPath} style={{ display: "block", fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {formatPathBasename(privateRegistryPath)}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="button"
                      onClick={() => {
                        setPrivateRegistry(null);
                        setPrivateRegistrySummary(null);
                        setPrivateWorksetSummary(null);
                        setPrivateRegistryNativePath(null);
                        setPrivateRegistryPath(null);
                        setPrivateRegistryQuery("");
                        setPrivateRegistryQueueFilter("all");
                        setPrivateRegistrySelectedConversionAssetIds([]);
                        setPrivateRegistryProjectPage(emptyPrivateRegistryAssetPage(PRIVATE_REGISTRY_PAGE_LIMITS.project_ready));
                        setPrivateRegistryConversionPage(emptyPrivateRegistryAssetPage(PRIVATE_REGISTRY_PAGE_LIMITS.conversion_queue));
                        setPrivateRegistryReviewPage(emptyPrivateRegistryAssetPage(PRIVATE_REGISTRY_PAGE_LIMITS.review));
                        setPrivateRegistryStatus("Local registry/workset view cleared.");
                        setPrivateRegistryError(null);
                      }}
                    disabled={!activePrivateRegistrySummary}
                    style={{ padding: "5px 8px", fontSize: 9.5 }}
                  >
                    Clear
                  </button>
                </div>

                {privateRegistryError ? (
                  <p style={{ margin: 0, color: "var(--atlas-orange)", fontSize: 11, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                    {privateRegistryError}
                  </p>
                ) : null}
                {privateRegistryStatus ? (
                  <p className="muted" style={{ margin: 0, fontSize: 11, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                    {privateRegistryStatus}
                  </p>
                ) : null}

                {activePrivateRegistrySummary ? (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                      {[
                        ["Assets", activePrivateRegistrySummary.asset_count],
                        ["Volumes", activePrivateRegistrySummary.volume_candidate_count],
                        ["Open", activePrivateRegistrySummary.project_ready_count],
                        ["Queue", privateRegistryConversionQueueTotal],
                        ["Gaps", activePrivateRegistrySummary.metadata_gap_count],
                        ["Fixity", activePrivateRegistrySummary.checksum_record_count],
                        ["Review", activePrivateRegistrySummary.review_queue_count],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          style={{
                            border: "1px solid var(--border)",
                            background: "rgba(0, 0, 0, 0.06)",
                            padding: "6px 7px",
                            fontFamily: "var(--font-display)",
                          }}
                        >
                          <span className="muted" style={{ display: "block", fontSize: 8.5, textTransform: "uppercase", letterSpacing: 0 }}>
                            {label}
                          </span>
                          <strong style={{ display: "block", fontSize: 12, color: "var(--atlas-blue-dark)" }}>
                            {value}
                          </strong>
                        </div>
                        ))}
                      </div>

                      {privateWorksetSummary ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
                          {[
                            ["Dataset", privateWorksetSummary.summary.dataset_mode_ready_count],
                            ["Selected", formatBytes(privateWorksetSummary.summary.selected_bytes_total)],
                            [
                              "Blocked Ops",
                              Object.values(privateWorksetSummary.summary.blocked_operation_counts).reduce(
                                (sum, value) => sum + value,
                                0
                              ),
                            ],
                          ].map(([label, value]) => (
                            <div
                              key={label}
                              style={{
                                border: "1px solid var(--border)",
                                background: "rgba(31, 111, 135, 0.08)",
                                padding: "6px 7px",
                                fontFamily: "var(--font-display)",
                              }}
                            >
                              <span className="muted" style={{ display: "block", fontSize: 8.5, textTransform: "uppercase", letterSpacing: 0 }}>
                                {label}
                              </span>
                              <strong style={{ display: "block", fontSize: 12, color: "var(--atlas-blue-dark)" }}>
                                {value}
                              </strong>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div style={{ display: "grid", gap: 7 }}>
                        <input
                          type="search"
                          aria-label="Search local registry assets"
                          value={privateRegistryQuery}
                          onChange={(event) => {
                            setPrivateRegistryQuery(event.target.value);
                            setPrivateRegistrySelectedConversionAssetIds([]);
                          }}
                          placeholder="Search path, format, dtype, status, gap"
                          style={{
                            width: "100%",
                            minWidth: 0,
                            border: "1px solid var(--border)",
                            background: "rgba(255, 255, 255, 0.72)",
                            color: "var(--foreground)",
                            padding: "7px 8px",
                            fontSize: 10.5,
                            fontFamily: "var(--font-display)",
                          }}
                        />
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 }}>
                          {(Object.entries(PRIVATE_REGISTRY_QUEUE_FILTER_LABELS) as Array<[PrivateRegistryQueueFilter, string]>).map(([filter, label]) => (
                            <button
                              key={filter}
                              type="button"
                              className="button"
                              onClick={() => {
                                setPrivateRegistryQueueFilter(filter);
                                setPrivateRegistrySelectedConversionAssetIds([]);
                              }}
                              style={{
                                padding: "5px 6px",
                                fontSize: 9,
                                background: privateRegistryQueueFilter === filter ? "var(--atlas-blue)" : undefined,
                                color: privateRegistryQueueFilter === filter ? "white" : undefined,
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div style={{ display: "grid", gap: 8 }}>
                        <div style={{ display: "grid", gap: 6 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
                            <strong style={{ display: "block", fontSize: 11, color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                            Project Ready
                            </strong>
                            <span className="muted" style={{ fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                              {privateRegistryFilteredProjectReadyAssets.length} shown / {privateRegistryProjectReadyTotal}
                            </span>
                          </div>
                          {privateRegistryFilteredProjectReadyAssets.length > 0 ? (
                            privateRegistryFilteredProjectReadyAssets.map((asset) => {
                              const target = findLoadedDerivativeForRegistryAsset(asset);
                              return (
                              <div
                                key={asset.asset_id}
                                style={{
                                  display: "grid",
                                  gap: 6,
                                  border: "1px solid var(--border)",
                                  background: "rgba(31, 111, 135, 0.08)",
                                  padding: "8px 9px",
                                }}
                              >
                                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "start" }}>
                                  <div style={{ minWidth: 0 }}>
                                    <strong style={{ display: "block", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                                      {asset.relative_path}
                                    </strong>
                                    <span className="muted" style={{ display: "block", fontSize: 9.5 }}>
                                      {asset.metadata.format || "unknown"} | {formatBytes(asset.size_bytes)} | {formatDimensions(asset.metadata.dimensions)}
                                    </span>
                                  </div>
                                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                    <button
                                      type="button"
                                      className="button"
                                      onClick={() => openRegistryProjectReadyAsset(asset)}
                                      disabled={!target}
                                      title={target ? `Open ${target.dataset.slug}` : "Load the matching volume before opening this registry asset."}
                                      style={{ padding: "5px 8px", fontSize: 9.5 }}
                                    >
                                      Open
                                    </button>
                                    <button
                                      type="button"
                                      className="button"
                                      onClick={() => void createCaosProjectFromRegistryAsset(asset)}
                                      disabled={!target}
                                      title={target ? `Create a CAOS project from ${target.dataset.slug}` : "Load the matching volume before creating a project."}
                                      style={{ padding: "5px 8px", fontSize: 9.5 }}
                                    >
                                      Create Project…
                                    </button>
                                  </div>
                                </div>
                                <span style={{ color: "var(--atlas-blue-dark)", fontSize: 9.5, fontFamily: "var(--font-display)", fontWeight: 700 }}>
                                  {privateRegistryAssetStatusLabel(asset)}
                                </span>
                              </div>
                            );
                          })
                          ) : (
                            <p className="muted" style={{ margin: 0, fontSize: 10.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                              {privateRegistryProjectPage.loading ? "Loading project-ready registry assets." : "No project-ready registry assets match the current filters."}
                            </p>
                          )}
                          {privateRegistryProjectPage.error ? (
                            <p style={{ margin: 0, color: "var(--atlas-orange)", fontSize: 10, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                              {privateRegistryProjectPage.error}
                            </p>
                          ) : null}
                          {renderPrivateRegistryPager("project_ready", privateRegistryProjectPage)}
                      </div>

                      <div style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
                          <strong style={{ display: "block", fontSize: 11, color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                            Conversion Queue
                            </strong>
                            <span className="muted" style={{ fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                              {privateRegistryFilteredConversionQueueAssets.length} shown / {privateRegistryConversionQueueTotal}
                            </span>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
                            <button
                              type="button"
                              className="button"
                              onClick={selectVisibleMatchedRegistryConversions}
                              disabled={!privateRegistryMatchedVisibleConversionCount}
                              style={{ padding: "5px 6px", fontSize: 9 }}
                            >
                              Select Matched
                            </button>
                            <button
                              type="button"
                              className="button"
                              onClick={buildRegistryConversionBatchPlan}
                              disabled={indexBatchLoading || !privateRegistrySelectedConversionAssets.length}
                              style={{ padding: "5px 6px", fontSize: 9 }}
                            >
                              Plan Selected
                            </button>
                            <button
                              type="button"
                              className="button"
                              onClick={() => setPrivateRegistrySelectedConversionAssetIds([])}
                              disabled={!privateRegistrySelectedConversionAssetIds.length}
                              style={{ padding: "5px 6px", fontSize: 9 }}
                            >
                              Clear Selected
                            </button>
                          </div>
                          <p className="muted" style={{ margin: 0, fontSize: 9.5, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                            {privateRegistrySelectedConversionAssets.length} selected on this page | {privateRegistryMatchedVisibleConversionCount} matched to sidecar conversion commands
                          </p>
                          {privateRegistryFilteredConversionQueueAssets.length > 0 ? (
                            privateRegistryFilteredConversionQueueAssets.map((asset) => {
                              const reviewBlockers = registryAssetReviewBlockers(asset);
                              const queueMatch = findIndexQueueAssetForRegistryAsset(asset);
                              const convertJob = queueMatch ? findIndexJob("convert", queueMatch.dataset.slug, queueMatch.asset.relative_path) : undefined;
                              const convertBusy = convertJob && ["queued", "running", "cancel_requested"].includes(convertJob.status);
                              const convertDisabled = Boolean(convertBusy || indexJobsLoading || (queueMatch && !queueMatch.asset.convert_command));
                              const selected = privateRegistrySelectedConversionAssetSet.has(asset.asset_id);
                              return (
                                <div
                                key={asset.asset_id}
                                style={{
                                  display: "grid",
                                  gap: 5,
                                  border: "1px solid var(--border)",
                                  background: "rgba(0, 0, 0, 0.08)",
                                  padding: "8px 9px",
                                }}
                              >
                                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "start" }}>
                                  <input
                                    type="checkbox"
                                    aria-label={`Select ${asset.relative_path} for registry batch conversion`}
                                    checked={selected}
                                    disabled={!queueMatch?.asset.convert_command}
                                    onChange={() => togglePrivateRegistryConversionSelection(asset.asset_id)}
                                    style={{ marginTop: 2 }}
                                  />
                                  <div style={{ minWidth: 0 }}>
                                    <strong style={{ display: "block", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                                      {asset.relative_path}
                                    </strong>
                                    <span className="muted" style={{ display: "block", fontSize: 9.5 }}>
                                      {asset.metadata.format || "unknown"} | {formatBytes(asset.size_bytes)} | {formatDimensions(asset.metadata.dimensions)}
                                    </span>
                                  </div>
                                  <span style={{ color: reviewBlockers.length ? "var(--atlas-orange)" : "var(--atlas-blue-dark)", fontSize: 9.5, fontFamily: "var(--font-display)", fontWeight: 700 }}>
                                    {privateRegistryAssetStatusLabel(asset)}
                                  </span>
                                </div>
                                  <p className="muted" style={{ margin: 0, fontSize: 9.5, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                                    {reviewBlockers.length ? `${reviewBlockers.length} review flag${reviewBlockers.length === 1 ? "" : "s"}` : "metadata ready"} | source fixity {asset.checksum.algorithm || "none"} | {queueMatch ? `queue ${queueMatch.dataset.slug}` : "queue not matched"}
                                  </p>
                                  {convertJob ? (
                                    <p className="muted" style={{ margin: 0, fontSize: 9.5, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                                      Latest convert job: {INDEX_JOB_STATUS_LABELS[convertJob.status] || convertJob.status}
                                    </p>
                                  ) : null}
                                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                    <button
                                      type="button"
                                      className="button"
                                      disabled={convertDisabled}
                                      onClick={() => startRegistryConversionAsset(asset)}
                                      title={queueMatch ? "Run the sidecar conversion job for this registry asset." : "Scan the sidecar index queue and try to match this registry asset."}
                                      style={{ padding: "4px 6px", fontSize: 9 }}
                                    >
                                      {convertBusy ? "Converting" : queueMatch ? (queueMatch.asset.convert_command ? "Run Convert" : "No Command") : indexQueue ? "Rescan" : "Scan Queue"}
                                    </button>
                                    {queueMatch?.asset.convert_command ? (
                                      <button type="button" className="button" onClick={() => copyIndexCommand(queueMatch.asset.convert_command!)} style={{ padding: "4px 6px", fontSize: 9 }}>
                                        Copy
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <p className="muted" style={{ margin: 0, fontSize: 10.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                              {privateRegistryConversionPage.loading ? "Loading conversion queue assets." : "No conversion-ready source assets match the current filters."}
                            </p>
                          )}
                          {privateRegistryConversionPage.error ? (
                            <p style={{ margin: 0, color: "var(--atlas-orange)", fontSize: 10, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                              {privateRegistryConversionPage.error}
                            </p>
                          ) : null}
                          {renderPrivateRegistryPager("conversion_queue", privateRegistryConversionPage)}
                      </div>

                      <div style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
                          <strong style={{ display: "block", fontSize: 11, color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                            Review Pressure
                            </strong>
                            <span className="muted" style={{ fontSize: 9.5, fontFamily: "var(--font-display)" }}>
                              {privateRegistryFilteredReviewAssets.length} shown / {privateRegistryReviewTotal}
                            </span>
                          </div>
                          {privateRegistryFilteredReviewAssets.length > 0 ? (
                            privateRegistryFilteredReviewAssets.map((asset) => (
                              <div
                                key={asset.asset_id}
                                style={{
                                  display: "grid",
                                  gap: 5,
                                  border: "1px solid var(--border)",
                                  background: "rgba(0, 0, 0, 0.08)",
                                  padding: "8px 9px",
                                }}
                              >
                                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "start" }}>
                                  <div style={{ minWidth: 0 }}>
                                    <strong style={{ display: "block", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                                      {asset.relative_path}
                                    </strong>
                                    <span className="muted" style={{ display: "block", fontSize: 9.5 }}>
                                      {asset.metadata.format || "unknown"} | {formatBytes(asset.size_bytes)} | {formatDimensions(asset.metadata.dimensions)}
                                    </span>
                                  </div>
                                  <span style={{ color: asset.readiness.project_ready ? "var(--atlas-blue-dark)" : "var(--atlas-orange)", fontSize: 9.5, fontFamily: "var(--font-display)", fontWeight: 700 }}>
                                    {privateRegistryAssetStatusLabel(asset)}
                                  </span>
                                </div>
                                <p className="muted" style={{ margin: 0, fontSize: 9.5, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                                  {asset.readiness.blockers.length} blockers | {asset.review.gap_codes.length} metadata gaps | rights {asset.status.rights_status}
                                </p>
                              </div>
                            ))
                          ) : (
                            <p className="muted" style={{ margin: 0, fontSize: 10.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                              {privateRegistryReviewPage.loading ? "Loading review rows." : "No review rows match the current filters."}
                            </p>
                          )}
                          {privateRegistryReviewPage.error ? (
                            <p style={{ margin: 0, color: "var(--atlas-orange)", fontSize: 10, lineHeight: 1.35, fontFamily: "var(--font-body)" }}>
                              {privateRegistryReviewPage.error}
                            </p>
                          ) : null}
                          {renderPrivateRegistryPager("review", privateRegistryReviewPage)}
                        </div>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            <div style={{ display: "grid", gap: 9, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                    Background
                  </span>
                  <strong style={{ display: "block", fontSize: 12, color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                    Volume Jobs
                  </strong>
                </div>
                <button type="button" className="button" onClick={() => loadIndexJobs()} disabled={indexJobsLoading} style={{ padding: "5px 8px", fontSize: 9.5 }}>
                  {indexJobsLoading ? "Refreshing" : "Refresh Jobs"}
                </button>
              </div>

              {visibleIndexJobs.length > 0 ? (
                <div style={{ display: "grid", gap: 7 }}>
                  {visibleIndexJobs.map((job) => {
                    const jobActive = ["queued", "running", "cancel_requested"].includes(job.status);
                    const canRetry = ["failed", "cancelled"].includes(job.status);
                    return (
                      <div
                        key={job.id}
                        style={{
                          display: "grid",
                          gap: 7,
                          background: "rgba(0, 0, 0, 0.08)",
                          border: "1px solid var(--border)",
                          padding: "8px 9px",
                        }}
                      >
                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "start" }}>
                          <div style={{ minWidth: 0 }}>
                            <strong style={{ display: "block", fontSize: 11, color: "var(--atlas-blue-dark)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-display)" }}>
                              {indexJobKindLabel(job.kind)} | {job.asset_relative_path}
                            </strong>
                            <span className="muted" style={{ display: "block", fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {job.dataset_slug} | started {formatJobTime(job.started_at_ms || job.created_at_ms)}
                            </span>
                          </div>
                          <span style={{ color: indexJobStatusTone(job.status), fontSize: 9.5, fontFamily: "var(--font-display)", fontWeight: 700 }}>
                            {INDEX_JOB_STATUS_LABELS[job.status] || job.status}
                          </span>
                        </div>

                        <div style={{ fontSize: 9.5, color: "var(--accent-foreground)", fontFamily: "var(--font-display)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {job.command_display}
                        </div>

                        {job.log.length > 0 && (
                          <div style={{ display: "grid", gap: 3, background: "rgba(255, 255, 255, 0.18)", border: "1px solid var(--border)", padding: "6px 7px", fontFamily: "var(--font-display)", fontSize: 9.5, color: "var(--foreground)" }}>
                            {job.log.slice(-3).map((line, index) => (
                              <span key={`${job.id}-log-${index}`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {line}
                              </span>
                            ))}
                          </div>
                        )}

                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {jobActive && (
                            <button type="button" className="button" onClick={() => cancelIndexJob(job)} disabled={job.status === "cancel_requested"} style={{ padding: "4px 6px", fontSize: 9 }}>
                              Cancel
                            </button>
                          )}
                          {canRetry && (
                            <button type="button" className="button" onClick={() => retryIndexJob(job)} disabled={indexJobsLoading} style={{ padding: "4px 6px", fontSize: 9 }}>
                              Retry
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, fontFamily: "var(--font-body)" }}>
                  No import jobs have been started in this sidecar session.
                </p>
              )}
            </div>

            <div style={{ display: "grid", gap: 7, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <button type="button" className="button" onClick={runProjectAuditJob} style={{ width: "100%", padding: "7px 10px", fontSize: 10.5 }}>
                Run Project Audit
              </button>
              <button type="button" className="button" onClick={runRoiInventoryJob} style={{ width: "100%", padding: "7px 10px", fontSize: 10.5 }}>
                Run ROI Inventory
              </button>
              <button type="button" className="button" onClick={runHistogramJob} style={{ width: "100%", padding: "7px 10px", fontSize: 10.5 }}>
                Run Histogram Summary
              </button>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                  Results
                </span>
                <strong style={{ color: "var(--atlas-blue-dark)", fontSize: 10, fontFamily: "var(--font-display)" }}>
                  {activeJobs.length}
                </strong>
              </div>
              {activeJobs.length > 0 ? (
                <div style={{ display: "grid", gap: 7 }}>
                  {activeJobs.map((job) => (
                    <div
                      key={job.id}
                      style={{
                        display: "grid",
                        gap: 7,
                        background: "rgba(0, 0, 0, 0.1)",
                        border: "1px solid var(--border)",
                        padding: "8px 9px",
                        fontFamily: "var(--font-display)",
                      }}
                    >
                      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 6, alignItems: "center" }}>
                        <div style={{ minWidth: 0 }}>
                          <strong style={{ display: "block", fontSize: 11, color: "var(--atlas-blue-dark)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {job.title}
                          </strong>
                          <span className="muted" style={{ display: "block", fontSize: 9.5 }}>
                            {formatDateTime(job.createdAt)} | {job.kind}
                          </span>
                        </div>
                        <button type="button" className="button" onClick={() => exportJobJson(job)} style={{ padding: "4px 6px", fontSize: 9 }}>
                          Export
                        </button>
                        <button type="button" className="button" onClick={() => deleteJob(job.id)} style={{ padding: "4px 6px", fontSize: 9 }}>
                          Delete
                        </button>
                      </div>
                      <p className="muted" style={{ margin: 0, fontSize: 11, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                        {job.summary}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, fontFamily: "var(--font-body)" }}>
                  No local jobs have been run for this volume yet.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Tab 4: Experiment Planner */}
        {activeTab === "planner" && (
          <div className="tab-pane">
            <div>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 4, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Planner
              </span>
              <h3 style={{ fontSize: "1.05rem", fontWeight: "bold", margin: "0 0 8px 0", fontFamily: "var(--font-display)" }}>
                Feasibility Check
              </h3>
              <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                Query sidecar plan registry to assess specimen feasibility based on active resolution thresholds and target organelle structures.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <div>
                <label style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 4, fontWeight: "bold", fontFamily: "var(--font-display)" }}>
                  Target Organelle Markers
                </label>
                <input
                  type="text"
                  className="search-input"
                  style={{ width: "100%", padding: "5px 10px", fontSize: 12, background: "var(--field-background)", color: "var(--foreground)", border: "1px solid var(--border)", fontFamily: "var(--font-display)" }}
                  value={planningOrganelles}
                  onChange={(e) => {
                    setPlanningOrganelles(e.target.value);
                    setPlanningResult(null);
                    setPlanningError(null);
                  }}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 4, fontWeight: "bold", fontFamily: "var(--font-display)" }}>
                    Max Res (nm)
                  </label>
                  <input
                    type="number"
                    className="search-input"
                    style={{ width: "100%", padding: "5px 10px", fontSize: 12, background: "var(--field-background)", color: "var(--foreground)", border: "1px solid var(--border)", fontFamily: "var(--font-display)" }}
                    value={planningRes}
                    onChange={(e) => {
                      setPlanningRes(Number(e.target.value));
                      setPlanningResult(null);
                      setPlanningError(null);
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 4, fontWeight: "bold", fontFamily: "var(--font-display)" }}>
                    Min Size (n)
                  </label>
                  <input
                    type="number"
                    className="search-input"
                    style={{ width: "100%", padding: "5px 10px", fontSize: 12, background: "var(--field-background)", color: "var(--foreground)", border: "1px solid var(--border)", fontFamily: "var(--font-display)" }}
                    value={planningSample}
                    onChange={(e) => {
                      setPlanningSample(Number(e.target.value));
                      setPlanningResult(null);
                      setPlanningError(null);
                    }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 4, fontWeight: "bold", fontFamily: "var(--font-display)" }}>
                  Cell Line Type
                </label>
                <select
                  className="search-input"
                  style={{ width: "100%", padding: "5px 10px", fontSize: 12, background: "var(--field-background)", color: "var(--foreground)", border: "1px solid var(--border)", fontFamily: "var(--font-display)" }}
                  value={planningCellType}
                  onChange={(e) => {
                    setPlanningCellType(e.target.value);
                    setPlanningResult(null);
                    setPlanningError(null);
                  }}
                >
                  <option value="hiPSC">Human iPSC (hiPSC)</option>
                  <option value="HEK293">HEK293</option>
                  <option value="HeLa">HeLa</option>
                  <option value="RAW264">RAW264.7</option>
                </select>
              </div>

              <button
                type="button"
                className="button"
                disabled={planningLoading}
                onClick={fetchPlanningResult}
                style={{ width: "100%", padding: "7px 12px", fontSize: 11, fontFamily: "var(--font-display)" }}
              >
                {planningLoading ? "Running..." : "Run Check"}
              </button>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Result
              </span>

              {planningLoading ? (
                <div style={{ padding: "16px 0", textAlign: "center", fontSize: 12, fontFamily: "var(--font-display)", color: "var(--atlas-blue)" }}>
                  Querying sidecar plan registry...
                </div>
              ) : planningError ? (
                <div style={{ color: "var(--atlas-orange)", fontSize: 12, fontFamily: "var(--font-display)" }}>
                  Error: {planningError}
                </div>
              ) : planningResult ? (
                <div>
                  <div
                    style={{
                      background:
                        planningResult.status === "feasible"
                          ? "rgba(85, 184, 211, 0.05)"
                          : planningResult.status === "challenging"
                          ? "rgba(22, 139, 179, 0.04)"
                          : "rgba(198, 111, 45, 0.04)",
                      border: `1px solid ${
                        planningResult.status === "feasible"
                          ? "rgba(85, 184, 211, 0.4)"
                          : "rgba(198, 111, 45, 0.3)"
                      }`,
                      padding: "10px 14px",
                      marginBottom: 12,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: "bold", textTransform: "uppercase", letterSpacing: 0, color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                        STATUS: {planningResult.status}
                      </span>
                      <span style={{ fontSize: 9, fontFamily: "var(--font-display)", color: "#888" }}>
                        API ROUTE APPROVED
                      </span>
                    </div>
                    <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                      {planningResult.status_message}
                    </p>
                  </div>

                  <div style={{ fontSize: 11.5, fontFamily: "var(--font-display)", background: "rgba(0,0,0,0.1)", border: "1px solid var(--border)", padding: "8px 12px" }}>
                    <div style={{ fontWeight: "bold", fontSize: 10, textTransform: "uppercase", color: "var(--accent-foreground)", marginBottom: 4, fontFamily: "var(--font-display)" }}>
                      Modality Recommendations
                    </div>
                    {planningResult.modality_recommendation}
                  </div>

                  {planningResult.precedents && planningResult.precedents.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0, marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                        Baseline Reference Precedents
                      </span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {planningResult.precedents.slice(0, 2).map((p: any, idx: number) => (
                          <div key={idx} style={{ padding: "8px 10px", background: "rgba(0,0,0,0.04)", border: "1px solid var(--border)", fontSize: 11, fontFamily: "var(--font-display)" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold" }}>
                              <span>{p.source} {p.entry_id}</span>
                              <span style={{ color: "var(--atlas-blue)" }}>{p.lateral_resolution_nm} nm</span>
                            </div>
                            <div style={{ color: "#888", fontSize: 9, marginTop: 2 }}>
                              {p.cell_type} | Modal: {p.modality} | Size: n={p.sample_size}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontStyle: "italic", fontSize: 12, color: "#666", fontFamily: "var(--font-body)" }}>
                  Set planning inputs above, then run a feasibility check.
                </div>
              )}
            </div>
          </div>
        )}
      </aside>
    </div>
    </>
  );
}
