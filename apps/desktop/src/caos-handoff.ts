export const CAOS_HANDOFF_SCHEMA = "cell-anatomy-caos-handoff";
export const CAOS_HANDOFF_SCHEMA_VERSION = 1;

export type CaosHandoffAssetCandidate = {
  source: "public_locator";
  locator_url: string;
  repository?: string | null;
  accession?: string | null;
  availability: "indexed" | "unknown";
};

export type CaosHandoffDataset = {
  dataset_id: string;
  title: string;
  paper_title: string;
  year: number;
  source: string;
  source_type: "paper" | "repository" | "internal";
  public_data_status: "none" | "partial" | "complete";
  species: string;
  cell_type: string;
  tissue_or_system?: string | null;
  comparator_class?: string | null;
  comparator_detail?: string | null;
  modality: string;
  modality_family: "EM" | "X-ray" | "optical" | "other";
  lateral_resolution_nm?: number | null;
  axial_resolution_nm?: number | null;
  isotropic?: boolean | null;
  organelles: string[];
  organelle_pairs: string[];
  metric_families: string[];
  sample_size?: number | null;
  sample_size_bucket: string;
  metadata_completeness_score: number;
  whole_cell_boundary_confirmed: "yes" | "no" | "unclear";
  notes?: string | null;
  source_study_id?: string | null;
  publication_pmid?: string | null;
  source_publication_url?: string | null;
  public_locator_urls: string[];
  included_status: string;
};

export type CaosHandoff = {
  schema: typeof CAOS_HANDOFF_SCHEMA;
  schema_version: typeof CAOS_HANDOFF_SCHEMA_VERSION;
  generated_at: string;
  intent: "inspect_dataset";
  atlas: {
    dataset_path: string;
    api_path: string;
  };
  dataset: CaosHandoffDataset;
  asset_candidates: CaosHandoffAssetCandidate[];
  project_seed: {
    name: string;
    note: string;
    intended_operations: Array<"inspect" | "compare" | "measure" | "annotate" | "convert" | "review">;
  };
  requirements: {
    local_data_required: boolean;
    raw_data_included: boolean;
    automatic_download_allowed: boolean;
    minimum_workbench_schema_version: number;
  };
  integrity: {
    algorithm: "sha256";
    dataset_fingerprint: string;
    generated_by: "cell-anatomy-api";
  };
};

export type CaosHandoffLoadedDataset = {
  slug: string;
  title: string;
  source: string;
  entryId: string;
  derivatives: unknown[];
};

export type CaosHandoffResolution<Dataset extends CaosHandoffLoadedDataset = CaosHandoffLoadedDataset> =
  | { status: "ready"; dataset: Dataset; matchedBy: "dataset-id" | "study-id" | "repository-accession" }
  | { status: "pending" | "ambiguous"; summary: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requireObject = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${path} must be a JSON object.`);
  return value;
};

const requireArray = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value;
};

const requireString = (value: unknown, path: string, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
};

const requireOptionalString = (value: unknown, path: string): string | null | undefined => {
  if (value === null || value === undefined) return value;
  return requireString(value, path);
};

const requireStringArray = (value: unknown, path: string): string[] =>
  requireArray(value, path).map((item, index) => requireString(item, `${path}[${index}]`));

const requireNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  return value;
};

const requireBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
};

const requireEnum = <T extends string>(value: unknown, allowed: readonly T[], path: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
};

const requireHttpUrl = (value: unknown, path: string): string => {
  const url = requireString(value, path);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${path} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${path} must use http or https.`);
  }
  return url;
};

