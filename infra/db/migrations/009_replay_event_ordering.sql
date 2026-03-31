ALTER TABLE replay_events
  ADD COLUMN IF NOT EXISTS event_seq BIGINT,
  ADD COLUMN IF NOT EXISTS event_id TEXT,
  ADD COLUMN IF NOT EXISTS step_id TEXT,
  ADD COLUMN IF NOT EXISTS phase TEXT,
  ADD COLUMN IF NOT EXISTS capture_status TEXT;

CREATE INDEX IF NOT EXISTS idx_replay_events_run_order
  ON replay_events(run_id, (coalesce(event_seq, 9223372036854775807::BIGINT)), id);

CREATE INDEX IF NOT EXISTS idx_replay_events_run_step_order
  ON replay_events(run_id, step_id, (coalesce(event_seq, 9223372036854775807::BIGINT)), id);

CREATE INDEX IF NOT EXISTS idx_replay_events_run_event_id
  ON replay_events(run_id, event_id);
