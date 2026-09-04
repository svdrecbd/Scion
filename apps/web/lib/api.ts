import {
  benchmarks,
  compareDatasets,
  corpusTimeline,
  coverageAtlas,
  crossTab,
  experimentPlan,
  findDataset,
  frontier,
  getCorpusFacets,
  measurementGrammar,
  reusabilityMap,
  searchDatasets,
  similarDatasets,
  toolkit,
  type CorpusFilters
} from "./corpus";
import type { CompareResponse, DatasetRecord, FacetResponse, PlanAnalysis, SearchResponse } from "./types";

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

function notFound(path: string, detail: string): ScionApiError {
  return new ScionApiError({ message: detail, kind: "http", path, statusCode: 404 });
}

export async function getDatasets(searchParams?: CorpusFilters): Promise<SearchResponse> {
  return searchDatasets(searchParams);
}

export async function getFacets(): Promise<FacetResponse> {
  return getCorpusFacets();
}

export async function getAnalyticsCrossTab(row: string, col: string, _searchParams?: CorpusFilters) {
  return crossTab(row, col);
}

export async function getToolkitMatrix(searchParams?: CorpusFilters) {
  return toolkit(searchParams);
}

export async function getMeasurementGrammar(searchParams?: CorpusFilters) {
  return measurementGrammar(searchParams);
}

export async function getReusabilityMap(searchParams?: CorpusFilters) {
  return reusabilityMap(searchParams);
}

export async function getCoverageAtlas(searchParams?: CorpusFilters) {
  return coverageAtlas(searchParams);
}

export async function getCorpusTimeline(searchParams?: CorpusFilters) {
  return corpusTimeline(searchParams);
}

export async function getFrontierData(searchParams?: CorpusFilters) {
  return frontier(searchParams);
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
  return experimentPlan(params);
}

export async function getAnalyticsBenchmarks() {
  return benchmarks();
}

export async function getDataset(datasetId: string): Promise<DatasetRecord> {
  const dataset = findDataset(datasetId);
  if (!dataset) throw notFound(`/datasets/${datasetId}`, "Dataset not found.");
  return dataset;
}

export async function getSimilarDatasets(datasetId: string): Promise<DatasetRecord[]> {
  if (!findDataset(datasetId)) throw notFound(`/datasets/${datasetId}/similar`, "Dataset not found.");
  return similarDatasets(datasetId);
}

export async function getCompare(datasetIds: string[]): Promise<CompareResponse> {
  if (datasetIds.length < 2) throw new Error("Compare requires at least two dataset ids.");
  try {
    return compareDatasets(datasetIds);
  } catch {
    throw notFound("/datasets/compare", "One or more dataset IDs were not found.");
  }
}

export function pickExampleCompareIds(searchResponse: SearchResponse): string[] {
  const { results } = searchResponse;
  if (!results || results.length < 2) return [];

  for (let index = 0; index < results.length; index += 1) {
    const left = results[index];
    for (let offset = index + 1; offset < results.length; offset += 1) {
      const right = results[offset];
      const sameCellType = left.cell_type === right.cell_type;
      const sameSpecies = left.species === right.species;
      const sameComparator = left.comparator_class && left.comparator_class === right.comparator_class;
      if (sameCellType || (sameSpecies && sameComparator)) return [left.dataset_id, right.dataset_id];
    }
  }

  return [results[0].dataset_id, results[1].dataset_id];
}
