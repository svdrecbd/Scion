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
  source_study_id?: string | null;
  publication_pmid?: string | null;
  included_status: "included" | "borderline";
  source_publication_url?: string | null;
  public_locator_urls?: string[];
};

export type FacetValue = {
  value: string;
  count: number;
};

export type FacetResponse = {
  cell_types: FacetValue[];
  modalities: FacetValue[];
  organelles: FacetValue[];
  metric_families: FacetValue[];
  comparator_classes: FacetValue[];
};

export type PlanAnalysis = {
  biological_target: string;
  target_res_nm?: number | null;
  target_sample_size?: number | null;
  status: "feasible" | "challenging" | "high-risk" | "frontier";
  status_message: string;
  modality_recommendation: string;
  precedents: DatasetRecord[];
  standard_metrics: string[];
  suggested_baselines: DatasetRecord[];
  matched_records_count: number;
  threshold_records_count: number;
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
