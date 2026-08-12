import type { PackagedDataset } from "./workbench-client";

export const CAOS_PROJECT_SCHEMA = "cell-anatomy-caos-project";
export const CAOS_PROJECT_SCHEMA_VERSION = 1;

export type CaosViewMode = "orthogonal" | "2d" | "3d";
export type CaosAxis = "z" | "y" | "x";
export type CaosRoiKind = "point" | "box";
export type CaosJobKind = "project-audit" | "roi-inventory" | "histogram";

export type CaosViewState = {
  mode: CaosViewMode;
  axis: CaosAxis;
  slice: number;
  xSlice: number;
  ySlice: number;
  zSlice: number;
  minContrast: number;
  maxContrast: number;
  colormap: number;
  logScale: boolean;
  downsample: number;
  pitch: number;
  yaw: number;
  alphaScale: number;
};

export type CaosVolumeReference = {
  datasetSlug: string;
  datasetTitle: string;
  source: string;
  entryId: string;
  experimentType: string;
  assetPath: string;
  sourcePath?: string;
  outputPath?: string;
  sourceSha256: string;
  sourceSizeBytes: number;
  format: string;
  dtype: string;
  shapeZyx: number[];
  chunksZyx: number[];
  physicalVoxelSizeNm: Record<string, string | number>;
  validationStatus?: string;
  byteSize?: number;
  archiveStatus?: CaosArchiveStatus;
};

export type CaosArchiveStatus = {
  registryId?: string;
  assetId?: string;
  archiveId?: string;
  relativePath?: string;
  worksetId?: string;
  worksetTitle?: string;
  assetStatus?: string;
  fixityStatus?: string;
  publicationStatus?: string;
  triageStatus?: string;
  rightsStatus?: string;
  classificationStatus?: string;
  reviewRequired?: boolean;
  blockers?: string[];
  metadataGapCodes?: string[];
  allowedOperations?: Record<string, boolean>;
};

export type CaosProjectNote = {
  id: string;
  scope: "project" | "view" | "volume";
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type CaosVoxelPoint = {
  x: number;
  y: number;
  z: number;
};

export type CaosProjectMeasurement = {
  id: string;
  label: string;
  note?: string;
  datasetSlug: string;
  assetPath: string;
  axis: CaosAxis;
  slice: number;
  start: CaosVoxelPoint;
  end: CaosVoxelPoint;
  distanceUm: number;
  createdAt: string;
};

export type CaosProjectRoi = {
  id: string;
  label: string;
  kind: CaosRoiKind;
  category: string;
  datasetSlug: string;
  assetPath: string;
  axis: CaosAxis;
  slice: number;
  start: CaosVoxelPoint;
  end?: CaosVoxelPoint;
  color?: string;
  createdAt: string;
  note: string;
};

export type CaosProjectJob = {
  id: string;
  datasetSlug: string;
  assetPath: string;
  title: string;
  kind: CaosJobKind;
  status: "completed";
  createdAt: string;
  summary: string;
  result: Record<string, unknown>;
};

export type CaosProjectSnapshot = {
  schema: typeof CAOS_PROJECT_SCHEMA;
  schemaVersion: typeof CAOS_PROJECT_SCHEMA_VERSION;
  project: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  };
  active: {
    datasetSlug: string;
    assetPath: string;
    view: CaosViewState;
  };
  volumes: CaosVolumeReference[];
  notes: CaosProjectNote[];
  measurements: CaosProjectMeasurement[];
  rois: CaosProjectRoi[];
  jobs: CaosProjectJob[];
  exports: unknown[];
  integrity: {
    activeVolumeFingerprint: string;
    volumeFingerprints: string[];
    volumeCount: number;
    generatedBy: "cell-anatomy-workbench";
    generatedAt: string;
  };
};

export type CaosProjectBuildInput = {
  projectName: string;
  projectNote?: string;
  dataset: PackagedDataset;
  derivative: PackagedDataset["derivatives"][number];
  view: CaosViewState;
  notes?: CaosProjectNote[];
  measurements?: CaosProjectMeasurement[];
  rois?: CaosProjectRoi[];
  jobs?: CaosProjectJob[];
  exports?: unknown[];
  existingProjectId?: string;
  createdAt?: string;
};

