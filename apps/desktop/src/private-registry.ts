export const PRIVATE_REGISTRY_SCHEMA = "cell-anatomy-private-archive-registry";
export const PRIVATE_REGISTRY_ASSET_SCHEMA = "cell-anatomy-private-archive-asset";
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

export type PrivateRegistryBundleInput = {
  summaryContents: string;
  assetsContents: string;
  searchContents?: string | null;
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
