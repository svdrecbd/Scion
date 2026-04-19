import type { DatasetRecord } from "./types";

type DatasetDisplayFields = Pick<
  DatasetRecord,
  | "dataset_id"
  | "source_study_id"
  | "year"
  | "source"
  | "species"
  | "lateral_resolution_nm"
  | "axial_resolution_nm"
  | "isotropic"
  | "publication_pmid"
  | "source_publication_url"
  | "public_data_status"
  | "public_locator_urls"
>;

export function firstAuthorLabel(datasetId: string) {
  const slug = datasetId.split("-")[0] || datasetId;
  return slug
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function studyCitationLabel(dataset: DatasetDisplayFields) {
  const author = (dataset.source_study_id || "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\bet\s+al\.?/i, "")
    .replace(/[,\s]+$/g, "")
    .trim()
    .split(/\s+/)[0];
  const firstAuthor = author || firstAuthorLabel(dataset.dataset_id);

  return `${firstAuthor} et al., ${dataset.year}, ${dataset.source}`;
}

export function publicationHref(dataset: DatasetDisplayFields) {
  if (dataset.source_publication_url) return dataset.source_publication_url;
  if (dataset.publication_pmid) return `https://pubmed.ncbi.nlm.nih.gov/${dataset.publication_pmid}/`;
  return null;
}

export function publicDataHref(dataset: DatasetDisplayFields) {
  return dataset.public_locator_urls?.[0] ?? null;
}

export function publicDataLabel(dataset: DatasetDisplayFields) {
  if (dataset.public_data_status === "complete") return "Data Publicly Available: Complete";
  if (dataset.public_data_status === "partial") return "Data Publicly Available: Partial";
  return "Data Publicly Available: Not Indexed";
}

export function voxelSizeLabel(dataset: DatasetDisplayFields) {
  if (dataset.lateral_resolution_nm === null || dataset.lateral_resolution_nm === undefined) {
    return "Unknown";
  }

  if (dataset.axial_resolution_nm === null || dataset.axial_resolution_nm === undefined) {
    return `${dataset.lateral_resolution_nm} nm XY voxel`;
  }

  return `${dataset.lateral_resolution_nm} x ${dataset.axial_resolution_nm} nm voxel (XY/Z)${
    dataset.isotropic ? " isotropic" : ""
  }`;
}
