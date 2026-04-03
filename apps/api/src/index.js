import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 4000);
const databaseUrl = process.env.DATABASE_URL || 'postgres://testharbor:testharbor@localhost:5432/testharbor';
const pool = new pg.Pool({ connectionString: databaseUrl });

const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || '';
const LOCAL_AUTH_SECRET = process.env.LOCAL_AUTH_SECRET || 'testharbor-local-dev-secret';
const LOCAL_AUTH_REQUIRED = process.env.LOCAL_AUTH_REQUIRED === '1';
const REQUIRE_WORKSPACE_AUTH = process.env.REQUIRE_WORKSPACE_AUTH === '1';
const AUTH_TOKEN_TTL_SEC = Number(process.env.AUTH_TOKEN_TTL_SEC || 60 * 60 * 12);
const ARTIFACT_SIGN_TTL_SEC = Number(process.env.ARTIFACT_SIGN_TTL_SEC || 15 * 60);
const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || process.env.ARTIFACT_STORAGE_BACKEND || 'minio').toLowerCase();
const STORAGE_PUBLIC_BASE_URL = process.env.STORAGE_PUBLIC_BASE_URL || process.env.MINIO_PUBLIC_BASE_URL || '';
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || process.env.S3_BUCKET || 'testharbor';
const STORAGE_PREFIX = (process.env.STORAGE_PREFIX || 'artifacts').replace(/^\/+|\/+$/g, '');
const ARTIFACT_PROXY_MODE = process.env.ARTIFACT_PROXY_MODE || 'json';
const DEFAULT_ANALYTICS_SEED = process.env.ANALYTICS_SEED || 'testharbor-v1';
const ENABLE_AUDIT_LOGS = process.env.ENABLE_AUDIT_LOGS !== '0';
const INGEST_BASE_URL = (process.env.INGEST_BASE_URL || 'http://localhost:4010').replace(/\/+$/, '');
const SYSTEM_STATUS_TIMEOUT_MS = Number(process.env.SYSTEM_STATUS_TIMEOUT_MS || 4000);
const WORKER_HEARTBEAT_STALE_SEC = Number(process.env.WORKER_HEARTBEAT_STALE_SEC || 60);
const PROJECT_INGEST_TOKEN_DEFAULT_TTL_DAYS = Number(process.env.PROJECT_INGEST_TOKEN_DEFAULT_TTL_DAYS || 90);
const PROJECT_INGEST_TOKEN_MAX_TTL_DAYS = Number(process.env.PROJECT_INGEST_TOKEN_MAX_TTL_DAYS || 365);

const ROLE_RANK = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3
};

const WORKSPACE_ROLES = Object.keys(ROLE_RANK);

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function signText(value, secret = LOCAL_AUTH_SECRET) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

function encodeTokenPayload(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeTokenPayload(encoded) {
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

function createLocalToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    iat: now,
    exp: now + AUTH_TOKEN_TTL_SEC
  };
  const encoded = encodeTokenPayload(payload);
  const sig = signText(encoded);
  return `thloc.${encoded}.${sig}`;
}

