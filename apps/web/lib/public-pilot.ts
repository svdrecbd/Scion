import { existsSync } from "fs";
import { readFile, readdir, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";

export type PilotDatasetRecord = {
  slug: string;
  dataset: {
    source?: string;
    entry_id?: string;
    entry_doi?: string;
    title?: string;
    dataset_size?: string;
    experiment_type?: string;
  };
  report: {
    file_count?: number;
    total_gib?: number;
    preview_count?: number;
    warnings?: string[];
    formats?: string[];
  };
  asset_states: Record<string, number>;
  readiness: {
    total_assets: number;
    ready_assets: number;
    ready_gib: number;
    blocked_assets: number;
    blocked_gib: number;
    sidecar_assets: number;
    status: string;
    target_format: string;
  };
  advisory?: {
    total_findings: number;
    public_notice_candidates: number;
    by_severity?: Record<string, number>;
    by_category?: Record<string, number>;
    by_review_status?: Record<string, number>;
  };
};

export type PilotIndex = {
  pipeline_version: string;
  datasets: PilotDatasetRecord[];
};

export type PreviewRecord = {
  filename: string;
  kind: string;
  preview: string;
  width: string;
  height: string;
  slices: string;
  mode: string;
  middle_z: string;
  warning: string;
};

export type ConversionReadiness = {
  dataset: PilotDatasetRecord["dataset"];
  summary: PilotDatasetRecord["readiness"];
  ready_assets: Array<{
    relative_path: string;
    local_path: string;
    format: string;
    size_bytes: number;
    dimensions: Record<string, string | number>;
    physical_voxel_size_nm: Record<string, string | number>;
    preview_path: string;
    review_notes?: string[];
    readiness: string;
  }>;
  blocked_assets: Array<{
    relative_path: string;
    local_path: string;
    format: string;
    size_bytes: number;
    blockers: string[];
    recommended_actions: string[];
    preview_path: string;
  }>;
  sidecar_assets: Array<{
    relative_path: string;
    local_path: string;
    format: string;
    size_bytes: number;
  }>;
};

export type DerivativeManifest = {
  dataset: PilotDatasetRecord["dataset"];
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
    validation: {
      status: string;
      checks: Record<string, boolean>;
    };
  }>;
};

export type SliceCacheManifest = {
  pipeline_version: string;
  dataset: PilotDatasetRecord["dataset"];
  updated_at?: string;
  caches: Array<{
    source_relative_path: string;
    source_local_path: string;
    source_sha256: string;
    source_size_bytes: number | string;
    generated_at: string;
    generation_tool: string;
    format: string;
    source_format: string;
    source_dtype: string;
    source_shape_zyx: number[];
    frame_shape_yx: number[];
    physical_voxel_size_nm: Record<string, string | number>;
    sampling: {
      mode: string;
      source_slices: number;
      cached_slices: number;
      max_slices: number;
      selected_z_indices: number[];
    };
    contrast: {
      mode: string;
      note: string;
    };
    frames: Array<{
      sequence_index: number;
      z_index: number;
      relative_path: string;
      width: number;
      height: number;
    }>;
    byte_size: number;
  }>;
};

export type AdvisoryFinding = {
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
  reviewed_at?: string;
  reviewed_by?: string;
  evidence: Array<{
    source: string;
    field: string;
    value: unknown;
  }>;
};

export type AdvisoryManifest = {
  pipeline_version: string;
  dataset: PilotDatasetRecord["dataset"];
  dataset_slug: string;
  generated_at: string;
  scope: string;
  summary: {
    total_findings: number;
    public_notice_candidates: number;
    by_severity: Record<string, number>;
    by_category: Record<string, number>;
    by_review_status: Record<string, number>;
  };
  findings: AdvisoryFinding[];
};

export const PUBLIC_ADVISORY_REVIEW_STATUS = "approved_public";
export const ADVISORY_REVIEW_STATUSES = [
  "needs_human_review",
  "approved_public",
  "internal_only",
  "dismissed",
] as const;

