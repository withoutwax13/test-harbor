import crypto from 'node:crypto';
import http from 'node:http';
import {
  assertWebhookApiRoutesAvailable,
  cleanupWebhookSmokeSeededData,
  getWebhookSmokeCleanupSettings,
  jsonFetch
} from './webhook-smoke-helpers.mjs';

const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const ingestBase = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const apiAuthToken = process.env.API_AUTH_TOKEN || '';
const ingestAuthToken = process.env.INGEST_AUTH_TOKEN || '';

const mockPort = Number(process.env.WEBHOOK_MOCK_PORT || 5099);
const mockPath = process.env.WEBHOOK_MOCK_PATH || '/hook';
const webhookTargetHost = process.env.WEBHOOK_TARGET_HOST || 'host.docker.internal';
const waitTimeoutMs = Number(process.env.WEBHOOK_WAIT_TIMEOUT_MS || 45000);
const cleanupSettings = getWebhookSmokeCleanupSettings();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function postIngest(type, payload, idempotencyKey = crypto.randomUUID()) {
  return jsonFetch(`${ingestBase}/v1/ingest/events`, {
    method: 'POST',
    body: JSON.stringify({ type, idempotencyKey, payload })
  }, ingestAuthToken);
}

async function seedWorkspaceProject() {
  const ws = await jsonFetch(`${apiBase}/v1/workspaces`, {
    method: 'POST',
    body: JSON.stringify({
      organizationName: 'Webhook Org',
      organizationSlug: `webhook-org-${Date.now()}`,
      name: 'Webhook Workspace',
      slug: `webhook-workspace-${Date.now()}`,
      timezone: 'UTC',
      retentionDays: 30
    })
  }, apiAuthToken);

  const project = await jsonFetch(`${apiBase}/v1/projects`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: ws.item.id,
      name: 'Webhook Project',
      slug: `webhook-project-${Date.now()}`,
      provider: 'github',
      repoUrl: 'https://example.com/repo.git',
      defaultBranch: 'main'
    })
  }, apiAuthToken);

  return { workspaceId: ws.item.id, projectId: project.item.id };
}

async function createEndpoint(workspaceId, targetUrl, type, secret) {
  return jsonFetch(`${apiBase}/v1/webhook-endpoints`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId, type, targetUrl, secret, enabled: true })
  }, apiAuthToken);
}

async function patchEndpoint(endpointId, patch) {
  return jsonFetch(`${apiBase}/v1/webhook-endpoints/${endpointId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  }, apiAuthToken);
}


async function assertApiPatchContract(endpointId) {
  const res = await fetch(`${apiBase}/v1/webhook-endpoints/${endpointId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(apiAuthToken ? { authorization: `Bearer ${apiAuthToken}` } : {})
    },
    body: JSON.stringify({})
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (res.status !== 400) {
    throw new Error(
      `webhook PATCH contract preflight expected 400 for empty body, got ${res.status}. Likely stale API runtime/image. Rebuild api/ingest/worker from latest source and retry. response=${JSON.stringify(body)}`
    );
  }
}

async function disableEndpoint(endpointId) {
  return jsonFetch(`${apiBase}/v1/webhook-endpoints/${endpointId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false })
  }, apiAuthToken);
}

let received = 0;
const requests = [];
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== mockPath) {
    res.statusCode = 404;
    res.end('not_found');
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }

  received += 1;
  requests.push({ n: received, headers: req.headers, body: parsed });

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, n: received }));
});

await new Promise((resolve) => server.listen(mockPort, '0.0.0.0', resolve));

let workspaceId = null;
let projectId = null;
let endpointId = null;

try {
  await assertWebhookApiRoutesAvailable();
  ({ workspaceId, projectId } = await seedWorkspaceProject());
  const target = `http://${webhookTargetHost}:${mockPort}${mockPath}`;
  const endpoint = await createEndpoint(workspaceId, target, 'run.finished', 'clear-secret-smoke');
  endpointId = endpoint?.item?.id;
  if (!endpointId) throw new Error('failed to create endpoint');

  await assertApiPatchContract(endpointId);

  const runId1 = crypto.randomUUID();
  await postIngest('run.started', { runId: runId1, workspaceId, projectId, branch: 'main', commitSha: 'secret-on', ciProvider: 'local' });
  await postIngest('run.finished', { runId: runId1, status: 'passed', totalSpecs: 1, totalTests: 1, passCount: 1, failCount: 0, flakyCount: 0 });

  const findRunRequest = (runId) => requests.find((r) => r?.body?.payload?.runId === runId && r?.body?.type === 'run.finished');

  const deadline1 = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline1 && !findRunRequest(runId1)) {
    await sleep(800);
  }
  const firstRequest = findRunRequest(runId1);
  if (!firstRequest) throw new Error(`did not receive first run.finished webhook for runId=${runId1} in time`);

  const firstHasSignature = Boolean(firstRequest.headers['x-testharbor-signature']);
  if (!firstHasSignature) throw new Error('expected signature on first request before clearing secret');

  await patchEndpoint(endpointId, { secret: null });

  const runId2 = crypto.randomUUID();
  await postIngest('run.started', { runId: runId2, workspaceId, projectId, branch: 'main', commitSha: 'secret-off', ciProvider: 'local' });
  await postIngest('run.finished', { runId: runId2, status: 'passed', totalSpecs: 1, totalTests: 1, passCount: 1, failCount: 0, flakyCount: 0 });

  const deadline2 = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline2 && !findRunRequest(runId2)) {
    await sleep(800);
  }
  const secondRequest = findRunRequest(runId2);
  if (!secondRequest) throw new Error(`did not receive second run.finished webhook for runId=${runId2} in time`);

  const secondHasSignature = Boolean(secondRequest.headers['x-testharbor-signature']);
  if (secondHasSignature) throw new Error('expected no signature after clearing secret');

  console.log(JSON.stringify({
    ok: true,
    workspaceId,
    projectId,
    endpointId,
    cleanupMode: cleanupSettings.seededDataMode,
    checks: {
      firstHasSignature,
      secondHasSignature,
      secretClearedBehaviorVerified: firstHasSignature && !secondHasSignature,
      correlatedRunIds: { first: runId1, second: runId2 }
    }
  }, null, 2));
} finally {
  await cleanupWebhookSmokeSeededData({
    workspaceId,
    projectId,
    endpointId,
    disableEndpoint,
    log: (message) => console.error(message)
  });
  await new Promise((resolve) => server.close(resolve));
}
