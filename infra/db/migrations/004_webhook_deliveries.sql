CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_event_id UUID NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  webhook_endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  target_url TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'queued',
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  response_status INT,
  response_body TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_retry
  ON webhook_deliveries(status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_workspace
  ON webhook_deliveries(workspace_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_webhook_delivery_event_endpoint
  ON webhook_deliveries(notification_event_id, webhook_endpoint_id);
