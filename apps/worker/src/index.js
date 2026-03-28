import crypto from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL || 'postgres://testharbor:testharbor@localhost:5432/testharbor';
const pool = new pg.Pool({ connectionString: databaseUrl });

const POLL_MS = Number(process.env.WEBHOOK_WORKER_POLL_MS || 1500);
const MAX_BATCH = Number(process.env.WEBHOOK_WORKER_MAX_BATCH || 20);
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 6000);
const MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5);
const BASE_BACKOFF_MS = Number(process.env.WEBHOOK_BASE_BACKOFF_MS || 2000);
const ENABLE_RETENTION_WORKER = process.env.ENABLE_RETENTION_WORKER !== '0';
const RETENTION_WORKER_POLL_MS = Number(process.env.RETENTION_WORKER_POLL_MS || 30000);
const WORKER_HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS || 10000);

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function heartbeat(meta = {}) {
  await query(
    `insert into service_heartbeats(service_name, last_seen_at, meta_json, updated_at)
     values ('worker', now(), $1::jsonb, now())
     on conflict (service_name)
     do update set last_seen_at = excluded.last_seen_at,
                   meta_json = excluded.meta_json,
                   updated_at = excluded.updated_at`,
    [JSON.stringify(meta)]
  );
}

function retryDelayMs(attemptCount) {
  const exp = Math.min(attemptCount, 6);
  return BASE_BACKOFF_MS * (2 ** exp);
}

function signPayload(secret, body, timestamp) {
  const payload = `${timestamp}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${sig}`;
}

async function claimDeliveries(limit = MAX_BATCH) {
  const { rows } = await query(
    `update webhook_deliveries d
     set status = 'delivering', updated_at = now(), last_attempt_at = now(), attempt_count = d.attempt_count + 1
     where d.id in (
       select id
       from webhook_deliveries
       where status in ('queued','retry_scheduled')
         and next_retry_at <= now()
         and attempt_count < max_attempts
       order by next_retry_at asc
       limit $1
       for update skip locked
     )
     returning d.*`,
    [limit]
  );
  return rows;
}

async function markDeliverySuccess(id, responseStatus, responseBody) {
  await query(
    `update webhook_deliveries
     set status='delivered', delivered_at=now(), response_status=$2, response_body=$3, updated_at=now()
     where id=$1`,
    [id, responseStatus, responseBody?.slice(0, 4000) ?? null]
  );
}

async function markDeliveryRetry(id, errText, responseStatus, responseBody) {
  const current = await query('select attempt_count, max_attempts from webhook_deliveries where id = $1', [id]);
  if (!current.rows.length) return;

  const { attempt_count, max_attempts } = current.rows[0];
  if (attempt_count >= max_attempts) {
    await query(
      `update webhook_deliveries
       set status='dead', last_error=$2, response_status=$3, response_body=$4, updated_at=now()
       where id=$1`,
      [id, errText.slice(0, 2000), responseStatus ?? null, responseBody?.slice(0, 4000) ?? null]
    );
    return;
  }

  const delayMs = retryDelayMs(attempt_count);
  await query(
    `update webhook_deliveries
     set status='retry_scheduled',
         next_retry_at = now() + ($2 || ' milliseconds')::interval,
         last_error=$3,
         response_status=$4,
         response_body=$5,
         updated_at=now()
     where id=$1`,
    [id, String(delayMs), errText.slice(0, 2000), responseStatus ?? null, responseBody?.slice(0, 4000) ?? null]
  );
}

async function markDeliveryTerminal(id, status, errText, responseStatus = null, responseBody = null) {
  await query(
    `update webhook_deliveries
     set status = $2,
         last_error = $3,
         response_status = $4,
         response_body = $5,
         updated_at = now()
     where id = $1`,
    [
      id,
      status,
      errText.slice(0, 2000),
      responseStatus ?? null,
      responseBody?.slice(0, 4000) ?? null
    ]
  );
}

async function syncNotificationStatus(notificationEventId) {
  const { rows } = await query(
    `select
      count(*)::int as total,
      count(*) filter (where status='delivered')::int as delivered,
      count(*) filter (where status='dead')::int as dead,
      count(*) filter (where status in ('queued','retry_scheduled','delivering'))::int as pending
     from webhook_deliveries
     where notification_event_id = $1`,
    [notificationEventId]
  );

  if (!rows.length || rows[0].total === 0) return;
  const stats = rows[0];
  const nextStatus = stats.pending > 0 ? 'queued' : (stats.delivered > 0 ? 'sent' : 'failed');

  await query(
    `update notification_events
     set status = $2,
         sent_at = case when $2 = 'sent' then now() else sent_at end
     where id = $1`,
    [notificationEventId, nextStatus]
  );
}

