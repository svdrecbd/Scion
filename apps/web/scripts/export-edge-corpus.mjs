import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "lib/corpus-data.json");
const sourceUrl =
  process.env.SCION_CORPUS_EXPORT_URL ??
  "http://127.0.0.1:8000/api/datasets?borderline=true&limit=500";

const fields = [
  "dataset_id",
  "title",
  "paper_title",
  "year",
  "source",
  "source_type",
  "public_data_status",
  "species",
  "cell_type",
  "tissue_or_system",
  "comparator_class",
  "comparator_detail",
  "modality",
  "modality_family",
  "lateral_resolution_nm",
  "axial_resolution_nm",
  "isotropic",
  "organelles",
  "organelle_pairs",
  "metric_families",
  "sample_size",
  "sample_size_bucket",
  "metadata_completeness_score",
  "whole_cell_boundary_confirmed",
  "notes",
  "source_study_id",
  "publication_pmid",
  "included_status",
  "source_publication_url",
  "public_locator_urls"
];

const response = await fetch(sourceUrl);
if (!response.ok) {
  throw new Error(`Corpus export failed: ${response.status} ${response.statusText}`);
}

const payload = await response.json();
if (!payload || !Array.isArray(payload.results) || payload.results.length === 0) {
  throw new Error("Corpus export returned no dataset records.");
}

const records = payload.results.map((record) =>
  Object.fromEntries(fields.map((field) => [field, record[field] ?? null]))
);
const ids = new Set(records.map((record) => record.dataset_id));
if (ids.size !== records.length || ids.has(null)) {
  throw new Error("Corpus export contains a missing or duplicate dataset ID.");
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
console.log(`Exported ${records.length} public metadata records to ${outputPath}.`);
