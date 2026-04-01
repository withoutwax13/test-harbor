import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { INGEST_EVENT_TYPES, isValidIngestType } from '@testharbor/shared';

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const INGEST_BODY_LIMIT_BYTES = parsePositiveInt(
  process.env.INGEST_BODY_LIMIT_BYTES || process.env.TESTHARBOR_BODY_LIMIT_BYTES,
  150_000_000
);

const app = Fastify({ logger: true, bodyLimit: INGEST_BODY_LIMIT_BYTES });
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
  [INGEST_EVENT_TYPES.RUN_STARTED]: ['runId', 'projectId'],
  [INGEST_EVENT_TYPES.RUN_FINISHED]: ['runId', 'status'],
  [INGEST_EVENT_TYPES.SPEC_STARTED]: ['specRunId', 'runId', 'specPath'],
  [INGEST_EVENT_TYPES.SPEC_FINISHED]: ['specRunId', 'status'],
  [INGEST_EVENT_TYPES.TEST_RESULT]: ['testResultId', 'specRunId', 'status'],
  [INGEST_EVENT_TYPES.ARTIFACT_REGISTERED]: ['artifactId', 'runId', 'type', 'storageKey'],
  [INGEST_EVENT_TYPES.REPLAY_CHUNK]: ['runId', 'events'],
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

  if (type === INGEST_EVENT_TYPES.REPLAY_CHUNK && !Array.isArray(payload.events)) {
    throw new ValidationError('payload_invalid_events_array', { type });
  }

  if (type === INGEST_EVENT_TYPES.ARTIFACT_REGISTERED && payload.contentBase64 != null && typeof payload.contentBase64 !== 'string') {
    throw new ValidationError('payload_invalid_artifact_content_base64', { type });
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

function decodeBase64Content(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const direct = trimmed.startsWith('data:')
    ? trimmed.slice(trimmed.indexOf(',') + 1)
    : trimmed;

  try {
    return Buffer.from(direct, 'base64');
  } catch {
    return null;
  }
}

function firstPresent() {
  for (const value of arguments) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

function normalizeReplaySeq(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function normalizeReplayText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function clampNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.trunc(parsed));
}

function normalizeReplayChunkMeta(meta, events = []) {
  const raw = meta && typeof meta === 'object' ? meta : {};
  const inferredEncodedBytes = Buffer.byteLength(JSON.stringify(events || []), 'utf8');
  return {
    clientChunkSeq: normalizeReplaySeq(raw.clientChunkSeq),
    clientChunkId: normalizeReplayText(raw.clientChunkId || raw.chunkId),
    compression: normalizeReplayText(raw.compression) || 'none',
    encodedBytes: clampNonNegativeInt(raw.encodedBytes, inferredEncodedBytes),
    droppedEvents: clampNonNegativeInt(raw.droppedEvents, 0),
    droppedEventsTotal: clampNonNegativeInt(raw.droppedEventsTotal, clampNonNegativeInt(raw.droppedEvents, 0)),
    truncatedEvents: clampNonNegativeInt(raw.truncatedEvents, 0)
  };
}

function normalizeReplayCaptureStatus(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const domCapture = payload.domCapture && typeof payload.domCapture === 'object'
    ? payload.domCapture
    : (event?.domCapture && typeof event.domCapture === 'object' ? event.domCapture : {});

  if (domCapture.exactForStep === true || typeof event?.domSnapshot === 'string' || typeof payload.domSnapshot === 'string') {
    return 'exact';
  }
  if (domCapture.degraded === true) {
    return 'degraded';
  }
  if (domCapture.available === false || firstPresent(event?.domSnapshot, payload.domSnapshot) == null) {
    return 'unavailable';
  }
  return 'available';
}

function normalizeReplayEventRecord(chunkPayload, event, chunkContext = {}) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const payloadJson = JSON.stringify(event);
  const receivedAt = chunkContext?.receivedAt || new Date().toISOString();
  return {
    runId: chunkPayload.runId,
    specRunId: firstPresent(event?.specRunId, payload.specRunId, chunkPayload.specRunId),
    testResultId: firstPresent(event?.testResultId, payload.testResultId, chunkPayload.testResultId),
    eventType: normalizeReplayText(firstPresent(event?.event_type, payload.event_type, event?.type, payload.type)) || 'replay.event',
    eventTs: firstPresent(event?.ts, event?.at, payload.ts, payload.at, null),
    eventSeq: normalizeReplaySeq(firstPresent(event?.eventSeq, payload.eventSeq, event?.seq, payload.seq)),
    eventId: normalizeReplayText(firstPresent(event?.eventId, payload.eventId)),
    stepId: normalizeReplayText(firstPresent(event?.stepId, payload.stepId)),
    phase: normalizeReplayText(firstPresent(event?.phase, payload.phase)),
    captureStatus: normalizeReplayCaptureStatus(event),
    serverReceivedAt: receivedAt,
    payloadBytes: Buffer.byteLength(payloadJson, 'utf8'),
    replayChunkId: chunkContext?.chunkId || null,
    payload: payloadJson
  };
}