function verifyLocalToken(token) {
  if (!token || !token.startsWith('thloc.')) return null;
  const [, encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  if (signText(encoded) !== signature) return null;

  try {
    const payload = decodeTokenPayload(encoded);
    if (!payload?.sub || !payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseBearerToken(headerValue) {
  if (!headerValue) return null;
  const [scheme, token] = String(headerValue).split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

function jsonBody(body) {
  return body ? JSON.stringify(body) : '{}';
}

function normalizeLimit(limit, fallback = 20, max = 200) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normalizePage(page) {
  const parsed = Number(page);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.floor(parsed);
}

function buildPageInfo(total, page, limit) {
  const totalCount = Number(total || 0);
  return {
    page,
    limit,
    total: totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / limit))
  };
}

function deterministicUnit(seed, key) {
  const hex = hashText(`${seed}:${key}`).slice(0, 12);
  return Number.parseInt(hex, 16) / 0xffffffffffff;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isoCutoff(windowDays) {
  return new Date(Date.now() - (windowDays * 24 * 60 * 60 * 1000)).toISOString();
}

function ensureArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function fetchJsonWithTimeout(url, timeoutMs = SYSTEM_STATUS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: { error: String(error?.message || error) } };
  } finally {
    clearTimeout(timeout);
  }
}

async function recordAuditLog({ workspaceId, actorUserId = null, action, entityType, entityId, meta = null }) {
  if (!ENABLE_AUDIT_LOGS || !workspaceId) return;
  await query(
    `insert into audit_logs(workspace_id, actor_user_id, action, entity_type, entity_id, meta_json)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [workspaceId, actorUserId, action, entityType, String(entityId), meta ? JSON.stringify(meta) : null]
  );
}

async function readWorkerStatus() {
  const heartbeatRes = await query(
    `select service_name, last_seen_at, meta_json, updated_at
     from service_heartbeats
     where service_name = 'worker'`
  );
  const deliveryRes = await query(
    `select
       count(*) filter (where status = 'queued')::int as queued,
       count(*) filter (where status = 'retry_scheduled')::int as retry_scheduled,
       count(*) filter (where status = 'delivering')::int as delivering,
       count(*) filter (where status = 'dead')::int as dead
     from webhook_deliveries`
  );
  const heartbeat = heartbeatRes.rows[0] || null;
  const counts = deliveryRes.rows[0] || { queued: 0, retry_scheduled: 0, delivering: 0, dead: 0 };

  if (!heartbeat) {
    return {
      ok: false,
      state: 'missing',
      staleSeconds: null,
      heartbeat: null,
      queue: counts
    };
  }

  const staleSeconds = Math.max(0, Math.floor((Date.now() - new Date(heartbeat.last_seen_at).getTime()) / 1000));
  return {
    ok: staleSeconds <= WORKER_HEARTBEAT_STALE_SEC,
    state: staleSeconds <= WORKER_HEARTBEAT_STALE_SEC ? 'up' : 'stale',
    staleSeconds,
    heartbeat,
    queue: counts
  };
}

async function buildSystemStatus() {
  let db = 'down';
  try {
    await query('select 1');
    db = 'up';
  } catch {
    db = 'down';
  }

  const ingest = await fetchJsonWithTimeout(`${normalizeBaseUrl(INGEST_BASE_URL)}/healthz`);
  const worker = await readWorkerStatus();
  const recentRuns = await query(
    `select count(*)::int as count
     from runs
     where created_at >= now() - interval '24 hours'`
  );

  return {
    ok: db === 'up' && ingest.ok && worker.ok,
    generatedAt: new Date().toISOString(),
    services: {
      api: {
        ok: db === 'up',
        state: db === 'up' ? 'up' : 'down',
        db,
        storageBackend: STORAGE_BACKEND
      },
      ingest: {
        ok: ingest.ok && ingest.body?.ok === true,
        state: ingest.ok && ingest.body?.ok === true ? 'up' : 'down',
        baseUrl: INGEST_BASE_URL,
        response: ingest.body
      },
      worker
    },
    metrics: {
      recentRuns24h: Number(recentRuns.rows[0]?.count || 0)
    }
  };
}

async function getUserById(userId) {
  const { rows } = await query(
    `select id, email, name, avatar_url, created_at
     from users
     where id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function getMembership(workspaceId, userId) {
  if (!workspaceId || !userId) return null;
  const { rows } = await query(
    `select wm.id, wm.workspace_id, wm.user_id, wm.role, wm.created_at,
            w.name as workspace_name, w.slug as workspace_slug
     from workspace_members wm
     join workspaces w on w.id = wm.workspace_id
     where wm.workspace_id = $1 and wm.user_id = $2`,
    [workspaceId, userId]
  );
  return rows[0] || null;
}

async function resolveWorkspaceIdFromRequestPart(request, source) {
  if (!source) return null;
  const body = request.body || {};
  const querystring = request.query || {};
  const params = request.params || {};

  if (source === 'body.workspaceId') return body.workspaceId || null;
  if (source === 'query.workspaceId') return querystring.workspaceId || null;
  if (source === 'params.id') return params.id || null;

  if (source === 'projectParam') {
    const { rows } = await query('select workspace_id from projects where id = $1', [params.id]);
    return rows[0]?.workspace_id || null;
  }

  if (source === 'runParam') {
    const { rows } = await query('select workspace_id from runs where id = $1', [params.id || params.runId]);
    return rows[0]?.workspace_id || null;
  }

  if (source === 'specParam') {
    const { rows } = await query(
      `select r.workspace_id
       from spec_runs sr
       join runs r on r.id = sr.run_id
       where sr.id = $1`,
      [params.id]
    );
    return rows[0]?.workspace_id || null;
  }

  if (source === 'testCaseParam') {
    const { rows } = await query(
      `select p.workspace_id
       from test_cases tc
       join projects p on p.id = tc.project_id
       where tc.id = $1`,
      [params.testCaseId]
    );
    return rows[0]?.workspace_id || null;
  }

  if (source === 'artifactParam') {
    const { rows } = await query(
      `select r.workspace_id
       from artifacts a
       join runs r on r.id = a.run_id
       where a.id = $1`,
      [params.id]
    );
    return rows[0]?.workspace_id || null;
  }

  if (source === 'runBody') {
    const { rows } = await query('select workspace_id from runs where id = $1', [body.runId]);
    return rows[0]?.workspace_id || null;
  }

  return null;
}

function workspaceGuard({ role = 'viewer', resolveWorkspaceId }) {
  return async function guard(request, reply) {
    const auth = request.auth || { mode: 'anonymous' };
    let workspaceId = request.headers['x-workspace-id'] || null;

    if (!workspaceId) {
      if (typeof resolveWorkspaceId === 'function') {
        workspaceId = await resolveWorkspaceId(request);
      } else if (typeof resolveWorkspaceId === 'string') {
        workspaceId = await resolveWorkspaceIdFromRequestPart(request, resolveWorkspaceId);
      }
    }

    if (!workspaceId) {
      if (REQUIRE_WORKSPACE_AUTH) {
        return reply.code(400).send({ error: 'workspace_context_required' });
      }
      return;
    }

    request.workspaceId = workspaceId;

    if (auth.isService) {
      request.workspaceRole = 'owner';
      return;
    }

    if (!auth.userId) {
      if (REQUIRE_WORKSPACE_AUTH || LOCAL_AUTH_REQUIRED) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      return;
    }

    const membership = await getMembership(workspaceId, auth.userId);
    if (!membership) return reply.code(403).send({ error: 'workspace_access_denied' });
    request.workspaceRole = membership.role;
    request.workspaceMembership = membership;

    if ((ROLE_RANK[membership.role] ?? -1) < (ROLE_RANK[role] ?? 0)) {
      return reply.code(403).send({ error: 'workspace_role_insufficient', requiredRole: role });
    }
  };
}

async function fetchRun(runId) {
  const { rows } = await query(
    `select id, workspace_id, project_id, ci_provider, ci_build_id, commit_sha, branch, pr_id,
            status, started_at, finished_at, parallel_group_id,
            total_specs, total_tests, pass_count, fail_count, flaky_count, created_at
     from runs
     where id = $1`,
    [runId]
  );
  return rows[0] || null;
}

async function fetchRunFailureSummary(runId) {
  const { rows } = await query(
    `select tr.id, tr.status, tr.error_hash, tr.error_message, tr.duration_ms,
            tc.id as test_case_id, tc.title, tc.file_path, sr.spec_path
     from test_results tr
     join spec_runs sr on sr.id = tr.spec_run_id
     join test_cases tc on tc.id = tr.test_case_id
     where sr.run_id = $1 and tr.status in ('failed', 'flaky')
     order by tr.created_at desc
     limit 20`,
    [runId]
  );
  return rows;
}

async function fetchRunSummary(runId) {
  const run = await fetchRun(runId);
  if (!run) return null;

  const specStats = await query(
    `select count(*)::int as spec_count,
            coalesce(sum(duration_ms), 0)::int as total_spec_duration_ms,
            coalesce(max(duration_ms), 0)::int as slowest_spec_duration_ms,
            coalesce((array_agg(spec_path order by duration_ms desc nulls last))[1], null) as slowest_spec_path
     from spec_runs
     where run_id = $1`,
    [runId]
  );

  const testStats = await query(
    `select count(*)::int as test_count,
            count(*) filter (where tr.status = 'passed')::int as passed,
            count(*) filter (where tr.status = 'failed')::int as failed,
            count(*) filter (where tr.status = 'flaky')::int as flaky,
            coalesce(sum(tr.duration_ms), 0)::int as total_test_duration_ms
     from test_results tr
     join spec_runs sr on sr.id = tr.spec_run_id
     where sr.run_id = $1`,
    [runId]
  );

  const artifactStats = await query(
    `select count(*)::int as artifact_count,
            coalesce(sum(byte_size), 0)::bigint as total_artifact_bytes
     from artifacts
     where run_id = $1`,
    [runId]
  );

  return {
    item: run,
    summary: {
      specs: specStats.rows[0],
      tests: testStats.rows[0],
      artifacts: artifactStats.rows[0]
    },
    failures: await fetchRunFailureSummary(runId)
  };
}

async function resolveProjectWorkspace(projectId) {
  const { rows } = await query(
    `select workspace_id
     from projects
     where id = $1`,
    [projectId]
  );
  return rows[0]?.workspace_id || null;
}

function createArtifactToken({ artifactId, action, expiresAt }) {
  const payload = {
    artifactId,
    action,
    exp: Math.floor(new Date(expiresAt).getTime() / 1000)
  };
  const encoded = encodeTokenPayload(payload);
  return `tha.${encoded}.${signText(encoded)}`;
}

function verifyArtifactToken(token, artifactId, action) {
  if (!token?.startsWith('tha.')) return null;
  const [, encoded, signature] = token.split('.');
  if (!encoded || !signature || signText(encoded) !== signature) return null;

  try {
    const payload = decodeTokenPayload(encoded);
    if (payload.artifactId !== artifactId || payload.action !== action) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function buildArtifactStorageKey({ workspaceId, runId, artifactId, fileName }) {
  const safeFileName = String(fileName || `${artifactId}.bin`).replace(/[^a-zA-Z0-9._/-]/g, '-');
  return `${STORAGE_PREFIX}/${workspaceId}/${runId}/${artifactId}/${safeFileName}`.replace(/\/+/g, '/');
}

function inferBaseUrl(request) {
  const forwarded = request.headers['x-forwarded-proto'] && request.headers['x-forwarded-host']
    ? `${request.headers['x-forwarded-proto']}://${request.headers['x-forwarded-host']}`
    : null;
  if (forwarded) return forwarded;
  return `${request.protocol}://${request.headers.host}`;
}

function buildArtifactSignedUrl(request, artifactId, token, action) {
  const path = action === 'upload' ? `/v1/artifacts/upload/${artifactId}` : `/v1/artifacts/download/${artifactId}`;
  if (STORAGE_PUBLIC_BASE_URL) {
    const base = STORAGE_PUBLIC_BASE_URL.replace(/\/+$/, '');
    return `${base}${path}?token=${encodeURIComponent(token)}&backend=${encodeURIComponent(STORAGE_BACKEND)}`;
  }
  return `${inferBaseUrl(request)}${path}?token=${encodeURIComponent(token)}&backend=${encodeURIComponent(STORAGE_BACKEND)}`;
}

async function createArtifactGrant({ artifactId, workspaceId, action, expiresAt, meta = null }) {
  const token = createArtifactToken({ artifactId, action, expiresAt });
  await query(
    `insert into artifact_access_tokens(artifact_id, workspace_id, action, token_hash, expires_at, meta_json)
     values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)`,
    [artifactId, workspaceId, action, hashText(token), expiresAt, meta ? JSON.stringify(meta) : null]
  );
  return token;
}

async function validateArtifactGrant({ artifactId, action, token }) {
  const payload = verifyArtifactToken(token, artifactId, action);
  if (!payload) return null;

  const { rows } = await query(
    `select id, artifact_id, workspace_id, action, expires_at, used_at, meta_json
     from artifact_access_tokens
     where artifact_id = $1
       and action = $2
       and token_hash = $3
       and expires_at > now()
     order by created_at desc
     limit 1`,
    [artifactId, action, hashText(token)]
  );
  return rows[0] || null;
}

async function markArtifactGrantUsed(grantId) {
  await query(
    `update artifact_access_tokens
     set used_at = now()
     where id = $1`,
    [grantId]
  );
}

function createProjectIngestTokenRaw() {
  const random = crypto.randomBytes(24).toString('base64url');
  return `thpit.${random}`;
}

function tokenHint(token) {
  const value = String(token || '');
  if (!value) return '';
  return value.length <= 8 ? value : value.slice(-8);
}

function normalizeTtlDays(input, fallbackDays, maxDays) {
  if (input === undefined || input === null || input === '') return { ok: true, value: fallbackDays };
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return { ok: false, error: 'ttlDays must be a number' };
  const days = Math.floor(parsed);
  if (days <= 0) return { ok: false, error: 'ttlDays must be a positive integer' };
  if (days > maxDays) return { ok: false, error: `ttlDays must be <= ${maxDays}` };
  return { ok: true, value: days };
}

function buildExpiresAtFromTtlDays(ttlDays, fromDate = new Date()) {
  return new Date(fromDate.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

function parseExpiresAtInput(value) {
  if (value === undefined || value === '') return { provided: false, value: null };
  if (value === null) return { provided: true, value: null };
  if (String(value).trim().toLowerCase() === 'null') return { provided: true, value: null };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { provided: true, error: 'expiresAt must be a valid ISO timestamp or null' };
  return { provided: true, value: parsed };
}

function projectIngestTokenState(token) {
  if (token.revoked_at) return 'revoked';
  if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}
function buildSlackPayload({ run, summary, failures, workspaceId }) {
  return {
    text: `Run ${run.id} ${run.status} in workspace ${workspaceId}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Run:* ${run.id}\n*Status:* ${run.status}\n*Branch:* ${run.branch || 'n/a'}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Tests:* ${summary.tests.test_count} total, ${summary.tests.failed} failed, ${summary.tests.flaky} flaky` } },
      { type: 'section', text: { type: 'mrkdwn', text: failures.length ? `*Top failure:* ${failures[0].title} (${failures[0].spec_path})` : '*Top failure:* none' } }
    ]
  };
}

function buildDiscordPayload({ run, summary, failures }) {
  const tests = summary?.tests || { test_count: 0, failed: 0, flaky: 0 };
  const list = Array.isArray(failures) ? failures : [];
  return {
    content: `Run ${run.id} ${run.status}`,
    embeds: [
      {
        title: `TestHarbor run ${run.branch || 'unknown-branch'}`,
        description: `${tests.test_count || 0} tests, ${tests.failed || 0} failed, ${tests.flaky || 0} flaky`,
        fields: list.slice(0, 3).map((failure) => ({
          name: failure.title || 'unknown failure',
          value: `${failure.spec_path || failure.file_path || 'n/a'}: ${failure.error_message || failure.status || 'unknown'}`
        }))
      }
    ]
  };
}

function buildPrFeedbackPayload({ run, summary, failures }) {
  const lines = [
    `## TestHarbor PR feedback`,
    ``,
    `- Run: \`${run.id}\``,
    `- Status: **${run.status}**`,
    `- Branch: \`${run.branch || 'n/a'}\``,
    `- Tests: ${summary.tests.test_count}`,
    `- Failed: ${summary.tests.failed}`,
    `- Flaky: ${summary.tests.flaky}`
  ];

  if (failures.length) {
    lines.push('', `### Top failures`);
    for (const failure of failures.slice(0, 5)) {
      lines.push(`- \`${failure.spec_path}\` :: ${failure.title} :: ${failure.error_message || failure.status}`);
    }
  }

  return {
    body: lines.join('\n'),
    summary: {
      runId: run.id,
      status: run.status,
      failCount: summary.tests.failed,
      flakyCount: summary.tests.flaky
    }
  };
}

function formatNotificationPayload({ channel, runBundle, workspaceId }) {
  if (!runBundle) {
    return { channel, payload: { text: 'No run payload available' } };
  }

  const normalizedBundle = {
    run: runBundle.run || runBundle.item || { id: 'unknown', status: 'unknown', branch: null },
    summary: runBundle.summary || { tests: { test_count: 0, failed: 0, flaky: 0 } },
    failures: Array.isArray(runBundle.failures) ? runBundle.failures : []
  };


  if (channel === 'discord') {
    return { channel, payload: buildDiscordPayload({ ...normalizedBundle, workspaceId }) };
  }

  if (channel === 'github-pr') {
    return { channel, payload: buildPrFeedbackPayload({ ...normalizedBundle, workspaceId }) };
  }

  return { channel: 'slack', payload: buildSlackPayload({ ...normalizedBundle, workspaceId }) };
}

async function queueWebhookFanout({ workspaceId, runId = null, eventType, payload }) {
  const notification = await query(
    `insert into notification_events(workspace_id, run_id, channel, payload, status)
     values ($1, $2, 'webhook', $3::jsonb, 'queued')
     returning id, workspace_id, run_id, status, created_at`,
    [workspaceId, runId, JSON.stringify(payload)]
  );

  const endpoints = await query(
    `select id, target_url
     from webhook_endpoints
     where workspace_id = $1 and enabled = true and type = $2`,
    [workspaceId, eventType]
  );

  for (const endpoint of endpoints.rows) {
    await query(
      `insert into webhook_deliveries(
         notification_event_id, webhook_endpoint_id, workspace_id, event_type,
         target_url, payload, status, next_retry_at
       )
       values ($1, $2, $3, $4, $5, $6::jsonb, 'queued', now())
       on conflict (notification_event_id, webhook_endpoint_id) do nothing`,
      [notification.rows[0].id, endpoint.id, workspaceId, eventType, endpoint.target_url, JSON.stringify(payload)]
    );
  }

  return { event: notification.rows[0], deliveryCount: endpoints.rows.length };
}

async function computeFlakeScores({ projectId, windowDays, seed }) {
  const cutoff = isoCutoff(windowDays);
  const { rows } = await query(
    `select tc.id as test_case_id, tc.title, tc.file_path,
            count(*)::int as total_runs,
            count(*) filter (where tr.status = 'failed')::int as failed_runs,
            count(*) filter (where tr.status = 'flaky')::int as flaky_runs,
            count(*) filter (where tr.status = 'passed')::int as passed_runs,
            max(tr.created_at) as last_seen_at
     from test_cases tc
     join test_results tr on tr.test_case_id = tc.id
     join spec_runs sr on sr.id = tr.spec_run_id
     join runs r on r.id = sr.run_id
     where tc.project_id = $1 and tr.created_at >= $2::timestamptz
     group by tc.id, tc.title, tc.file_path
     order by tc.title asc`,
    [projectId, cutoff]
  );

  const items = [];
  for (const row of rows) {
    const totalRuns = Number(row.total_runs || 0);
    const flakyRate = totalRuns ? Number(row.flaky_runs || 0) / totalRuns : 0;
    const failureRate = totalRuns ? Number(row.failed_runs || 0) / totalRuns : 0;
    const jitter = deterministicUnit(seed, row.test_case_id) * 0.05;
    const score = clamp((flakyRate * 0.7) + (failureRate * 0.45) + jitter, 0, 1);
    const confidence = clamp(Math.log2(totalRuns + 1) / 5, 0.1, 0.99);

    await query(
      `insert into flake_scores(test_case_id, score, confidence, window_days, computed_at)
       values ($1, $2, $3, $4, now())
       on conflict (test_case_id, window_days)
       do update set score = excluded.score, confidence = excluded.confidence, computed_at = excluded.computed_at`,
      [row.test_case_id, score, confidence, windowDays]
    );

    items.push({
      testCaseId: row.test_case_id,
      title: row.title,
      filePath: row.file_path,
      totalRuns,
      failedRuns: Number(row.failed_runs || 0),
      flakyRuns: Number(row.flaky_runs || 0),
      passedRuns: Number(row.passed_runs || 0),
      score: Number(score.toFixed(3)),
      confidence: Number(confidence.toFixed(3)),
      lastSeenAt: row.last_seen_at
    });
  }

  items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return items;
}

async function computeFailureClusters({ projectId, windowDays, seed }) {
  const cutoff = isoCutoff(windowDays);
  const past24h = isoCutoff(1);
  const past7d = isoCutoff(7);
  const { rows } = await query(
    `select coalesce(tr.error_hash, md5(coalesce(tr.error_message, 'unknown_error'))) as signature,
            min(tr.error_message) as sample_error,
            count(*)::int as count_window,
            count(*) filter (where tr.created_at >= $2::timestamptz)::int as count_24h,
            count(*) filter (where tr.created_at >= $3::timestamptz)::int as count_7d
     from test_results tr
     join spec_runs sr on sr.id = tr.spec_run_id
     join runs r on r.id = sr.run_id
     where r.project_id = $1
       and tr.status in ('failed', 'flaky')
       and tr.created_at >= $4::timestamptz
     group by 1
     order by count_window desc, signature asc`,
    [projectId, past24h, past7d, cutoff]
  );

  const items = [];
  for (const row of rows) {
    const clusterKey = hashText(`${seed}:${projectId}:${row.signature}`).slice(0, 16);
    await query(
      `insert into failure_clusters(project_id, cluster_key, signature, sample_error, count_24h, count_7d, computed_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (project_id, cluster_key)
       do update set signature = excluded.signature,
                     sample_error = excluded.sample_error,
                     count_24h = excluded.count_24h,
                     count_7d = excluded.count_7d,
                     computed_at = excluded.computed_at`,
      [projectId, clusterKey, row.signature, row.sample_error, row.count_24h, row.count_7d]
    );

    items.push({
      clusterKey,
      signature: row.signature,
      sampleError: row.sample_error,
      count24h: Number(row.count_24h || 0),
      count7d: Number(row.count_7d || 0),
      countWindow: Number(row.count_window || 0)
    });
  }

  return items;
}

async function loadProjectSpecPaths(projectId) {
  const fromHistory = await query(
    `select spec_path
     from spec_timing_history
     where project_id = $1
     order by last_seen_at desc, spec_path asc`,
    [projectId]
  );
  if (fromHistory.rows.length) return fromHistory.rows.map((row) => row.spec_path);

  const fromRuns = await query(
    `select distinct sr.spec_path
     from spec_runs sr
     join runs r on r.id = sr.run_id
     where r.project_id = $1
     order by sr.spec_path asc`,
    [projectId]
  );
  return fromRuns.rows.map((row) => row.spec_path);
}

async function estimateSpecDurations(projectId, specPaths, seed) {
  const paths = specPaths.length ? specPaths : await loadProjectSpecPaths(projectId);
  const timing = await query(
    `select spec_path, median_ms, p95_ms
     from spec_timing_history
     where project_id = $1 and spec_path = any($2::text[])`,
    [projectId, paths]
  );
  const timingMap = new Map(timing.rows.map((row) => [row.spec_path, row]));

  const historicFallback = await query(
    `select sr.spec_path,
            percentile_cont(0.5) within group (order by sr.duration_ms) as median_ms,
            percentile_cont(0.95) within group (order by sr.duration_ms) as p95_ms
     from spec_runs sr
     join runs r on r.id = sr.run_id
     where r.project_id = $1
       and sr.spec_path = any($2::text[])
       and sr.duration_ms is not null
     group by sr.spec_path`,
    [projectId, paths]
  );
  const historicMap = new Map(historicFallback.rows.map((row) => [row.spec_path, row]));

  return paths.map((specPath) => {
    const direct = timingMap.get(specPath);
    const historic = historicMap.get(specPath);
    const medianMs = Number(direct?.median_ms || historic?.median_ms || 0);
    const p95Ms = Number(direct?.p95_ms || historic?.p95_ms || 0);
    const estimatedDurationMs = medianMs || p95Ms || Math.round(30000 + deterministicUnit(seed, specPath) * 90000);
    return {
      specPath,
      estimatedDurationMs,
      source: medianMs || p95Ms ? (direct ? 'spec_timing_history' : 'spec_runs_history') : 'seeded_fallback'
    };
  });
}

function buildShardPlan(timings, shardCount, strategy) {
  const shards = Array.from({ length: Math.max(1, shardCount) }, (_, index) => ({
    shardIndex: index,
    estimatedDurationMs: 0,
    specs: []
  }));

  const ordered = [...timings].sort((a, b) => b.estimatedDurationMs - a.estimatedDurationMs || a.specPath.localeCompare(b.specPath));
  for (const timing of ordered) {
    const shard = strategy === 'round-robin'
      ? shards[ordered.indexOf(timing) % shards.length]
      : shards.reduce((best, candidate) => candidate.estimatedDurationMs < best.estimatedDurationMs ? candidate : best, shards[0]);
    shard.specs.push(timing);
    shard.estimatedDurationMs += timing.estimatedDurationMs;
  }
  return shards;
}

async function createOrchestratorPlan({ workspaceId, projectId, runId = null, specPaths, shardCount, strategy, seed }) {
  const timings = await estimateSpecDurations(projectId, specPaths, seed);
  const shards = buildShardPlan(timings, shardCount, strategy);

  let parallelGroup = null;
  if (runId) {
    const groupInsert = await query(
      `insert into parallel_groups(run_id, strategy, shard_count)
       values ($1, $2, $3)
       returning *`,
      [runId, strategy, shardCount]
    );
    parallelGroup = groupInsert.rows[0];
    await query(
      `update runs
       set parallel_group_id = $2
       where id = $1`,
      [runId, parallelGroup.id]
    );
  }

  return {
    workspaceId,
    projectId,
    runId,
    strategy,
    shardCount,
    shards,
    parallelGroup
  };
}

async function purgeRetentionWorkspace(workspaceId, actorUserId = null) {
  const workspaceRes = await query(
    `select id, retention_days
     from workspaces
     where id = $1`,
    [workspaceId]
  );
  const workspace = workspaceRes.rows[0];
  if (!workspace) return { workspaceId, deletedRunCount: 0 };

  const cutoff = isoCutoff(Number(workspace.retention_days || 30));
  const candidateRuns = await query(
    `select r.id, r.project_id,
            (select count(*)::int from artifacts a where a.run_id = r.id) as artifact_count
     from runs r
     where r.workspace_id = $1
       and r.finished_at is not null
       and coalesce(r.finished_at, r.created_at) < $2::timestamptz`,
    [workspaceId, cutoff]
  );

  if (!candidateRuns.rows.length) {
    return { workspaceId, retentionDays: workspace.retention_days, deletedRunCount: 0 };
  }

  const runIds = candidateRuns.rows.map((row) => row.id);
  await query(
    `delete from runs
     where id = any($1::uuid[])`,
    [runIds]
  );

  for (const row of candidateRuns.rows) {
    await recordAuditLog({
      workspaceId,
      actorUserId,
      action: 'retention.purge',
      entityType: 'run',
      entityId: row.id,
      meta: {
        projectId: row.project_id,
        artifactCount: Number(row.artifact_count || 0),
        cutoff
      }
    });
  }

  return {
    workspaceId,
    retentionDays: workspace.retention_days,
    deletedRunCount: candidateRuns.rows.length,
    deletedArtifactCount: candidateRuns.rows.reduce((sum, row) => sum + Number(row.artifact_count || 0), 0)
  };
}

app.addHook('onRequest', async (request, reply) => {
  const token = parseBearerToken(request.headers.authorization);
  request.auth = { mode: 'anonymous', isService: false, userId: null, user: null };

  if (token && API_AUTH_TOKEN && token === API_AUTH_TOKEN) {
    request.auth = { mode: 'service', isService: true, userId: null, user: { id: 'service-token', name: 'Service Token' } };
    return;
  }

  const localPayload = token ? verifyLocalToken(token) : null;
  if (localPayload) {
    const user = await getUserById(localPayload.sub);
    if (user) {
      request.auth = { mode: 'local', isService: false, userId: user.id, user };
      return;
    }
  }

  const openPath = request.url.startsWith('/healthz')
    || request.url.startsWith('/v1/auth/login')
    || request.url.startsWith('/v1/artifacts/upload/')
    || request.url.startsWith('/v1/artifacts/download/');

  if (!openPath && request.url.startsWith('/v1/') && (LOCAL_AUTH_REQUIRED || API_AUTH_TOKEN)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

app.get('/healthz', async () => {
  let db = 'down';
  try {
    await query('select 1');
    db = 'up';
  } catch {
    db = 'down';
  }

  return {
    ok: true,
    service: '@testharbor/api',
    db,
    storageBackend: STORAGE_BACKEND
  };
});

app.get('/v1/system/status', async (request, reply) => {
  if (!request.auth?.isService && !request.auth?.userId) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return buildSystemStatus();
});

app.post('/v1/auth/login', async (request, reply) => {
  const { email, name, avatarUrl = null } = request.body || {};
  if (!email || !name) {
    return reply.code(400).send({ error: 'email and name are required' });
  }

  const userRes = await query(
    `insert into users(email, name, avatar_url)
     values ($1, $2, $3)
     on conflict (email)
     do update set name = excluded.name, avatar_url = excluded.avatar_url
     returning id, email, name, avatar_url, created_at`,
    [String(email).toLowerCase(), name, avatarUrl]
  );
  const user = userRes.rows[0];
  const token = createLocalToken(user);
  const memberships = await query(
    `select wm.workspace_id, wm.role, w.name, w.slug
     from workspace_members wm
     join workspaces w on w.id = wm.workspace_id
     where wm.user_id = $1
     order by w.created_at desc`,
    [user.id]
  );

  return reply.code(200).send({
    token,
    user,
    memberships: memberships.rows
  });
});

app.get('/v1/me', async (request, reply) => {
  if (request.auth?.isService) {
    return {
      user: { id: 'service-token', email: null, name: 'Service Token' },
      memberships: []
    };
  }

  if (!request.auth?.userId) return reply.code(401).send({ error: 'unauthorized' });

  const memberships = await query(
    `select wm.workspace_id, wm.role, w.name, w.slug, o.id as organization_id, o.slug as organization_slug
     from workspace_members wm
     join workspaces w on w.id = wm.workspace_id
     join organizations o on o.id = w.organization_id
     where wm.user_id = $1
     order by w.created_at desc`,
    [request.auth.userId]
  );

  return {
    user: request.auth.user,
    memberships: memberships.rows
  };
});

app.get('/v1/workspaces', async (request) => {
  if (request.auth?.userId && !request.auth?.isService) {
    const { rows } = await query(
      `select w.id, w.name, w.slug, w.timezone, w.retention_days, w.created_at,
              o.id as organization_id, o.name as organization_name, o.slug as organization_slug,
              wm.role
       from workspace_members wm
       join workspaces w on w.id = wm.workspace_id
       join organizations o on o.id = w.organization_id
       where wm.user_id = $1
       order by w.created_at desc`,
      [request.auth.userId]
    );
    return { items: rows };
  }

  const { rows } = await query(
    `select w.id, w.name, w.slug, w.timezone, w.retention_days, w.created_at,
            o.id as organization_id, o.name as organization_name, o.slug as organization_slug
     from workspaces w
     join organizations o on o.id = w.organization_id
     order by w.created_at desc`
  );
  return { items: rows };
});

app.post('/v1/workspaces', async (request, reply) => {
  const {
    organizationName,
    organizationSlug,
    name,
    slug,
    timezone = 'UTC',
    retentionDays = 30
  } = request.body || {};

  if (!organizationName || !organizationSlug || !name || !slug) {
    return reply.code(400).send({ error: 'organizationName, organizationSlug, name, slug are required' });
  }

  const org = await query(
    `insert into organizations(name, slug)
     values ($1, $2)
     on conflict (slug) do update set name = excluded.name
     returning id, name, slug`,
    [organizationName, organizationSlug]
  );

  const ws = await query(
    `insert into workspaces(organization_id, name, slug, timezone, retention_days)
     values ($1, $2, $3, $4, $5)
     on conflict (organization_id, slug)
     do update set name = excluded.name, timezone = excluded.timezone, retention_days = excluded.retention_days
     returning *`,
    [org.rows[0].id, name, slug, timezone, retentionDays]
  );

  if (request.auth?.userId) {
    await query(
      `insert into workspace_members(workspace_id, user_id, role)
       values ($1, $2, 'owner')
       on conflict (workspace_id, user_id) do update set role = excluded.role`,
      [ws.rows[0].id, request.auth.userId]
    );
  }

  return reply.code(201).send({
    item: {
      ...ws.rows[0],
      organization_id: org.rows[0].id,
      organization_slug: org.rows[0].slug
    }
  });
});

app.post('/v1/workspaces/:id/members', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'params.id' }) }, async (request, reply) => {
  const { id } = request.params;
  const { userId, email, name = 'Local User', avatarUrl = null, role = 'member' } = request.body || {};

  if (!ROLE_RANK.hasOwnProperty(role)) {
    return reply.code(400).send({ error: 'role must be owner|admin|member|viewer' });
  }

  let targetUserId = userId;
  if (!targetUserId && email) {
    const userRes = await query(
      `insert into users(email, name, avatar_url)
       values ($1, $2, $3)
       on conflict (email) do update set name = excluded.name, avatar_url = excluded.avatar_url
       returning id, email, name, avatar_url, created_at`,
      [String(email).toLowerCase(), name, avatarUrl]
    );
    targetUserId = userRes.rows[0].id;
  }

  if (!targetUserId) {
    return reply.code(400).send({ error: 'userId or email is required' });
  }

  const existingMemberRes = await query(
    `select role
     from workspace_members
     where workspace_id = $1 and user_id = $2`,
    [id, targetUserId]
  );
  const existingRole = existingMemberRes.rows[0]?.role || null;
  if (existingRole === 'owner' && role !== 'owner') {
    const ownersRes = await query(
      `select count(*)::int as count
       from workspace_members
       where workspace_id = $1 and role = 'owner' and user_id <> $2`,
      [id, targetUserId]
    );
    if (Number(ownersRes.rows[0]?.count || 0) === 0) {
      return reply.code(400).send({ error: 'workspace_requires_owner' });
    }
  }

  const memberRes = await query(
    `insert into workspace_members(workspace_id, user_id, role)
     values ($1, $2, $3)
     on conflict (workspace_id, user_id)
     do update set role = excluded.role
     returning *`,
    [id, targetUserId, role]
  );

  await recordAuditLog({
    workspaceId: id,
    actorUserId: request.auth?.userId,
    action: 'workspace.member.upserted',
    entityType: 'workspace_member',
    entityId: memberRes.rows[0].id,
    meta: { userId: targetUserId, role }
  });

  return reply.code(201).send({ item: memberRes.rows[0] });
});



app.get('/v1/workspaces/:id/members', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'params.id' }) }, async (request, reply) => {
  const { id } = request.params;
  const { rows } = await query(
    `select wm.id, wm.workspace_id, wm.user_id, wm.role, wm.created_at,
            u.email, u.name, u.avatar_url
     from workspace_members wm
     join users u on u.id = wm.user_id
     where wm.workspace_id = $1
     order by wm.created_at asc`,
    [id]
  );

  return { items: rows };
});



app.patch('/v1/workspaces/:id/members/:userId', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'params.id' }) }, async (request, reply) => {
  const { id, userId } = request.params;
  const role = String(request.body?.role || '').trim();

  if (!role || !ROLE_RANK.hasOwnProperty(role)) {
    return reply.code(400).send({ error: 'role must be owner|admin|member|viewer' });
  }

  const memberRes = await query(
    `select id, role
     from workspace_members
     where workspace_id = $1 and user_id = $2`,
    [id, userId]
  );
  const member = memberRes.rows[0] || null;
  if (!member) return reply.code(404).send({ error: 'not_found' });

  if (member.role === 'owner' && role !== 'owner') {
    const ownersRes = await query(
      `select count(*)::int as count
       from workspace_members
       where workspace_id = $1 and role = 'owner' and user_id <> $2`,
      [id, userId]
    );
    if (Number(ownersRes.rows[0]?.count || 0) === 0) {
      return reply.code(400).send({ error: 'workspace_requires_owner' });
    }
  }

  const updated = await query(
    `update workspace_members
     set role = $3
     where workspace_id = $1 and user_id = $2
     returning *`,
    [id, userId, role]
  );

  await recordAuditLog({
    workspaceId: id,
    actorUserId: request.auth?.userId,
    action: 'workspace.member.role_updated',
    entityType: 'workspace_member',
    entityId: updated.rows[0].id,
    meta: { userId, role }
  });

  return reply.code(200).send({ item: updated.rows[0] });
});
app.delete('/v1/workspaces/:id/members/:userId', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'params.id' }) }, async (request, reply) => {
  const { id, userId } = request.params;

  const memberRes = await query(
    `select id, role
     from workspace_members
     where workspace_id = $1 and user_id = $2`,
    [id, userId]
  );

  const member = memberRes.rows[0] || null;
  if (!member) return reply.code(404).send({ error: 'not_found' });

  if (member.role === 'owner') {
    const ownersRes = await query(
      `select count(*)::int as count
       from workspace_members
       where workspace_id = $1 and role = 'owner' and user_id <> $2`,
      [id, userId]
    );
    if (Number(ownersRes.rows[0]?.count || 0) === 0) {
      return reply.code(400).send({ error: 'workspace_requires_owner' });
    }
  }

  const deleted = await query(
    `delete from workspace_members
     where workspace_id = $1 and user_id = $2
     returning id`,
    [id, userId]
  );

  if (!deleted.rows.length) return reply.code(404).send({ error: 'not_found' });

  await recordAuditLog({
    workspaceId: id,
    actorUserId: request.auth?.userId,
    action: 'workspace.member.removed',
    entityType: 'workspace_member',
    entityId: deleted.rows[0].id,
    meta: { userId }
  });

  return reply.code(204).send();
});
app.delete('/v1/workspaces/:id', { preHandler: workspaceGuard({ role: 'owner', resolveWorkspaceId: 'params.id' }) }, async (request, reply) => {
  const { id } = request.params;
  const { rows } = await query(
    `delete from workspaces
     where id = $1
     returning id`,
    [id]
  );

  if (!rows.length) return reply.code(404).send({ error: 'not_found' });

  await recordAuditLog({
    workspaceId: id,
    actorUserId: request.auth?.userId,
    action: 'workspace.deleted',
    entityType: 'workspace',
    entityId: id
  });

  return reply.code(204).send();
});