const parseDataset = (value: unknown): CaosHandoffDataset => {
  const dataset = requireObject(value, "handoff.dataset");
  const optionalNumber = (key: string) =>
    dataset[key] === null || dataset[key] === undefined
      ? dataset[key] as null | undefined
      : requireNumber(dataset[key], `handoff.dataset.${key}`);
  const optionalBoolean = (key: string) => {
    const item = dataset[key];
    if (item === null || item === undefined) return item as null | undefined;
    return requireBoolean(item, `handoff.dataset.${key}`);
  };

  return {
    dataset_id: requireString(dataset.dataset_id, "handoff.dataset.dataset_id"),
    title: requireString(dataset.title, "handoff.dataset.title"),
    paper_title: requireString(dataset.paper_title, "handoff.dataset.paper_title"),
    year: requireNumber(dataset.year, "handoff.dataset.year"),
    source: requireString(dataset.source, "handoff.dataset.source"),
    source_type: requireEnum(dataset.source_type, ["paper", "repository", "internal"], "handoff.dataset.source_type"),
    public_data_status: requireEnum(dataset.public_data_status, ["none", "partial", "complete"], "handoff.dataset.public_data_status"),
    species: requireString(dataset.species, "handoff.dataset.species"),
    cell_type: requireString(dataset.cell_type, "handoff.dataset.cell_type"),
    tissue_or_system: requireOptionalString(dataset.tissue_or_system, "handoff.dataset.tissue_or_system"),
    comparator_class: requireOptionalString(dataset.comparator_class, "handoff.dataset.comparator_class"),
    comparator_detail: requireOptionalString(dataset.comparator_detail, "handoff.dataset.comparator_detail"),
    modality: requireString(dataset.modality, "handoff.dataset.modality"),
    modality_family: requireEnum(dataset.modality_family, ["EM", "X-ray", "optical", "other"], "handoff.dataset.modality_family"),
    lateral_resolution_nm: optionalNumber("lateral_resolution_nm"),
    axial_resolution_nm: optionalNumber("axial_resolution_nm"),
    isotropic: optionalBoolean("isotropic"),
    organelles: requireStringArray(dataset.organelles, "handoff.dataset.organelles"),
    organelle_pairs: requireStringArray(dataset.organelle_pairs, "handoff.dataset.organelle_pairs"),
    metric_families: requireStringArray(dataset.metric_families, "handoff.dataset.metric_families"),
    sample_size: optionalNumber("sample_size"),
    sample_size_bucket: requireString(dataset.sample_size_bucket, "handoff.dataset.sample_size_bucket"),
    metadata_completeness_score: requireNumber(dataset.metadata_completeness_score, "handoff.dataset.metadata_completeness_score"),
    whole_cell_boundary_confirmed: requireEnum(dataset.whole_cell_boundary_confirmed, ["yes", "no", "unclear"], "handoff.dataset.whole_cell_boundary_confirmed"),
    notes: requireOptionalString(dataset.notes, "handoff.dataset.notes"),
    source_study_id: requireOptionalString(dataset.source_study_id, "handoff.dataset.source_study_id"),
    publication_pmid: requireOptionalString(dataset.publication_pmid, "handoff.dataset.publication_pmid"),
    source_publication_url: dataset.source_publication_url == null
      ? dataset.source_publication_url as null | undefined
      : requireHttpUrl(dataset.source_publication_url, "handoff.dataset.source_publication_url"),
    public_locator_urls: requireArray(dataset.public_locator_urls, "handoff.dataset.public_locator_urls")
      .map((item, index) => requireHttpUrl(item, `handoff.dataset.public_locator_urls[${index}]`)),
    included_status: requireString(dataset.included_status, "handoff.dataset.included_status"),
  };
};

export const parseCaosHandoff = (input: string | unknown): CaosHandoff => {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error("CAOS handoff must contain valid JSON.");
    }
  }

  const handoff = requireObject(value, "handoff");
  if (handoff.schema !== CAOS_HANDOFF_SCHEMA) {
    throw new Error(`Unsupported CAOS handoff schema: ${String(handoff.schema || "missing")}.`);
  }
  if (handoff.schema_version !== CAOS_HANDOFF_SCHEMA_VERSION) {
    throw new Error(`Unsupported CAOS handoff schema version: ${String(handoff.schema_version)}.`);
  }
  const generatedAt = requireString(handoff.generated_at, "handoff.generated_at");
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("handoff.generated_at must be a valid timestamp.");

  const atlas = requireObject(handoff.atlas, "handoff.atlas");
  const projectSeed = requireObject(handoff.project_seed, "handoff.project_seed");
  const requirements = requireObject(handoff.requirements, "handoff.requirements");
  const integrity = requireObject(handoff.integrity, "handoff.integrity");
  const dataset = parseDataset(handoff.dataset);
  const assetCandidates = requireArray(handoff.asset_candidates, "handoff.asset_candidates").map((item, index) => {
    const candidate = requireObject(item, `handoff.asset_candidates[${index}]`);
    return {
      source: requireEnum(candidate.source, ["public_locator"], `handoff.asset_candidates[${index}].source`),
      locator_url: requireHttpUrl(candidate.locator_url, `handoff.asset_candidates[${index}].locator_url`),
      repository: requireOptionalString(candidate.repository, `handoff.asset_candidates[${index}].repository`),
      accession: requireOptionalString(candidate.accession, `handoff.asset_candidates[${index}].accession`),
      availability: requireEnum(candidate.availability, ["indexed", "unknown"], `handoff.asset_candidates[${index}].availability`),
    };
  });
  const fingerprint = requireString(integrity.dataset_fingerprint, "handoff.integrity.dataset_fingerprint");
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("handoff.integrity.dataset_fingerprint must be a lowercase SHA-256 digest.");
  }

  return {
    schema: CAOS_HANDOFF_SCHEMA,
    schema_version: CAOS_HANDOFF_SCHEMA_VERSION,
    generated_at: generatedAt,
    intent: requireEnum(handoff.intent, ["inspect_dataset"], "handoff.intent"),
    atlas: {
      dataset_path: requireString(atlas.dataset_path, "handoff.atlas.dataset_path"),
      api_path: requireString(atlas.api_path, "handoff.atlas.api_path"),
    },
    dataset,
    asset_candidates: assetCandidates,
    project_seed: {
      name: requireString(projectSeed.name, "handoff.project_seed.name"),
      note: requireString(projectSeed.note, "handoff.project_seed.note"),
      intended_operations: requireArray(projectSeed.intended_operations, "handoff.project_seed.intended_operations")
        .map((item, index) => requireEnum(item, ["inspect", "compare", "measure", "annotate", "convert", "review"], `handoff.project_seed.intended_operations[${index}]`)),
    },
    requirements: {
      local_data_required: requireBoolean(requirements.local_data_required, "handoff.requirements.local_data_required"),
      raw_data_included: requireBoolean(requirements.raw_data_included, "handoff.requirements.raw_data_included"),
      automatic_download_allowed: requireBoolean(requirements.automatic_download_allowed, "handoff.requirements.automatic_download_allowed"),
      minimum_workbench_schema_version: requireNumber(requirements.minimum_workbench_schema_version, "handoff.requirements.minimum_workbench_schema_version"),
    },
    integrity: {
      algorithm: requireEnum(integrity.algorithm, ["sha256"], "handoff.integrity.algorithm"),
      dataset_fingerprint: fingerprint,
      generated_by: requireEnum(integrity.generated_by, ["cell-anatomy-api"], "handoff.integrity.generated_by"),
    },
  };
};