function sanitizePayloadForReceipt(type, payload) {
  if (!payload || typeof payload !== 'object') return payload;

  let clone;
  try {
    clone = JSON.parse(JSON.stringify(payload));
  } catch {
    return { note: 'payload_not_json_serializable' };
  }

  if (type === INGEST_EVENT_TYPES.ARTIFACT_REGISTERED && typeof clone.contentBase64 === 'string') {
    clone.contentBase64Length = clone.contentBase64.length;
    clone.contentBase64 = '[omitted]';
  }

  if (type === INGEST_EVENT_TYPES.REPLAY_CHUNK && Array.isArray(clone.events)) {
    clone.events = clone.events.map((event) => {
      if (!event || typeof event !== 'object') return event;
      const out = { ...event };
      if (typeof out.domSnapshot === 'string') {
        out.domSnapshotLength = out.domSnapshot.length;
        out.domSnapshot = '[omitted]';
      }
      if (out.payload && typeof out.payload === 'object') {
        out.payload = { ...out.payload };
        if (typeof out.payload.domSnapshot === 'string') {
          out.payload.domSnapshotLength = out.payload.domSnapshot.length;
          out.payload.domSnapshot = '[omitted]';
        }
        if (out.payload.domCapture && typeof out.payload.domCapture === 'object' && typeof out.payload.domCapture.html === 'string') {
          out.payload.domCapture = {
            ...out.payload.domCapture,
            htmlLength: out.payload.domCapture.html.length,
            html: '[omitted]'
          };
        }
      }
      return out;
    });
  }

  return clone;
}