app.get('/v1/projects', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'query.workspaceId' }) }, async (request, reply) => {
  const { workspaceId } = request.query || {};
  if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });

  const { rows } = await query(
    `select id, workspace_id, name, slug, provider, repo_url, default_branch, created_at
     from projects
     where workspace_id = $1
     order by created_at desc`,
    [workspaceId]
  );

  return { items: rows };
});

app.post('/v1/projects', { preHandler: workspaceGuard({ role: 'member', resolveWorkspaceId: 'body.workspaceId' }) }, async (request, reply) => {
  const { workspaceId, name, slug, provider = null, repoUrl = null, defaultBranch = 'main' } = request.body || {};
  if (!workspaceId || !name || !slug) {
    return reply.code(400).send({ error: 'workspaceId, name, slug are required' });
  }

  const { rows } = await query(
    `insert into projects(workspace_id, name, slug, provider, repo_url, default_branch)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (workspace_id, slug)
     do update set name = excluded.name,
                   provider = excluded.provider,
                   repo_url = excluded.repo_url,
                   default_branch = excluded.default_branch
     returning *`,
    [workspaceId, name, slug, provider, repoUrl, defaultBranch]
  );

  return reply.code(201).send({ item: rows[0] });
});

app.get('/v1/projects/:id', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'projectParam' }) }, async (request, reply) => {
  const { id } = request.params;
  const { rows } = await query(
    `select id, workspace_id, name, slug, provider, repo_url, default_branch, created_at
     from projects
     where id = $1`,
    [id]
  );
  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return { item: rows[0] };
});

