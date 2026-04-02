CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dataset_records (
    dataset_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    paper_title TEXT NOT NULL,
    year INTEGER NOT NULL,
    source TEXT NOT NULL,
    source_type TEXT NOT NULL,
    public_data_status TEXT NOT NULL,
    species TEXT NOT NULL,
    cell_type TEXT NOT NULL,
    tissue_or_system TEXT,
    comparator_class TEXT,
    comparator_detail TEXT,
    modality TEXT NOT NULL,
    modality_family TEXT NOT NULL,
    lateral_resolution_nm REAL,
    axial_resolution_nm REAL,
    isotropic BOOLEAN,
    organelles TEXT[] NOT NULL DEFAULT '{}',
    organelle_pairs TEXT[] NOT NULL DEFAULT '{}',
    metric_families TEXT[] NOT NULL DEFAULT '{}',
    sample_size INTEGER,
    sample_size_bucket TEXT NOT NULL DEFAULT 'unknown',
    metadata_completeness_score REAL NOT NULL,
    whole_cell_boundary_confirmed TEXT NOT NULL DEFAULT 'unclear',
    notes TEXT,
    included_status TEXT NOT NULL DEFAULT 'included',
    source_study_id TEXT,
    source_publication_url TEXT,
    public_locator_urls TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dataset_records_included_status
    ON dataset_records(included_status);

CREATE INDEX IF NOT EXISTS idx_dataset_records_year
    ON dataset_records(year DESC);

CREATE INDEX IF NOT EXISTS idx_dataset_records_cell_type
    ON dataset_records(cell_type);

CREATE INDEX IF NOT EXISTS idx_dataset_records_modality
    ON dataset_records(modality);

CREATE INDEX IF NOT EXISTS idx_dataset_records_comparator_class
    ON dataset_records(comparator_class);