async function upsertArtifactBlob({ artifactId, contentBuffer, contentType = null, byteSize = null, checksum = null }) {
  if (!artifactId || !Buffer.isBuffer(contentBuffer) || !contentBuffer.length) return;
  const size = Number.isFinite(Number(byteSize)) ? Number(byteSize) : contentBuffer.length;
  await query(
    `insert into artifact_blobs(artifact_id, content, content_type, byte_size, checksum, created_at, updated_at)
     values($1, $2, $3, $4, $5, now(), now())
     on conflict (artifact_id) do update set
       content = excluded.content,
       content_type = excluded.content_type,
       byte_size = excluded.byte_size,
       checksum = excluded.checksum,
       updated_at = now()`,
    [artifactId, contentBuffer, contentType, size, checksum]
  );
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

async function resolveWorkspaceContextFromProject({ projectId, workspaceId = null }) {
  const res = await query('select workspace_id from projects where id = $1', [projectId]);
  const projectWorkspaceId = res.rows[0]?.workspace_id || null;
  if (!projectWorkspaceId) {
    throw new ValidationError('project_not_found', { projectId });
  }

  if (workspaceId && String(projectWorkspaceId) !== String(workspaceId)) {
    throw new ValidationError('workspace_project_mismatch', { workspaceId, projectId, projectWorkspaceId });
  }

  return {
    projectId,
    workspaceId: workspaceId || projectWorkspaceId,
    projectWorkspaceId
  };
}

async function authorizeIngestRequest(request, reply, { type, payload }) {
  const bearer = parseBearerToken(request.headers.authorization);
  if (!bearer) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }

  if (INGEST_AUTH_TOKEN && bearer === INGEST_AUTH_TOKEN) {
    return { mode: 'static', token: null };
  }

  const token = await findActiveProjectIngestToken(bearer);
  if (!token) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }

  if (type === INGEST_EVENT_TYPES.RUN_STARTED) {
    if (String(payload.projectId) !== String(token.project_id)) {
      reply.code(403).send({ error: 'token_scope_mismatch' });
      return null;
    }

    if (payload.workspaceId && String(payload.workspaceId) !== String(token.workspace_id)) {
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

  const receiptPayload = sanitizePayloadForReceipt(eventType, payload);

  try {
    await handler();
    await query(
      `insert into ingest_events(idempotency_key, event_type, payload, status)
       values($1, $2, $3::jsonb, 'processed')`,
      [idempotencyKey, eventType, JSON.stringify(receiptPayload)]
    );
    return { duplicate: false, status: 'processed' };
  } catch (err) {
    await query(
      `insert into ingest_events(idempotency_key, event_type, payload, status, error)
       values($1, $2, $3::jsonb, 'failed', $4)
       on conflict (idempotency_key)
       do update set status = 'failed', error = excluded.error`,
      [idempotencyKey, eventType, JSON.stringify(receiptPayload), String(err.message || err)]
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
      if (!requireKeys(payload, ['runId', 'projectId'])) throw new Error('run.started missing required fields');
      const context = await resolveWorkspaceContextFromProject({ projectId: payload.projectId, workspaceId: payload.workspaceId ?? null });
      await query(
        `insert into runs(id, workspace_id, project_id, ci_provider, ci_build_id, commit_sha, branch, status, started_at)
         values($1,$2,$3,$4,$5,$6,$7,'running',coalesce($8::timestamptz, now()))
         on conflict (id) do update set status='running', started_at=coalesce(excluded.started_at, runs.started_at),
            ci_provider=coalesce(excluded.ci_provider, runs.ci_provider),
            ci_build_id=coalesce(excluded.ci_build_id, runs.ci_build_id),
            commit_sha=coalesce(excluded.commit_sha, runs.commit_sha),
            branch=coalesce(excluded.branch, runs.branch),
            workspace_id=excluded.workspace_id,
            project_id=excluded.project_id`,
        [payload.runId, context.workspaceId, payload.projectId, payload.ciProvider ?? null, payload.ciBuildId ?? null, payload.commitSha ?? null, payload.branch ?? null, payload.startedAt ?? null]
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

      if (payload.contentBase64) {
        const contentBuffer = decodeBase64Content(payload.contentBase64);
        if (!contentBuffer || !contentBuffer.length) {
          throw new ValidationError('artifact_content_invalid_base64', { artifactId: payload.artifactId });
        }

        await upsertArtifactBlob({
          artifactId: payload.artifactId,
          contentBuffer,
          contentType: payload.contentType ?? null,
          byteSize: payload.byteSize ?? contentBuffer.length,
          checksum: payload.checksum ?? null
        });
      }

      return;
    }
    case INGEST_EVENT_TYPES.REPLAY_CHUNK: {
      if (!requireKeys(payload, ['runId', 'events'])) throw new Error('replay.chunk missing required fields');
      const events = Array.isArray(payload.events) ? payload.events : [];
      const receivedAt = new Date().toISOString();
      const chunkId = crypto.randomUUID();
      const meta = normalizeReplayChunkMeta(payload.meta, events);

      await query(
        `insert into replay_chunks(
           id, run_id, spec_run_id, test_result_id,
           client_chunk_seq, client_chunk_id,
           compression, encoded_bytes,
           event_count, dropped_events, dropped_events_total, truncated_events,
           received_at, created_at
         )
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())`,
        [
          chunkId,
          payload.runId,
          payload.specRunId ?? null,
          payload.testResultId ?? null,
          meta.clientChunkSeq,
          meta.clientChunkId,
          meta.compression,
          meta.encodedBytes,
          events.length,
          meta.droppedEvents,
          meta.droppedEventsTotal,
          meta.truncatedEvents,
          receivedAt
        ]
      );

      for (const event of events) {
        if (!event || typeof event !== 'object') continue;
        const normalizedEvent = normalizeReplayEventRecord(payload, event, { chunkId, receivedAt });
        await query(
          `insert into replay_events(
             run_id, spec_run_id, test_result_id, event_type, event_ts,
             event_seq, event_id, step_id, phase, capture_status,
             server_received_at, payload_bytes, replay_chunk_id, payload
           )
           values($1,$2,$3,$4,coalesce($5::timestamptz, now()),$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
          [
            normalizedEvent.runId,
            normalizedEvent.specRunId,
            normalizedEvent.testResultId,
            normalizedEvent.eventType,
            normalizedEvent.eventTs,
            normalizedEvent.eventSeq,
            normalizedEvent.eventId,
            normalizedEvent.stepId,
            normalizedEvent.phase,
            normalizedEvent.captureStatus,
            normalizedEvent.serverReceivedAt,
            normalizedEvent.payloadBytes,
            normalizedEvent.replayChunkId,
            normalizedEvent.payload
          ]
        );
      }
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
  if (error?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return reply.code(413).send({
      error: 'payload_too_large',
      message: `Request body exceeds ingest body limit (${INGEST_BODY_LIMIT_BYTES} bytes). Reduce payload size or raise INGEST_BODY_LIMIT_BYTES.`
    });
  }
  return reply.code(500).send({ error: 'ingest_failed', detail: String(error.message || error) });
});

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