app.patch('/v1/projects/:id', { preHandler: workspaceGuard({ role: 'member', resolveWorkspaceId: 'projectParam' }) }, async (request, reply) => {
  const { id } = request.params;
  const { name, provider, repoUrl, defaultBranch } = request.body || {};

  const { rows } = await query(
    `update projects
     set name = coalesce($2, name),
         provider = coalesce($3, provider),
         repo_url = coalesce($4, repo_url),
         default_branch = coalesce($5, default_branch)
     where id = $1
     returning *`,
    [id, name ?? null, provider ?? null, repoUrl ?? null, defaultBranch ?? null]
  );

  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return { item: rows[0] };
});

app.delete('/v1/projects/:id', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'projectParam' }) }, async (request, reply) => {
  const { id } = request.params;
  const workspaceId = await resolveProjectWorkspace(id);
  const { rows } = await query(
    `delete from projects
     where id = $1
     returning id`,
    [id]
  );
  if (!rows.length) return reply.code(404).send({ error: 'not_found' });

  await recordAuditLog({
    workspaceId,
    actorUserId: request.auth?.userId,
    action: 'project.deleted',
    entityType: 'project',
    entityId: id
  });

  return reply.code(204).send();
});

app.get('/v1/projects/:id/latest-run', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'projectParam' }) }, async (request, reply) => {
  const { id } = request.params;
  const { rows } = await query(
    `select id, workspace_id, project_id, status, branch, commit_sha, started_at, finished_at,
            total_specs, total_tests, pass_count, fail_count, flaky_count, created_at
     from runs
     where project_id = $1
     order by created_at desc
     limit 1`,
    [id]
  );
  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return { item: rows[0] };
});



