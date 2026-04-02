export type DatasetRecord = {
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
  included_status: "included" | "borderline";
  source_publication_url?: string | null;
};

export type SearchResponse = {
  total: number;
  results: DatasetRecord[];
  commonalities: Record<string, string[]>;
};

export type CompareResponse = {
  datasets: DatasetRecord[];
  shared_fields: Record<string, string[]>;
  key_differences: Record<string, string[]>;
  comparability_score: number;
  summary: string;
};
