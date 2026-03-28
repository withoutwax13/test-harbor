import crypto from 'node:crypto';
import http from 'node:http';

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

function createMockServer() {
  const deliveries = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      deliveries.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  return {
    deliveries,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      return `http://127.0.0.1:${address.port}/hook`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

const loginResp = await jsonFetch(`${apiBase}/v1/auth/login`, {
  method: 'POST',
  body: JSON.stringify({
    email: `notify-smoke-${Date.now()}@example.com`,
    name: 'Smoke Notify User'
  })
});
const userToken = loginResp.token;

const workspaceResp = await jsonFetch(`${apiBase}/v1/workspaces`, {
  method: 'POST',
  body: JSON.stringify({
    organizationName: `Notify Org ${Date.now()}`,
    organizationSlug: `notify-org-${Date.now()}`,
    name: `Notify Workspace ${Date.now()}`,
    slug: `notify-workspace-${Date.now()}`,
    timezone: 'UTC',
    retentionDays: 1
  })
}, userToken);
const workspaceId = workspaceResp.item.id;

const projectResp = await jsonFetch(`${apiBase}/v1/projects`, {
  method: 'POST',
  body: JSON.stringify({
    workspaceId,
    name: 'Notify Project',
    slug: `notify-project-${Date.now()}`,
    repoUrl: 'https://example.com/notify.git',
    defaultBranch: 'main'
  })
}, userToken);
const projectId = projectResp.item.id;

const oldStartedAt = new Date(Date.now() - (5 * 24 * 60 * 60 * 1000)).toISOString();
const oldFinishedAt = new Date(Date.now() - (4 * 24 * 60 * 60 * 1000)).toISOString();
const runId = crypto.randomUUID();
const specRunId = crypto.randomUUID();
const testResultId = crypto.randomUUID();

await sendIngest('run.started', {
  runId,
  workspaceId,
  projectId,
  branch: 'main',
  commitSha: 'notify123',
  ciProvider: 'local-dev',
  startedAt: oldStartedAt
});
await sendIngest('spec.started', {
  specRunId,
  runId,
  specPath: 'cypress/e2e/notify.cy.ts',
  startedAt: oldStartedAt
});
await sendIngest('test.result', {
  testResultId,
  specRunId,
  projectId,
  stableTestKey: 'cypress/e2e/notify.cy.ts::notification smoke',
  title: 'notification smoke',
  filePath: 'cypress/e2e/notify.cy.ts',
  suitePath: 'Smoke/Notify',
  status: 'failed',
  attemptNo: 1,
  durationMs: 333,
  errorHash: 'notify-failure',
  errorMessage: 'Webhook delivery smoke failure'
});
await sendIngest('spec.finished', {
  specRunId,
  status: 'failed',
  durationMs: 500,
  attempts: 1,
  finishedAt: oldFinishedAt
});
await sendIngest('run.finished', {
  runId,
  status: 'failed',
  totalSpecs: 1,
  totalTests: 1,
  passCount: 0,
  failCount: 1,
  flakyCount: 0,
  finishedAt: oldFinishedAt
});

const mock = createMockServer();
const targetUrl = await mock.listen();
let formatResp;
let prFeedbackResp;
let notifyResp;
let retentionResp;
let auditResp;

try {
  const webhookResp = await jsonFetch(`${apiBase}/v1/webhooks`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      type: 'notification.test',
      targetUrl,
      secret: 'notify-secret',
      enabled: true
    })
  }, userToken);

  formatResp = await jsonFetch(`${apiBase}/v1/notifications/format`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      runId,
      channel: 'slack'
    })
  }, userToken);

  prFeedbackResp = await jsonFetch(`${apiBase}/v1/notifications/pr-feedback`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      runId
    })
  }, userToken);

  notifyResp = await jsonFetch(`${apiBase}/v1/notifications/test`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      runId,
      channel: 'slack',
      eventType: 'notification.test',
      message: 'Batch 16 notification smoke'
    })
  }, userToken);

  await new Promise((resolve) => setTimeout(resolve, 2500));

  retentionResp = await jsonFetch(`${apiBase}/v1/retention/run`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId })
  }, userToken);

  auditResp = await jsonFetch(`${apiBase}/v1/audit-logs?workspaceId=${workspaceId}&limit=20`, undefined, userToken);

  console.log(JSON.stringify({
    ok: true,
    workspaceId,
    projectId,
    webhookId: webhookResp.item.id,
    formatter: {
      channel: formatResp.channel,
      hasBlocks: Array.isArray(formatResp.payload.blocks)
    },
    prFeedback: {
      channel: prFeedbackResp.channel,
      containsHeader: prFeedbackResp.payload.body.includes('TestHarbor PR feedback')
    },
    notifications: {
      deliveryCount: notifyResp.deliveryCount,
      mockDeliveries: mock.deliveries.length
    },
    retention: retentionResp,
    auditLogCount: auditResp.items.length
  }, null, 2));
} finally {
  await mock.close();
}