app.get('/v1/projects/:id/ingest-tokens', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'projectParam' }) }, async (request, reply) => {
  const { id } = request.params;
  const limit = normalizeLimit(request.query?.limit, 50, 200);

  const projectRes = await query('select id from projects where id = $1', [id]);
  if (!projectRes.rows.length) return reply.code(404).send({ error: 'not_found' });

  const { rows } = await query(
    `select id, workspace_id, project_id, label, token_hint, created_by, last_used_at,
            expires_at, revoked_at, revoked_by, created_at,
            case
              when revoked_at is not null then 'revoked'
              when expires_at is not null and expires_at <= now() then 'expired'
              else 'active'
            end as state
     from project_ingest_tokens
     where project_id = $1
     order by created_at desc
     limit $2`,
    [id, limit]
  );

  return { items: rows };
});

app.post('/v1/projects/:id/ingest-tokens', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'projectParam' }) }, async (request, reply) => {
  const { id } = request.params;
  const { label, ttlDays = null } = request.body || {};
  const trimmedLabel = String(label || '').trim();
  if (!trimmedLabel) return reply.code(400).send({ error: 'label is required' });

  const projectRes = await query(
    `select id, workspace_id, name, slug
     from projects
     where id = $1`,
    [id]
  );
  const project = projectRes.rows[0] || null;
  if (!project) return reply.code(404).send({ error: 'not_found' });

  const ttl = normalizeTtlDays(ttlDays, PROJECT_INGEST_TOKEN_DEFAULT_TTL_DAYS, PROJECT_INGEST_TOKEN_MAX_TTL_DAYS);
  if (!ttl.ok) {
    return reply.code(400).send({ error: ttl.error });
  }

  const expiresAt = buildExpiresAtFromTtlDays(ttl.value);
  const token = createProjectIngestTokenRaw();

  const created = await query(
    `insert into project_ingest_tokens(
       workspace_id, project_id,
       label, token_hash, token_hint,
       created_by,
       last_used_at,
       expires_at,
       meta_json
     )
     values ($1, $2, $3, $4, $5, $6, null, $7::timestamptz, $8::jsonb)
     returning id, workspace_id, project_id, label, token_hint, created_by, last_used_at,
               expires_at, revoked_at, revoked_by, created_at`,
    [project.workspace_id, project.id, trimmedLabel, hashText(token), tokenHint(token), request.auth?.userId || null, expiresAt, JSON.stringify({ ttlDays: ttl.value })]
  );

  const item = created.rows[0];

  await recordAuditLog({
    workspaceId: project.workspace_id,
    actorUserId: request.auth?.userId,
    action: 'project.ingest_token.created',
    entityType: 'project_ingest_token',
    entityId: item.id,
    meta: { projectId: project.id, label: trimmedLabel, ttlDays: ttl.value, expiresAt: expiresAt.toISOString() }
  });

  return reply.code(201).send({
    token,
    item: {
      ...item,
      state: projectIngestTokenState(item)
    }
  });
});

app.patch('/v1/projects/:id/ingest-tokens/:tokenId', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'projectParam' }) }, async (request, reply) => {
  const { id, tokenId } = request.params;
  const { label, ttlDays, expiresAt } = request.body || {};

  if (ttlDays !== undefined && ttlDays !== null && ttlDays !== '' && expiresAt !== undefined) {
    return reply.code(400).send({ error: 'provide either ttlDays or expiresAt, not both' });
  }

  const projectRes = await query(
    `select id, workspace_id
     from projects
     where id = $1`,
    [id]
  );
  const project = projectRes.rows[0] || null;
  if (!project) return reply.code(404).send({ error: 'not_found' });

  const tokenRes = await query(
    `select id, workspace_id, project_id, label, expires_at, revoked_at, created_at
     from project_ingest_tokens
     where id = $1 and project_id = $2`,
    [tokenId, id]
  );
  const tokenRow = tokenRes.rows[0] || null;
  if (!tokenRow) return reply.code(404).send({ error: 'not_found' });
  if (tokenRow.revoked_at) return reply.code(400).send({ error: 'cannot_update_revoked_token' });

  const updates = [];
  const values = [tokenId, id];
  let valueIdx = 3;
  const auditMeta = { projectId: id };

  if (label !== undefined) {
    const trimmedLabel = String(label || '').trim();
    if (!trimmedLabel) return reply.code(400).send({ error: 'label cannot be empty' });
    updates.push(`label = $${valueIdx++}`);
    values.push(trimmedLabel);
    auditMeta.label = trimmedLabel;
  }

  if (ttlDays !== undefined && ttlDays !== null && ttlDays !== '') {
    const ttl = normalizeTtlDays(ttlDays, PROJECT_INGEST_TOKEN_DEFAULT_TTL_DAYS, PROJECT_INGEST_TOKEN_MAX_TTL_DAYS);
    if (!ttl.ok) return reply.code(400).send({ error: ttl.error });
    const nextExpiresAt = buildExpiresAtFromTtlDays(ttl.value);
    updates.push(`expires_at = $${valueIdx++}::timestamptz`);
    values.push(nextExpiresAt.toISOString());
    updates.push(`meta_json = coalesce(meta_json, '{}'::jsonb) || $${valueIdx++}::jsonb`);
    values.push(JSON.stringify({ ttlDays: ttl.value }));
    auditMeta.ttlDays = ttl.value;
    auditMeta.expiresAt = nextExpiresAt.toISOString();
  } else {
    const parsedExpires = parseExpiresAtInput(expiresAt);
    if (parsedExpires.error) return reply.code(400).send({ error: parsedExpires.error });
    if (parsedExpires.provided) {
      if (parsedExpires.value && parsedExpires.value.getTime() <= Date.now()) {
        return reply.code(400).send({ error: 'expiresAt must be in the future' });
      }
      updates.push(`expires_at = $${valueIdx++}::timestamptz`);
      values.push(parsedExpires.value ? parsedExpires.value.toISOString() : null);
      auditMeta.expiresAt = parsedExpires.value ? parsedExpires.value.toISOString() : null;
    }
  }

  if (!updates.length) {
    return reply.code(400).send({ error: 'No changes requested. Provide label, ttlDays, or expiresAt.' });
  }

  const updated = await query(
    `update project_ingest_tokens
     set ${updates.join(', ')}
     where id = $1 and project_id = $2
     returning id, workspace_id, project_id, label, token_hint, created_by, last_used_at,
               expires_at, revoked_at, revoked_by, created_at`,
    values
  );

  const item = updated.rows[0] || null;
  if (!item) return reply.code(404).send({ error: 'not_found' });

  await recordAuditLog({
    workspaceId: project.workspace_id,
    actorUserId: request.auth?.userId,
    action: 'project.ingest_token.updated',
    entityType: 'project_ingest_token',
    entityId: item.id,
    meta: auditMeta
  });

  return reply.code(200).send({
    item: {
      ...item,
      state: projectIngestTokenState(item)
    }
  });
});

