import crypto from 'node:crypto';
import {
  INGEST_EVENT_TYPES,
  REPLAY_V2_EVENT_KINDS,
  REPLAY_V2_LIFECYCLE_EVENTS,
  assertReplayV2ChunkPayload
} from '../packages/shared/src/index.js';

const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const ingestBase = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const apiAuthToken = process.env.API_AUTH_TOKEN || '';
const ingestAuthTokenEnv = process.env.INGEST_AUTH_TOKEN || '';
const autoIngestTokenLabel = process.env.SMOKE_INGEST_TOKEN_LABEL || 'smoke-all-auto';
const autoIngestTokenTtlDays = Number(process.env.SMOKE_INGEST_TOKEN_TTL_DAYS || 1);

async function jsonFetch(url, init, authToken = '') {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(init?.headers || {})
    }
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(`${url} ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function seed() {
  const ws = await jsonFetch(`${apiBase}/v1/workspaces`, {
    method: 'POST',
    body: JSON.stringify({
      organizationName: 'Local Org',
      organizationSlug: 'local-org',
      name: 'Local Workspace',
      slug: 'local-workspace',
      timezone: 'UTC',
      retentionDays: 30
    })
  }, apiAuthToken);

  const project = await jsonFetch(`${apiBase}/v1/projects`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: ws.item.id,
      name: 'Local Project',
      slug: 'local-project',
      repoUrl: 'https://example.com/repo.git',
      defaultBranch: 'main'
    })
  }, apiAuthToken);

  return { workspaceId: ws.item.id, projectId: project.item.id };
}

async function issueProjectIngestToken(projectId) {
  const issued = await jsonFetch(`${apiBase}/v1/projects/${projectId}/ingest-tokens`, {
    method: 'POST',
    body: JSON.stringify({
      label: autoIngestTokenLabel,
      ttlDays: autoIngestTokenTtlDays
    })
  }, apiAuthToken);

  if (!issued?.token) {
    throw new Error('project_ingest_token_missing_in_response');
  }

  return issued.token;
}

async function resolveIngestAuth(projectId) {
  if (ingestAuthTokenEnv) {
    return { token: ingestAuthTokenEnv, source: 'env' };
  }

  try {
    const token = await issueProjectIngestToken(projectId);
    return { token, source: 'auto_minted_project_token' };
  } catch (error) {
    throw new Error(
      `failed_to_issue_project_ingest_token: ${error.message}. ` +
      'Set INGEST_AUTH_TOKEN explicitly or provide API auth context for token minting.'
    );
  }
}

async function sendIngest(type, payload, ingestAuthToken) {
  return jsonFetch(`${ingestBase}/v1/ingest/events`, {
    method: 'POST',
    body: JSON.stringify({
      type,
      idempotencyKey: crypto.randomUUID(),
      payload
    })
  }, ingestAuthToken);
}

function buildReplayV2Chunk(runId, streamId) {
  const startedAtMs = Date.parse('2026-04-03T00:00:00.000Z');
  const targetId = 'tgt_smoke_checkout_button';
  const finId = `fin-${streamId}`;
  const selectorBundle = {
    primary: { dataTestId: 'checkout-button' },
    accessibility: { role: 'button', name: 'Checkout' },
    structural: { cssPath: '#checkout-button' }
  };
  const events = [
    {
      kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE,
      payload: { eventType: REPLAY_V2_LIFECYCLE_EVENTS.SESSION_START }
    },
    {
      kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE,
      targetRef: { targetId, selectorVersion: 1 },
      payload: {
        eventType: REPLAY_V2_LIFECYCLE_EVENTS.TARGET_DECLARE,
        selectorBundle,
        metadata: { nodeName: 'BUTTON' }
      }
    },
    {
      kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE,
      targetRef: { targetId, selectorVersion: 1 },
      payload: {
        eventType: REPLAY_V2_LIFECYCLE_EVENTS.TARGET_BIND,
        selectorBundle,
        metadata: { state: 'attached' }
      }
    },
    {
      kind: REPLAY_V2_EVENT_KINDS.DOM,
      payload: {
        eventType: 'NAVIGATION',
        url: 'https://example.com/checkout',
        title: 'Checkout'
      }
    },
    {
      kind: REPLAY_V2_EVENT_KINDS.COMMAND,
      commandId: 'cmd-smoke-1',
      targetRef: { targetId, selectorVersion: 1 },
      payload: {
        eventType: 'CLICK',
        selectorBundle,
        targetSnapshot: { targetId, label: 'Checkout' }
      }
    },
    {
      kind: REPLAY_V2_EVENT_KINDS.DOM,
      targetRef: { targetId, selectorVersion: 1 },
      payload: {
        eventType: 'MUTATION',
        selectorBundle,
        mutationType: 'attributes',
        attributeName: 'aria-busy',
        value: 'false'
      }
    },
    {
      kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE,
      payload: {
        eventType: REPLAY_V2_LIFECYCLE_EVENTS.TRANSPORT_FIN,
        finId
      }
    },
    {
      kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE,
      payload: {
        eventType: REPLAY_V2_LIFECYCLE_EVENTS.TRANSPORT_ACK,
        finId,
        ack: true
      }
    },
    {
      kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE,
      payload: { eventType: REPLAY_V2_LIFECYCLE_EVENTS.SESSION_END }
    }
  ].map((event, index) => {
    const monotonicTs = (index + 1) * 10;
    return {
      runId,
      streamId,
      seq: index + 1,
      monotonicTs,
      ts: new Date(startedAtMs + monotonicTs).toISOString(),
      ...event
    };
  });

  return assertReplayV2ChunkPayload({
    runId,
    streamId,
    seqStart: 1,
    seqEnd: events.length,
    events
  });
}

async function sendReplayV2Chunk(runId, streamId, ingestAuthToken) {
  const payload = buildReplayV2Chunk(runId, streamId);
  return sendIngest(INGEST_EVENT_TYPES.REPLAY_V2_CHUNK, payload, ingestAuthToken);
}

async function runSmoke(workspaceId, projectId, ingestAuthToken) {
  const runId = crypto.randomUUID();
  const specRunId = crypto.randomUUID();
  const testResultId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();

  await sendIngest('run.started', { runId, workspaceId, projectId, branch: 'main', commitSha: 'smoke123', ciProvider: 'local' }, ingestAuthToken);
  await sendIngest('spec.started', { specRunId, runId, specPath: 'cypress/e2e/smoke.cy.ts' }, ingestAuthToken);
  await sendIngest('test.result', {
    testResultId,
    specRunId,
    projectId,
    stableTestKey: 'smoke.cy.ts::passes basic smoke',
    title: 'passes basic smoke',
    filePath: 'cypress/e2e/smoke.cy.ts',
    suitePath: 'Smoke suite',
    status: 'passed',
    attemptNo: 1,
    durationMs: 412
  }, ingestAuthToken);
  await sendIngest('artifact.registered', {
    artifactId,
    runId,
    specRunId,
    testResultId,
    type: 'video',
    storageKey: `artifacts/${runId}/video.mp4`,
    contentType: 'video/mp4',
    byteSize: 12345
  }, ingestAuthToken);
  await sendReplayV2Chunk(runId, specRunId, ingestAuthToken);
  await sendIngest('spec.finished', { specRunId, status: 'passed', durationMs: 900, attempts: 1 }, ingestAuthToken);
  await sendIngest('run.finished', { runId, status: 'passed', totalSpecs: 1, totalTests: 1, passCount: 1, failCount: 0, flakyCount: 0 }, ingestAuthToken);

  return { runId, streamId: specRunId };
}

async function verify(workspaceId, projectId, runId, streamId) {
  const runs = await jsonFetch(`${apiBase}/v1/runs?workspaceId=${workspaceId}&projectId=${projectId}`, undefined, apiAuthToken);
  const run = await jsonFetch(`${apiBase}/v1/runs/${runId}`, undefined, apiAuthToken);
  const streams = await jsonFetch(`${apiBase}/v1/runs/${runId}/replay-v2/streams`, undefined, apiAuthToken);
  const events = await jsonFetch(`${apiBase}/v1/runs/${runId}/replay-v2/events?${new URLSearchParams({
    streamId,
    limit: '300'
  }).toString()}`, undefined, apiAuthToken);
  const replayStreamCount = Array.isArray(streams.items) ? streams.items.length : 0;
  const replayEventCount = Array.isArray(events.items) ? events.items.length : 0;
  return {
    runCount: Array.isArray(runs.items) ? runs.items.length : 0,
    runStatus: run.item?.status,
    specCount: run.specs?.length || 0,
    testCount: run.tests?.length || 0,
    artifactCount: run.artifacts?.length || 0,
    replayStreamCount,
    replayEventCount,
    replaySelectedStreamPresent: Boolean(streams.items?.some((item) => item.stream_id === streamId)),
    replaySelectedStreamSeqRange: replayStreamCount
      ? `${streams.items.find((item) => item.stream_id === streamId)?.first_seq || 'n/a'}-${streams.items.find((item) => item.stream_id === streamId)?.last_seq || 'n/a'}`
      : 'n/a'
  };
}

function validateSummary(summary) {
  const failures = [];
  if (summary.runStatus !== 'passed') failures.push(`run_status_expected_passed_actual_${summary.runStatus || 'unknown'}`);
  if (summary.specCount < 1) failures.push('spec_count_lt_1');
  if (summary.testCount < 1) failures.push('test_count_lt_1');
  if (summary.artifactCount < 1) failures.push('artifact_count_lt_1');
  if (summary.replayStreamCount < 1) failures.push('replay_stream_count_lt_1');
  if (!summary.replaySelectedStreamPresent) failures.push('replay_selected_stream_missing');
  if (summary.replayEventCount < 1) failures.push('replay_event_count_lt_1');
  return failures;
}

const { workspaceId, projectId } = await seed();
const ingestAuth = await resolveIngestAuth(projectId);
const { runId, streamId } = await runSmoke(workspaceId, projectId, ingestAuth.token);
const summary = await verify(workspaceId, projectId, runId, streamId);
const failures = validateSummary(summary);

if (failures.length) {
  console.log(JSON.stringify({
    ok: false,
    apiBase,
    ingestBase,
    workspaceId,
    projectId,
    runId,
    ingestAuth: { source: ingestAuth.source },
    failures,
    summary
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  apiBase,
  ingestBase,
  workspaceId,
  projectId,
  runId,
  ingestAuth: { source: ingestAuth.source },
  summary
}, null, 2));
