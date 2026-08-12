export const PRIVATE_REGISTRY_SCHEMA = "cell-anatomy-private-archive-registry";
export const PRIVATE_REGISTRY_ASSET_SCHEMA = "cell-anatomy-private-archive-asset";
export const PRIVATE_WORKSET_SCHEMA = "cell-anatomy-archive-workset";
export const PRIVATE_WORKSET_ASSET_SCHEMA = "cell-anatomy-archive-workset-asset";
export const PRIVATE_REGISTRY_SCHEMA_VERSION = 1;

export type PrivateRegistryAllowedOperations = {
  can_store_locally: boolean;
  can_backup_to_cloud: boolean;
  can_convert: boolean;
  can_view_in_caos: boolean;
  can_share_with_collaborators: boolean;
  can_publish_derivatives: boolean;
  can_release_publicly: boolean;
};

export type PrivateRegistrySummary = {
  schema: typeof PRIVATE_REGISTRY_SCHEMA;
  schema_version: typeof PRIVATE_REGISTRY_SCHEMA_VERSION;
  registry_builder: string;
  registry_id: string;
  created_at: string;
  source_scan: {
    scan_dir: string;
    archive_id: string;
    root: string;
    scanner: string;
    started_at?: string;
    finished_at?: string;
    file_count?: number;
    bytes_total?: number;
  };
  asset_count: number;
  file_asset_count: number;
  logical_asset_count: number;
  bytes_total: number;
  volume_candidate_count: number;
  review_queue_count: number;
  metadata_gap_count: number;
  checksum_record_count: number;
  duplicate_asset_count: number;
  project_ready_count: number;
  output_dir: string;
};

export type PrivateRegistryAsset = {
  schema: typeof PRIVATE_REGISTRY_ASSET_SCHEMA;
  schema_version: typeof PRIVATE_REGISTRY_SCHEMA_VERSION;
  registry_id: string;
  asset_id: string;
  archive_id: string;
  workset_id?: string;
  relative_path: string;
  name: string;
  path_type: string;
  extension: string;
  likely_role: string;
  size_bytes: number;
  modified_at: string;
  source: {
    root: string;
    relative_path: string;
    link_target?: string;
  };
  checksum: {
    algorithm: string;
    digest: string;
    duplicate_of: string;
    computed_at: string;
    reused_from_previous_run: boolean;
  };
  metadata: {
    status: string;
    format: string;
    dimensions: Record<string, number | string>;
    shape?: unknown;
    chunks?: unknown;
    dtype: string;
    voxel_size_nm: Record<string, number | string> | null;
    metadata_source: string;
    source_metadata_path: string;
    warning?: string;
  };
  status: {
    asset_status: string;
    fixity_status: string;
    publication_status: string;
    triage_status: string;
    rights_status: string;
    classification_status: string;
    blocked_states: string[];
    review_required: boolean;
    review_notes: string[];
    allowed_operations: PrivateRegistryAllowedOperations;
  };
  volume_candidate: {
    is_candidate: boolean;
    source_metadata_path: string;
    candidate_status: string;
  };
  review: {
    gap_count: number;
    gap_codes: string[];
    gap_severities: string[];
    recommended_actions: string[];
  };
  readiness: {
    metadata_ready: boolean;
    has_checksum: boolean;
    is_volume_candidate: boolean;
    conversion_ready: boolean;
    project_ready: boolean;
    blockers: string[];
  };
};

export type PrivateRegistrySearchEntry = {
  schema: string;
  schema_version: number;
  asset_id: string;
  archive_id: string;
  relative_path: string;
  title: string;
  search_text: string;
  format: string;
  likely_role: string;
  project_ready: boolean;
  volume_candidate: boolean;
};

export type PrivateArchiveRegistryIndex = {
  summary: PrivateRegistrySummary;
  assets: PrivateRegistryAsset[];
  searchEntries: PrivateRegistrySearchEntry[];
  reviewAssets: PrivateRegistryAsset[];
  volumeCandidates: PrivateRegistryAsset[];
  projectReadyAssets: PrivateRegistryAsset[];
  conversionQueueAssets: PrivateRegistryAsset[];
};

export type PrivateWorksetSummary = {
  schema: typeof PRIVATE_WORKSET_SCHEMA;
  schema_version: typeof PRIVATE_REGISTRY_SCHEMA_VERSION;
  workset_builder: string;
  generated_at: string;
  workset_id: string;
  title: string;
  source_registry: {
    registry_dir: string;
    registry_id: string;
    archive_id: string;
    archive_root: string;
    asset_count?: number;
  };
  selection: {
    asset_ids: string[];
    path_prefixes: string[];
    queries: string[];
    all_assets: boolean;
    volume_candidates_only: boolean;
    limit?: number | null;
  };
  promotion_rule: {
    selected_asset_count: number;
    selected_assets_artifact: string;
    selected_assets_preview: Array<Record<string, string>>;
    intended_operations: string[];
    destination_workset_dir: string;
    notes: string[];
  };
  summary: {
    selected_asset_count: number;
    selected_bytes_total: number;
    checksum_record_count: number;
    metadata_ready_count: number;
    conversion_ready_count: number;
    project_ready_count: number;
    dataset_mode_ready_count: number;
    rights_status_counts: Record<string, number>;
    triage_status_counts: Record<string, number>;
    publication_status_counts: Record<string, number>;
    format_counts: Record<string, number>;
    blocker_counts: Record<string, number>;
    blocked_operation_counts: Record<string, number>;
  };
  findings: Array<{ severity: string; code: string; summary: string }>;
  output_dir: string;
};

