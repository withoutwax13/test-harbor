ALTER TABLE replay_events
  ADD COLUMN IF NOT EXISTS server_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS payload_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS replay_chunk_id UUID;

CREATE TABLE IF NOT EXISTS replay_chunks (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  spec_run_id UUID REFERENCES spec_runs(id) ON DELETE SET NULL,
  test_result_id UUID REFERENCES test_results(id) ON DELETE SET NULL,
  client_chunk_seq BIGINT,
  client_chunk_id TEXT,
  compression TEXT NOT NULL DEFAULT 'none',
  encoded_bytes BIGINT,
  event_count INT NOT NULL DEFAULT 0,
  dropped_events INT NOT NULL DEFAULT 0,
  dropped_events_total BIGINT NOT NULL DEFAULT 0,
  truncated_events INT NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE replay_events
  DROP CONSTRAINT IF EXISTS replay_events_replay_chunk_id_fkey;

ALTER TABLE replay_events
  ADD CONSTRAINT replay_events_replay_chunk_id_fkey
  FOREIGN KEY (replay_chunk_id)
  REFERENCES replay_chunks(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_replay_events_run_seq_received_order
  ON replay_events(run_id, (coalesce(event_seq, 9223372036854775807::BIGINT)), server_received_at, id);

CREATE INDEX IF NOT EXISTS idx_replay_events_chunk_id
  ON replay_events(replay_chunk_id);

CREATE INDEX IF NOT EXISTS idx_replay_chunks_run_received
  ON replay_chunks(run_id, received_at DESC, id DESC);