export type AdvisoryReviewStatus = typeof ADVISORY_REVIEW_STATUSES[number];

export function publicAdvisoryFindings(advisory: AdvisoryManifest | null | undefined): AdvisoryFinding[] {
  return (advisory?.findings ?? []).filter(
    (finding) =>
      finding.public_notice_candidate &&
      finding.review_status === PUBLIC_ADVISORY_REVIEW_STATUS
  );
}

export function publicAdvisoryCount(summary: PilotDatasetRecord["advisory"] | undefined): number {
  return summary?.by_review_status?.[PUBLIC_ADVISORY_REVIEW_STATUS] ?? 0;
}

export function isAdvisoryReviewStatus(value: string): value is AdvisoryReviewStatus {
  return (ADVISORY_REVIEW_STATUSES as readonly string[]).includes(value);
}

const DEFAULT_PUBLIC_DATA_ROOT = path.join(homedir(), "Downloads", "scion-public-data");

export function isPilotEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.SCION_ENABLE_PUBLIC_DATA_PILOT === "true";
}

export function isPilotReviewEnabled(): boolean {
  return isPilotEnabled() && process.env.SCION_ENABLE_LOCAL_REVIEW_SUITE === "true";
}

export function getPilotRoot(): string {
  return path.resolve(process.env.SCION_PUBLIC_DATA_ROOT || DEFAULT_PUBLIC_DATA_ROOT);
}

export function safePilotPath(relativePath: string): string {
  const root = getPilotRoot();
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("pilot_path_outside_root");
  }
  return resolved;
}

async function readJson<T>(relativePath: string): Promise<T> {
  const raw = await readFile(safePilotPath(relativePath), "utf8");
  return JSON.parse(raw) as T;
}

export async function getPilotIndex(): Promise<PilotIndex | null> {
  if (!isPilotEnabled()) return null;
  const indexPath = safePilotPath("pilot-index.json");
  if (!existsSync(indexPath)) return null;
  return readJson<PilotIndex>("pilot-index.json");
}

export async function getConversionReadiness(slug: string): Promise<ConversionReadiness | null> {
  if (!isPilotEnabled()) return null;
  const relativePath = path.join(slug, "metadata", "conversion-readiness-manifest.json");
  if (!existsSync(safePilotPath(relativePath))) return null;
  return readJson<ConversionReadiness>(relativePath);
}

export async function getPreviewRecords(slug: string): Promise<PreviewRecord[]> {
  if (!isPilotEnabled()) return [];
  const relativePath = path.join(slug, "metadata", "preview-inventory.tsv");
  const inventoryPath = safePilotPath(relativePath);
  if (!existsSync(inventoryPath)) return [];
  const raw = await readFile(inventoryPath, "utf8");
  const [headerLine, ...lines] = raw.trim().split(/\r?\n/);
  if (!headerLine) return [];
  const headers = headerLine.split("\t");
  return lines.map((line) => {
    const values = line.split("\t");
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row as PreviewRecord;
  });
}

export async function getDerivativeManifest(slug: string): Promise<DerivativeManifest | null> {
  if (!isPilotEnabled()) return null;
  const relativePath = path.join(slug, "metadata", "derivative-manifest.json");
  if (!existsSync(safePilotPath(relativePath))) return null;
  return readJson<DerivativeManifest>(relativePath);
}

export async function getSliceCacheManifest(slug: string): Promise<SliceCacheManifest | null> {
  if (!isPilotEnabled()) return null;
  const relativePath = path.join(slug, "metadata", "slice-manifest.json");
  if (!existsSync(safePilotPath(relativePath))) return null;
  return readJson<SliceCacheManifest>(relativePath);
}

