DELETE FROM beta_signups
WHERE rowid NOT IN (
  SELECT MAX(rowid)
  FROM beta_signups
  GROUP BY email
);

DROP INDEX IF EXISTS idx_beta_signups_email;

CREATE UNIQUE INDEX IF NOT EXISTS idx_beta_signups_email
  ON beta_signups (email);
