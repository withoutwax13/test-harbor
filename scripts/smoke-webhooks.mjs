import crypto from 'node:crypto';
import http from 'node:http';

const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const ingestBase = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const apiAuthToken = process.env.API_AUTH_TOKEN || '';
const ingestAuthToken = process.env.INGEST_AUTH_TOKEN || '';

const mockPort = Number(process.env.WEBHOOK_MOCK_PORT || 5099);
const mockPath = process.env.WEBHOOK_MOCK_PATH || '/hook';
const failCountBeforeSuccess = Number(process.env.WEBHOOK_MOCK_FAILS || 2);
const maxAttempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5);
const webhookTargetHost = process.env.WEBHOOK_TARGET_HOST || 'host.docker.internal';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }


async function assertWebhookApiRoutesAvailable() {
  const probeUrl = `${apiBase}/v1/webhook-endpoints?workspaceId=route-probe`;
  const res = await fetch(probeUrl, {
    method: 'GET',
    headers: {
      ...(apiAuthToken ? { authorization: `Bearer ${apiAuthToken}` } : {})
    }
  });

  if (res.status === 404) {
    throw new Error(
      [
        `Webhook API route missing at ${probeUrl} (404).`,
        'This usually means api container is stale or wrong target is bound to API_BASE_URL.',
        'Run: docker compose build --no-cache api ingest worker && docker compose up -d postgres redis api ingest worker'
      ].join(' ')
    );
  }

  if (res.status >= 500) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webhook API route probe failed ${res.status}: ${body}`);
  }
}

async function jsonFetch(url, init = {}, authToken = '') {
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
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`${url} ${res.status} ${JSON.stringify(body)}`);
  return body;
}

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

async function createEndpoint(workspaceId, targetUrl, type) {
  return jsonFetch(`${apiBase}/v1/webhook-endpoints`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId, type, targetUrl, enabled: true })
  }, apiAuthToken);
}

async function listDeliveries(workspaceId) {
  return jsonFetch(`${apiBase}/v1/webhook-deliveries?workspaceId=${workspaceId}&limit=200`, undefined, apiAuthToken);
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
  requests.push({
    n: received,
    headers: req.headers,
    body: parsed
  });

  if (received <= failCountBeforeSuccess) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, phase: 'forced-fail', n: received }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, n: received }));
});

await new Promise((resolve) => server.listen(mockPort, '0.0.0.0', resolve));

try {
  await assertWebhookApiRoutesAvailable();
  const { workspaceId, projectId } = await seedWorkspaceProject();
  if (!Number.isFinite(failCountBeforeSuccess) || failCountBeforeSuccess < 0) {
    throw new Error('WEBHOOK_MOCK_FAILS must be a non-negative number');
  }
  if (failCountBeforeSuccess >= maxAttempts) {
    throw new Error(`WEBHOOK_MOCK_FAILS (${failCountBeforeSuccess}) must be less than WEBHOOK_MAX_ATTEMPTS (${maxAttempts})`);
  }

  const target = `http://${webhookTargetHost}:${mockPort}${mockPath}`;

  await createEndpoint(workspaceId, target, 'run.finished');

  const runId = crypto.randomUUID();
  await postIngest('run.started', {
    runId,
    workspaceId,
    projectId,
    branch: 'main',
    commitSha: 'webhook-smoke',
    ciProvider: 'local'
  });

  await postIngest('run.finished', {
    runId,
    status: 'passed',
    totalSpecs: 1,
    totalTests: 1,
    passCount: 1,
    failCount: 0,
    flakyCount: 0
  });

  let final = null;
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const deliveries = await listDeliveries(workspaceId);
    const byRun = (deliveries.items || []).filter((d) => d.event_type === 'run.finished');
    if (byRun.length) {
      const top = byRun[0];
      if (top.status === 'delivered' || top.status === 'dead') {
        final = top;
        break;
      }
    }
    await sleep(1200);
  }

  if (!final) {
    throw new Error('timeout waiting for webhook delivery terminal state (delivered/dead)');
  }

  if (final.status !== 'delivered') {
    throw new Error(`expected delivered, got ${final.status} attempts=${final.attempt_count}`);
  }
  if ((final.attempt_count || 0) < failCountBeforeSuccess + 1) {
    throw new Error(`expected at least ${failCountBeforeSuccess + 1} attempts, got ${final.attempt_count}`);
  }

  console.log(JSON.stringify({
    ok: true,
    workspaceId,
    projectId,
    runId,
    target,
    webhookTargetHost,
    maxAttempts,
    mockReceived: received,
    finalDelivery: {
      id: final.id,
      status: final.status,
      attemptCount: final.attempt_count,
      responseStatus: final.response_status,
      lastError: final.last_error
    },
    requestSamples: requests.slice(0, 3).map((r) => ({
      n: r.n,
      event: r.headers['x-testharbor-event'],
      signaturePresent: Boolean(r.headers['x-testharbor-signature'])
    }))
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
