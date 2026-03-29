CREATE TABLE IF NOT EXISTS artifact_blobs (
  artifact_id UUID PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  content BYTEA NOT NULL,
  content_type TEXT,
  byte_size BIGINT,
  checksum TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifact_blobs_created ON artifact_blobs(created_at DESC);

CREATE TABLE IF NOT EXISTS replay_events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  spec_run_id UUID REFERENCES spec_runs(id) ON DELETE SET NULL,
  test_result_id UUID REFERENCES test_results(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  event_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_replay_events_run_id ON replay_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_replay_events_spec_run_id ON replay_events(spec_run_id, id);
CREATE INDEX IF NOT EXISTS idx_replay_events_test_result_id ON replay_events(test_result_id, id);
CREATE INDEX IF NOT EXISTS idx_replay_events_event_type ON replay_events(event_type);
