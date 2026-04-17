ALTER TABLE dataset_records
    ADD COLUMN IF NOT EXISTS publication_pmid TEXT;

CREATE INDEX IF NOT EXISTS idx_dataset_records_publication_pmid
    ON dataset_records(publication_pmid);
