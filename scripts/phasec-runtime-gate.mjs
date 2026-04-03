import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const API = process.env.API_BASE_URL || 'http://localhost:4000';
const INGEST = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const WEB = process.env.WEB_BASE_URL || 'http://localhost:3000';
const ART_DIR = 'artifacts/phasec-runtime-gate';

await fs.mkdir(ART_DIR, { recursive: true });

async function req(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual'
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  return {
    status: res.status,
    text,
    json,
    headers: Object.fromEntries(res.headers.entries())
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function authHeader(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function issueProjectToken({ apiToken, projectId, label, ttlDays = 7 }) {
  const res = await req(`${API}/v1/projects/${projectId}/ingest-tokens`, {
    method: 'POST',
    headers: authHeader(apiToken),
    body: { label, ttlDays }
  });
  assert(res.status === 201 && res.json?.token, `Ingest token issue failed (${projectId}): ${res.status} ${res.text}`);
  return res.json.token;
}

async function ingest({ token, type, payload, idempotencyKey = crypto.randomUUID() }) {
  return req(`${INGEST}/v1/ingest/events`, {
    method: 'POST',
    headers: authHeader(token),
    body: { type, idempotencyKey, payload }
  });
}

const healthApi = await req(`${API}/healthz`);
const healthIngest = await req(`${INGEST}/healthz`);
const healthWeb = await req(`${WEB}/healthz`);
assert(healthApi.status === 200, `API healthz failed: ${healthApi.status}`);
assert(healthIngest.status === 200, `Ingest healthz failed: ${healthIngest.status}`);
assert(healthWeb.status === 200, `Web healthz failed: ${healthWeb.status}`);

const stamp = Date.now();
const login = await req(`${API}/v1/auth/login`, {
  method: 'POST',
  body: {
    email: `phasec+${stamp}@local.test`,
    name: 'Phase C Gate'
  }
});
assert(login.status === 200 && login.json?.token, `Login failed: ${login.status} ${login.text}`);
const apiToken = login.json.token;

const workspace = await req(`${API}/v1/workspaces`, {
  method: 'POST',
  headers: authHeader(apiToken),
  body: {
    organizationName: 'Phase C Org',
    organizationSlug: `phasec-org-${stamp}`,
    name: 'Phase C Workspace',
    slug: `phasec-ws-${stamp}`,
    timezone: 'UTC',
    retentionDays: 30
  }
});
assert(workspace.status === 201 && workspace.json?.item?.id, `Workspace create failed: ${workspace.status} ${workspace.text}`);
const workspaceId = workspace.json.item.id;

const project = await req(`${API}/v1/projects`, {
  method: 'POST',
  headers: authHeader(apiToken),
  body: {
    workspaceId,
    name: 'Phase C Project',
    slug: `phasec-proj-${stamp}`,
    repoUrl: 'https://example.test/repo.git',
    defaultBranch: 'main'
  }
});
assert(project.status === 201 && project.json?.item?.id, `Project create failed: ${project.status} ${project.text}`);
const projectId = project.json.item.id;

const project2 = await req(`${API}/v1/projects`, {
  method: 'POST',
  headers: authHeader(apiToken),
  body: {
    workspaceId,
    name: 'Phase C Project 2',
    slug: `phasec-proj2-${stamp}`,
    repoUrl: 'https://example.test/repo2.git',
    defaultBranch: 'main'
  }
});
assert(project2.status === 201 && project2.json?.item?.id, `Project2 create failed: ${project2.status} ${project2.text}`);
const project2Id = project2.json.item.id;

const ingestToken = await issueProjectToken({ apiToken, projectId, label: `phasec-gate-${stamp}` });
const ingestTokenProject2 = await issueProjectToken({ apiToken, projectId: project2Id, label: `phasec-gate-p2-${stamp}` });

// Ingest auth gate checks
const unauth = await ingest({
  token: '',
  type: 'heartbeat.signal',
  payload: { runId: crypto.randomUUID() }
});
assert(unauth.status === 401, `Expected 401 for missing ingest auth, got ${unauth.status}`);

const scopeMismatchRunId = crypto.randomUUID();
const mismatch = await ingest({
  token: ingestTokenProject2,
  type: 'run.started',
  payload: {
    runId: scopeMismatchRunId,
    workspaceId,
    projectId,
    branch: 'main',
    commitSha: 'phasec-gate-mismatch',
    ciProvider: 'local'
  }
});
assert(mismatch.status === 403, `Expected 403 token_scope_mismatch, got ${mismatch.status} ${mismatch.text}`);
assert(mismatch.json?.error === 'token_scope_mismatch', `Expected token_scope_mismatch body, got ${mismatch.text}`);

// Seed replay-v2 data for main run
const runId = crypto.randomUUID();
const streamDefault = 'default';
const streamAlt = 'alt';
const t0 = Date.now();

const runStarted = await ingest({
  token: ingestToken,
  type: 'run.started',
  payload: {
    runId,
    workspaceId,
    projectId,
    branch: 'main',
    commitSha: 'phasec-gate',
    ciProvider: 'local'
  }
});
assert([200, 202].includes(runStarted.status), `run.started failed: ${runStarted.status} ${runStarted.text}`);

const chunkDefault = await ingest({
  token: ingestToken,
  type: 'replay.v2.chunk',
  payload: {
    runId,
    streamId: streamDefault,
    schemaVersion: '2.0',
    startedAt: new Date(t0).toISOString(),
    chunkIndex: 0,
    seqStart: 1,
    seqEnd: 2,
    events: [
      {
        kind: 'session.start',
        runId,
        streamId: streamDefault,
        seq: 1,
        monotonicMs: 0,
        ts: new Date(t0).toISOString(),
        data: { url: 'https://example.test/default' }
      },
      {
        kind: 'log',
        runId,
        streamId: streamDefault,
        seq: 2,
        monotonicMs: 25,
        ts: new Date(t0 + 25).toISOString(),
        data: { level: 'info', message: 'default-stream' }
      }
    ],
    final: true
  }
});
assert([200, 202].includes(chunkDefault.status), `default chunk failed: ${chunkDefault.status} ${chunkDefault.text}`);

const chunkAlt = await ingest({
  token: ingestToken,
  type: 'replay.v2.chunk',
  payload: {
    runId,
    streamId: streamAlt,
    schemaVersion: '2.0',
    startedAt: new Date(t0 + 1000).toISOString(),
    chunkIndex: 0,
    seqStart: 1,
    seqEnd: 1,
    events: [
      {
        kind: 'log',
        runId,
        streamId: streamAlt,
        seq: 1,
        monotonicMs: 0,
        ts: new Date(t0 + 1000).toISOString(),
        data: { level: 'info', message: 'alt-stream' }
      }
    ],
    final: false
  }
});
assert([200, 202].includes(chunkAlt.status), `alt chunk failed: ${chunkAlt.status} ${chunkAlt.text}`);

// Seed run with no replay streams for empty-state web check
const runNoReplay = crypto.randomUUID();
const runNoReplayStarted = await ingest({
  token: ingestToken,
  type: 'run.started',
  payload: {
    runId: runNoReplay,
    workspaceId,
    projectId,
    branch: 'main',
    commitSha: 'phasec-gate-no-replay',
    ciProvider: 'local'
  }
});
assert([200, 202].includes(runNoReplayStarted.status), `runNoReplay start failed: ${runNoReplayStarted.status} ${runNoReplayStarted.text}`);

// API: streams + events
const streams = await req(`${API}/v1/runs/${runId}/replay-v2/streams`, {
  headers: authHeader(apiToken)
});
assert(streams.status === 200, `Streams endpoint failed: ${streams.status} ${streams.text}`);
assert(Array.isArray(streams.json?.items) && streams.json.items.length >= 2, `Expected >=2 streams, got ${streams.json?.items?.length ?? 'n/a'}`);

const defaultEvents = await req(`${API}/v1/runs/${runId}/replay-v2/events?streamId=${encodeURIComponent(streamDefault)}&limit=300`, {
  headers: authHeader(apiToken)
});
assert(defaultEvents.status === 200, `Events endpoint failed: ${defaultEvents.status} ${defaultEvents.text}`);
assert(Array.isArray(defaultEvents.json?.items) && defaultEvents.json.items.length === 2, `Default events count mismatch: ${defaultEvents.json?.items?.length ?? 'n/a'}`);
assert(defaultEvents.json.items[0]?.seq === 1 && defaultEvents.json.items[1]?.seq === 2, 'Default events sequence ordering mismatch');
assert(defaultEvents.json.items[0]?.chunk_index === 0, `chunk_index missing/mismatch: ${defaultEvents.json.items[0]?.chunk_index}`);
assert(defaultEvents.json.items[0]?.final === true, `final flag mismatch: ${defaultEvents.json.items[0]?.final}`);

const rangeEvents = await req(`${API}/v1/runs/${runId}/replay-v2/events?streamId=${encodeURIComponent(streamDefault)}&fromSeq=2&toSeq=2&limit=10`, {
  headers: authHeader(apiToken)
});
assert(rangeEvents.status === 200, `Range events failed: ${rangeEvents.status} ${rangeEvents.text}`);
assert(Array.isArray(rangeEvents.json?.items) && rangeEvents.json.items.length === 1 && rangeEvents.json.items[0]?.seq === 2, 'fromSeq/toSeq filter mismatch');

const badLimit = await req(`${API}/v1/runs/${runId}/replay-v2/events?streamId=${encodeURIComponent(streamDefault)}&limit=abc`, {
  headers: authHeader(apiToken)
});
assert(badLimit.status === 400, `Invalid limit status mismatch: ${badLimit.status} ${badLimit.text}`);
assert(badLimit.json?.error === 'invalid_limit', `Invalid limit error mismatch: ${badLimit.text}`);

const badRange = await req(`${API}/v1/runs/${runId}/replay-v2/events?streamId=${encodeURIComponent(streamDefault)}&fromSeq=3&toSeq=2`, {
  headers: authHeader(apiToken)
});
assert(badRange.status === 400, `Invalid seq range status mismatch: ${badRange.status} ${badRange.text}`);
assert(badRange.json?.error === 'invalid_seq_range', `Invalid seq range error mismatch: ${badRange.text}`);

// Web viewer checks
const replayFallbackPage = await req(`${WEB}/app/runs/${runId}/replay-v2?streamId=does-not-exist`, {
  headers: {
    cookie: `th_session=${apiToken}`
  }
});
assert(replayFallbackPage.status === 200, `Replay page fallback status mismatch: ${replayFallbackPage.status}`);
assert(replayFallbackPage.text.includes('Replay V2'), 'Replay page missing heading');
assert(replayFallbackPage.text.includes('streamId=default'), 'Replay page did not fall back to first stream');
assert(replayFallbackPage.text.includes('default-stream'), 'Replay fallback page did not load default stream events');

const replayAltPage = await req(`${WEB}/app/runs/${runId}/replay-v2?streamId=${encodeURIComponent(streamAlt)}`, {
  headers: {
    cookie: `th_session=${apiToken}`
  }
});
assert(replayAltPage.status === 200, `Replay page stream-switch status mismatch: ${replayAltPage.status}`);
assert(replayAltPage.text.includes('alt-stream'), 'Replay stream switch did not load alternate stream events');

const replayNoStreamPage = await req(`${WEB}/app/runs/${runNoReplay}/replay-v2`, {
  headers: {
    cookie: `th_session=${apiToken}`
  }
});
assert(replayNoStreamPage.status === 200, `Replay no-stream page status mismatch: ${replayNoStreamPage.status}`);
assert(replayNoStreamPage.text.includes('No replay streams'), 'Replay no-stream empty state missing');

const summary = {
  ok: true,
  branch: 'feat/replay-v2-phase-c-20260403',
  runId,
  runNoReplay,
  workspaceId,
  projectId,
  checks: {
    streamsStatus: streams.status,
    defaultEventsStatus: defaultEvents.status,
    rangeEventsStatus: rangeEvents.status,
    invalidLimitStatus: badLimit.status,
    invalidSeqRangeStatus: badRange.status,
    webFallbackStatus: replayFallbackPage.status,
    webSwitchStatus: replayAltPage.status,
    webNoStreamStatus: replayNoStreamPage.status
  },
  artifacts: {
    summary: `${ART_DIR}/phasec-runtime-gate.json`,
    fallbackHtml: `${ART_DIR}/phasec-runtime-gate-fallback.html`,
    altHtml: `${ART_DIR}/phasec-runtime-gate-alt.html`,
    noStreamHtml: `${ART_DIR}/phasec-runtime-gate-no-stream.html`
  }
};

await fs.writeFile(`${ART_DIR}/phasec-runtime-gate.json`, JSON.stringify(summary, null, 2));
await fs.writeFile(`${ART_DIR}/phasec-runtime-gate-fallback.html`, replayFallbackPage.text);
await fs.writeFile(`${ART_DIR}/phasec-runtime-gate-alt.html`, replayAltPage.text);
await fs.writeFile(`${ART_DIR}/phasec-runtime-gate-no-stream.html`, replayNoStreamPage.text);

console.log(JSON.stringify(summary, null, 2));
