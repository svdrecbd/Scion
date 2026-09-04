import corpusData from "./corpus-data.json";
import type {
  CompareResponse,
  DatasetRecord,
  FacetResponse,
  FacetValue,
  PlanAnalysis,
  SearchResponse
} from "./types";

export type CorpusFilters = {
  query?: unknown;
  year?: unknown;
  cell_type?: unknown;
  organelle?: unknown;
  pair?: unknown;
  modality?: unknown;
  family?: unknown;
  metric?: unknown;
  comparator_class?: unknown;
  status?: unknown;
  public?: unknown;
  borderline?: unknown;
  limit?: unknown;
};

const records = corpusData as DatasetRecord[];
const publicStatuses = new Set(["complete", "partial", "none"]);

function text(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function flag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function contains(value: string | null | undefined, target: unknown): boolean {
  const needle = text(target)?.toLowerCase();
  return !needle || (value ?? "").toLowerCase().includes(needle);
}

function hasExact(values: string[], target: unknown): boolean {
  const needle = text(target)?.toLowerCase();
  return !needle || values.some((value) => value.toLowerCase() === needle);
}

function increment(target: Record<string, number>, key: string, amount = 1) {
  target[key] = (target[key] ?? 0) + amount;
}

function sortedKeysByCount(counts: Record<string, number>): string[] {
  return Object.keys(counts).sort((left, right) => counts[right] - counts[left] || left.localeCompare(right));
}

function countValues(values: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) increment(counts, value);
  return counts;
}

function topValues(values: Iterable<string>, limit = 5): string[] {
  return sortedKeysByCount(countValues(values)).slice(0, limit);
}

