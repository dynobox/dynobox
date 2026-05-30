CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX api_tokens_subject_idx ON api_tokens (provider, subject_id);
CREATE INDEX api_tokens_token_hash_idx ON api_tokens (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cli_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  git_hash TEXT,
  target TEXT,
  status TEXT NOT NULL,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),
  expires_at TEXT,
  summary_json TEXT NOT NULL
);

CREATE INDEX runs_subject_created_at_idx ON runs (provider, subject_id, created_at DESC);
CREATE INDEX runs_public_idx ON runs (id) WHERE public = 1;

CREATE TABLE run_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL,
  scenario_name TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT,
  iteration INTEGER NOT NULL,
  status TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  assertion_count INTEGER NOT NULL DEFAULT 0,
  passed_assertion_count INTEGER NOT NULL DEFAULT 0,
  failed_assertion_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
);

CREATE INDEX run_jobs_run_id_idx ON run_jobs (run_id);

CREATE TABLE run_assertions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES run_jobs (id) ON DELETE CASCADE,
  assertion_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  message TEXT,
  FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES run_jobs (id) ON DELETE CASCADE
);

CREATE INDEX run_assertions_run_id_idx ON run_assertions (run_id);
CREATE INDEX run_assertions_job_id_idx ON run_assertions (job_id);