const fingerprintPayload = (handoff: CaosHandoff): string => [
  handoff.dataset.dataset_id,
  handoff.dataset.title,
  handoff.dataset.paper_title,
  String(handoff.dataset.year),
  handoff.dataset.source_study_id || "",
  handoff.dataset.publication_pmid || "",
  handoff.dataset.source_publication_url || "",
  handoff.dataset.public_data_status,
  ...handoff.asset_candidates.map((candidate) => candidate.locator_url).sort(),
].join("\n");

export const verifyCaosHandoffIntegrity = async (handoff: CaosHandoff): Promise<boolean> => {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 verification is unavailable in this runtime.");
  const bytes = new TextEncoder().encode(fingerprintPayload(handoff));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return hex === handoff.integrity.dataset_fingerprint;
};

const normalizeIdentity = (value: string | null | undefined): string =>
  (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

export const resolveCaosHandoffDataset = <Dataset extends CaosHandoffLoadedDataset>(
  handoff: CaosHandoff,
  datasets: Dataset[],
): CaosHandoffResolution<Dataset> => {
  const datasetId = normalizeIdentity(handoff.dataset.dataset_id);
  const studyId = normalizeIdentity(handoff.dataset.source_study_id);
  const accessions = new Set(
    handoff.asset_candidates
      .map((candidate) => normalizeIdentity(candidate.accession))
      .filter(Boolean),
  );

  const scored: Array<{
    dataset: Dataset;
    score: number;
    matchedBy: "dataset-id" | "study-id" | "repository-accession";
  }> = [];
  for (const dataset of datasets) {
    const slug = normalizeIdentity(dataset.slug);
    const entryId = normalizeIdentity(dataset.entryId);
    if (slug && slug === datasetId) {
      scored.push({ dataset, score: 100, matchedBy: "dataset-id" });
      continue;
    }
    if (studyId && (slug === studyId || entryId === studyId)) {
      scored.push({ dataset, score: 90, matchedBy: "study-id" });
      continue;
    }
    if (entryId && accessions.has(entryId)) {
      scored.push({ dataset, score: 80, matchedBy: "repository-accession" });
    }
  }

  if (scored.length === 0) {
    return {
      status: "pending",
      summary: "Atlas context imported. No loaded derivative matches this dataset yet.",
    };
  }
  const topScore = Math.max(...scored.map((match) => match.score));
  const top = scored.filter((match) => match.score === topScore);
  if (top.length !== 1) {
    return {
      status: "ambiguous",
      summary: "More than one loaded dataset matches this Atlas handoff. Resolve the local data identity before opening it.",
    };
  }
  if (top[0].dataset.derivatives.length === 0) {
    return {
      status: "pending",
      summary: "The matching dataset is indexed, but it has no loadable derivative yet.",
    };
  }
  return { status: "ready", dataset: top[0].dataset, matchedBy: top[0].matchedBy };
};
