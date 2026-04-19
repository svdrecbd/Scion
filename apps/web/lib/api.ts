import type { CompareResponse, FacetResponse, PlanAnalysis, SearchResponse, DatasetRecord } from "./types";

const REQUEST_ID_HEADER = "X-Request-ID";
const DEFAULT_API_TIMEOUT_MS = 5000;

export type ScionApiErrorKind = "timeout" | "http" | "abort" | "network";

export class ScionApiError extends Error {
  kind: ScionApiErrorKind;
  path: string;
  requestId?: string;
  statusCode?: number;

  constructor({
    message,
    kind,
    path,
    requestId,
    statusCode
  }: {
    message: string;
    kind: ScionApiErrorKind;
    path: string;
    requestId?: string;
    statusCode?: number;
  }) {
    super(message);
    this.name = "ScionApiError";
    this.kind = kind;
    this.path = path;
    this.requestId = requestId;
    this.statusCode = statusCode;
  }
}

function getApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    return "/api";
  }

  return (
    process.env.SCION_API_BASE_URL ??
    process.env.NEXT_PUBLIC_SCION_API_BASE_URL ??
    "http://127.0.0.1:8000/api"
  );
}

function getApiTimeoutMs(): number {
  const rawValue =
    process.env.SCION_API_TIMEOUT_MS ??
    process.env.NEXT_PUBLIC_SCION_API_TIMEOUT_MS ??
    String(DEFAULT_API_TIMEOUT_MS);
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : DEFAULT_API_TIMEOUT_MS;
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `scion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readJsonOrThrow<T>(path: string, init?: RequestInit): Promise<T> {
  const requestId = createRequestId();
  const timeoutMs = getApiTimeoutMs();
  const controller = new AbortController();
  const headers = new Headers(init?.headers);
  headers.set(REQUEST_ID_HEADER, requestId);

  let timedOut = false;
  let abortListener: (() => void) | undefined;

  if (init?.signal) {
    abortListener = () => controller.abort(init.signal?.reason);

    if (init.signal.aborted) {
      abortListener();
    } else {
      init.signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: controller.signal
    });
  } catch (error) {
    if (timedOut) {
      throw new ScionApiError({
        message: `Scion API request timed out after ${timeoutMs}ms for ${path} [request_id=${requestId}]`,
        kind: "timeout",
        path,
        requestId
      });
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new ScionApiError({
        message: `Scion API request was aborted for ${path} [request_id=${requestId}]`,
        kind: "abort",
        path,
        requestId
      });
    }

    if (error instanceof Error) {
      throw new ScionApiError({
        message: `Scion API request failed before a response for ${path}: ${error.message} [request_id=${requestId}]`,
        kind: "network",
        path,
        requestId
      });
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (init?.signal && abortListener) {
      init.signal.removeEventListener("abort", abortListener);
    }
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    let responseRequestId = response.headers.get("x-request-id") ?? requestId;

    try {
      const payload = (await response.json()) as { detail?: string; request_id?: string };
      if (payload.detail) {
        detail = payload.detail;
      }
      if (payload.request_id) {
        responseRequestId = payload.request_id;
      }
    } catch {
      // Fall back to status text when the error payload is not JSON.
    }

    throw new ScionApiError({
      message: `Scion API request failed: ${detail} for ${path} [request_id=${responseRequestId}]`,
      kind: "http",
      path,
      requestId: responseRequestId,
      statusCode: response.status
    });
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
  year?: string | number;
  cell_type?: string;
  organelle?: string;
  pair?: string;
  modality?: string;
  family?: string;
  metric?: string;
  comparator_class?: string;
  status?: "none" | "partial" | "complete" | string;
  public?: string | boolean;
  borderline?: string | boolean;
  limit?: string | number;
}): Promise<SearchResponse> {
  const qs = buildQueryString(searchParams);
  return readJsonOrThrow<SearchResponse>(`/datasets${qs}`);
}

export async function getFacets(): Promise<FacetResponse> {
  return readJsonOrThrow<FacetResponse>("/datasets/facets");
}

export async function getAnalyticsCrossTab(row: string, col: string, searchParams?: any): Promise<any> {
  const qs = buildQueryString({ ...searchParams, row, col });
  return readJsonOrThrow<any>(`/datasets/analytics/cross-tab${qs}`);
}

export async function getToolkitMatrix(searchParams?: any): Promise<any> {
  const qs = buildQueryString(searchParams);
  return readJsonOrThrow<any>(`/datasets/analytics/toolkit${qs}`);
}

export async function getMeasurementGrammar(searchParams?: any): Promise<any> {
  const qs = buildQueryString(searchParams);
  return readJsonOrThrow<any>(`/datasets/analytics/measurement-grammar${qs}`);
}

export async function getReusabilityMap(searchParams?: any): Promise<any> {
  const qs = buildQueryString(searchParams);
  return readJsonOrThrow<any>(`/datasets/analytics/reusability-map${qs}`);
}

export async function getCoverageAtlas(searchParams?: any): Promise<any> {
  const qs = buildQueryString(searchParams);
  return readJsonOrThrow<any>(`/datasets/analytics/coverage-atlas${qs}`);
}

export async function getCorpusTimeline(searchParams?: any): Promise<any> {
  const qs = buildQueryString(searchParams);
  return readJsonOrThrow<any>(`/datasets/analytics/timeline${qs}`);
}

export async function getFrontierData(searchParams?: any): Promise<any[]> {
  const qs = buildQueryString(searchParams);
  return readJsonOrThrow<any[]>(`/datasets/analytics/frontier${qs}`);
}

export async function getExperimentPlan(params: {
  organelles: string;
  res?: string | number | null;
  ss?: string | number | null;
  cell_type?: string | null;
  metric?: string | null;
  comparator_class?: string | null;
  family?: string | null;
}): Promise<PlanAnalysis> {
  const qs = buildQueryString(params);
  return readJsonOrThrow<PlanAnalysis>(`/datasets/analytics/plan${qs}`);
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