export type PrivateWorksetIndex = {
  workset: PrivateWorksetSummary;
  registry: PrivateArchiveRegistryIndex;
};

export type PrivateRegistryLoadedDerivative = {
  source_relative_path: string;
  source_local_path?: string;
  source_sha256?: string;
  source_size_bytes?: number;
  output_path?: string;
  archiveStatus?: {
    registryId?: string;
    assetId?: string;
    archiveId?: string;
    relativePath?: string;
    worksetId?: string;
  };
};

export type PrivateRegistryLoadedDataset<
  Derivative extends PrivateRegistryLoadedDerivative = PrivateRegistryLoadedDerivative,
> = {
  slug: string;
  derivatives: Derivative[];
};

export type PrivateRegistryProjectAssetResolution<
  Dataset extends PrivateRegistryLoadedDataset = PrivateRegistryLoadedDataset,
> =
  | {
      status: "ready";
      dataset: Dataset;
      derivative: Dataset["derivatives"][number];
      matchedBy: "archive-identity" | "checksum" | "local-path" | "relative-path";
    }
  | {
      status: "blocked" | "not-loaded" | "ambiguous";
      summary: string;
    };

export type PrivateRegistryProjectSeed = {
  name: string;
  note: string;
  archiveStatus: {
    registryId: string;
    assetId: string;
    archiveId: string;
    relativePath: string;
    assetStatus: string;
    fixityStatus: string;
    publicationStatus: string;
    triageStatus: string;
    rightsStatus: string;
    classificationStatus: string;
    reviewRequired: boolean;
    blockers: string[];
    metadataGapCodes: string[];
    allowedOperations: Record<string, boolean>;
    worksetId?: string;
    worksetTitle?: string;
  };
};

export type PrivateRegistryBundleInput = {
  summaryContents: string;
  assetsContents: string;
  searchContents?: string | null;
};

export type PrivateWorksetBundleInput = {
  worksetContents: string;
  assetsContents: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requireObject = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${path} must be a JSON object.`);
  }
  return value;
};

const requireString = (value: unknown, path: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  return value;
};

const requireNonEmptyString = (value: unknown, path: string): string => {
  const text = requireString(value, path);
  if (!text.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return text;
};

const requireNumber = (value: unknown, path: string, min = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new Error(`${path} must be a finite number greater than or equal to ${min}.`);
  }
  return value;
};

const requireBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
};

const requireStringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((item, index) => requireString(item, `${path}[${index}]`));
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const stringValue = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const booleanValue = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

const stringArrayValue = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const numberValue = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const parseJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
};

const parseJsonl = (text: string, label: string): unknown[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseJson(line, `${label}:${index + 1}`));

const validateAllowedOperations = (value: unknown, path: string): PrivateRegistryAllowedOperations => {
  const operations = requireObject(value, path);
  return {
    can_store_locally: requireBoolean(operations.can_store_locally, `${path}.can_store_locally`),
    can_backup_to_cloud: requireBoolean(operations.can_backup_to_cloud, `${path}.can_backup_to_cloud`),
    can_convert: requireBoolean(operations.can_convert, `${path}.can_convert`),
    can_view_in_caos: requireBoolean(operations.can_view_in_caos, `${path}.can_view_in_caos`),
    can_share_with_collaborators: requireBoolean(
      operations.can_share_with_collaborators,
      `${path}.can_share_with_collaborators`
    ),
    can_publish_derivatives: requireBoolean(
      operations.can_publish_derivatives,
      `${path}.can_publish_derivatives`
    ),
    can_release_publicly: requireBoolean(operations.can_release_publicly, `${path}.can_release_publicly`),
  };
};

const validateDimensions = (value: unknown, path: string): Record<string, number | string> => {
  const dimensions = requireObject(value, path);
  for (const [key, item] of Object.entries(dimensions)) {
    if (typeof item !== "number" && typeof item !== "string") {
      throw new Error(`${path}.${key} must be a number or string.`);
    }
  }
  return dimensions as Record<string, number | string>;
};

const validateVoxelSize = (value: unknown, path: string): Record<string, number | string> | null => {
  if (value == null) return null;
  return validateDimensions(value, path);
};

const optionalRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const validateNumberRecord = (value: unknown, path: string): Record<string, number> => {
  const record = requireObject(value, path);
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    result[key] = requireNumber(item, `${path}.${key}`);
  }
  return result;
};

export const validatePrivateRegistrySummary = (value: unknown): PrivateRegistrySummary => {
  const summary = requireObject(value, "private-registry.json");
  if (summary.schema !== PRIVATE_REGISTRY_SCHEMA) {
    throw new Error(`Unsupported private registry schema: ${String(summary.schema || "missing")}.`);
  }
  if (summary.schema_version !== PRIVATE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported private registry schema version: ${String(summary.schema_version)}.`);
  }

  const sourceScan = requireObject(summary.source_scan, "source_scan");
  return {
    schema: PRIVATE_REGISTRY_SCHEMA,
    schema_version: PRIVATE_REGISTRY_SCHEMA_VERSION,
    registry_builder: requireNonEmptyString(summary.registry_builder, "registry_builder"),
    registry_id: requireNonEmptyString(summary.registry_id, "registry_id"),
    created_at: requireNonEmptyString(summary.created_at, "created_at"),
    source_scan: {
      scan_dir: requireString(sourceScan.scan_dir, "source_scan.scan_dir"),
      archive_id: requireNonEmptyString(sourceScan.archive_id, "source_scan.archive_id"),
      root: requireString(sourceScan.root, "source_scan.root"),
      scanner: requireString(sourceScan.scanner, "source_scan.scanner"),
      started_at: optionalString(sourceScan.started_at),
      finished_at: optionalString(sourceScan.finished_at),
      file_count: typeof sourceScan.file_count === "number" ? sourceScan.file_count : undefined,
      bytes_total: typeof sourceScan.bytes_total === "number" ? sourceScan.bytes_total : undefined,
    },
    asset_count: requireNumber(summary.asset_count, "asset_count"),
    file_asset_count: requireNumber(summary.file_asset_count, "file_asset_count"),
    logical_asset_count: requireNumber(summary.logical_asset_count, "logical_asset_count"),
    bytes_total: requireNumber(summary.bytes_total, "bytes_total"),
    volume_candidate_count: requireNumber(summary.volume_candidate_count, "volume_candidate_count"),
    review_queue_count: requireNumber(summary.review_queue_count, "review_queue_count"),
    metadata_gap_count: requireNumber(summary.metadata_gap_count, "metadata_gap_count"),
    checksum_record_count: requireNumber(summary.checksum_record_count, "checksum_record_count"),
    duplicate_asset_count: requireNumber(summary.duplicate_asset_count, "duplicate_asset_count"),
    project_ready_count: requireNumber(summary.project_ready_count, "project_ready_count"),
    output_dir: requireString(summary.output_dir, "output_dir"),
  };
};

