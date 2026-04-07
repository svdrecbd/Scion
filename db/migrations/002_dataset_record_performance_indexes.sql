CREATE INDEX IF NOT EXISTS idx_dataset_records_organelles_gin
    ON dataset_records
    USING GIN (organelles);

CREATE INDEX IF NOT EXISTS idx_dataset_records_organelle_pairs_gin
    ON dataset_records
    USING GIN (organelle_pairs);

CREATE INDEX IF NOT EXISTS idx_dataset_records_metric_families_gin
    ON dataset_records
    USING GIN (metric_families);
