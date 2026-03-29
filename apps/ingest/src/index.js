import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { INGEST_EVENT_TYPES, isValidIngestType } from '@testharbor/shared';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 4010);
const databaseUrl = process.env.DATABASE_URL || 'postgres://testharbor:testharbor@localhost:5432/testharbor';
const pool = new pg.Pool({ connectionString: databaseUrl });

const INGEST_AUTH_TOKEN = process.env.INGEST_AUTH_TOKEN || '';
const EMIT_TEST_RESULT_WEBHOOKS = String(process.env.EMIT_TEST_RESULT_WEBHOOKS || '').toLowerCase() === 'true';

function parseBearerToken(headerValue) {
  if (!headerValue) return null;
  const [scheme, token] = String(headerValue).split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

app.addHook('onRequest', async (request, reply) => {
  if (!INGEST_AUTH_TOKEN) return;
  if (request.url.startsWith('/healthz')) return;

  const token = parseBearerToken(request.headers.authorization);
  if (!token) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

const REQUIRED_FIELDS_BY_TYPE = {
  [INGEST_EVENT_TYPES.RUN_STARTED]: ['runId', 'workspaceId', 'projectId'],
  [INGEST_EVENT_TYPES.RUN_FINISHED]: ['runId', 'status'],
  [INGEST_EVENT_TYPES.SPEC_STARTED]: ['specRunId', 'runId', 'specPath'],
  [INGEST_EVENT_TYPES.SPEC_FINISHED]: ['specRunId', 'status'],
  [INGEST_EVENT_TYPES.TEST_RESULT]: ['testResultId', 'specRunId', 'status'],
  [INGEST_EVENT_TYPES.ARTIFACT_REGISTERED]: ['artifactId', 'runId', 'type', 'storageKey'],
  [INGEST_EVENT_TYPES.HEARTBEAT]: ['runId']
};

function missingKeys(obj, keys) {
  return (keys || []).filter((k) => !Object.prototype.hasOwnProperty.call(obj || {}, k));
}

function validatePayloadShape(type, payload) {
  const required = REQUIRED_FIELDS_BY_TYPE[type] || [];
  const missing = missingKeys(payload, required);
  if (missing.length) {
    throw new ValidationError('payload_missing_required_fields', { type, missing });
  }
}

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}



function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function findActiveProjectIngestToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashText(rawToken);
  const { rows } = await query(
    `select id, workspace_id, project_id, label, token_hint, last_used_at, expires_at, revoked_at
     from project_ingest_tokens
     where token_hash = $1
       and revoked_at is null
       and (expires_at is null or expires_at > now())
     order by created_at desc
     limit 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function markProjectIngestTokenUsed(tokenId) {
  if (!tokenId) return;
  await query(
    `update project_ingest_tokens
     set last_used_at = now()
     where id = $1`,
    [tokenId]
  );
}

async function assertProjectWorkspaceMatch({ workspaceId, projectId }) {
  const res = await query('select workspace_id from projects where id = $1', [projectId]);
  const projectWorkspaceId = res.rows[0]?.workspace_id || null;
  if (!projectWorkspaceId) {
    throw new ValidationError('project_not_found', { projectId });
  }
  if (String(projectWorkspaceId) !== String(workspaceId)) {
    throw new ValidationError('workspace_project_mismatch', { workspaceId, projectId, projectWorkspaceId });
  }
}

async function authorizeIngestRequest(request, reply, { type, payload }) {
  if (!INGEST_AUTH_TOKEN) {
    return { mode: 'open', token: null };
  }

  const bearer = parseBearerToken(request.headers.authorization);
  if (!bearer) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }

  if (bearer === INGEST_AUTH_TOKEN) {
    return { mode: 'static', token: null };
  }

  const token = await findActiveProjectIngestToken(bearer);
  if (!token) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }

  if (type === INGEST_EVENT_TYPES.RUN_STARTED) {
    if (String(payload.workspaceId) != String(token.workspace_id) || String(payload.projectId) != String(token.project_id)) {
      reply.code(403).send({ error: 'token_scope_mismatch' });
      return null;
    }
    return { mode: 'project', token };
  }

  const runContext = payload.runId
    ? await lookupRunContextByRunId(payload.runId)
    : (payload.specRunId ? await lookupRunContextBySpecRunId(payload.specRunId) : null);

  if (!runContext) {
    reply.code(400).send({ error: 'run_context_required' });
    return null;
  }

  const ctxWorkspaceId = runContext.workspace_id;
  const ctxProjectId = runContext.project_id;

  if (String(ctxWorkspaceId) != String(token.workspace_id) || String(ctxProjectId) != String(token.project_id)) {
    reply.code(403).send({ error: 'token_scope_mismatch' });
    return null;
  }

  return { mode: 'project', token };
}
function requireKeys(obj, keys) {
  return keys.every((k) => Object.prototype.hasOwnProperty.call(obj || {}, k));
}

async function withIdempotency(idempotencyKey, eventType, payload, handler) {
  const existing = await query('select id, status from ingest_events where idempotency_key = $1', [idempotencyKey]);
  if (existing.rows.length) return { duplicate: true, status: existing.rows[0].status };

  try {
    await handler();
    await query(
      `insert into ingest_events(idempotency_key, event_type, payload, status)
       values($1, $2, $3::jsonb, 'processed')`,
      [idempotencyKey, eventType, JSON.stringify(payload)]
    );
    return { duplicate: false, status: 'processed' };
  } catch (err) {
    await query(
      `insert into ingest_events(idempotency_key, event_type, payload, status, error)
       values($1, $2, $3::jsonb, 'failed', $4)
       on conflict (idempotency_key)
       do update set status = 'failed', error = excluded.error`,
      [idempotencyKey, eventType, JSON.stringify(payload), String(err.message || err)]
    );
    throw err;
  }
}

async function enqueueWebhooks({ eventType, workspaceId, runId = null, payload }) {
  const notification = await query(
    `insert into notification_events(workspace_id, run_id, channel, payload, status)
     values ($1, $2, 'webhook', $3::jsonb, 'queued')
     returning id`,
    [workspaceId, runId, JSON.stringify({ eventType, payload })]
  );

  const notificationEventId = notification.rows[0].id;
  const endpoints = await query(
    `select id, target_url
     from webhook_endpoints
     where workspace_id = $1 and enabled = true and type = $2`,
    [workspaceId, eventType]
  );

  for (const ep of endpoints.rows) {
    await query(
      `insert into webhook_deliveries (
         notification_event_id, webhook_endpoint_id, workspace_id,
         event_type, target_url, payload, status, next_retry_at
       )
       values ($1, $2, $3, $4, $5, $6::jsonb, 'queued', now())
       on conflict (notification_event_id, webhook_endpoint_id)
       do nothing`,
      [notificationEventId, ep.id, workspaceId, eventType, ep.target_url, JSON.stringify(payload)]
    );
  }
}

async function resolveTestCaseId(payload) {
  if (payload.testCaseId) return payload.testCaseId;
  if (!requireKeys(payload, ['projectId', 'stableTestKey', 'title', 'filePath'])) {
    throw new Error('test.result requires testCaseId or projectId+stableTestKey+title+filePath');
  }

  const row = await query(
    `insert into test_cases(project_id, stable_test_key, title, file_path, suite_path)
     values($1,$2,$3,$4,$5)
     on conflict (project_id, stable_test_key)
     do update set title = excluded.title, file_path = excluded.file_path, suite_path = excluded.suite_path
     returning id`,
    [payload.projectId, payload.stableTestKey, payload.title, payload.filePath, payload.suitePath ?? null]
  );

  return row.rows[0].id;
}

async function lookupRunContextByRunId(runId) {
  const res = await query('select id, workspace_id, project_id from runs where id = $1', [runId]);
  return res.rows[0] || null;
}

async function lookupRunContextBySpecRunId(specRunId) {
  const res = await query(
    `select r.id as run_id, r.workspace_id, r.project_id
     from spec_runs s
     join runs r on r.id = s.run_id
     where s.id = $1`,
    [specRunId]
  );
  return res.rows[0] || null;
}

async function handleEvent(type, payload) {
  switch (type) {
    case INGEST_EVENT_TYPES.RUN_STARTED: {
      if (!requireKeys(payload, ['runId', 'workspaceId', 'projectId'])) throw new Error('run.started missing required fields');
      await assertProjectWorkspaceMatch({ workspaceId: payload.workspaceId, projectId: payload.projectId });
      await query(
        `insert into runs(id, workspace_id, project_id, ci_provider, ci_build_id, commit_sha, branch, status, started_at)
         values($1,$2,$3,$4,$5,$6,$7,'running',coalesce($8::timestamptz, now()))
         on conflict (id) do update set status='running', started_at=coalesce(excluded.started_at, runs.started_at),
            ci_provider=coalesce(excluded.ci_provider, runs.ci_provider),
            ci_build_id=coalesce(excluded.ci_build_id, runs.ci_build_id),
            commit_sha=coalesce(excluded.commit_sha, runs.commit_sha),
            branch=coalesce(excluded.branch, runs.branch)`,
        [payload.runId, payload.workspaceId, payload.projectId, payload.ciProvider ?? null, payload.ciBuildId ?? null, payload.commitSha ?? null, payload.branch ?? null, payload.startedAt ?? null]
      );
      return;
    }
    case INGEST_EVENT_TYPES.RUN_FINISHED: {
      if (!requireKeys(payload, ['runId', 'status'])) throw new Error('run.finished missing required fields');
      await query(
        `update runs set status=$2, finished_at=coalesce($3::timestamptz, now()),
          total_specs=coalesce($4, total_specs), total_tests=coalesce($5, total_tests),
          pass_count=coalesce($6, pass_count), fail_count=coalesce($7, fail_count), flaky_count=coalesce($8, flaky_count)
         where id=$1`,
        [payload.runId, payload.status, payload.finishedAt ?? null, payload.totalSpecs ?? null, payload.totalTests ?? null, payload.passCount ?? null, payload.failCount ?? null, payload.flakyCount ?? null]
      );

      const ctx = await lookupRunContextByRunId(payload.runId);
      if (ctx) {
        await enqueueWebhooks({
          eventType: INGEST_EVENT_TYPES.RUN_FINISHED,
          workspaceId: ctx.workspace_id,
          runId: ctx.id,
          payload: { type, payload }
        });
      }
      return;
    }
    case INGEST_EVENT_TYPES.SPEC_STARTED: {
      if (!requireKeys(payload, ['specRunId', 'runId', 'specPath'])) throw new Error('spec.started missing required fields');
      await query(
        `insert into spec_runs(id, run_id, spec_path, status, started_at)
         values($1,$2,$3,'running',coalesce($4::timestamptz, now()))
         on conflict (id) do update set status='running', started_at=coalesce(excluded.started_at, spec_runs.started_at)`,
        [payload.specRunId, payload.runId, payload.specPath, payload.startedAt ?? null]
      );
      return;
    }
    case INGEST_EVENT_TYPES.SPEC_FINISHED: {
      if (!requireKeys(payload, ['specRunId', 'status'])) throw new Error('spec.finished missing required fields');
      await query(
        `update spec_runs
         set status=$2, duration_ms=coalesce($3, duration_ms), attempts=coalesce($4, attempts), finished_at=coalesce($5::timestamptz, now())
         where id=$1`,
        [payload.specRunId, payload.status, payload.durationMs ?? null, payload.attempts ?? null, payload.finishedAt ?? null]
      );

      const ctx = await lookupRunContextBySpecRunId(payload.specRunId);
      if (ctx) {
        await enqueueWebhooks({
          eventType: INGEST_EVENT_TYPES.SPEC_FINISHED,
          workspaceId: ctx.workspace_id,
          runId: ctx.run_id,
          payload: { type, payload }
        });
      }
      return;
    }
    case INGEST_EVENT_TYPES.TEST_RESULT: {
      if (!requireKeys(payload, ['testResultId', 'specRunId', 'status'])) throw new Error('test.result missing required fields');
      const testCaseId = await resolveTestCaseId(payload);
      await query(
        `insert into test_results(id, spec_run_id, test_case_id, attempt_no, status, duration_ms, error_hash, error_message, stacktrace)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (id) do update set
           attempt_no=excluded.attempt_no,
           status=excluded.status,
           duration_ms=excluded.duration_ms,
           error_hash=excluded.error_hash,
           error_message=excluded.error_message,
           stacktrace=excluded.stacktrace`,
        [payload.testResultId, payload.specRunId, testCaseId, payload.attemptNo ?? 1, payload.status, payload.durationMs ?? null, payload.errorHash ?? null, payload.errorMessage ?? null, payload.stacktrace ?? null]
      );

      if (EMIT_TEST_RESULT_WEBHOOKS) {
        const ctx = await lookupRunContextBySpecRunId(payload.specRunId);
        if (ctx) {
          await enqueueWebhooks({
            eventType: INGEST_EVENT_TYPES.TEST_RESULT,
            workspaceId: ctx.workspace_id,
            runId: ctx.run_id,
            payload: { type, payload }
          });
        }
      }
      return;
    }
    case INGEST_EVENT_TYPES.ARTIFACT_REGISTERED: {
      if (!requireKeys(payload, ['artifactId', 'runId', 'type', 'storageKey'])) throw new Error('artifact.registered missing required fields');
      await query(
        `insert into artifacts(id, run_id, spec_run_id, test_result_id, type, storage_key, content_type, byte_size, checksum)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (id) do update set
           type=excluded.type,
           storage_key=excluded.storage_key,
           content_type=excluded.content_type,
           byte_size=excluded.byte_size,
           checksum=excluded.checksum`,
        [payload.artifactId, payload.runId, payload.specRunId ?? null, payload.testResultId ?? null, payload.type, payload.storageKey, payload.contentType ?? null, payload.byteSize ?? null, payload.checksum ?? null]
      );
      return;
    }
    case INGEST_EVENT_TYPES.HEARTBEAT: {
      if (!requireKeys(payload, ['runId'])) throw new Error('heartbeat missing required fields');
      await query(
        `insert into ingest_events(idempotency_key, event_type, payload, status)
         values($1, 'heartbeat.signal', $2::jsonb, 'processed')
         on conflict (idempotency_key) do nothing`,
        [`hb-${payload.runId}-${Date.now()}`, JSON.stringify(payload)]
      );
      return;
    }
    default:
      throw new Error(`Unhandled event type: ${type}`);
  }
}

app.get('/healthz', async () => {
  let db = 'down';
  try { await query('select 1'); db = 'up'; } catch { db = 'down'; }
  return { ok: true, service: '@testharbor/ingest', db };
});

app.post('/v1/ingest/events', async (request, reply) => {
  const { type, idempotencyKey, payload } = request.body || {};
  if (!type || !idempotencyKey || !payload) return reply.code(400).send({ error: 'type, idempotencyKey, payload are required' });
  if (!isValidIngestType(type)) return reply.code(400).send({ error: `unsupported_event_type: ${type}` });

  try {
    validatePayloadShape(type, payload);
  } catch (error) {
    if (error instanceof ValidationError) {
      return reply.code(400).send({
        error: 'validation_error',
        message: error.message,
        details: error.details
      });
    }
    throw error;
  }

  const auth = await authorizeIngestRequest(request, reply, { type, payload });
  if (!auth) return;

  try {
    const result = await withIdempotency(idempotencyKey, type, payload, async () => {
      await handleEvent(type, payload);
    });

    if (auth.mode === 'project' && auth.token?.id) {
      await markProjectIngestTokenUsed(auth.token.id);
    }

    return reply.code(result.duplicate ? 200 : 202).send({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ValidationError) {
      return reply.code(400).send({
        error: 'validation_error',
        message: error.message,
        details: error.details
      });
    }

    const msg = String(error?.message || error);
    if (msg.includes('missing required fields')) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'payload_missing_required_fields',
        details: { type }
      });
    }
    throw error;
  }
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  return reply.code(500).send({ error: 'ingest_failed', detail: String(error.message || error) });
});

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
