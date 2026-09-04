CREATE TABLE IF NOT EXISTS beta_signups (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  affiliation TEXT,
  source_path TEXT,
  consent_text_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_beta_signups_created_at
  ON beta_signups (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_beta_signups_email
  ON beta_signups (email);