type ValidatedVolume = CaosVolumeReference & {
  fingerprint: string;
};

const VIEW_MODES = ["orthogonal", "2d", "3d"] as const;
const AXES = ["z", "y", "x"] as const;
const NOTE_SCOPES = ["project", "view", "volume"] as const;
const ROI_KINDS = ["point", "box"] as const;
const JOB_KINDS = ["project-audit", "roi-inventory", "histogram"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const requireObject = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${path} must be a JSON object.`);
  }
  return value;
};

const requireArray = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
};

const requireNonEmptyString = (value: unknown, path: string): string => {
  if (!nonEmpty(value)) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
};

const requireString = (value: unknown, path: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  return value;
};

const requireOptionalString = (value: unknown, path: string): string | undefined => {
  if (value === undefined) return undefined;
  return requireString(value, path);
};

const requireFiniteNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  return value;
};

const requireInteger = (value: unknown, path: string, min = Number.NEGATIVE_INFINITY): number => {
  const number = requireFiniteNumber(value, path);
  if (!Number.isInteger(number) || number < min) {
    throw new Error(`${path} must be an integer greater than or equal to ${min}.`);
  }
  return number;
};

const requireBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
};

const requireEnum = <T extends string>(value: unknown, allowed: readonly T[], path: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
};

const requireTimestamp = (value: unknown, path: string): string => {
  const timestamp = requireNonEmptyString(value, path);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${path} must be a valid timestamp.`);
  }
  return timestamp;
};

const requireDimensionTriplet = (value: unknown, path: string): number[] => {
  const triplet = requireArray(value, path);
  if (triplet.length !== 3) {
    throw new Error(`${path} must contain exactly three Z/Y/X dimensions.`);
  }
  return triplet.map((item, index) => requireInteger(item, `${path}[${index}]`, 1));
};

