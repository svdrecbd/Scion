import assert from "node:assert/strict";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, "..");
const tempRoot = join(desktopRoot, ".tmp");
const tempDir = join(tempRoot, "caos-handoff-tests");
const sourcePath = join(desktopRoot, "src", "caos-handoff.ts");
const outputPath = join(tempDir, "caos-handoff.mjs");

await rm(tempDir, { force: true, recursive: true });
await mkdir(tempDir, { recursive: true });
const source = await readFile(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: sourcePath,
});
await writeFile(outputPath, transpiled.outputText);
const caos = await import(pathToFileURL(outputPath).href);
await rm(tempDir, { force: true, recursive: true });
await rmdir(tempRoot).catch(() => undefined);

const dataset = {
  dataset_id: "dataset-10392",
  title: "Fixture whole-cell dataset",
  paper_title: "Fixture paper",
  year: 2020,
  source: "Fixture Journal",
  source_type: "paper",
  public_data_status: "complete",
  species: "Fixture species",
  cell_type: "Fixture cell",
  tissue_or_system: null,
  comparator_class: null,
  comparator_detail: null,
  modality: "FIB-SEM",
  modality_family: "EM",
  lateral_resolution_nm: 10,
  axial_resolution_nm: 20,
  isotropic: false,
  organelles: ["nucleus", "mitochondria"],
  organelle_pairs: ["mitochondria:nucleus"],
  metric_families: ["volume"],
  sample_size: 1,
  sample_size_bucket: "1",
  metadata_completeness_score: 0.9,
  whole_cell_boundary_confirmed: "yes",
  notes: null,
  source_study_id: "fixture-study",
  publication_pmid: "12345678",
  source_publication_url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
  public_locator_urls: ["https://www.ebi.ac.uk/empiar/EMPIAR-10392/"],
  included_status: "included",
};

const fingerprintPayload = [
  dataset.dataset_id,
  dataset.title,
  dataset.paper_title,
  String(dataset.year),
  dataset.source_study_id,
  dataset.publication_pmid,
  dataset.source_publication_url,
  dataset.public_data_status,
  ...dataset.public_locator_urls,
].join("\n");
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintPayload));
const fingerprint = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");

const fixture = {
  schema: "cell-anatomy-caos-handoff",
  schema_version: 1,
  generated_at: "2026-08-12T12:00:00Z",
  intent: "inspect_dataset",
  atlas: {
    dataset_path: "/datasets/dataset-10392",
    api_path: "/api/datasets/dataset-10392",
  },
  dataset,
  asset_candidates: [
    {
      source: "public_locator",
      locator_url: dataset.public_locator_urls[0],
      repository: "EMPIAR",
      accession: "10392",
      availability: "indexed",
    },
  ],
  project_seed: {
    name: "Fixture Cell — 2020",
    note: "Inspect the fixture.",
    intended_operations: ["inspect", "measure", "review"],
  },
  requirements: {
    local_data_required: true,
    raw_data_included: false,
    automatic_download_allowed: false,
    minimum_workbench_schema_version: 1,
  },
  integrity: {
    algorithm: "sha256",
    dataset_fingerprint: fingerprint,
    generated_by: "cell-anatomy-api",
  },
};

const derivative = { source_relative_path: "fixture.ome.zarr" };
const loadedDataset = {
  slug: "empiar-10392",
  title: "Loaded fixture",
  source: "EMPIAR",
  entryId: "10392",
  derivatives: [derivative],
};

test("CAOS handoff parses and verifies the Atlas fingerprint", async () => {
  const parsed = caos.parseCaosHandoff(JSON.stringify(fixture));
  assert.equal(parsed.dataset.dataset_id, dataset.dataset_id);
  assert.equal(parsed.asset_candidates[0].accession, "10392");
  assert.equal(await caos.verifyCaosHandoffIntegrity(parsed), true);
});

test("CAOS handoff resolves a loaded derivative by repository accession", () => {
  const parsed = caos.parseCaosHandoff(fixture);
  const resolution = caos.resolveCaosHandoffDataset(parsed, [loadedDataset]);
  assert.equal(resolution.status, "ready");
  assert.equal(resolution.matchedBy, "repository-accession");
  assert.equal(resolution.dataset.slug, loadedDataset.slug);
});

test("CAOS handoff remains pending when image data is unavailable", () => {
  const parsed = caos.parseCaosHandoff(fixture);
  const resolution = caos.resolveCaosHandoffDataset(parsed, []);
  assert.equal(resolution.status, "pending");
  assert.match(resolution.summary, /No loaded derivative/);
});

test("CAOS handoff rejects unsafe locator protocols and fingerprint tampering", async () => {
  const unsafe = structuredClone(fixture);
  unsafe.asset_candidates[0].locator_url = "file:///private/archive";
  assert.throws(() => caos.parseCaosHandoff(unsafe), /http or https/);

  const tampered = structuredClone(fixture);
  tampered.dataset.title = "Tampered title";
  const parsed = caos.parseCaosHandoff(tampered);
  assert.equal(await caos.verifyCaosHandoffIntegrity(parsed), false);
});