export const validatePrivateRegistryAsset = (value: unknown, path = "asset"): PrivateRegistryAsset => {
  const asset = requireObject(value, path);
  if (asset.schema !== PRIVATE_REGISTRY_ASSET_SCHEMA) {
    throw new Error(`${path}.schema must be ${PRIVATE_REGISTRY_ASSET_SCHEMA}.`);
  }
  if (asset.schema_version !== PRIVATE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`${path}.schema_version must be ${PRIVATE_REGISTRY_SCHEMA_VERSION}.`);
  }

  const source = requireObject(asset.source, `${path}.source`);
  const checksum = requireObject(asset.checksum, `${path}.checksum`);
  const metadata = requireObject(asset.metadata, `${path}.metadata`);
  const status = requireObject(asset.status, `${path}.status`);
  const volumeCandidate = requireObject(asset.volume_candidate, `${path}.volume_candidate`);
  const review = requireObject(asset.review, `${path}.review`);
  const readiness = requireObject(asset.readiness, `${path}.readiness`);

  return {
    schema: PRIVATE_REGISTRY_ASSET_SCHEMA,
    schema_version: PRIVATE_REGISTRY_SCHEMA_VERSION,
    registry_id: requireNonEmptyString(asset.registry_id, `${path}.registry_id`),
    asset_id: requireNonEmptyString(asset.asset_id, `${path}.asset_id`),
    archive_id: requireNonEmptyString(asset.archive_id, `${path}.archive_id`),
    workset_id: optionalString(asset.workset_id),
    relative_path: requireNonEmptyString(asset.relative_path, `${path}.relative_path`),
    name: requireString(asset.name, `${path}.name`),
    path_type: requireNonEmptyString(asset.path_type, `${path}.path_type`),
    extension: requireString(asset.extension, `${path}.extension`),
    likely_role: requireNonEmptyString(asset.likely_role, `${path}.likely_role`),
    size_bytes: requireNumber(asset.size_bytes, `${path}.size_bytes`),
    modified_at: requireString(asset.modified_at, `${path}.modified_at`),
    source: {
      root: requireString(source.root, `${path}.source.root`),
      relative_path: requireNonEmptyString(source.relative_path, `${path}.source.relative_path`),
      link_target: optionalString(source.link_target),
    },
    checksum: {
      algorithm: requireString(checksum.algorithm, `${path}.checksum.algorithm`),
      digest: requireString(checksum.digest, `${path}.checksum.digest`),
      duplicate_of: requireString(checksum.duplicate_of, `${path}.checksum.duplicate_of`),
      computed_at: requireString(checksum.computed_at, `${path}.checksum.computed_at`),
      reused_from_previous_run: requireBoolean(
        checksum.reused_from_previous_run,
        `${path}.checksum.reused_from_previous_run`
      ),
    },
    metadata: {
      status: requireNonEmptyString(metadata.status, `${path}.metadata.status`),
      format: requireString(metadata.format, `${path}.metadata.format`),
      dimensions: validateDimensions(metadata.dimensions, `${path}.metadata.dimensions`),
      shape: metadata.shape,
      chunks: metadata.chunks,
      dtype: requireString(metadata.dtype, `${path}.metadata.dtype`),
      voxel_size_nm: validateVoxelSize(metadata.voxel_size_nm, `${path}.metadata.voxel_size_nm`),
      metadata_source: requireString(metadata.metadata_source, `${path}.metadata.metadata_source`),
      source_metadata_path: requireString(metadata.source_metadata_path, `${path}.metadata.source_metadata_path`),
      warning: optionalString(metadata.warning),
    },
    status: {
      asset_status: requireNonEmptyString(status.asset_status, `${path}.status.asset_status`),
      fixity_status: requireNonEmptyString(status.fixity_status, `${path}.status.fixity_status`),
      publication_status: requireNonEmptyString(status.publication_status, `${path}.status.publication_status`),
      triage_status: requireNonEmptyString(status.triage_status, `${path}.status.triage_status`),
      rights_status: requireNonEmptyString(status.rights_status, `${path}.status.rights_status`),
      classification_status: requireNonEmptyString(status.classification_status, `${path}.status.classification_status`),
      blocked_states: requireStringArray(status.blocked_states, `${path}.status.blocked_states`),
      review_required: requireBoolean(status.review_required, `${path}.status.review_required`),
      review_notes: requireStringArray(status.review_notes, `${path}.status.review_notes`),
      allowed_operations: validateAllowedOperations(status.allowed_operations, `${path}.status.allowed_operations`),
    },
    volume_candidate: {
      is_candidate: requireBoolean(volumeCandidate.is_candidate, `${path}.volume_candidate.is_candidate`),
      source_metadata_path: requireString(
        volumeCandidate.source_metadata_path,
        `${path}.volume_candidate.source_metadata_path`
      ),
      candidate_status: requireString(volumeCandidate.candidate_status, `${path}.volume_candidate.candidate_status`),
    },
    review: {
      gap_count: requireNumber(review.gap_count, `${path}.review.gap_count`),
      gap_codes: requireStringArray(review.gap_codes, `${path}.review.gap_codes`),
      gap_severities: requireStringArray(review.gap_severities, `${path}.review.gap_severities`),
      recommended_actions: requireStringArray(review.recommended_actions, `${path}.review.recommended_actions`),
    },
    readiness: {
      metadata_ready: requireBoolean(readiness.metadata_ready, `${path}.readiness.metadata_ready`),
      has_checksum: requireBoolean(readiness.has_checksum, `${path}.readiness.has_checksum`),
      is_volume_candidate: requireBoolean(readiness.is_volume_candidate, `${path}.readiness.is_volume_candidate`),
      conversion_ready: requireBoolean(readiness.conversion_ready, `${path}.readiness.conversion_ready`),
      project_ready: requireBoolean(readiness.project_ready, `${path}.readiness.project_ready`),
      blockers: requireStringArray(readiness.blockers, `${path}.readiness.blockers`),
    },
  };
};