app.post('/v1/projects/:id/ingest-tokens/:tokenId/revoke', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'projectParam' }) }, async (request, reply) => {
  const { id, tokenId } = request.params;

  const projectRes = await query(
    `select id, workspace_id
     from projects
     where id = $1`,
    [id]
  );
  const project = projectRes.rows[0] || null;
  if (!project) return reply.code(404).send({ error: 'not_found' });

  const tokenRes = await query(
    `select id, revoked_at
     from project_ingest_tokens
     where id = $1 and project_id = $2`,
    [tokenId, id]
  );
  const tokenRow = tokenRes.rows[0] || null;
  if (!tokenRow) return reply.code(404).send({ error: 'not_found' });

  if (!tokenRow.revoked_at) {
    await query(
      `update project_ingest_tokens
       set revoked_at = now(), revoked_by = $3
       where id = $1 and project_id = $2`,
      [tokenId, id, request.auth?.userId || null]
    );

    await recordAuditLog({
      workspaceId: project.workspace_id,
      actorUserId: request.auth?.userId,
      action: 'project.ingest_token.revoked',
      entityType: 'project_ingest_token',
      entityId: tokenId,
      meta: { projectId: id }
    });
  }

  const refreshed = await query(
    `select id, workspace_id, project_id, label, token_hint, created_by, last_used_at,
            expires_at, revoked_at, revoked_by, created_at
     from project_ingest_tokens
     where id = $1 and project_id = $2`,
    [tokenId, id]
  );
  const item = refreshed.rows[0] || null;
  if (!item) return reply.code(404).send({ error: 'not_found' });

  return reply.code(200).send({
    item: {
      ...item,
      state: projectIngestTokenState(item)
    }
  });
});

app.get('/v1/runs', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'query.workspaceId' }) }, async (request, reply) => {
  const {
    workspaceId,
    projectId,
    branch = null,
    status = null,
    from = null,
    to = null,
    page = 1,
    limit = 20
  } = request.query || {};

  if (!workspaceId || !projectId) {
    return reply.code(400).send({ error: 'workspaceId and projectId are required' });
  }

  const normalizedPage = normalizePage(page);
  const normalizedLimit = normalizeLimit(limit, 20);
  const offset = (normalizedPage - 1) * normalizedLimit;

  const countRes = await query(
    `select count(*)::int as total
     from runs
     where workspace_id = $1
       and project_id = $2
       and ($3::text is null or branch = $3)
       and ($4::text is null or status = $4)
       and ($5::timestamptz is null or created_at >= $5::timestamptz)
       and ($6::timestamptz is null or created_at <= $6::timestamptz)`,
    [workspaceId, projectId, branch, status, from, to]
  );

  const { rows } = await query(
    `select id, workspace_id, project_id, status, branch, commit_sha, started_at, finished_at,
            total_specs, total_tests, pass_count, fail_count, flaky_count, created_at
     from runs
     where workspace_id = $1
       and project_id = $2
       and ($3::text is null or branch = $3)
       and ($4::text is null or status = $4)
       and ($5::timestamptz is null or created_at >= $5::timestamptz)
       and ($6::timestamptz is null or created_at <= $6::timestamptz)
     order by created_at desc
     limit $7 offset $8`,
    [workspaceId, projectId, branch, status, from, to, normalizedLimit, offset]
  );

  return {
    items: rows,
    pageInfo: buildPageInfo(countRes.rows[0]?.total, normalizedPage, normalizedLimit)
  };
});

app.get('/v1/runs/:id', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'runParam' }) }, async (request, reply) => {
  const { id } = request.params;
  const runBundle = await fetchRunSummary(id);
  if (!runBundle) return reply.code(404).send({ error: 'not_found' });

  const specs = await query(
    `select id, run_id, machine_id, spec_path, status, attempts, duration_ms, started_at, finished_at, created_at
     from spec_runs
     where run_id = $1
     order by created_at asc`,
    [id]
  );

  const specIds = specs.rows.map((row) => row.id);
  const tests = specIds.length
    ? await query(
      `select tr.id, tr.spec_run_id, tr.test_case_id, tr.attempt_no, tr.status, tr.duration_ms,
              tr.error_hash, tr.error_message, tr.stacktrace, tr.retried_from_result_id, tr.created_at,
              tc.title as test_title, tc.file_path, tc.suite_path
       from test_results tr
       left join test_cases tc on tc.id = tr.test_case_id
       where tr.spec_run_id = any($1::uuid[])
       order by tr.created_at asc`,
      [specIds]
    )
    : { rows: [] };

  const artifacts = await query(
    `select id, run_id, spec_run_id, test_result_id, type, storage_key, content_type, byte_size, checksum, created_at
     from artifacts
     where run_id = $1
     order by created_at asc`,
    [id]
  );

  return {
    item: runBundle.item,
    summary: runBundle.summary,
    specs: specs.rows,
    tests: tests.rows,
    artifacts: artifacts.rows
  };
});

app.get('/v1/runs/:id/summary', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'runParam' }) }, async (request, reply) => {
  const runBundle = await fetchRunSummary(request.params.id);
  if (!runBundle) return reply.code(404).send({ error: 'not_found' });
  return runBundle;
});

app.get('/v1/runs/:runId/specs', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: async (request) => resolveWorkspaceIdFromRequestPart(request, 'runParam') }) }, async (request, reply) => {
  const { runId } = request.params;
  const { status = null, page = 1, limit = 50 } = request.query || {};
  const normalizedPage = normalizePage(page);
  const normalizedLimit = normalizeLimit(limit, 50);
  const offset = (normalizedPage - 1) * normalizedLimit;

  const totalRes = await query(
    `select count(*)::int as total
     from spec_runs
     where run_id = $1
       and ($2::text is null or status = $2)`,
    [runId, status]
  );

  const { rows } = await query(
    `select id, run_id, machine_id, spec_path, status, attempts, duration_ms, started_at, finished_at, created_at
     from spec_runs
     where run_id = $1
       and ($2::text is null or status = $2)
     order by created_at asc
     limit $3 offset $4`,
    [runId, status, normalizedLimit, offset]
  );

  return {
    items: rows,
    pageInfo: buildPageInfo(totalRes.rows[0]?.total, normalizedPage, normalizedLimit)
  };
});

app.get('/v1/spec-runs/:id/tests', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'specParam' }) }, async (request, reply) => {
  const { id } = request.params;
  const { status = null, page = 1, limit = 50 } = request.query || {};
  const normalizedPage = normalizePage(page);
  const normalizedLimit = normalizeLimit(limit, 50);
  const offset = (normalizedPage - 1) * normalizedLimit;

  const totalRes = await query(
    `select count(*)::int as total
     from test_results
     where spec_run_id = $1
       and ($2::text is null or status = $2)`,
    [id, status]
  );

  const { rows } = await query(
    `select tr.id, tr.spec_run_id, tr.test_case_id, tr.attempt_no, tr.status, tr.duration_ms,
            tr.error_hash, tr.error_message, tr.stacktrace, tr.retried_from_result_id, tr.created_at,
            tc.title, tc.file_path, tc.suite_path
     from test_results tr
     join test_cases tc on tc.id = tr.test_case_id
     where tr.spec_run_id = $1
       and ($2::text is null or tr.status = $2)
     order by tr.created_at asc
     limit $3 offset $4`,
    [id, status, normalizedLimit, offset]
  );

  return {
    items: rows,
    pageInfo: buildPageInfo(totalRes.rows[0]?.total, normalizedPage, normalizedLimit)
  };
});

app.get('/v1/tests/:testCaseId/history', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'testCaseParam' }) }, async (request, reply) => {
  const { testCaseId } = request.params;
  const { status = null, page = 1, limit = 50 } = request.query || {};
  const normalizedPage = normalizePage(page);
  const normalizedLimit = normalizeLimit(limit, 50);
  const offset = (normalizedPage - 1) * normalizedLimit;

  const totalRes = await query(
    `select count(*)::int as total
     from test_results
     where test_case_id = $1
       and ($2::text is null or status = $2)`,
    [testCaseId, status]
  );

  const { rows } = await query(
    `select tr.id, tr.spec_run_id, tr.test_case_id, tr.attempt_no, tr.status, tr.duration_ms,
            tr.error_hash, tr.error_message, tr.stacktrace, tr.retried_from_result_id, tr.created_at,
            sr.spec_path, r.id as run_id, r.branch, r.status as run_status
     from test_results tr
     join spec_runs sr on sr.id = tr.spec_run_id
     join runs r on r.id = sr.run_id
     where tr.test_case_id = $1
       and ($2::text is null or tr.status = $2)
     order by tr.created_at desc
     limit $3 offset $4`,
    [testCaseId, status, normalizedLimit, offset]
  );

  return {
    items: rows,
    pageInfo: buildPageInfo(totalRes.rows[0]?.total, normalizedPage, normalizedLimit)
  };
});

app.get('/v1/analytics/flaky', async (request, reply) => {
  const { projectId, window = 14, seed = DEFAULT_ANALYTICS_SEED } = request.query || {};
  if (!projectId) return reply.code(400).send({ error: 'projectId is required' });
  const workspaceId = await resolveProjectWorkspace(projectId);
  const guard = workspaceGuard({ role: 'viewer', resolveWorkspaceId: async () => workspaceId });
  const guardResponse = await guard(request, reply);
  if (guardResponse) return guardResponse;

  const items = await computeFlakeScores({
    projectId,
    windowDays: clamp(Number(window) || 14, 1, 90),
    seed
  });
  return { items, seed };
});