const requirePhysicalVoxelScale = (value: unknown, path: string): Record<string, string | number> => {
  const scale = requireObject(value, path);
  for (const axis of AXES) {
    const item = scale[axis];
    if (typeof item === "number") {
      if (!Number.isFinite(item) || item <= 0) {
        throw new Error(`${path}.${axis} must be a positive finite number.`);
      }
    } else if (typeof item === "string") {
      const parsed = Number(item);
      if (!item.trim() || !Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${path}.${axis} must be a positive numeric string.`);
      }
    } else {
      throw new Error(`${path}.${axis} must be present as a positive number or numeric string.`);
    }
  }

  for (const [key, item] of Object.entries(scale)) {
    if (typeof item !== "string" && typeof item !== "number") {
      throw new Error(`${path}.${key} must be a string or number.`);
    }
  }

  return scale as Record<string, string | number>;
};

const isJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 24) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isRecord(value)) {
    return Object.values(value).every((item) => item !== undefined && isJsonValue(item, depth + 1));
  }
  return false;
};

const requireJsonRecord = (value: unknown, path: string): Record<string, unknown> => {
  const record = requireObject(value, path);
  if (!isJsonValue(record)) {
    throw new Error(`${path} must contain JSON-serializable values.`);
  }
  return record;
};

const requireStringArrayItems = (value: unknown, path: string): string[] => {
  const items = requireArray(value, path);
  return items.map((item, index) => requireString(item, `${path}[${index}]`));
};

const requireBooleanMap = (value: unknown, path: string): Record<string, boolean> => {
  const record = requireObject(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (typeof item !== "boolean") {
        throw new Error(`${path}.${key} must be a boolean.`);
      }
      return [key, item];
    })
  );
};

const requireJsonArray = (value: unknown, path: string): unknown[] => {
  const items = requireArray(value, path);
  items.forEach((item, index) => {
    if (!isJsonValue(item)) {
      throw new Error(`${path}[${index}] must contain JSON-serializable values.`);
    }
  });
  return items;
};

const volumeKey = (datasetSlug: string, assetPath: string) => `${datasetSlug}::${assetPath}`;

type VolumeScopedReference = {
  datasetSlug: string;
  assetPath: string;
};

export const replaceVolumeScopedRecords = <T extends VolumeScopedReference>(
  previous: T[],
  incoming: T[],
  volumes: VolumeScopedReference[],
  maxItems: number
) => {
  const volumeKeys = new Set(volumes.map((volume) => volumeKey(volume.datasetSlug, volume.assetPath)));
  return [
    ...incoming,
    ...previous.filter((item) => !volumeKeys.has(volumeKey(item.datasetSlug, item.assetPath))),
  ].slice(0, maxItems);
};

const shapeLimitForAxis = (shapeZyx: number[], axis: CaosAxis) => {
  if (axis === "z") return shapeZyx[0];
  if (axis === "y") return shapeZyx[1];
  return shapeZyx[2];
};

const requireSliceForAxis = (
  value: unknown,
  path: string,
  axis: CaosAxis,
  shapeZyx: number[]
) => {
  const slice = requireInteger(value, path, 0);
  const limit = shapeLimitForAxis(shapeZyx, axis);
  if (slice >= limit) {
    throw new Error(`${path} is outside the ${axis.toUpperCase()} axis bounds.`);
  }
  return slice;
};

const requireVoxelPoint = (value: unknown, path: string, shapeZyx: number[]): CaosVoxelPoint => {
  const point = requireObject(value, path);
  const x = requireInteger(point.x, `${path}.x`, 0);
  const y = requireInteger(point.y, `${path}.y`, 0);
  const z = requireInteger(point.z, `${path}.z`, 0);
  if (x >= shapeZyx[2]) throw new Error(`${path}.x is outside the volume X bounds.`);
  if (y >= shapeZyx[1]) throw new Error(`${path}.y is outside the volume Y bounds.`);
  if (z >= shapeZyx[0]) throw new Error(`${path}.z is outside the volume Z bounds.`);
  return { x, y, z };
};

const volumeFromReference = (
  volumesByReference: Map<string, ValidatedVolume>,
  datasetSlug: string,
  assetPath: string,
  path: string
) => {
  const volume = volumesByReference.get(volumeKey(datasetSlug, assetPath));
  if (!volume) {
    throw new Error(`${path} references a volume that is not present in the project manifest.`);
  }
  return volume;
};

export const clampIndex = (value: number, max: number) => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.round(value), Math.max(0, max - 1)));
};

export const sanitizeFileSegment = (value: string) =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "caos-project";

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export const volumeReferenceFingerprint = (volume: CaosVolumeReference) =>
  [
    volume.datasetSlug,
    volume.assetPath,
    volume.sourceSha256 || "no-sha256",
    volume.sourceSizeBytes,
    volume.shapeZyx.join("x"),
    volume.chunksZyx.join("x"),
    volume.dtype,
    volume.format,
  ].join("::");

export const volumeFingerprint = (
  dataset: PackagedDataset,
  derivative: PackagedDataset["derivatives"][number]
) =>
  volumeReferenceFingerprint({
    datasetSlug: dataset.slug,
    datasetTitle: dataset.title,
    source: dataset.source,
    entryId: dataset.entryId,
    experimentType: dataset.experimentType,
    assetPath: derivative.source_relative_path,
    sourcePath: derivative.source_local_path,
    outputPath: derivative.output_path,
    sourceSha256: derivative.source_sha256 || "",
    sourceSizeBytes: derivative.source_size_bytes,
    format: derivative.format,
    dtype: derivative.dtype,
    shapeZyx: derivative.shape_zyx,
    chunksZyx: derivative.chunks_zyx,
    physicalVoxelSizeNm: derivative.physical_voxel_size_nm,
    validationStatus: derivative.validation?.status,
    byteSize: derivative.byte_size,
  });

export type CaosProjectActiveVolumeResolution =
  | {
      status: "ready";
      dataset: PackagedDataset;
      derivative: PackagedDataset["derivatives"][number];
      fingerprint: string;
    }
  | {
      status: "missing-volume";
      summary: string;
    }
  | {
      status: "fingerprint-mismatch";
      summary: string;
      expectedFingerprint: string;
      indexedFingerprint: string;
    };

export const resolveCaosProjectActiveVolume = (
  snapshot: CaosProjectSnapshot,
  datasets: PackagedDataset[]
): CaosProjectActiveVolumeResolution => {
  const targetDataset = datasets.find((dataset) => dataset.slug === snapshot.active.datasetSlug);
  const targetDerivative = targetDataset?.derivatives.find(
    (derivative) => derivative.source_relative_path === snapshot.active.assetPath
  );

  if (!targetDataset || !targetDerivative) {
    return {
      status: "missing-volume",
      summary: "The CAOS project is valid, but its active local volume is not available in this Workbench index.",
    };
  }

  const indexedFingerprint = volumeFingerprint(targetDataset, targetDerivative);
  if (indexedFingerprint !== snapshot.integrity.activeVolumeFingerprint) {
    return {
      status: "fingerprint-mismatch",
      summary: "The CAOS project active volume fingerprint does not match the currently indexed local volume.",
      expectedFingerprint: snapshot.integrity.activeVolumeFingerprint,
      indexedFingerprint,
    };
  }

  return {
    status: "ready",
    dataset: targetDataset,
    derivative: targetDerivative,
    fingerprint: indexedFingerprint,
  };
};

const validateArchiveStatus = (value: unknown, path: string): CaosArchiveStatus | undefined => {
  if (value === undefined) return undefined;
  const status = requireObject(value, path);
  const archiveStatus: CaosArchiveStatus = {
    registryId: requireOptionalString(status.registryId, `${path}.registryId`),
    assetId: requireOptionalString(status.assetId, `${path}.assetId`),
    archiveId: requireOptionalString(status.archiveId, `${path}.archiveId`),
    relativePath: requireOptionalString(status.relativePath, `${path}.relativePath`),
    worksetId: requireOptionalString(status.worksetId, `${path}.worksetId`),
    worksetTitle: requireOptionalString(status.worksetTitle, `${path}.worksetTitle`),
    assetStatus: requireOptionalString(status.assetStatus, `${path}.assetStatus`),
    fixityStatus: requireOptionalString(status.fixityStatus, `${path}.fixityStatus`),
    publicationStatus: requireOptionalString(status.publicationStatus, `${path}.publicationStatus`),
    triageStatus: requireOptionalString(status.triageStatus, `${path}.triageStatus`),
    rightsStatus: requireOptionalString(status.rightsStatus, `${path}.rightsStatus`),
    classificationStatus: requireOptionalString(status.classificationStatus, `${path}.classificationStatus`),
    reviewRequired: status.reviewRequired === undefined
      ? undefined
      : requireBoolean(status.reviewRequired, `${path}.reviewRequired`),
    blockers: status.blockers === undefined
      ? undefined
      : requireStringArrayItems(status.blockers, `${path}.blockers`),
    metadataGapCodes: status.metadataGapCodes === undefined
      ? undefined
      : requireStringArrayItems(status.metadataGapCodes, `${path}.metadataGapCodes`),
    allowedOperations: status.allowedOperations === undefined
      ? undefined
      : requireBooleanMap(status.allowedOperations, `${path}.allowedOperations`),
  };

  return Object.fromEntries(
    Object.entries(archiveStatus).filter(([, item]) => item !== undefined)
  ) as CaosArchiveStatus;
};

const validateVolumeReference = (value: unknown, path: string): ValidatedVolume => {
  const volume = requireObject(value, path);
  const datasetSlug = requireNonEmptyString(volume.datasetSlug, `${path}.datasetSlug`);
  const datasetTitle = requireNonEmptyString(volume.datasetTitle, `${path}.datasetTitle`);
  const source = requireNonEmptyString(volume.source, `${path}.source`);
  const entryId = requireNonEmptyString(volume.entryId, `${path}.entryId`);
  const experimentType = requireNonEmptyString(volume.experimentType, `${path}.experimentType`);
  const assetPath = requireNonEmptyString(volume.assetPath, `${path}.assetPath`);
  const sourcePath = requireOptionalString(volume.sourcePath, `${path}.sourcePath`);
  const outputPath = requireOptionalString(volume.outputPath, `${path}.outputPath`);
  const sourceSha256 = requireString(volume.sourceSha256, `${path}.sourceSha256`);
  const sourceSizeBytes = requireInteger(volume.sourceSizeBytes, `${path}.sourceSizeBytes`, 0);
  const format = requireNonEmptyString(volume.format, `${path}.format`);
  const dtype = requireNonEmptyString(volume.dtype, `${path}.dtype`);
  const shapeZyx = requireDimensionTriplet(volume.shapeZyx, `${path}.shapeZyx`);
  const chunksZyx = requireDimensionTriplet(volume.chunksZyx, `${path}.chunksZyx`);
  const physicalVoxelSizeNm = requirePhysicalVoxelScale(
    volume.physicalVoxelSizeNm,
    `${path}.physicalVoxelSizeNm`
  );
  const validationStatus = requireOptionalString(volume.validationStatus, `${path}.validationStatus`);
  const byteSize = volume.byteSize === undefined
    ? undefined
    : requireInteger(volume.byteSize, `${path}.byteSize`, 0);
  const archiveStatus = validateArchiveStatus(volume.archiveStatus, `${path}.archiveStatus`);

  const validated: CaosVolumeReference = {
    datasetSlug,
    datasetTitle,
    source,
    entryId,
    experimentType,
    assetPath,
    sourcePath,
    outputPath,
    sourceSha256,
    sourceSizeBytes,
    format,
    dtype,
    shapeZyx,
    chunksZyx,
    physicalVoxelSizeNm,
    validationStatus,
    byteSize,
    archiveStatus,
  };

  return {
    ...validated,
    fingerprint: volumeReferenceFingerprint(validated),
  };
};

const validateViewState = (value: unknown, path: string, activeShapeZyx: number[]) => {
  const view = requireObject(value, path);
  const mode = requireEnum(view.mode, VIEW_MODES, `${path}.mode`);
  const axis = requireEnum(view.axis, AXES, `${path}.axis`);
  requireSliceForAxis(view.slice, `${path}.slice`, axis, activeShapeZyx);
  const xSlice = requireInteger(view.xSlice, `${path}.xSlice`, 0);
  const ySlice = requireInteger(view.ySlice, `${path}.ySlice`, 0);
  const zSlice = requireInteger(view.zSlice, `${path}.zSlice`, 0);
  if (xSlice >= activeShapeZyx[2]) throw new Error(`${path}.xSlice is outside the volume X bounds.`);
  if (ySlice >= activeShapeZyx[1]) throw new Error(`${path}.ySlice is outside the volume Y bounds.`);
  if (zSlice >= activeShapeZyx[0]) throw new Error(`${path}.zSlice is outside the volume Z bounds.`);

  const minContrast = requireFiniteNumber(view.minContrast, `${path}.minContrast`);
  const maxContrast = requireFiniteNumber(view.maxContrast, `${path}.maxContrast`);
  if (minContrast < 0 || maxContrast < minContrast) {
    throw new Error(`${path}.maxContrast must be greater than or equal to minContrast.`);
  }
  requireInteger(view.colormap, `${path}.colormap`, 0);
  requireBoolean(view.logScale, `${path}.logScale`);
  requireInteger(view.downsample, `${path}.downsample`, 1);
  requireFiniteNumber(view.pitch, `${path}.pitch`);
  requireFiniteNumber(view.yaw, `${path}.yaw`);
  const alphaScale = requireFiniteNumber(view.alphaScale, `${path}.alphaScale`);
  if (alphaScale < 0) {
    throw new Error(`${path}.alphaScale must be greater than or equal to 0.`);
  }

  return { mode, axis };
};

const validateNotes = (items: unknown[]) => {
  items.forEach((item, index) => {
    const path = `notes[${index}]`;
    const note = requireObject(item, path);
    requireNonEmptyString(note.id, `${path}.id`);
    requireEnum(note.scope, NOTE_SCOPES, `${path}.scope`);
    requireString(note.text, `${path}.text`);
    requireTimestamp(note.createdAt, `${path}.createdAt`);
    requireTimestamp(note.updatedAt, `${path}.updatedAt`);
  });
};

const validateMeasurements = (
  items: unknown[],
  volumesByReference: Map<string, ValidatedVolume>
) => {
  items.forEach((item, index) => {
    const path = `measurements[${index}]`;
    const measurement = requireObject(item, path);
    requireNonEmptyString(measurement.id, `${path}.id`);
    requireNonEmptyString(measurement.label, `${path}.label`);
    requireOptionalString(measurement.note, `${path}.note`);
    const datasetSlug = requireNonEmptyString(measurement.datasetSlug, `${path}.datasetSlug`);
    const assetPath = requireNonEmptyString(measurement.assetPath, `${path}.assetPath`);
    const volume = volumeFromReference(volumesByReference, datasetSlug, assetPath, path);
    const axis = requireEnum(measurement.axis, AXES, `${path}.axis`);
    requireSliceForAxis(measurement.slice, `${path}.slice`, axis, volume.shapeZyx);
    requireVoxelPoint(measurement.start, `${path}.start`, volume.shapeZyx);
    requireVoxelPoint(measurement.end, `${path}.end`, volume.shapeZyx);
    const distanceUm = requireFiniteNumber(measurement.distanceUm, `${path}.distanceUm`);
    if (distanceUm < 0) {
      throw new Error(`${path}.distanceUm must be greater than or equal to 0.`);
    }
    requireTimestamp(measurement.createdAt, `${path}.createdAt`);
  });
};

const validateRois = (items: unknown[], volumesByReference: Map<string, ValidatedVolume>) => {
  items.forEach((item, index) => {
    const path = `rois[${index}]`;
    const roi = requireObject(item, path);
    requireNonEmptyString(roi.id, `${path}.id`);
    requireNonEmptyString(roi.label, `${path}.label`);
    const kind = requireEnum(roi.kind, ROI_KINDS, `${path}.kind`);
    requireNonEmptyString(roi.category, `${path}.category`);
    const datasetSlug = requireNonEmptyString(roi.datasetSlug, `${path}.datasetSlug`);
    const assetPath = requireNonEmptyString(roi.assetPath, `${path}.assetPath`);
    const volume = volumeFromReference(volumesByReference, datasetSlug, assetPath, path);
    const axis = requireEnum(roi.axis, AXES, `${path}.axis`);
    requireSliceForAxis(roi.slice, `${path}.slice`, axis, volume.shapeZyx);
    requireVoxelPoint(roi.start, `${path}.start`, volume.shapeZyx);
    if (kind === "box") {
      requireVoxelPoint(roi.end, `${path}.end`, volume.shapeZyx);
    } else if (roi.end !== undefined) {
      requireVoxelPoint(roi.end, `${path}.end`, volume.shapeZyx);
    }
    requireOptionalString(roi.color, `${path}.color`);
    requireTimestamp(roi.createdAt, `${path}.createdAt`);
    requireString(roi.note, `${path}.note`);
  });
};

const validateJobs = (items: unknown[], volumesByReference: Map<string, ValidatedVolume>) => {
  items.forEach((item, index) => {
    const path = `jobs[${index}]`;
    const job = requireObject(item, path);
    requireNonEmptyString(job.id, `${path}.id`);
    const datasetSlug = requireNonEmptyString(job.datasetSlug, `${path}.datasetSlug`);
    const assetPath = requireNonEmptyString(job.assetPath, `${path}.assetPath`);
    volumeFromReference(volumesByReference, datasetSlug, assetPath, path);
    requireNonEmptyString(job.title, `${path}.title`);
    requireEnum(job.kind, JOB_KINDS, `${path}.kind`);
    if (job.status !== "completed") {
      throw new Error(`${path}.status must be completed.`);
    }
    requireTimestamp(job.createdAt, `${path}.createdAt`);
    requireNonEmptyString(job.summary, `${path}.summary`);
    requireJsonRecord(job.result, `${path}.result`);
  });
};

const validateIntegrity = (
  value: unknown,
  volumes: ValidatedVolume[],
  activeVolume: ValidatedVolume
) => {
  const integrity = requireObject(value, "integrity");
  const activeVolumeFingerprint = requireNonEmptyString(
    integrity.activeVolumeFingerprint,
    "integrity.activeVolumeFingerprint"
  );
  if (activeVolumeFingerprint !== activeVolume.fingerprint) {
    throw new Error("integrity.activeVolumeFingerprint does not match the active volume manifest.");
  }

  const volumeCount = requireInteger(integrity.volumeCount, "integrity.volumeCount", 1);
  if (volumeCount !== volumes.length) {
    throw new Error("integrity.volumeCount does not match the project volume manifest.");
  }

  const volumeFingerprints = requireArray(integrity.volumeFingerprints, "integrity.volumeFingerprints");
  if (volumeFingerprints.length !== volumes.length) {
    throw new Error("integrity.volumeFingerprints does not match the project volume count.");
  }

  const expectedFingerprints = new Set(volumes.map((volume) => volume.fingerprint));
  const observedFingerprints = new Set<string>();
  volumeFingerprints.forEach((fingerprint, index) => {
    const value = requireNonEmptyString(fingerprint, `integrity.volumeFingerprints[${index}]`);
    if (!expectedFingerprints.has(value)) {
      throw new Error(`integrity.volumeFingerprints[${index}] is not present in the volume manifest.`);
    }
    observedFingerprints.add(value);
  });
  if (observedFingerprints.size !== expectedFingerprints.size) {
    throw new Error("integrity.volumeFingerprints must exactly match the project volume manifest.");
  }

  if (integrity.generatedBy !== "cell-anatomy-workbench") {
    throw new Error("integrity.generatedBy must be cell-anatomy-workbench.");
  }
  requireTimestamp(integrity.generatedAt, "integrity.generatedAt");
};

export const buildCaosProjectSnapshot = ({
  projectName,
  projectNote,
  dataset,
  derivative,
  view,
  notes: existingNotes = [],
  measurements = [],
  rois = [],
  jobs = [],
  exports = [],
  existingProjectId,
  createdAt,
}: CaosProjectBuildInput): CaosProjectSnapshot => {
  const now = new Date().toISOString();
  const nowId = Date.parse(now);
  const name = projectName.trim() || `${dataset.slug} project`;
  const volume: CaosVolumeReference = {
    datasetSlug: dataset.slug,
    datasetTitle: dataset.title,
    source: dataset.source,
    entryId: dataset.entryId,
    experimentType: dataset.experimentType,
    assetPath: derivative.source_relative_path,
    sourcePath: derivative.source_local_path,
    outputPath: derivative.output_path,
    sourceSha256: derivative.source_sha256 || "",
    sourceSizeBytes: derivative.source_size_bytes,
    format: derivative.format,
    dtype: derivative.dtype,
    shapeZyx: derivative.shape_zyx,
    chunksZyx: derivative.chunks_zyx,
    physicalVoxelSizeNm: derivative.physical_voxel_size_nm,
    validationStatus: derivative.validation?.status,
    byteSize: derivative.byte_size,
    archiveStatus: derivative.archiveStatus,
  };
  const activeVolumeFingerprint = volumeReferenceFingerprint(volume);

  const projectNoteText = projectNote?.trim() || "";
  let projectNoteApplied = false;
  const notes: CaosProjectNote[] = existingNotes.flatMap((note) => {
    if (note.scope !== "project") return [note];
    if (!projectNoteText || projectNoteApplied) return [];
    projectNoteApplied = true;
    return [
      {
        id: note.id,
        scope: "project",
        text: projectNoteText,
        createdAt: note.createdAt,
        updatedAt: note.text === projectNoteText ? note.updatedAt : now,
      },
    ];
  });
  if (projectNoteText && !projectNoteApplied) {
    notes.push({
      id: `note_${nowId}`,
      scope: "project",
      text: projectNoteText,
      createdAt: now,
      updatedAt: now,
    });
  }

  const snapshot: CaosProjectSnapshot = {
    schema: CAOS_PROJECT_SCHEMA,
    schemaVersion: CAOS_PROJECT_SCHEMA_VERSION,
    project: {
      id: existingProjectId || `project_${nowId}`,
      name,
      createdAt: createdAt || now,
      updatedAt: now,
    },
    active: {
      datasetSlug: dataset.slug,
      assetPath: derivative.source_relative_path,
      view,
    },
    volumes: [volume],
    notes,
    measurements,
    rois,
    jobs,
    exports,
    integrity: {
      activeVolumeFingerprint,
      volumeFingerprints: [activeVolumeFingerprint],
      volumeCount: 1,
      generatedBy: "cell-anatomy-workbench",
      generatedAt: now,
    },
  };

  return validateCaosProjectSnapshot(snapshot);
};

export const validateCaosProjectSnapshot = (value: unknown): CaosProjectSnapshot => {
  const snapshot = requireObject(value, "Project file");
  if (snapshot.schema !== CAOS_PROJECT_SCHEMA) {
    throw new Error(`Unsupported project schema: ${String(snapshot.schema || "missing")}.`);
  }
  if (snapshot.schemaVersion !== CAOS_PROJECT_SCHEMA_VERSION) {
    throw new Error(`Unsupported project schema version: ${String(snapshot.schemaVersion)}.`);
  }

  const project = requireObject(snapshot.project, "project");
  requireNonEmptyString(project.id, "project.id");
  requireNonEmptyString(project.name, "project.name");
  requireTimestamp(project.createdAt, "project.createdAt");
  requireTimestamp(project.updatedAt, "project.updatedAt");

  const volumes = requireArray(snapshot.volumes, "volumes").map((item, index) =>
    validateVolumeReference(item, `volumes[${index}]`)
  );
  if (volumes.length === 0) {
    throw new Error("Project file does not contain volume references.");
  }

  const duplicatedVolume = volumes.find(
    (volume, index) =>
      volumes.findIndex((item) => volumeKey(item.datasetSlug, item.assetPath) === volumeKey(volume.datasetSlug, volume.assetPath)) !== index
  );
  if (duplicatedVolume) {
    throw new Error(`Duplicate volume reference: ${duplicatedVolume.datasetSlug} ${duplicatedVolume.assetPath}.`);
  }

  const volumesByReference = new Map(
    volumes.map((volume) => [volumeKey(volume.datasetSlug, volume.assetPath), volume])
  );
  const active = requireObject(snapshot.active, "active");
  const activeDatasetSlug = requireNonEmptyString(active.datasetSlug, "active.datasetSlug");
  const activeAssetPath = requireNonEmptyString(active.assetPath, "active.assetPath");
  const activeVolume = volumeFromReference(
    volumesByReference,
    activeDatasetSlug,
    activeAssetPath,
    "active"
  );
  validateViewState(active.view, "active.view", activeVolume.shapeZyx);

  validateNotes(requireArray(snapshot.notes, "notes"));
  validateMeasurements(requireArray(snapshot.measurements, "measurements"), volumesByReference);
  validateRois(requireArray(snapshot.rois, "rois"), volumesByReference);
  validateJobs(requireArray(snapshot.jobs, "jobs"), volumesByReference);
  requireJsonArray(snapshot.exports, "exports");
  validateIntegrity(snapshot.integrity, volumes, activeVolume);

  return value as CaosProjectSnapshot;
};

export const parseCaosProjectSnapshot = (text: string): CaosProjectSnapshot => {
  try {
    return validateCaosProjectSnapshot(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Project file is not valid JSON.");
    }
    throw error;
  }
};

export const serializeCaosProjectSnapshot = (snapshot: CaosProjectSnapshot) =>
  `${JSON.stringify(validateCaosProjectSnapshot(snapshot), null, 2)}\n`;

export const caosProjectStableSignature = (snapshot: CaosProjectSnapshot) => {
  const validated = validateCaosProjectSnapshot(snapshot);
  return JSON.stringify({
    schema: validated.schema,
    schemaVersion: validated.schemaVersion,
    project: {
      id: validated.project.id,
      name: validated.project.name,
      createdAt: validated.project.createdAt,
    },
    active: validated.active,
    volumes: validated.volumes,
    notes: validated.notes.map((note) => ({
      scope: note.scope,
      text: note.text,
    })),
    measurements: validated.measurements,
    rois: validated.rois,
    jobs: validated.jobs,
    exports: validated.exports,
    integrity: {
      activeVolumeFingerprint: validated.integrity.activeVolumeFingerprint,
      volumeFingerprints: validated.integrity.volumeFingerprints,
      volumeCount: validated.integrity.volumeCount,
      generatedBy: validated.integrity.generatedBy,
    },
  });
};
