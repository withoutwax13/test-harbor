import crypto from 'node:crypto';

const base = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const workspaceId = process.env.SMOKE_WORKSPACE_ID || '00000000-0000-0000-0000-000000000001';
const projectId = process.env.SMOKE_PROJECT_ID || '00000000-0000-0000-0000-000000000002';
const runId = crypto.randomUUID();
const specRunId = crypto.randomUUID();
const testResultId = crypto.randomUUID();
const artifactId = crypto.randomUUID();

async function send(type, payload) {
  const res = await fetch(`${base}/v1/ingest/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, idempotencyKey: crypto.randomUUID(), payload })
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${type} failed: ${res.status} ${body}`);
  console.log(type, res.status, body);
}

await send('run.started', {
  runId,
  workspaceId,
  projectId,
  branch: 'main',
  commitSha: 'smoke123',
  ciProvider: 'local'
});

await send('spec.started', {
  specRunId,
  runId,
  specPath: 'cypress/e2e/smoke.cy.ts'
});

await send('test.result', {
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

await send('artifact.registered', {
  artifactId,
  runId,
  specRunId,
  testResultId,
  type: 'video',
  storageKey: `artifacts/${runId}/video.mp4`,
  contentType: 'video/mp4',
  byteSize: 12345
});

await send('spec.finished', {
  specRunId,
  status: 'passed',
  durationMs: 900,
  attempts: 1
});

await send('run.finished', {
  runId,
  status: 'passed',
  totalSpecs: 1,
  totalTests: 1,
  passCount: 1,
  failCount: 0,
  flakyCount: 0
});

console.log('Smoke ingest complete. runId=', runId);
