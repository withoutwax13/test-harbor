import crypto from 'node:crypto';

const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const ingestBase = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const ingestAuthToken = process.env.INGEST_AUTH_TOKEN || '';

async function jsonFetch(url, init = {}, authToken = '') {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${url} ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function login(email, name) {
  return jsonFetch(`${apiBase}/v1/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email, name })
  });
}

async function sendIngest(type, payload) {
  return jsonFetch(`${ingestBase}/v1/ingest/events`, {
    method: 'POST',
    body: JSON.stringify({
      type,
      idempotencyKey: crypto.randomUUID(),
      payload
    })
  }, ingestAuthToken);
}

const loginResp = await login(`smoke-auth-${Date.now()}@example.com`, 'Smoke Auth User');
const userToken = loginResp.token;

const workspaceResp = await jsonFetch(`${apiBase}/v1/workspaces`, {
  method: 'POST',
  body: JSON.stringify({
    organizationName: `Smoke Org ${Date.now()}`,
    organizationSlug: `smoke-org-${Date.now()}`,
    name: `Smoke Workspace ${Date.now()}`,
    slug: `smoke-workspace-${Date.now()}`,
    timezone: 'UTC',
    retentionDays: 1
  })
}, userToken);
const workspaceId = workspaceResp.item.id;

const memberResp = await jsonFetch(`${apiBase}/v1/workspaces/${workspaceId}/members`, {
  method: 'POST',
  body: JSON.stringify({
    email: `viewer-${Date.now()}@example.com`,
    name: 'Smoke Viewer',
    role: 'viewer'
  })
}, userToken);

const projectResp = await jsonFetch(`${apiBase}/v1/projects`, {
  method: 'POST',
  body: JSON.stringify({
    workspaceId,
    name: 'Smoke Project',
    slug: `smoke-project-${Date.now()}`,
    repoUrl: 'https://example.com/smoke.git',
    defaultBranch: 'main'
  })
}, userToken);
const projectId = projectResp.item.id;

const runId = crypto.randomUUID();
const specRunId = crypto.randomUUID();
const testCaseKey = 'cypress/e2e/auth-explorer.cy.ts::smoke';
const testResultId = crypto.randomUUID();

await sendIngest('run.started', {
  runId,
  workspaceId,
  projectId,
  branch: 'main',
  commitSha: 'authsmoke123',
  ciProvider: 'local-dev'
});
await sendIngest('spec.started', {
  specRunId,
  runId,
  specPath: 'cypress/e2e/auth-explorer.cy.ts'
});
await sendIngest('test.result', {
  testResultId,
  specRunId,
  projectId,
  stableTestKey: testCaseKey,
  title: 'auth explorer smoke',
  filePath: 'cypress/e2e/auth-explorer.cy.ts',
  suitePath: 'Smoke/Auth',
  status: 'flaky',
  attemptNo: 2,
  durationMs: 525,
  errorHash: 'flake-hash-auth-smoke',
  errorMessage: 'Timed out retrying after seeded flake'
});
await sendIngest('spec.finished', {
  specRunId,
  status: 'failed',
  durationMs: 1225,
  attempts: 2
});
await sendIngest('run.finished', {
  runId,
  status: 'failed',
  totalSpecs: 1,
  totalTests: 1,
  passCount: 0,
  failCount: 1,
  flakyCount: 1
});

const me = await jsonFetch(`${apiBase}/v1/me`, undefined, userToken);
const runs = await jsonFetch(`${apiBase}/v1/runs?workspaceId=${workspaceId}&projectId=${projectId}&branch=main&status=failed&page=1&limit=10`, undefined, userToken);
const specs = await jsonFetch(`${apiBase}/v1/runs/${runId}/specs?page=1&limit=10`, undefined, userToken);
const specTests = await jsonFetch(`${apiBase}/v1/spec-runs/${specRunId}/tests?page=1&limit=10`, undefined, userToken);
const history = await jsonFetch(`${apiBase}/v1/tests/${specTests.items[0].test_case_id}/history?page=1&limit=10`, undefined, userToken);
const flaky = await jsonFetch(`${apiBase}/v1/analytics/flaky?projectId=${projectId}&window=14&seed=batch-11-18`, undefined, userToken);
const clusters = await jsonFetch(`${apiBase}/v1/analytics/failures/clusters?projectId=${projectId}&window=14&seed=batch-11-18`, undefined, userToken);
const plan = await jsonFetch(`${apiBase}/v1/orchestrator/plan`, {
  method: 'POST',
  body: JSON.stringify({
    workspaceId,
    projectId,
    runId,
    shardCount: 2,
    specPaths: ['cypress/e2e/auth-explorer.cy.ts'],
    strategy: 'timing-aware',
    seed: 'batch-11-18'
  })
}, userToken);
const retryPlan = await jsonFetch(`${apiBase}/v1/orchestrator/retry-failures/${runId}`, {
  method: 'POST',
  body: JSON.stringify({
    shardCount: 1,
    seed: 'batch-11-18'
  })
}, userToken);

const signUpload = await jsonFetch(`${apiBase}/v1/artifacts/sign-upload`, {
  method: 'POST',
  body: JSON.stringify({
    workspaceId,
    runId,
    specRunId,
    testResultId,
    type: 'screenshot',
    fileName: 'auth-explorer.png',
    contentType: 'image/png',
    byteSize: 2048,
    checksum: 'sha256:smoke'
  })
}, userToken);

const uploadAck = await jsonFetch(signUpload.upload.url, {
  method: 'PUT',
  body: JSON.stringify({ fake: true }),
  headers: {
    'x-testharbor-artifact-token': signUpload.upload.headers['x-testharbor-artifact-token']
  }
});

const signDownload = await jsonFetch(`${apiBase}/v1/artifacts/${signUpload.item.id}/sign-download`, undefined, userToken);
const downloadAck = await jsonFetch(signDownload.download.url);

console.log(JSON.stringify({
  ok: true,
  workspaceId,
  projectId,
  memberId: memberResp.item.id,
  me: {
    userId: me.user.id,
    membershipCount: me.memberships.length
  },
  explorer: {
    runCount: runs.items.length,
    specCount: specs.items.length,
    testCount: specTests.items.length,
    historyCount: history.items.length
  },
  analytics: {
    flakyCount: flaky.items.length,
    clusterCount: clusters.items.length
  },
  orchestrator: {
    shardCount: plan.shards.length,
    retryFailedSpecs: retryPlan.failedSpecCount
  },
  artifacts: {
    artifactId: signUpload.item.id,
    uploadAck: uploadAck.ok,
    downloadAck: downloadAck.ok,
    backend: signDownload.download.backend
  }
}, null, 2));