async function deliverOne(delivery) {
  const endpointRow = await query(
    'select secret, enabled from webhook_endpoints where id = $1',
    [delivery.webhook_endpoint_id]
  );
  const endpoint = endpointRow.rows[0];

  if (!endpoint?.enabled) {
    await markDeliveryTerminal(delivery.id, 'dead', 'endpoint_disabled');
    await syncNotificationStatus(delivery.notification_event_id);
    return;
  }

  const secret = endpoint.secret || '';

  const bodyJson = JSON.stringify(delivery.payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = secret ? signPayload(secret, bodyJson, ts) : '';

  const headers = {
    'content-type': 'application/json',
    'x-testharbor-event': delivery.event_type,
    'x-testharbor-delivery-id': delivery.id,
    'x-testharbor-idempotency-key': `${delivery.notification_event_id}:${delivery.webhook_endpoint_id}`,
    'x-testharbor-timestamp': ts
  };
  if (sig) headers['x-testharbor-signature'] = sig;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  let responseStatus = null;
  let responseBody = '';
  try {
    const res = await fetch(delivery.target_url, {
      method: 'POST',
      headers,
      body: bodyJson,
      signal: controller.signal
    });
    responseStatus = res.status;
    responseBody = await res.text();

    if (res.status >= 200 && res.status < 300) {
      await markDeliverySuccess(delivery.id, responseStatus, responseBody);
    } else {
      await markDeliveryRetry(delivery.id, `http_${res.status}`, responseStatus, responseBody);
    }
  } catch (error) {
    await markDeliveryRetry(delivery.id, String(error?.message || error), responseStatus, responseBody);
  } finally {
    clearTimeout(timeout);
    await syncNotificationStatus(delivery.notification_event_id);
  }
}

async function tick() {
  await heartbeat({ lane: 'webhook', batchSize: MAX_BATCH });
  const claimed = await claimDeliveries(MAX_BATCH);
  if (!claimed.length) return;

  for (const delivery of claimed) {
    await deliverOne(delivery);
  }
}

function retentionCutoffIso(retentionDays) {
  return new Date(Date.now() - (Number(retentionDays || 30) * 24 * 60 * 60 * 1000)).toISOString();
}

async function recordRetentionAudit(workspaceId, runRow, cutoff) {
  await query(
    `insert into audit_logs(workspace_id, actor_user_id, action, entity_type, entity_id, meta_json)
     values ($1, null, 'retention.purge', 'run', $2, $3::jsonb)`,
    [
      workspaceId,
      runRow.id,
      JSON.stringify({
        projectId: runRow.project_id,
        artifactCount: Number(runRow.artifact_count || 0),
        cutoff
      })
    ]
  );
}

async function retentionTick() {
  if (!ENABLE_RETENTION_WORKER) return;
  await heartbeat({ lane: 'retention', pollMs: RETENTION_WORKER_POLL_MS });

  const workspaceRows = await query(
    `select id, retention_days
     from workspaces
     where retention_days > 0`
  );

  for (const workspace of workspaceRows.rows) {
    const cutoff = retentionCutoffIso(workspace.retention_days);
    const runRows = await query(
      `select r.id, r.project_id,
              (select count(*)::int from artifacts a where a.run_id = r.id) as artifact_count
       from runs r
       where r.workspace_id = $1
         and r.finished_at is not null
         and coalesce(r.finished_at, r.created_at) < $2::timestamptz`,
      [workspace.id, cutoff]
    );

    if (!runRows.rows.length) continue;

    await query(
      `delete from runs
       where id = any($1::uuid[])`,
      [runRows.rows.map((row) => row.id)]
    );

    for (const runRow of runRows.rows) {
      await recordRetentionAudit(workspace.id, runRow, cutoff);
    }
  }
}

console.log('[worker] webhook worker started');
heartbeat({ lane: 'startup', pollMs: POLL_MS, retentionPollMs: RETENTION_WORKER_POLL_MS }).catch((err) => {
  console.error('[worker] heartbeat error', err);
});
setInterval(() => {
  tick().catch((err) => {
    console.error('[worker] tick error', err);
  });
}, POLL_MS);

console.log('[worker] retention worker', ENABLE_RETENTION_WORKER ? 'enabled' : 'disabled');
setInterval(() => {
  retentionTick().catch((err) => {
    console.error('[worker] retention tick error', err);
  });
}, RETENTION_WORKER_POLL_MS);
setInterval(() => {
  heartbeat({ lane: 'interval', pollMs: POLL_MS, retentionPollMs: RETENTION_WORKER_POLL_MS }).catch((err) => {
    console.error('[worker] heartbeat interval error', err);
  });
}, WORKER_HEARTBEAT_MS);

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
