import { existsSync } from "fs";
import { readFile } from "fs/promises";
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

const DEFAULT_PUBLIC_DATA_ROOT = path.join(homedir(), "Downloads", "scion-public-data");

export function isPilotEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.SCION_ENABLE_PUBLIC_DATA_PILOT === "true";
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
