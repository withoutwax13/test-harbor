import crypto from 'node:crypto';

const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const ingestBase = process.env.INGEST_BASE_URL || 'http://localhost:4010';

async function jsonFetch(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
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
  });

  const project = await jsonFetch(`${apiBase}/v1/projects`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: ws.item.id,
      name: 'Local Project',
      slug: 'local-project',
      repoUrl: 'https://example.com/repo.git',
      defaultBranch: 'main'
    })
  });

  return { workspaceId: ws.item.id, projectId: project.item.id };
}

async function sendIngest(type, payload) {
  return jsonFetch(`${ingestBase}/v1/ingest/events`, {
    method: 'POST',
    body: JSON.stringify({
      type,
      idempotencyKey: crypto.randomUUID(),
      payload
    })
  });
}

async function runSmoke(workspaceId, projectId) {
  const runId = crypto.randomUUID();
  const specRunId = crypto.randomUUID();
  const testResultId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();

  await sendIngest('run.started', { runId, workspaceId, projectId, branch: 'main', commitSha: 'smoke123', ciProvider: 'local' });
  await sendIngest('spec.started', { specRunId, runId, specPath: 'cypress/e2e/smoke.cy.ts' });
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
  });
  await sendIngest('artifact.registered', {
    artifactId,
    runId,
    specRunId,
    testResultId,
    type: 'video',
    storageKey: `artifacts/${runId}/video.mp4`,
    contentType: 'video/mp4',
    byteSize: 12345
  });
  await sendIngest('spec.finished', { specRunId, status: 'passed', durationMs: 900, attempts: 1 });
  await sendIngest('run.finished', { runId, status: 'passed', totalSpecs: 1, totalTests: 1, passCount: 1, failCount: 0, flakyCount: 0 });

  return runId;
}

async function verify(workspaceId, projectId, runId) {
  const runs = await jsonFetch(`${apiBase}/v1/runs?workspaceId=${workspaceId}&projectId=${projectId}`);
  const run = await jsonFetch(`${apiBase}/v1/runs/${runId}`);
  return {
    runCount: Array.isArray(runs.items) ? runs.items.length : 0,
    runStatus: run.item?.status,
    specCount: run.specs?.length || 0,
    testCount: run.tests?.length || 0,
    artifactCount: run.artifacts?.length || 0
  };
}

const { workspaceId, projectId } = await seed();
const runId = await runSmoke(workspaceId, projectId);
const summary = await verify(workspaceId, projectId, runId);

console.log(JSON.stringify({
  ok: true,
  apiBase,
  ingestBase,
  workspaceId,
  projectId,
  runId,
  summary
}, null, 2));
