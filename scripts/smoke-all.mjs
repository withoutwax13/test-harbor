import crypto from 'node:crypto';

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
  await sendIngest('spec.finished', { specRunId, status: 'passed', durationMs: 900, attempts: 1 }, ingestAuthToken);
  await sendIngest('run.finished', { runId, status: 'passed', totalSpecs: 1, totalTests: 1, passCount: 1, failCount: 0, flakyCount: 0 }, ingestAuthToken);

  return runId;
}

async function verify(workspaceId, projectId, runId) {
  const runs = await jsonFetch(`${apiBase}/v1/runs?workspaceId=${workspaceId}&projectId=${projectId}`, undefined, apiAuthToken);
  const run = await jsonFetch(`${apiBase}/v1/runs/${runId}`, undefined, apiAuthToken);
  return {
    runCount: Array.isArray(runs.items) ? runs.items.length : 0,
    runStatus: run.item?.status,
    specCount: run.specs?.length || 0,
    testCount: run.tests?.length || 0,
    artifactCount: run.artifacts?.length || 0
  };
}

const { workspaceId, projectId } = await seed();
const ingestAuth = await resolveIngestAuth(projectId);
const runId = await runSmoke(workspaceId, projectId, ingestAuth.token);
const summary = await verify(workspaceId, projectId, runId);

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