export async function getAdvisoryManifest(slug: string): Promise<AdvisoryManifest | null> {
  if (!isPilotEnabled()) return null;
  const relativePath = path.join(slug, "metadata", "advisory-findings.json");
  if (!existsSync(safePilotPath(relativePath))) return null;
  return readJson<AdvisoryManifest>(relativePath);
}

export type AdvisoryReviewItem = {
  slug: string;
  dataset: PilotDatasetRecord["dataset"];
  finding: AdvisoryFinding;
};

function advisorySummaryFromFindings(findings: AdvisoryFinding[]): AdvisoryManifest["summary"] {
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byReviewStatus: Record<string, number> = {};
  let publicNoticeCandidates = 0;

  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
    byReviewStatus[finding.review_status] = (byReviewStatus[finding.review_status] ?? 0) + 1;
    if (finding.public_notice_candidate) publicNoticeCandidates += 1;
  }

  return {
    total_findings: findings.length,
    public_notice_candidates: publicNoticeCandidates,
    by_severity: Object.fromEntries(Object.entries(bySeverity).sort()),
    by_category: Object.fromEntries(Object.entries(byCategory).sort()),
    by_review_status: Object.fromEntries(Object.entries(byReviewStatus).sort()),
  };
}

export async function getAdvisoryReviewItems(): Promise<AdvisoryReviewItem[]> {
  if (!isPilotReviewEnabled()) return [];

  const root = getPilotRoot();
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const items: AdvisoryReviewItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const advisory = await getAdvisoryManifest(entry.name);
    if (!advisory) continue;

    for (const finding of advisory.findings) {
      items.push({
        slug: entry.name,
        dataset: advisory.dataset,
        finding,
      });
    }
  }

  return items.sort((left, right) =>
    [
      left.finding.review_status.localeCompare(right.finding.review_status),
      left.finding.severity.localeCompare(right.finding.severity),
      left.slug.localeCompare(right.slug),
      left.finding.finding_id.localeCompare(right.finding.finding_id),
    ].find((value) => value !== 0) ?? 0
  );
}

async function updatePilotIndexAdvisorySummary(slug: string, summary: AdvisoryManifest["summary"]): Promise<void> {
  const indexPath = safePilotPath("pilot-index.json");
  if (!existsSync(indexPath)) return;

  const index = JSON.parse(await readFile(indexPath, "utf8")) as PilotIndex;
  const record = index.datasets.find((item) => item.slug === slug);
  if (!record) return;

  record.advisory = summary;
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

export async function updateAdvisoryFindingReview({
  slug,
  findingId,
  reviewStatus,
  publicNoticeCandidate,
}: {
  slug: string;
  findingId: string;
  reviewStatus: AdvisoryReviewStatus;
  publicNoticeCandidate: boolean;
}): Promise<void> {
  if (!isPilotReviewEnabled()) {
    throw new Error("pilot_review_disabled");
  }

  const relativePath = path.join(slug, "metadata", "advisory-findings.json");
  const manifestPath = safePilotPath(relativePath);
  const advisory = JSON.parse(await readFile(manifestPath, "utf8")) as AdvisoryManifest;
  const finding = advisory.findings.find((item) => item.finding_id === findingId);
  if (!finding) {
    throw new Error("advisory_finding_not_found");
  }

  finding.review_status = reviewStatus;
  finding.public_notice_candidate = publicNoticeCandidate;
  finding.reviewed_at = new Date().toISOString();
  finding.reviewed_by = "local_review_suite";
  advisory.summary = advisorySummaryFromFindings(advisory.findings);

  await writeFile(manifestPath, `${JSON.stringify(advisory, null, 2)}\n`);
  await updatePilotIndexAdvisorySummary(slug, advisory.summary);
}

export function pilotAssetHref(absolutePath: string): string {
  const root = getPilotRoot();
  const resolved = path.resolve(absolutePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return "";
  }
  const relativePath = path.relative(root, resolved);
  return `/pilot-assets/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export function bytesToGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(3)} GiB`;
}
