CREATE TABLE IF NOT EXISTS service_heartbeats (
  service_name TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_heartbeats_last_seen
  ON service_heartbeats(last_seen_at DESC);
