ALTER TABLE replay_v2_streams
  ADD COLUMN IF NOT EXISTS protocol_version TEXT NOT NULL DEFAULT 'v2',
  ADD COLUMN IF NOT EXISTS transport_kind TEXT NOT NULL DEFAULT 'ws+msgpack',
  ADD COLUMN IF NOT EXISTS harbor_root TEXT,
  ADD COLUMN IF NOT EXISTS fin_seq INT,
  ADD COLUMN IF NOT EXISTS ack_seq INT,
  ADD COLUMN IF NOT EXISTS ack_received BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fin_ack_meta_json JSONB,
  ADD COLUMN IF NOT EXISTS seek_stride INT NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS actionable_command_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aligned_command_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS target_resolved_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS orphan_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS target_registry_version INT NOT NULL DEFAULT 0;

ALTER TABLE replay_v2_chunks
  ADD COLUMN IF NOT EXISTS harbor_segment_path TEXT,
  ADD COLUMN IF NOT EXISTS harbor_segment_index INT,
  ADD COLUMN IF NOT EXISTS harbor_byte_offset BIGINT,
  ADD COLUMN IF NOT EXISTS harbor_byte_length INT,
  ADD COLUMN IF NOT EXISTS frame_codec TEXT NOT NULL DEFAULT 'msgpack',
  ADD COLUMN IF NOT EXISTS acked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ack_meta_json JSONB;

ALTER TABLE replay_v2_events
  ADD COLUMN IF NOT EXISTS command_id TEXT,
  ADD COLUMN IF NOT EXISTS target_ref JSONB,
  ADD COLUMN IF NOT EXISTS payload_json JSONB,
  ADD COLUMN IF NOT EXISTS lifecycle_event TEXT,
  ADD COLUMN IF NOT EXISTS selector_version INT,
  ADD COLUMN IF NOT EXISTS dom_signature_hash TEXT,
  ADD COLUMN IF NOT EXISTS asset_refs JSONB;

CREATE TABLE IF NOT EXISTS replay_v2_target_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  stream_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  selector_version INT NOT NULL,
  state TEXT NOT NULL,
  event_seq INT NOT NULL,
  lifecycle_event TEXT NOT NULL,
  selector_bundle JSONB,
  metadata_json JSONB,
  dom_signature_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, stream_id) REFERENCES replay_v2_streams(run_id, stream_id) ON DELETE CASCADE,
  UNIQUE (run_id, stream_id, target_id, event_seq)
);

CREATE INDEX IF NOT EXISTS idx_replay_v2_target_registry_stream_seq
  ON replay_v2_target_registry(run_id, stream_id, event_seq);

CREATE INDEX IF NOT EXISTS idx_replay_v2_target_registry_target
  ON replay_v2_target_registry(run_id, stream_id, target_id, event_seq DESC);

CREATE TABLE IF NOT EXISTS replay_v2_seek_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  stream_id TEXT NOT NULL,
  checkpoint_seq INT NOT NULL,
  event_seq INT NOT NULL,
  monotonic_ms INT NOT NULL,
  target_registry_state_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, stream_id) REFERENCES replay_v2_streams(run_id, stream_id) ON DELETE CASCADE,
  UNIQUE (run_id, stream_id, checkpoint_seq)
);

CREATE INDEX IF NOT EXISTS idx_replay_v2_seek_index_stream_seq
  ON replay_v2_seek_index(run_id, stream_id, checkpoint_seq);

CREATE TABLE IF NOT EXISTS replay_v2_assets_cas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  source_url TEXT,
  cas_ref TEXT NOT NULL,
  mime_type TEXT,
  byte_size BIGINT,
  blocked BOOLEAN NOT NULL DEFAULT false,
  block_reason TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_replay_v2_assets_cas_run
  ON replay_v2_assets_cas(run_id, created_at DESC);
