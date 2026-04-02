import type { CompareResponse, SearchResponse, DatasetRecord } from "./types";

const API_BASE_URL = typeof window === "undefined" 
  ? "http://127.0.0.1:8000/api" 
  : "/api";

async function readJsonOrThrow<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Scion API request failed: ${response.status} ${response.statusText} for ${path}`);
  }

  return (await response.json()) as T;
}

function buildQueryString(params?: Record<string, any>): string {
  if (!params) return "";
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.set(key, String(value));
    }
  });
  const qs = searchParams.toString();
  return qs ? `?${qs}` : "";
}

export async function getDatasets(searchParams?: {
  query?: string;
  cell_type?: string;
  organelle?: string;
  pair?: string;
  modality?: string;
  family?: string;
  metric?: string;
  comparator_class?: string;
  public?: string | boolean;
  borderline?: string | boolean;
}): Promise<SearchResponse> {
  const qs = buildQueryString(searchParams);
  return readJsonOrThrow<SearchResponse>(`/datasets${qs}`);
}

export async function getAnalyticsCrossTab(row: string, col: string, searchParams?: any): Promise<any> {
  const qs = buildQueryString({ ...searchParams, row, col });
  return readJsonOrThrow<any>(`/datasets/analytics/cross-tab${qs}`);
}

export async function getToolkitMatrix(searchParams?: any): Promise<any> {
  const qs = buildQueryString(searchParams);
  return readJsonOrThrow<any>(`/datasets/analytics/toolkit${qs}`);
}

export async function getFrontierData(searchParams?: any): Promise<any[]> {
  const qs = buildQueryString(searchParams);
  return readJsonOrThrow<any[]>(`/datasets/analytics/frontier${qs}`);
}

export async function getExperimentPlan(organelles: string, res: number, ss: number): Promise<any> {
  return readJsonOrThrow<any>(`/datasets/analytics/plan?organelles=${encodeURIComponent(organelles)}&res=${res}&ss=${ss}`);
}

export async function getAnalyticsBenchmarks(): Promise<any[]> {
  return readJsonOrThrow<any[]>("/datasets/analytics/benchmarks");
}

export async function getDataset(datasetId: string): Promise<DatasetRecord> {
  return readJsonOrThrow<DatasetRecord>(`/datasets/${datasetId}`);
}

export async function getSimilarDatasets(datasetId: string): Promise<DatasetRecord[]> {
  return readJsonOrThrow<DatasetRecord[]>(`/datasets/${datasetId}/similar`);
}

export async function getCompare(datasetIds: string[]): Promise<CompareResponse> {
  if (datasetIds.length < 2) {
    throw new Error("Scion compare requires at least two dataset ids.");
  }

  return readJsonOrThrow<CompareResponse>("/datasets/compare", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      dataset_ids: datasetIds
    })
  });
}

export function pickExampleCompareIds(searchResponse: SearchResponse): string[] {
  const { results } = searchResponse;

  if (!results || results.length < 2) {
    return [];
  }

  for (let index = 0; index < results.length; index += 1) {
    const left = results[index];

    for (let offset = index + 1; offset < results.length; offset += 1) {
      const right = results[offset];

      const sameCellType = left.cell_type === right.cell_type;
      const sameSpecies = left.species === right.species;
      const sameComparator = left.comparator_class && left.comparator_class === right.comparator_class;

      if (sameCellType || (sameSpecies && sameComparator)) {
        return [left.dataset_id, right.dataset_id];
      }
    }
  }

  return [results[0].dataset_id, results[1].dataset_id];
}