export const validatePrivateRegistrySearchEntry = (
  value: unknown,
  path = "search-entry"
): PrivateRegistrySearchEntry => {
  const entry = requireObject(value, path);
  return {
    schema: requireNonEmptyString(entry.schema, `${path}.schema`),
    schema_version: requireNumber(entry.schema_version, `${path}.schema_version`),
    asset_id: requireNonEmptyString(entry.asset_id, `${path}.asset_id`),
    archive_id: requireNonEmptyString(entry.archive_id, `${path}.archive_id`),
    relative_path: requireNonEmptyString(entry.relative_path, `${path}.relative_path`),
    title: requireString(entry.title, `${path}.title`),
    search_text: requireString(entry.search_text, `${path}.search_text`),
    format: requireString(entry.format, `${path}.format`),
    likely_role: requireNonEmptyString(entry.likely_role, `${path}.likely_role`),
    project_ready: requireBoolean(entry.project_ready, `${path}.project_ready`),
    volume_candidate: requireBoolean(entry.volume_candidate, `${path}.volume_candidate`),
  };
};

export const parsePrivateRegistrySummary = (text: string): PrivateRegistrySummary =>
  validatePrivateRegistrySummary(parseJson(text, "private-registry.json"));

export const parsePrivateRegistryAssetsJsonl = (text: string): PrivateRegistryAsset[] =>
  parseJsonl(text, "private-registry-assets.jsonl").map((value, index) =>
    validatePrivateRegistryAsset(value, `assets[${index}]`)
  );

export const parsePrivateRegistrySearchJsonl = (text: string): PrivateRegistrySearchEntry[] =>
  parseJsonl(text, "private-registry-search-index.jsonl").map((value, index) =>
    validatePrivateRegistrySearchEntry(value, `search[${index}]`)
  );