export function filterDatasets(filters: CorpusFilters = {}): DatasetRecord[] {
  const includeBorderline = flag(filters.borderline);
  const year = text(filters.year);
  const query = text(filters.query)?.toLowerCase();
  const status = text(filters.status);

  if (status && !publicStatuses.has(status)) {
    throw new Error(`Unsupported public data status '${status}'.`);
  }

  return records
    .filter((dataset) => {
      if (dataset.included_status !== "included" && !(includeBorderline && dataset.included_status === "borderline")) return false;
      if (year && dataset.year !== Number(year)) return false;
      if (query) {
        const haystack = [
          dataset.title,
          dataset.paper_title,
          dataset.source_study_id,
          dataset.publication_pmid,
          dataset.source,
          dataset.species,
          dataset.cell_type,
          dataset.comparator_class,
          dataset.comparator_detail,
          dataset.modality,
          ...dataset.organelles,
          ...dataset.organelle_pairs,
          ...dataset.metric_families,
          dataset.notes
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (!contains(dataset.cell_type, filters.cell_type)) return false;
      if (!hasExact(dataset.organelles, filters.organelle)) return false;
      if (!hasExact(dataset.organelle_pairs, filters.pair)) return false;
      if (!contains(dataset.modality, filters.modality)) return false;
      if (!contains(dataset.modality_family, filters.family)) return false;
      if (!hasExact(dataset.metric_families, filters.metric)) return false;
      if (text(filters.comparator_class) && dataset.comparator_class?.toLowerCase() !== text(filters.comparator_class)?.toLowerCase()) return false;
      if (status && dataset.public_data_status !== status) return false;
      if (flag(filters.public) && dataset.public_data_status === "none") return false;
      return true;
    })
    .sort((left, right) => right.year - left.year || left.dataset_id.localeCompare(right.dataset_id));
}

function commonalities(datasets: DatasetRecord[]): SearchResponse["commonalities"] {
  return {
    top_organelles: topValues(datasets.flatMap((dataset) => dataset.organelles)),
    top_organelle_pairs: topValues(datasets.flatMap((dataset) => dataset.organelle_pairs)),
    top_metric_families: topValues(datasets.flatMap((dataset) => dataset.metric_families)),
    top_modalities: topValues(datasets.map((dataset) => dataset.modality)),
    top_cell_types: topValues(datasets.map((dataset) => dataset.cell_type))
  };
}

export function searchDatasets(filters: CorpusFilters = {}): SearchResponse {
  const matches = filterDatasets(filters);
  const requestedLimit = Number(text(filters.limit) ?? 200);
  const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 200;
  return {
    total: matches.length,
    results: matches.slice(0, limit),
    commonalities: matches.length ? commonalities(matches) : commonalities([])
  };
}

function facets(values: Iterable<string>): FacetValue[] {
  const counts = countValues(values);
  return sortedKeysByCount(counts).map((value) => ({ value, count: counts[value] }));
}

export function getCorpusFacets(): FacetResponse {
  const datasets = filterDatasets();
  return {
    cell_types: facets(datasets.map((dataset) => dataset.cell_type)),
    modalities: facets(datasets.map((dataset) => dataset.modality)),
    organelles: facets(datasets.flatMap((dataset) => dataset.organelles)),
    metric_families: facets(datasets.flatMap((dataset) => dataset.metric_families)),
    comparator_classes: facets(datasets.flatMap((dataset) => dataset.comparator_class ? [dataset.comparator_class] : []))
  };
}

export function findDataset(datasetId: string): DatasetRecord | undefined {
  return records.find((dataset) => dataset.dataset_id === datasetId && ["included", "borderline"].includes(dataset.included_status));
}

function intersection(groups: string[][]): string[] {
  if (!groups.length) return [];
  return [...new Set(groups[0])].filter((value) => groups.every((group) => group.includes(value))).sort();
}

export function compareDatasets(datasetIds: string[]): CompareResponse {
  const datasets = datasetIds.map(findDataset);
  if (datasets.some((dataset) => !dataset)) throw new Error("One or more dataset IDs were not found.");
  const selected = datasets as DatasetRecord[];
  const sharedFields = {
    cell_types: intersection(selected.map((dataset) => [dataset.cell_type])),
    species: intersection(selected.map((dataset) => [dataset.species])),
    organelles: intersection(selected.map((dataset) => dataset.organelles)),
    organelle_pairs: intersection(selected.map((dataset) => dataset.organelle_pairs)),
    metric_families: intersection(selected.map((dataset) => dataset.metric_families)),
    comparator_classes: intersection(selected.filter((dataset) => dataset.comparator_class).map((dataset) => [dataset.comparator_class!])),
    modality_families: intersection(selected.map((dataset) => [dataset.modality_family]))
  };
  const unique = (values: string[]) => [...new Set(values)].sort();
  const keyDifferences = {
    modalities: unique(selected.map((dataset) => dataset.modality)),
    sample_size_buckets: unique(selected.map((dataset) => dataset.sample_size_bucket)),
    public_data_statuses: unique(selected.map((dataset) => dataset.public_data_status)),
    boundary_confirmation: unique(selected.map((dataset) => dataset.whole_cell_boundary_confirmed))
  };
  const allSame = (values: string[]) => new Set(values).size === 1;
  let score = 0;
  if (allSame(selected.map((dataset) => dataset.cell_type))) score += 25;
  if (allSame(selected.map((dataset) => dataset.species))) score += 10;
  score += Math.min(20, sharedFields.organelle_pairs.length * 5);
  score += Math.min(15, sharedFields.metric_families.length * 3);
  if (allSame(selected.map((dataset) => dataset.modality_family))) score += 10;
  if (sharedFields.comparator_classes.length) score += 10;
  if (selected.every((dataset) => dataset.metadata_completeness_score >= 0.8)) score += 10;
  score = Math.min(score, 100);
  const summary = score >= 75
    ? "High biological overlap with enough shared structure to justify direct comparison."
    : score >= 50
      ? "Moderate comparability; useful for targeted comparison with technical caveats."
      : "Low direct comparability; treat these datasets as analogs rather than close matches.";
  return { datasets: selected, shared_fields: sharedFields, key_differences: keyDifferences, comparability_score: score, summary };
}

function similarity(left: DatasetRecord, right: DatasetRecord): number {
  let score = 0;
  if (left.cell_type === right.cell_type) score += 40;
  if (left.species === right.species) score += 10;
  if (left.modality_family === right.modality_family) score += 10;
  score += intersection([left.organelles, right.organelles]).length * 5;
  score += intersection([left.metric_families, right.metric_families]).length * 5;
  return score;
}

export function similarDatasets(datasetId: string, limit = 4): DatasetRecord[] {
  const target = findDataset(datasetId);
  if (!target) throw new Error("Dataset not found.");
  return filterDatasets()
    .filter((dataset) => dataset.dataset_id !== datasetId)
    .sort((left, right) => similarity(right, target) - similarity(left, target) || right.year - left.year || left.dataset_id.localeCompare(right.dataset_id))
    .slice(0, limit);
}

export function crossTab(row: string, col: string) {
  const allowed = new Set([
    "dataset_id", "title", "paper_title", "year", "source", "source_type", "public_data_status", "species",
    "cell_type", "tissue_or_system", "comparator_class", "comparator_detail", "modality", "modality_family",
    "sample_size_bucket", "whole_cell_boundary_confirmed", "included_status", "organelles", "organelle_pairs", "metric_families"
  ]);
  if (!allowed.has(row) || !allowed.has(col)) throw new Error("Unsupported analytics dimension.");
  const table: Record<string, Record<string, number>> = {};
  const rowTotals: Record<string, number> = {};
  const colTotals: Record<string, number> = {};
  const normalize = (value: unknown) => Array.isArray(value) ? String(value[0] ?? "none") : String(value ?? "none").trim() || "none";
  for (const dataset of filterDatasets({ borderline: true })) {
    const rowValue = normalize(dataset[row as keyof DatasetRecord]);
    const colValue = normalize(dataset[col as keyof DatasetRecord]);
    table[rowValue] ??= {};
    increment(table[rowValue], colValue);
    increment(rowTotals, rowValue);
    increment(colTotals, colValue);
  }
  return { table, row_totals: rowTotals, col_totals: colTotals, rows: Object.keys(rowTotals).sort(), cols: Object.keys(colTotals).sort() };
}

export function frontier(filters: CorpusFilters = {}) {
  return filterDatasets(filters)
    .filter((dataset) => dataset.lateral_resolution_nm != null && dataset.sample_size != null)
    .map((dataset) => ({ id: dataset.dataset_id, title: dataset.title, res: dataset.lateral_resolution_nm!, ss: dataset.sample_size!, modality: dataset.modality_family }));
}

export function toolkit(filters: CorpusFilters = {}) {
  const datasets = filterDatasets(filters);
  const matrix: Record<string, Record<string, number>> = {};
  for (const dataset of datasets) for (const organelle of dataset.organelles) {
    matrix[organelle] ??= {};
    increment(matrix[organelle], dataset.modality_family);
  }
  return {
    matrix,
    organelles: Object.keys(matrix).sort(),
    modalities: [...new Set(datasets.map((dataset) => dataset.modality_family))].sort()
  };
}

export function measurementGrammar(filters: CorpusFilters = {}) {
  const matrix: Record<string, Record<string, number>> = {};
  const organelleTotals: Record<string, number> = {};
  const metricTotals: Record<string, number> = {};
  for (const dataset of filterDatasets(filters)) for (const organelle of dataset.organelles) for (const metric of dataset.metric_families) {
    matrix[organelle] ??= {};
    increment(matrix[organelle], metric);
    increment(organelleTotals, organelle);
    increment(metricTotals, metric);
  }
  const diversity = Object.fromEntries(Object.entries(matrix).map(([organelle, values]) => [organelle, Object.keys(values).length]));
  const organelles = Object.keys(matrix).sort((a, b) => diversity[b] - diversity[a] || organelleTotals[b] - organelleTotals[a] || a.localeCompare(b));
  const metricFamilies = Object.keys(metricTotals).sort((a, b) => metricTotals[b] - metricTotals[a] || a.localeCompare(b));
  return { matrix, organelles, metric_families: metricFamilies, organelle_totals: organelleTotals, metric_totals: metricTotals, organelle_metric_family_counts: diversity };
}

export function reusabilityMap(filters: CorpusFilters = {}) {
  const statuses = ["complete", "partial", "none"];
  const matrix: Record<string, Record<string, number>> = {};
  const rowTotals: Record<string, number> = {};
  const reusableTotals: Record<string, number> = {};
  const modalities: Record<string, Set<string>> = {};
  const metrics: Record<string, Set<string>> = {};
  for (const dataset of filterDatasets(filters)) for (const organelle of dataset.organelles) {
    matrix[organelle] ??= Object.fromEntries(statuses.map((status) => [status, 0]));
    increment(matrix[organelle], dataset.public_data_status);
    increment(rowTotals, organelle);
    if (dataset.public_data_status !== "none") {
      increment(reusableTotals, organelle);
      modalities[organelle] ??= new Set();
      metrics[organelle] ??= new Set();
      modalities[organelle].add(dataset.modality_family);
      dataset.metric_families.forEach((metric) => metrics[organelle].add(metric));
    }
  }
  const publicShare = Object.fromEntries(Object.entries(rowTotals).map(([key, total]) => [key, Math.round(((reusableTotals[key] ?? 0) / total) * 1000) / 1000]));
  const organelles = Object.keys(rowTotals).sort((a, b) => (reusableTotals[b] ?? 0) - (reusableTotals[a] ?? 0) || publicShare[b] - publicShare[a] || rowTotals[b] - rowTotals[a] || a.localeCompare(b));
  return {
    matrix, organelles, statuses, row_totals: rowTotals, reusable_totals: reusableTotals, public_share: publicShare,
    reusable_modality_families: Object.fromEntries(Object.entries(modalities).map(([key, values]) => [key, [...values].sort()])),
    reusable_metric_families: Object.fromEntries(Object.entries(metrics).map(([key, values]) => [key, [...values].sort()]))
  };
}

export function coverageAtlas(filters: CorpusFilters = {}) {
  const matrix: Record<string, Record<string, number>> = {};
  const cellTypeTotals: Record<string, number> = {};
  const organelleTotals: Record<string, number> = {};
  const species: Record<string, Set<string>> = {};
  for (const dataset of filterDatasets(filters)) {
    increment(cellTypeTotals, dataset.cell_type);
    species[dataset.cell_type] ??= new Set();
    species[dataset.cell_type].add(dataset.species);
    matrix[dataset.cell_type] ??= {};
    for (const organelle of dataset.organelles) {
      increment(matrix[dataset.cell_type], organelle);
      increment(organelleTotals, organelle);
    }
  }
  const diversity = Object.fromEntries(Object.entries(matrix).map(([cellType, values]) => [cellType, Object.keys(values).length]));
  const cellTypes = Object.keys(cellTypeTotals).sort((a, b) => (diversity[b] ?? 0) - (diversity[a] ?? 0) || cellTypeTotals[b] - cellTypeTotals[a] || a.localeCompare(b));
  const organelles = sortedKeysByCount(organelleTotals);
  return {
    matrix, cell_types: cellTypes, organelles, cell_type_totals: cellTypeTotals, organelle_totals: organelleTotals,
    cell_type_organelle_counts: diversity,
    cell_type_species: Object.fromEntries(Object.entries(species).map(([key, values]) => [key, [...values].sort()]))
  };
}

export function corpusTimeline(filters: CorpusFilters = {}) {
  const matrix: Record<number, Record<string, number>> = {};
  const yearTotals: Record<number, number> = {};
  const publicCounts: Record<number, number> = {};
  const organellesByYear: Record<number, Set<string>> = {};
  const metricsByYear: Record<number, Set<string>> = {};
  const modalityTotals: Record<string, number> = {};
  for (const dataset of filterDatasets(filters)) {
    matrix[dataset.year] ??= {};
    increment(matrix[dataset.year], dataset.modality_family);
    increment(yearTotals, String(dataset.year));
    increment(modalityTotals, dataset.modality_family);
    if (dataset.public_data_status !== "none") increment(publicCounts, String(dataset.year));
    organellesByYear[dataset.year] ??= new Set();
    metricsByYear[dataset.year] ??= new Set();
    dataset.organelles.forEach((value) => organellesByYear[dataset.year].add(value));
    dataset.metric_families.forEach((value) => metricsByYear[dataset.year].add(value));
  }
  const years = Object.keys(yearTotals).map(Number).sort((a, b) => a - b);
  return {
    matrix, years, modality_families: sortedKeysByCount(modalityTotals), year_totals: yearTotals, public_counts: publicCounts,
    organelle_counts: Object.fromEntries(years.map((year) => [year, organellesByYear[year]?.size ?? 0])),
    metric_family_counts: Object.fromEntries(years.map((year) => [year, metricsByYear[year]?.size ?? 0]))
  };
}

function stats(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], max: sorted.at(-1)!, median: sorted[Math.floor(sorted.length / 2)], avg: Math.round((sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 10) / 10 };
}

export function benchmarks() {
  const grouped: Record<string, { resolutions: number[]; sampleSizes: number[]; count: number }> = {};
  for (const dataset of filterDatasets({ borderline: true })) {
    grouped[dataset.modality_family] ??= { resolutions: [], sampleSizes: [], count: 0 };
    grouped[dataset.modality_family].count += 1;
    if (dataset.lateral_resolution_nm != null) grouped[dataset.modality_family].resolutions.push(dataset.lateral_resolution_nm);
    if (dataset.sample_size != null) grouped[dataset.modality_family].sampleSizes.push(dataset.sample_size);
  }
  return Object.keys(grouped).sort().map((family) => ({
    modality_family: family,
    count: grouped[family].count,
    resolution_stats: stats(grouped[family].resolutions),
    sample_size_stats: stats(grouped[family].sampleSizes)
  }));
}

export function experimentPlan(params: {
  organelles: string;
  res?: string | number | null;
  ss?: string | number | null;
  cell_type?: string | null;
  metric?: string | null;
  comparator_class?: string | null;
  family?: string | null;
}): PlanAnalysis {
  const organelles = params.organelles.split(",").map((value) => value.trim()).filter(Boolean);
  const datasets = filterDatasets({
    borderline: true,
    cell_type: params.cell_type,
    metric: params.metric,
    comparator_class: params.comparator_class,
    family: params.family
  });
  const biological = datasets.filter((dataset) => organelles.some((organelle) => dataset.organelles.includes(organelle)));
  const targetResolution = params.res == null || params.res === "" ? null : Number(params.res);
  const targetSampleSize = params.ss == null || params.ss === "" ? null : Number(params.ss);
  const strict = biological.filter((dataset) =>
    (targetResolution == null || (dataset.lateral_resolution_nm ?? 999) <= targetResolution * 1.5) &&
    (targetSampleSize == null || (dataset.sample_size ?? 0) >= targetSampleSize * 0.5)
  );
  let status: PlanAnalysis["status"] = "feasible";
  let statusMessage = `${strict.length} records in the current corpus meet the active filters for this target.`;
  if (!biological.length) {
    status = "frontier";
    statusMessage = "No records in the current corpus capture this organelle target.";
  } else if (!strict.length) {
    status = "high-risk";
    statusMessage = `${biological.length} matching records exist in the current corpus, but none meet the active threshold filters.`;
  } else if (strict.length < 3) {
    status = "challenging";
    statusMessage = `Only ${strict.length} records in the current corpus meet the active threshold filters for this target.`;
  }
  const modalityCounts = countValues(biological.map((dataset) => dataset.modality));
  const topModality = sortedKeysByCount(modalityCounts)[0] ?? "Unknown";
  const metricCounts = countValues(biological.flatMap((dataset) => dataset.metric_families));
  return {
    biological_target: organelles.join(" & "),
    target_res_nm: targetResolution,
    target_sample_size: targetSampleSize,
    status,
    status_message: statusMessage,
    modality_recommendation: `In the current corpus, ${topModality} is the most common modality for this target (${biological.length} matching records).`,
    precedents: strict.length ? strict : biological,
    standard_metrics: sortedKeysByCount(metricCounts).slice(0, 3),
    suggested_baselines: biological.filter((dataset) => dataset.public_data_status !== "none").slice(0, 3),
    matched_records_count: biological.length,
    threshold_records_count: strict.length
  };
}

export function corpusRecordCount(): number {
  return records.length;
}