app.get('/v1/analytics/failures/clusters', async (request, reply) => {
  const { projectId, window = 14, seed = DEFAULT_ANALYTICS_SEED } = request.query || {};
  if (!projectId) return reply.code(400).send({ error: 'projectId is required' });
  const workspaceId = await resolveProjectWorkspace(projectId);
  const guard = workspaceGuard({ role: 'viewer', resolveWorkspaceId: async () => workspaceId });
  const guardResponse = await guard(request, reply);
  if (guardResponse) return guardResponse;

  const items = await computeFailureClusters({
    projectId,
    windowDays: clamp(Number(window) || 14, 1, 90),
    seed
  });
  return { items, seed };
});

app.post('/v1/orchestrator/plan', async (request, reply) => {
  const {
    workspaceId,
    projectId,
    runId = null,
    specPaths = [],
    shardCount = 2,
    strategy = 'timing-aware',
    seed = DEFAULT_ANALYTICS_SEED
  } = request.body || {};

  if (!workspaceId || !projectId) {
    return reply.code(400).send({ error: 'workspaceId and projectId are required' });
  }

  const guard = workspaceGuard({ role: 'member', resolveWorkspaceId: async () => workspaceId });
  const guardResponse = await guard(request, reply);
  if (guardResponse) return guardResponse;

  const plan = await createOrchestratorPlan({
    workspaceId,
    projectId,
    runId,
    specPaths: ensureArray(specPaths),
    shardCount: clamp(Number(shardCount) || 2, 1, 64),
    strategy: strategy === 'duration-balanced' ? 'duration-balanced' : 'timing-aware',
    seed
  });

  return reply.code(201).send(plan);
});

app.get('/v1/orchestrator/runs/:runId/shards', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: async (request) => resolveWorkspaceIdFromRequestPart(request, 'runParam') }) }, async (request, reply) => {
  const { runId } = request.params;
  const { shardCount = 2, seed = DEFAULT_ANALYTICS_SEED } = request.query || {};
  const run = await fetchRun(runId);
  if (!run) return reply.code(404).send({ error: 'not_found' });

  const specRows = await query(
    `select spec_path
     from spec_runs
     where run_id = $1
     order by created_at asc`,
    [runId]
  );

  const plan = await createOrchestratorPlan({
    workspaceId: run.workspace_id,
    projectId: run.project_id,
    runId: null,
    specPaths: specRows.rows.map((row) => row.spec_path),
    shardCount: clamp(Number(shardCount) || 2, 1, 64),
    strategy: 'timing-aware',
    seed
  });

  return plan;
});

app.post('/v1/orchestrator/retry-failures/:runId', { preHandler: workspaceGuard({ role: 'member', resolveWorkspaceId: async (request) => resolveWorkspaceIdFromRequestPart(request, 'runParam') }) }, async (request, reply) => {
  const { runId } = request.params;
  const { shardCount = 2, seed = DEFAULT_ANALYTICS_SEED } = request.body || {};
  const run = await fetchRun(runId);
  if (!run) return reply.code(404).send({ error: 'not_found' });

  const failed = await query(
    `select distinct sr.spec_path, tc.id as test_case_id, tc.title
     from test_results tr
     join spec_runs sr on sr.id = tr.spec_run_id
     join test_cases tc on tc.id = tr.test_case_id
     where sr.run_id = $1
       and tr.status in ('failed', 'flaky')
     order by sr.spec_path asc, tc.title asc`,
    [runId]
  );

  const specPaths = [...new Set(failed.rows.map((row) => row.spec_path))];
  const plan = await createOrchestratorPlan({
    workspaceId: run.workspace_id,
    projectId: run.project_id,
    runId: null,
    specPaths,
    shardCount: clamp(Number(shardCount) || 2, 1, 64),
    strategy: 'timing-aware',
    seed
  });

  return reply.code(201).send({
    runId,
    failedSpecCount: specPaths.length,
    failedTests: failed.rows,
    retryPlan: plan
  });
});