export const validatePrivateWorksetSummary = (value: unknown): PrivateWorksetSummary => {
  const workset = requireObject(value, "workset.json");
  if (workset.schema !== PRIVATE_WORKSET_SCHEMA) {
    throw new Error(`Unsupported workset schema: ${String(workset.schema || "missing")}.`);
  }
  if (workset.schema_version !== PRIVATE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported workset schema version: ${String(workset.schema_version)}.`);
  }
  const sourceRegistry = requireObject(workset.source_registry, "source_registry");
  const selection = requireObject(workset.selection, "selection");
  const promotionRule = requireObject(workset.promotion_rule, "promotion_rule");
  const summary = requireObject(workset.summary, "summary");
  return {
    schema: PRIVATE_WORKSET_SCHEMA,
    schema_version: PRIVATE_REGISTRY_SCHEMA_VERSION,
    workset_builder: requireNonEmptyString(workset.workset_builder, "workset_builder"),
    generated_at: requireNonEmptyString(workset.generated_at, "generated_at"),
    workset_id: requireNonEmptyString(workset.workset_id, "workset_id"),
    title: requireString(workset.title, "title"),
    source_registry: {
      registry_dir: requireString(sourceRegistry.registry_dir, "source_registry.registry_dir"),
      registry_id: requireString(sourceRegistry.registry_id, "source_registry.registry_id"),
      archive_id: requireString(sourceRegistry.archive_id, "source_registry.archive_id"),
      archive_root: requireString(sourceRegistry.archive_root, "source_registry.archive_root"),
      asset_count: typeof sourceRegistry.asset_count === "number" ? sourceRegistry.asset_count : undefined,
    },
    selection: {
      asset_ids: requireStringArray(selection.asset_ids, "selection.asset_ids"),
      path_prefixes: requireStringArray(selection.path_prefixes, "selection.path_prefixes"),
      queries: requireStringArray(selection.queries, "selection.queries"),
      all_assets: requireBoolean(selection.all_assets, "selection.all_assets"),
      volume_candidates_only: requireBoolean(selection.volume_candidates_only, "selection.volume_candidates_only"),
      limit: typeof selection.limit === "number" || selection.limit === null ? selection.limit : undefined,
    },
    promotion_rule: {
      selected_asset_count: requireNumber(promotionRule.selected_asset_count, "promotion_rule.selected_asset_count"),
      selected_assets_artifact: requireString(
        promotionRule.selected_assets_artifact,
        "promotion_rule.selected_assets_artifact"
      ),
      selected_assets_preview: Array.isArray(promotionRule.selected_assets_preview)
        ? promotionRule.selected_assets_preview.filter(isRecord).map((item) => item as Record<string, string>)
        : [],
      intended_operations: requireStringArray(promotionRule.intended_operations, "promotion_rule.intended_operations"),
      destination_workset_dir: requireString(
        promotionRule.destination_workset_dir,
        "promotion_rule.destination_workset_dir"
      ),
      notes: requireStringArray(promotionRule.notes, "promotion_rule.notes"),
    },
    summary: {
      selected_asset_count: requireNumber(summary.selected_asset_count, "summary.selected_asset_count"),
      selected_bytes_total: requireNumber(summary.selected_bytes_total, "summary.selected_bytes_total"),
      checksum_record_count: requireNumber(summary.checksum_record_count, "summary.checksum_record_count"),
      metadata_ready_count: requireNumber(summary.metadata_ready_count, "summary.metadata_ready_count"),
      conversion_ready_count: requireNumber(summary.conversion_ready_count, "summary.conversion_ready_count"),
      project_ready_count: requireNumber(summary.project_ready_count, "summary.project_ready_count"),
      dataset_mode_ready_count: requireNumber(
        summary.dataset_mode_ready_count,
        "summary.dataset_mode_ready_count"
      ),
      rights_status_counts: validateNumberRecord(summary.rights_status_counts, "summary.rights_status_counts"),
      triage_status_counts: validateNumberRecord(summary.triage_status_counts, "summary.triage_status_counts"),
      publication_status_counts: validateNumberRecord(
        summary.publication_status_counts,
        "summary.publication_status_counts"
      ),
      format_counts: validateNumberRecord(summary.format_counts, "summary.format_counts"),
      blocker_counts: validateNumberRecord(summary.blocker_counts, "summary.blocker_counts"),
      blocked_operation_counts: validateNumberRecord(
        summary.blocked_operation_counts,
        "summary.blocked_operation_counts"
      ),
    },
    findings: Array.isArray(workset.findings)
      ? workset.findings.filter(isRecord).map((finding) => ({
          severity: stringValue(finding.severity),
          code: stringValue(finding.code),
          summary: stringValue(finding.summary),
        }))
      : [],
    output_dir: requireString(workset.output_dir, "output_dir"),
  };
};

const extensionForPath = (relativePath: string) => {
  const name = relativePath.toLowerCase().split("/").pop() || relativePath.toLowerCase();
  if (name.endsWith(".ome.tif")) return ".ome.tif";
  if (name.endsWith(".ome.tiff")) return ".ome.tiff";
  if (name.endsWith(".nii.gz")) return ".nii.gz";
  if (name.endsWith(".xml.gz")) return ".xml.gz";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
};

const normalizeWorksetAsset = (value: unknown, workset: PrivateWorksetSummary, index: number): PrivateRegistryAsset => {
  const asset = requireObject(value, `workset-assets[${index}]`);
  if (asset.schema !== PRIVATE_WORKSET_ASSET_SCHEMA) {
    throw new Error(`workset-assets[${index}].schema must be ${PRIVATE_WORKSET_ASSET_SCHEMA}.`);
  }
  if (asset.schema_version !== PRIVATE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`workset-assets[${index}].schema_version must be ${PRIVATE_REGISTRY_SCHEMA_VERSION}.`);
  }
  const relativePath = requireNonEmptyString(asset.relative_path, `workset-assets[${index}].relative_path`);
  const source = optionalRecord(asset.source);
  const checksum = optionalRecord(asset.checksum);
  const metadata = optionalRecord(asset.metadata);
  const status = optionalRecord(asset.status);
  const readiness = optionalRecord(asset.readiness);
  const review = optionalRecord(asset.review);
  const operations = optionalRecord(status.allowed_operations);
  const dimensions = optionalRecord(metadata.dimensions);
  const blockerList = stringArrayValue(readiness.blockers);
  const gapCodes = stringArrayValue(review.gap_codes);
  const blockedOperations = stringArrayValue(optionalRecord(asset.promotion).blocked_operations);
  const isCandidate = booleanValue(readiness.is_volume_candidate);
  const reviewRequired =
    blockerList.length > 0 ||
    gapCodes.length > 0 ||
    blockedOperations.length > 0 ||
    stringValue(status.rights_status, "unknown") === "unknown";

  return validatePrivateRegistryAsset(
    {
      schema: PRIVATE_REGISTRY_ASSET_SCHEMA,
      schema_version: PRIVATE_REGISTRY_SCHEMA_VERSION,
      registry_id: stringValue(asset.registry_id, workset.source_registry.registry_id || workset.workset_id),
      asset_id: requireNonEmptyString(asset.asset_id, `workset-assets[${index}].asset_id`),
      archive_id: stringValue(asset.archive_id, workset.source_registry.archive_id || "archive"),
      workset_id: workset.workset_id,
      relative_path: relativePath,
      name: relativePath.split("/").pop() || relativePath,
      path_type: requireNonEmptyString(asset.path_type, `workset-assets[${index}].path_type`),
      extension: extensionForPath(relativePath),
      likely_role: stringValue(asset.likely_role, "unknown") || "unknown",
      size_bytes: numberValue(asset.size_bytes),
      modified_at: stringValue(asset.promoted_at, workset.generated_at),
      source: {
        root: stringValue(source.root, workset.source_registry.archive_root),
        relative_path: stringValue(source.relative_path, relativePath),
        link_target: stringValue(source.link_target),
      },
      checksum: {
        algorithm: stringValue(checksum.algorithm),
        digest: stringValue(checksum.digest),
        duplicate_of: stringValue(checksum.duplicate_of),
        computed_at: stringValue(checksum.computed_at),
        reused_from_previous_run: false,
      },
      metadata: {
        status: stringValue(metadata.status, "not_extracted") || "not_extracted",
        format: stringValue(metadata.format),
        dimensions,
        dtype: stringValue(metadata.dtype),
        voxel_size_nm: metadata.voxel_size_nm ?? null,
        metadata_source: stringValue(metadata.metadata_source),
        source_metadata_path: stringValue(metadata.source_metadata_path),
        warning: blockedOperations.length ? `Blocked operations: ${blockedOperations.join(", ")}` : undefined,
      },
      status: {
        asset_status: stringValue(status.asset_status, "promoted") || "promoted",
        fixity_status: stringValue(status.fixity_status, "unknown") || "unknown",
        publication_status: stringValue(status.publication_status, "unknown") || "unknown",
        triage_status: stringValue(status.triage_status, "unknown") || "unknown",
        rights_status: stringValue(status.rights_status, "unknown") || "unknown",
        classification_status: stringValue(status.classification_status, "unreviewed") || "unreviewed",
        blocked_states: stringArrayValue(status.blocked_states),
        review_required: reviewRequired,
        review_notes: [
          ...stringArrayValue(status.review_notes),
          ...blockedOperations.map((operation) => `blocked_operation:${operation}`),
        ],
        allowed_operations: {
          can_store_locally: booleanValue(operations.can_store_locally),
          can_backup_to_cloud: booleanValue(operations.can_backup_to_cloud),
          can_convert: booleanValue(operations.can_convert),
          can_view_in_caos: booleanValue(operations.can_view_in_caos),
          can_share_with_collaborators: booleanValue(operations.can_share_with_collaborators),
          can_publish_derivatives: booleanValue(operations.can_publish_derivatives),
          can_release_publicly: booleanValue(operations.can_release_publicly),
        },
      },
      volume_candidate: {
        is_candidate: isCandidate,
        source_metadata_path: stringValue(metadata.source_metadata_path, relativePath),
        candidate_status: isCandidate ? "promoted_workset_candidate" : "",
      },
      review: {
        gap_count: numberValue(review.gap_count, gapCodes.length),
        gap_codes: gapCodes,
        gap_severities: stringArrayValue(review.gap_severities),
        recommended_actions: stringArrayValue(review.recommended_actions),
      },
      readiness: {
        metadata_ready: booleanValue(readiness.metadata_ready),
        has_checksum: booleanValue(readiness.has_checksum),
        is_volume_candidate: isCandidate,
        conversion_ready: booleanValue(readiness.conversion_ready),
        project_ready: booleanValue(readiness.project_ready),
        blockers: [...new Set([...blockerList, ...blockedOperations.map((operation) => `blocked_operation:${operation}`)])],
      },
    },
    `workset-assets[${index}]`
  );
};

export const parsePrivateWorksetBundle = ({
  worksetContents,
  assetsContents,
}: PrivateWorksetBundleInput): PrivateWorksetIndex => {
  const workset = validatePrivateWorksetSummary(parseJson(worksetContents, "workset.json"));
  const assets = parseJsonl(assetsContents, "workset-assets.jsonl").map((value, index) =>
    normalizeWorksetAsset(value, workset, index)
  );
  const registryId = assets[0]?.registry_id || workset.source_registry.registry_id || workset.workset_id;
  const metadataGapCount = assets.reduce((sum, asset) => sum + asset.review.gap_codes.length, 0);
  const reviewQueueCount = assets.filter(
    (asset) =>
      asset.status.review_required ||
      asset.review.gap_codes.length > 0 ||
      asset.readiness.blockers.length > 0 ||
      asset.checksum.duplicate_of
  ).length;
  const summary: PrivateRegistrySummary = {
    schema: PRIVATE_REGISTRY_SCHEMA,
    schema_version: PRIVATE_REGISTRY_SCHEMA_VERSION,
    registry_builder: workset.workset_builder,
    registry_id: registryId,
    created_at: workset.generated_at,
    source_scan: {
      scan_dir: workset.source_registry.registry_dir,
      archive_id: workset.source_registry.archive_id || "archive",
      root: workset.source_registry.archive_root,
      scanner: "workset-promotion",
    },
    asset_count: assets.length,
    file_asset_count: assets.filter((asset) => asset.path_type !== "directory_volume").length,
    logical_asset_count: assets.filter((asset) => asset.path_type === "directory_volume").length,
    bytes_total: workset.summary.selected_bytes_total,
    volume_candidate_count: assets.filter((asset) => asset.readiness.is_volume_candidate).length,
    review_queue_count: reviewQueueCount,
    metadata_gap_count: metadataGapCount,
    checksum_record_count: assets.filter((asset) => asset.checksum.digest).length,
    duplicate_asset_count: assets.filter((asset) => asset.checksum.duplicate_of).length,
    project_ready_count: assets.filter((asset) => asset.readiness.project_ready).length,
    output_dir: workset.output_dir,
  };
  const searchEntries: PrivateRegistrySearchEntry[] = assets.map((asset) => ({
    schema: "cell-anatomy-private-archive-search-entry",
    schema_version: PRIVATE_REGISTRY_SCHEMA_VERSION,
    asset_id: asset.asset_id,
    archive_id: asset.archive_id,
    relative_path: asset.relative_path,
    title: asset.name || asset.relative_path,
    search_text: [
      workset.workset_id,
      workset.title,
      asset.archive_id,
      asset.relative_path,
      asset.likely_role,
      asset.metadata.format,
      asset.metadata.dtype,
      asset.status.publication_status,
      asset.status.triage_status,
      asset.status.rights_status,
      ...asset.readiness.blockers,
      ...asset.review.gap_codes,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
    format: asset.metadata.format,
    likely_role: asset.likely_role,
    project_ready: asset.readiness.project_ready,
    volume_candidate: asset.readiness.is_volume_candidate,
  }));
  return {
    workset,
    registry: parsePrivateArchiveRegistryBundle({
      summaryContents: JSON.stringify(summary),
      assetsContents: assets.map((asset) => JSON.stringify(asset)).join("\n"),
      searchContents: searchEntries.map((entry) => JSON.stringify(entry)).join("\n"),
    }),
  };
};

export const parsePrivateArchiveRegistryBundle = ({
  summaryContents,
  assetsContents,
  searchContents,
}: PrivateRegistryBundleInput): PrivateArchiveRegistryIndex => {
  const summary = parsePrivateRegistrySummary(summaryContents);
  const assets = parsePrivateRegistryAssetsJsonl(assetsContents);
  if (assets.some((asset) => asset.registry_id !== summary.registry_id)) {
    throw new Error("Private registry assets do not all match the selected registry id.");
  }

  const searchEntries = searchContents?.trim()
    ? parsePrivateRegistrySearchJsonl(searchContents)
    : assets.map((asset) => ({
        schema: "cell-anatomy-private-archive-search-entry",
        schema_version: PRIVATE_REGISTRY_SCHEMA_VERSION,
        asset_id: asset.asset_id,
        archive_id: asset.archive_id,
        relative_path: asset.relative_path,
        title: asset.name || asset.relative_path,
        search_text: [
          asset.archive_id,
          asset.relative_path,
          asset.likely_role,
          asset.metadata.format,
          asset.metadata.dtype,
          asset.status.publication_status,
          asset.status.triage_status,
          asset.status.rights_status,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
        format: asset.metadata.format,
        likely_role: asset.likely_role,
        project_ready: asset.readiness.project_ready,
        volume_candidate: asset.readiness.is_volume_candidate,
      }));

  const assetIds = new Set(assets.map((asset) => asset.asset_id));
  const danglingSearch = searchEntries.find((entry) => !assetIds.has(entry.asset_id));
  if (danglingSearch) {
    throw new Error(`Private registry search entry references a missing asset: ${danglingSearch.asset_id}.`);
  }

  const projectReadyAssets = assets
    .filter((asset) => asset.readiness.project_ready)
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const conversionQueueAssets = assets
    .filter(
      (asset) =>
        !asset.readiness.project_ready &&
        asset.status.allowed_operations.can_convert &&
        asset.readiness.metadata_ready &&
        asset.readiness.has_checksum
    )
    .sort((left, right) => {
      const leftReviewPressure = left.status.review_required || left.review.gap_codes.length > 0 ? 1 : 0;
      const rightReviewPressure = right.status.review_required || right.review.gap_codes.length > 0 ? 1 : 0;
      return leftReviewPressure - rightReviewPressure || left.relative_path.localeCompare(right.relative_path);
    });

  return {
    summary,
    assets,
    searchEntries,
    reviewAssets: assets.filter(
      (asset) =>
        asset.status.review_required ||
        asset.review.gap_codes.length > 0 ||
        asset.readiness.blockers.length > 0 ||
        asset.checksum.duplicate_of
    ),
    volumeCandidates: assets.filter((asset) => asset.readiness.is_volume_candidate),
    projectReadyAssets,
    conversionQueueAssets,
  };
};

export const privateRegistryAssetStatusLabel = (asset: PrivateRegistryAsset) => {
  if (asset.readiness.project_ready) return "Project Ready";
  if (
    asset.status.allowed_operations.can_convert &&
    asset.readiness.metadata_ready &&
    asset.readiness.has_checksum
  ) {
    return asset.review.gap_codes.length > 0 || asset.status.review_required ? "Review Before Convert" : "Ready To Convert";
  }
  if (asset.readiness.conversion_ready) return "Conversion Ready";
  if (asset.readiness.is_volume_candidate) return "Needs Review";
  return asset.status.asset_status || "Discovered";
};

export const normalizePrivateRegistryLocalPath = (value: string | null | undefined) =>
  (value || "")
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

const privateRegistryAssetLocalPath = (asset: PrivateRegistryAsset) => {
  const root = normalizePrivateRegistryLocalPath(asset.source.root);
  const relative = normalizePrivateRegistryLocalPath(asset.relative_path).replace(/^\//, "");
  return root ? `${root}/${relative}` : relative;
};

const privateRegistryMatchScore = (
  asset: PrivateRegistryAsset,
  derivative: PrivateRegistryLoadedDerivative
) => {
  const archiveStatus = derivative.archiveStatus;
  if (
    archiveStatus?.assetId === asset.asset_id &&
    (!archiveStatus.registryId || archiveStatus.registryId === asset.registry_id)
  ) {
    return { score: 400, matchedBy: "archive-identity" as const };
  }

  const checksum = asset.checksum.digest.trim().toLowerCase();
  const derivativeChecksum = (derivative.source_sha256 || "").trim().toLowerCase();
  if (
    checksum.length === 64 &&
    derivativeChecksum === checksum &&
    (!asset.size_bytes || !derivative.source_size_bytes || asset.size_bytes === derivative.source_size_bytes)
  ) {
    return { score: 300, matchedBy: "checksum" as const };
  }

  const assetLocalPath = privateRegistryAssetLocalPath(asset);
  const sourceLocalPath = normalizePrivateRegistryLocalPath(derivative.source_local_path);
  const outputPath = normalizePrivateRegistryLocalPath(derivative.output_path);
  if (assetLocalPath && (sourceLocalPath === assetLocalPath || outputPath === assetLocalPath)) {
    return { score: 200, matchedBy: "local-path" as const };
  }

  const relativePath = normalizePrivateRegistryLocalPath(asset.relative_path).replace(/^\//, "");
  const derivativeRelativePath = normalizePrivateRegistryLocalPath(
    derivative.source_relative_path
  ).replace(/^\//, "");
  if (
    relativePath &&
    (derivativeRelativePath === relativePath ||
      sourceLocalPath.endsWith(`/${relativePath}`) ||
      outputPath.endsWith(`/${relativePath}`))
  ) {
    return { score: 100, matchedBy: "relative-path" as const };
  }

  return null;
};

export const resolvePrivateRegistryProjectAsset = <Dataset extends PrivateRegistryLoadedDataset>(
  asset: PrivateRegistryAsset,
  datasets: Dataset[]
): PrivateRegistryProjectAssetResolution<Dataset> => {
  if (!asset.readiness.project_ready || !asset.status.allowed_operations.can_view_in_caos) {
    return {
      status: "blocked",
      summary: "This archive asset is not cleared and ready for a CAOS project.",
    };
  }

  const candidates: Array<{
    dataset: Dataset;
    derivative: Dataset["derivatives"][number];
    score: number;
    matchedBy: "archive-identity" | "checksum" | "local-path" | "relative-path";
  }> = [];

  for (const dataset of datasets) {
    for (const derivative of dataset.derivatives) {
      const match = privateRegistryMatchScore(asset, derivative);
      if (match) candidates.push({ dataset, derivative, ...match });
    }
  }

  if (candidates.length === 0) {
    return {
      status: "not-loaded",
      summary: "The project-ready archive asset is not present in the current Workbench data list.",
    };
  }

  const topScore = Math.max(...candidates.map((candidate) => candidate.score));
  const best = candidates.filter((candidate) => candidate.score === topScore);
  if (best.length !== 1) {
    return {
      status: "ambiguous",
      summary: "More than one loaded Workbench volume matches this archive asset; resolve the duplicate before creating a project.",
    };
  }

  return {
    status: "ready",
    dataset: best[0].dataset,
    derivative: best[0].derivative,
    matchedBy: best[0].matchedBy,
  };
};

const privateRegistryProjectAssetStem = (asset: PrivateRegistryAsset) => {
  const basename = (asset.name || asset.relative_path.split(/[\\/]/).pop() || "archive-volume").trim();
  return basename.replace(/\.ome\.zarr$/i, "").replace(/\.[^.]+$/, "") || "archive-volume";
};

export const buildPrivateRegistryProjectSeed = (
  asset: PrivateRegistryAsset,
  workset?: PrivateWorksetSummary | null
): PrivateRegistryProjectSeed => {
  const assetStem = privateRegistryProjectAssetStem(asset);
  const worksetTitle = workset?.title.trim();
  const name = worksetTitle ? `${worksetTitle} — ${assetStem}` : `${assetStem} project`;
  const sourceLabel = workset
    ? `promoted workset ${workset.workset_id}`
    : `private registry ${asset.registry_id}`;

  return {
    name,
    note: `Created from ${sourceLabel}; archive asset ${asset.asset_id} (${asset.relative_path}).`,
    archiveStatus: {
      registryId: asset.registry_id,
      assetId: asset.asset_id,
      archiveId: asset.archive_id,
      relativePath: asset.relative_path,
      assetStatus: asset.status.asset_status,
      fixityStatus: asset.status.fixity_status,
      publicationStatus: asset.status.publication_status,
      triageStatus: asset.status.triage_status,
      rightsStatus: asset.status.rights_status,
      classificationStatus: asset.status.classification_status,
      reviewRequired: asset.status.review_required,
      blockers: [...asset.readiness.blockers],
      metadataGapCodes: [...asset.review.gap_codes],
      allowedOperations: { ...asset.status.allowed_operations },
      ...(workset
        ? {
            worksetId: workset.workset_id,
            worksetTitle: workset.title,
          }
        : {}),
    },
  };
};
