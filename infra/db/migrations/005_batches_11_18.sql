ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS pr_id UUID REFERENCES pull_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parallel_group_id UUID REFERENCES parallel_groups(id) ON DELETE SET NULL;

ALTER TABLE spec_runs
  ADD COLUMN IF NOT EXISTS machine_id UUID REFERENCES machines(id) ON DELETE SET NULL;

ALTER TABLE test_results
  ADD COLUMN IF NOT EXISTS retried_from_result_id UUID REFERENCES test_results(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS flake_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_case_id UUID NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  score NUMERIC(6,3) NOT NULL,
  confidence NUMERIC(6,3) NOT NULL,
  window_days INT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (test_case_id, window_days)
);

CREATE TABLE IF NOT EXISTS failure_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cluster_key TEXT NOT NULL,
  signature TEXT NOT NULL,
  sample_error TEXT,
  count_24h INT NOT NULL DEFAULT 0,
  count_7d INT NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, cluster_key)
);

CREATE TABLE IF NOT EXISTS quarantine_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_case_id UUID NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  reason TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, test_case_id)
);

CREATE TABLE IF NOT EXISTS artifact_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('upload', 'download')),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  meta_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_role
  ON workspace_members(workspace_id, role, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_flake_scores_computed
  ON flake_scores(window_days, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_failure_clusters_project
  ON failure_clusters(project_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_artifact_access_tokens_lookup
  ON artifact_access_tokens(artifact_id, action, expires_at DESC);
