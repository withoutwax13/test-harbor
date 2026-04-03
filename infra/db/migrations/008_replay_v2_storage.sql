CREATE TABLE IF NOT EXISTS replay_v2_streams (
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '2.0',
  started_at TIMESTAMPTZ,
  metadata_json JSONB,
  first_seq INT,
  last_seq INT,
  chunk_count INT NOT NULL DEFAULT 0,
  event_count INT NOT NULL DEFAULT 0,
  final_received BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, stream_id)
);

CREATE TABLE IF NOT EXISTS replay_v2_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  stream_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '2.0',
  seq_start INT NOT NULL,
  seq_end INT NOT NULL,
  event_count INT NOT NULL,
  chunk_index INT,
  final BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ,
  payload_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, stream_id) REFERENCES replay_v2_streams(run_id, stream_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS replay_v2_events (
  run_id UUID NOT NULL,
  stream_id TEXT NOT NULL,
  seq INT NOT NULL,
  kind TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  monotonic_ms INT NOT NULL,
  target_id TEXT,
  selector_bundle JSONB,
  data_json JSONB,
  chunk_id UUID REFERENCES replay_v2_chunks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, stream_id, seq),
  FOREIGN KEY (run_id, stream_id) REFERENCES replay_v2_streams(run_id, stream_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_replay_v2_streams_run
  ON replay_v2_streams(run_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_replay_v2_chunks_run_received
  ON replay_v2_chunks(run_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_replay_v2_chunks_stream_seq
  ON replay_v2_chunks(run_id, stream_id, seq_start, seq_end);

CREATE INDEX IF NOT EXISTS idx_replay_v2_events_run_ts
  ON replay_v2_events(run_id, ts, seq);

CREATE INDEX IF NOT EXISTS idx_replay_v2_events_stream_ts
  ON replay_v2_events(run_id, stream_id, ts, seq);

CREATE INDEX IF NOT EXISTS idx_replay_v2_events_chunk
  ON replay_v2_events(chunk_id);