app.post('/v1/artifacts/sign-upload', async (request, reply) => {
  const {
    workspaceId,
    runId,
    specRunId = null,
    testResultId = null,
    type,
    fileName = null,
    contentType = 'application/octet-stream',
    byteSize = null,
    checksum = null
  } = request.body || {};

  if (!workspaceId || !runId || !type) {
    return reply.code(400).send({ error: 'workspaceId, runId, and type are required' });
  }

  const guard = workspaceGuard({ role: 'member', resolveWorkspaceId: async () => workspaceId });
  const guardResponse = await guard(request, reply);
  if (guardResponse) return guardResponse;

  const run = await fetchRun(runId);
  if (!run || run.workspace_id !== workspaceId) {
    return reply.code(400).send({ error: 'run_not_in_workspace' });
  }

  const artifactId = crypto.randomUUID();
  const storageKey = buildArtifactStorageKey({ workspaceId, runId, artifactId, fileName: fileName || `${type}.bin` });
  const insert = await query(
    `insert into artifacts(id, run_id, spec_run_id, test_result_id, type, storage_key, content_type, byte_size, checksum)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [artifactId, runId, specRunId, testResultId, type, storageKey, contentType, byteSize, checksum]
  );

  const expiresAt = new Date(Date.now() + (ARTIFACT_SIGN_TTL_SEC * 1000)).toISOString();
  const token = await createArtifactGrant({
    artifactId,
    workspaceId,
    action: 'upload',
    expiresAt,
    meta: { byteSize, checksum, contentType, backend: STORAGE_BACKEND }
  });

  return reply.code(201).send({
    item: insert.rows[0],
    upload: {
      backend: STORAGE_BACKEND,
      method: 'PUT',
      expiresAt,
      bucket: STORAGE_BUCKET,
      storageKey,
      url: buildArtifactSignedUrl(request, artifactId, token, 'upload'),
      headers: {
        'content-type': contentType,
        'x-testharbor-artifact-token': token
      }
    }
  });
});

app.get('/v1/artifacts/:id/sign-download', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'artifactParam' }) }, async (request, reply) => {
  const { id } = request.params;
  const artifactRes = await query(
    `select a.*, r.workspace_id
     from artifacts a
     join runs r on r.id = a.run_id
     where a.id = $1`,
    [id]
  );
  const artifact = artifactRes.rows[0];
  if (!artifact) return reply.code(404).send({ error: 'not_found' });

  const expiresAt = new Date(Date.now() + (ARTIFACT_SIGN_TTL_SEC * 1000)).toISOString();
  const token = await createArtifactGrant({
    artifactId: id,
    workspaceId: artifact.workspace_id,
    action: 'download',
    expiresAt,
    meta: { storageKey: artifact.storage_key, backend: STORAGE_BACKEND }
  });

  return {
    item: artifact,
    download: {
      backend: STORAGE_BACKEND,
      expiresAt,
      bucket: STORAGE_BUCKET,
      storageKey: artifact.storage_key,
      url: buildArtifactSignedUrl(request, id, token, 'download')
    }
  };
});

app.put('/v1/artifacts/upload/:id', async (request, reply) => {
  const { id } = request.params;
  const token = request.query?.token || request.headers['x-testharbor-artifact-token'];
  const grant = await validateArtifactGrant({ artifactId: id, action: 'upload', token });
  if (!grant) return reply.code(403).send({ error: 'invalid_artifact_grant' });
  await markArtifactGrantUsed(grant.id);

  if (ARTIFACT_PROXY_MODE === 'json') {
    return reply.code(200).send({
      ok: true,
      artifactId: id,
      backend: STORAGE_BACKEND,
      proxyMode: ARTIFACT_PROXY_MODE,
      message: 'Upload token validated. Configure object storage write-through for binary persistence.'
    });
  }

  return reply.code(501).send({ error: 'artifact_upload_proxy_not_implemented' });
});

app.get('/v1/artifacts/download/:id', async (request, reply) => {
  const { id } = request.params;
  const token = request.query?.token || request.headers['x-testharbor-artifact-token'];
  const grant = await validateArtifactGrant({ artifactId: id, action: 'download', token });
  if (!grant) return reply.code(403).send({ error: 'invalid_artifact_grant' });

  const artifactRes = await query(
    `select id, run_id, spec_run_id, test_result_id, type, storage_key, content_type, byte_size, checksum, created_at
     from artifacts
     where id = $1`,
    [id]
  );
  if (!artifactRes.rows.length) return reply.code(404).send({ error: 'not_found' });

  await markArtifactGrantUsed(grant.id);

  return {
    ok: true,
    backend: STORAGE_BACKEND,
    bucket: STORAGE_BUCKET,
    proxyMode: ARTIFACT_PROXY_MODE,
    item: artifactRes.rows[0]
  };
});

async function listWebhookEndpointsHandler(request, reply) {
  const { workspaceId } = request.query || {};
  if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });

  const { rows } = await query(
    `select id, workspace_id, type, target_url, enabled, created_at
     from webhook_endpoints
     where workspace_id = $1
     order by created_at desc`,
    [workspaceId]
  );
  return { items: rows };
}

async function createWebhookEndpointHandler(request, reply) {
  const { workspaceId, type, targetUrl, secret = null, enabled = true } = request.body || {};
  if (!workspaceId || !type || !targetUrl) {
    return reply.code(400).send({ error: 'workspaceId, type, targetUrl are required' });
  }

  const { rows } = await query(
    `insert into webhook_endpoints(workspace_id, type, target_url, secret, enabled)
     values ($1, $2, $3, $4, $5)
     returning id, workspace_id, type, target_url, enabled, created_at`,
    [workspaceId, type, targetUrl, secret, enabled]
  );

  return reply.code(201).send({ item: rows[0] });
}

async function patchWebhookEndpointHandler(request, reply) {
  const { id } = request.params;
  const body = request.body || {};
  const hasTargetUrl = Object.prototype.hasOwnProperty.call(body, 'targetUrl');
  const hasSecret = Object.prototype.hasOwnProperty.call(body, 'secret');
  const hasEnabled = Object.prototype.hasOwnProperty.call(body, 'enabled');
  const { targetUrl, secret, enabled } = body;

  if (!hasTargetUrl && !hasSecret && !hasEnabled) {
    return reply.code(400).send({ error: 'at least one of targetUrl, secret, enabled is required' });
  }
  if (hasTargetUrl && (!targetUrl || typeof targetUrl !== 'string')) {
    return reply.code(400).send({ error: 'targetUrl must be a non-empty string when provided' });
  }
  if (hasEnabled && typeof enabled !== 'boolean') {
    return reply.code(400).send({ error: 'enabled must be boolean when provided' });
  }
  if (hasSecret && !(secret === null || typeof secret === 'string')) {
    return reply.code(400).send({ error: 'secret must be string|null when provided' });
  }

  const { rows } = await query(
    `update webhook_endpoints
     set target_url = case when $2::boolean then $3 else target_url end,
         secret = case when $4::boolean then $5 else secret end,
         enabled = case when $6::boolean then $7 else enabled end
     where id = $1
     returning id, workspace_id, type, target_url, enabled, created_at`,
    [
      id,
      hasTargetUrl,
      hasTargetUrl ? targetUrl : null,
      hasSecret,
      hasSecret ? secret : null,
      hasEnabled,
      hasEnabled ? enabled : null
    ]
  );

  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return { item: rows[0] };
}

async function deleteWebhookEndpointHandler(request, reply) {
  const { id } = request.params;
  const workspaceLookup = await query('select workspace_id from webhook_endpoints where id = $1', [id]);
  const workspaceId = workspaceLookup.rows[0]?.workspace_id || null;
  const { rows } = await query(
    `delete from webhook_endpoints
     where id = $1
     returning id`,
    [id]
  );

  if (!rows.length) return reply.code(404).send({ error: 'not_found' });

  await recordAuditLog({
    workspaceId,
    actorUserId: request.auth?.userId,
    action: 'webhook.deleted',
    entityType: 'webhook_endpoint',
    entityId: id
  });

  return reply.code(204).send();
}

app.get('/v1/webhook-endpoints', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'query.workspaceId' }) }, listWebhookEndpointsHandler);
app.post('/v1/webhook-endpoints', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'body.workspaceId' }) }, createWebhookEndpointHandler);
app.patch('/v1/webhook-endpoints/:id', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: async (request) => {
  const res = await query('select workspace_id from webhook_endpoints where id = $1', [request.params.id]);
  return res.rows[0]?.workspace_id || null;
} }) }, patchWebhookEndpointHandler);
app.delete('/v1/webhook-endpoints/:id', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: async (request) => {
  const res = await query('select workspace_id from webhook_endpoints where id = $1', [request.params.id]);
  return res.rows[0]?.workspace_id || null;
} }) }, deleteWebhookEndpointHandler);

app.get('/v1/webhooks', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'query.workspaceId' }) }, listWebhookEndpointsHandler);
app.post('/v1/webhooks', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'body.workspaceId' }) }, createWebhookEndpointHandler);
app.patch('/v1/webhooks/:id', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: async (request) => {
  const res = await query('select workspace_id from webhook_endpoints where id = $1', [request.params.id]);
  return res.rows[0]?.workspace_id || null;
} }) }, patchWebhookEndpointHandler);
app.delete('/v1/webhooks/:id', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: async (request) => {
  const res = await query('select workspace_id from webhook_endpoints where id = $1', [request.params.id]);
  return res.rows[0]?.workspace_id || null;
} }) }, deleteWebhookEndpointHandler);

app.get('/v1/webhook-deliveries', { preHandler: workspaceGuard({ role: 'viewer', resolveWorkspaceId: 'query.workspaceId' }) }, async (request, reply) => {
  const { workspaceId, status = null, page = 1, limit = 50 } = request.query || {};
  if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });

  const normalizedPage = normalizePage(page);
  const normalizedLimit = normalizeLimit(limit, 50);
  const offset = (normalizedPage - 1) * normalizedLimit;

  const countRes = await query(
    `select count(*)::int as total
     from webhook_deliveries
     where workspace_id = $1 and ($2::text is null or status = $2)`,
    [workspaceId, status]
  );

  const { rows } = await query(
    `select id, notification_event_id, webhook_endpoint_id, event_type, target_url,
            attempt_count, max_attempts, status, next_retry_at, last_attempt_at, delivered_at,
            response_status, last_error, created_at, updated_at
     from webhook_deliveries
     where workspace_id = $1 and ($2::text is null or status = $2)
     order by created_at desc
     limit $3 offset $4`,
    [workspaceId, status, normalizedLimit, offset]
  );

  return {
    items: rows,
    pageInfo: buildPageInfo(countRes.rows[0]?.total, normalizedPage, normalizedLimit)
  };
});

app.post('/v1/notifications/format', async (request, reply) => {
  const { workspaceId, runId, channel = 'slack' } = request.body || {};
  if (!workspaceId || !runId) return reply.code(400).send({ error: 'workspaceId and runId are required' });

  const guard = workspaceGuard({ role: 'member', resolveWorkspaceId: async () => workspaceId });
  const guardResponse = await guard(request, reply);
  if (guardResponse) return guardResponse;

  const runBundle = await fetchRunSummary(runId);
  if (!runBundle) return reply.code(404).send({ error: 'not_found' });
  return formatNotificationPayload({ channel, runBundle, workspaceId });
});

app.post('/v1/notifications/pr-feedback', async (request, reply) => {
  const { workspaceId, runId } = request.body || {};
  if (!workspaceId || !runId) return reply.code(400).send({ error: 'workspaceId and runId are required' });

  const guard = workspaceGuard({ role: 'member', resolveWorkspaceId: async () => workspaceId });
  const guardResponse = await guard(request, reply);
  if (guardResponse) return guardResponse;

  const runBundle = await fetchRunSummary(runId);
  if (!runBundle) return reply.code(404).send({ error: 'not_found' });
  return formatNotificationPayload({ channel: 'github-pr', runBundle, workspaceId });
});

app.post('/v1/notifications/test', async (request, reply) => {
  const {
    workspaceId,
    runId = null,
    channel = 'slack',
    eventType = 'notification.test',
    message = 'TestHarbor notification smoke'
  } = request.body || {};
  if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });

  const guard = workspaceGuard({ role: 'admin', resolveWorkspaceId: async () => workspaceId });
  const guardResponse = await guard(request, reply);
  if (guardResponse) return guardResponse;

  const runBundle = runId ? await fetchRunSummary(runId) : null;
  const formatted = runBundle
    ? formatNotificationPayload({ channel, runBundle, workspaceId })
    : { channel, payload: { text: message } };

  const result = await queueWebhookFanout({
    workspaceId,
    runId,
    eventType,
    payload: {
      eventType,
      channel: formatted.channel,
      message,
      formatted: formatted.payload
    }
  });

  return reply.code(202).send({
    ok: true,
    notificationEvent: result.event,
    deliveryCount: result.deliveryCount,
    payload: formatted.payload
  });
});

app.get('/v1/audit-logs', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'query.workspaceId' }) }, async (request, reply) => {
  const { workspaceId, limit = 50 } = request.query || {};
  if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });
  const capped = normalizeLimit(limit, 50, 200);

  const { rows } = await query(
    `select id, workspace_id, actor_user_id, action, entity_type, entity_id, meta_json, ts
     from audit_logs
     where workspace_id = $1
     order by ts desc
     limit $2`,
    [workspaceId, capped]
  );

  return { items: rows };
});

app.post('/v1/retention/run', { preHandler: workspaceGuard({ role: 'admin', resolveWorkspaceId: 'body.workspaceId' }) }, async (request, reply) => {
  const { workspaceId } = request.body || {};
  if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });

  const result = await purgeRetentionWorkspace(workspaceId, request.auth?.userId);
  return reply.code(200).send(result);
});

app.delete('/v1/organizations/:id/smoke-cleanup', async (request, reply) => {
  if (!API_AUTH_TOKEN) {
    return reply.code(403).send({ error: 'smoke_org_cleanup_requires_api_token' });
  }
  if (process.env.ALLOW_SMOKE_ORG_CLEANUP !== '1') {
    return reply.code(403).send({ error: 'smoke_org_cleanup_disabled' });
  }
  if (request.query?.confirm !== 'delete-smoke-organization') {
    return reply.code(400).send({ error: 'confirm=delete-smoke-organization is required' });
  }

  const { id } = request.params;
  const orgRes = await query(
    `select id, slug, name, created_at
     from organizations
     where id = $1`,
    [id]
  );
  if (!orgRes.rows.length) return reply.code(404).send({ error: 'not_found' });

  const organization = orgRes.rows[0];
  if (!/^webhook-org-\d[\da-z-]*$/.test(organization.slug)) {
    return reply.code(400).send({ error: 'organization_not_eligible_for_smoke_cleanup', slug: organization.slug });
  }

  const workspaceRes = await query(
    `select id, slug
     from workspaces
     where organization_id = $1
     order by created_at asc`,
    [id]
  );
  if (workspaceRes.rows.length !== 1) {
    return reply.code(400).send({ error: 'organization_not_isolated', workspaceCount: workspaceRes.rows.length });
  }

  const workspace = workspaceRes.rows[0];
  if (!/^webhook-workspace-\d[\da-z-]*$/.test(workspace.slug)) {
    return reply.code(400).send({ error: 'workspace_not_eligible_for_smoke_cleanup', slug: workspace.slug });
  }

  const projectRes = await query(
    `select id, slug
     from projects
     where workspace_id = $1
     order by created_at asc`,
    [workspace.id]
  );
  if (projectRes.rows.length > 3) {
    return reply.code(400).send({ error: 'organization_not_bounded', projectCount: projectRes.rows.length });
  }
  if (projectRes.rows.some((project) => !/^webhook-project-\d[\da-z-]*$/.test(project.slug))) {
    return reply.code(400).send({ error: 'project_not_eligible_for_smoke_cleanup' });
  }

  await query('delete from organizations where id = $1', [id]);

  await recordAuditLog({
    workspaceId: workspace.id,
    actorUserId: request.auth?.userId,
    action: 'organization.smoke_cleanup',
    entityType: 'organization',
    entityId: id,
    meta: {
      organizationSlug: organization.slug,
      deletedProjectCount: projectRes.rows.length
    }
  });

  return reply.code(200).send({
    ok: true,
    organizationId: id,
    organizationSlug: organization.slug,
    deletedWorkspaceId: workspace.id,
    deletedProjectCount: projectRes.rows.length
  });
});

app.setErrorHandler((error, _req, reply) => {
  app.log.error(error);
  if (error.code === '23505') return reply.code(409).send({ error: 'conflict', detail: error.detail });
  return reply.code(500).send({ error: 'internal_error' });
});

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
