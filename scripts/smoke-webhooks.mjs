import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  artifactStamp,
  assertWebhookApiRoutesAvailable,
  cleanupWebhookSmokeSeededData,
  getWebhookSmokeCleanupSettings,
  jsonFetch,
  pollUntil,
  postIngestEvent,
  seedWebhookWorkspaceProject
} from './webhook-smoke-helpers.mjs';

const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const apiAuthToken = process.env.API_AUTH_TOKEN || '';
const ingestAuthToken = process.env.INGEST_AUTH_TOKEN || '';

const mockPort = Number(process.env.WEBHOOK_MOCK_PORT || 5099);
const mockPath = process.env.WEBHOOK_MOCK_PATH || '/hook';
const failCountBeforeSuccess = Number(process.env.WEBHOOK_MOCK_FAILS || 2);
const maxAttempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5);
const webhookTargetHost = process.env.WEBHOOK_TARGET_HOST || 'host.docker.internal';
const expectDead = process.env.WEBHOOK_EXPECT_DEAD === '1';
const workerBaseBackoffMs = Number(process.env.WEBHOOK_BASE_BACKOFF_MS || 2000);
const workerPollMs = Number(process.env.WEBHOOK_WORKER_POLL_MS || 1500);
const workerRequestTimeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 6000);

function defaultWaitTimeoutMs() {
  if (!expectDead) return 35000;
  // Mirror worker retry cadence: retryDelayMs(attempt)=BASE_BACKOFF_MS*2^attempt
  // with attempt_count incremented before each attempt and dead when attempt_count >= max_attempts.
  const retries = Math.max(0, maxAttempts - 1);
  const backoffBudget = Array.from({ length: retries }, (_, i) => workerBaseBackoffMs * (2 ** (i + 1)))
    .reduce((a, b) => a + b, 0);
  const attemptBudget = maxAttempts * workerRequestTimeoutMs;
  const pollBudget = (retries + 2) * workerPollMs;
  const jitterBudget = 15000;
  return Math.max(90000, backoffBudget + attemptBudget + pollBudget + jitterBudget);
}

const waitTimeoutMs = Number(process.env.WEBHOOK_WAIT_TIMEOUT_MS || defaultWaitTimeoutMs());
const artifactDir = process.env.WEBHOOK_ARTIFACT_DIR || '';
const cleanupSettings = getWebhookSmokeCleanupSettings();

async function createEndpoint(workspaceId, targetUrl, type, secret) {
  return jsonFetch(`${apiBase}/v1/webhook-endpoints`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId, type, targetUrl, secret, enabled: true })
  }, apiAuthToken);
}

async function listDeliveries(workspaceId) {
  return jsonFetch(`${apiBase}/v1/webhook-deliveries?workspaceId=${workspaceId}&limit=200`, undefined, apiAuthToken);
}

async function disableEndpoint(endpointId) {
  return jsonFetch(`${apiBase}/v1/webhook-endpoints/${endpointId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false })
  }, apiAuthToken);
}


async function maybeWriteArtifact(payload) {
  if (!artifactDir) return null;
  const outDir = path.resolve(artifactDir);
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `webhook-smoke-${artifactStamp()}-${expectDead ? 'dead' : 'delivered'}.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2));
  return file;
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

let workspaceId = null;
let projectId = null;
let endpointId = null;
let organizationId = null;

try {
  await assertWebhookApiRoutesAvailable();
  ({ organizationId, workspaceId, projectId } = await seedWebhookWorkspaceProject());
  if (!Number.isFinite(failCountBeforeSuccess) || failCountBeforeSuccess < 0) {
    throw new Error('WEBHOOK_MOCK_FAILS must be a non-negative number');
  }
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error('WEBHOOK_MAX_ATTEMPTS must be a positive number');
  }
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 1000) {
    throw new Error('WEBHOOK_WAIT_TIMEOUT_MS must be >= 1000 when provided');
  }
  if (!expectDead && failCountBeforeSuccess >= maxAttempts) {
    throw new Error(`WEBHOOK_MOCK_FAILS (${failCountBeforeSuccess}) must be less than WEBHOOK_MAX_ATTEMPTS (${maxAttempts}) for delivered-path smoke`);
  }
  if (expectDead && failCountBeforeSuccess < maxAttempts) {
    throw new Error(`WEBHOOK_EXPECT_DEAD=1 requires WEBHOOK_MOCK_FAILS (${failCountBeforeSuccess}) >= WEBHOOK_MAX_ATTEMPTS (${maxAttempts})`);
  }

  const target = `http://${webhookTargetHost}:${mockPort}${mockPath}`;
  const webhookSecret = 'smoke-secret';

  const endpoint = await createEndpoint(workspaceId, target, 'run.finished', webhookSecret);
  endpointId = endpoint?.item?.id || null;

  const runId = crypto.randomUUID();
  await postIngestEvent('run.started', {
    runId,
    workspaceId,
    projectId,
    branch: 'main',
    commitSha: 'webhook-smoke',
    ciProvider: 'local'
  }, crypto.randomUUID());

  await postIngestEvent('run.finished', {
    runId,
    status: 'passed',
    totalSpecs: 1,
    totalTests: 1,
    passCount: 1,
    failCount: 0,
    flakyCount: 0
  }, crypto.randomUUID());

  const terminalPoll = await pollUntil({
    label: expectDead ? 'webhook.dead-terminal' : 'webhook.delivered-terminal',
    timeoutMs: waitTimeoutMs,
    intervalMs: 1200,
    poll: async () => {
      const deliveries = await listDeliveries(workspaceId);
      const byRun = (deliveries.items || []).filter((d) => d.event_type === 'run.finished');
      return byRun[0] || null;
    },
    isDone: (delivery) => delivery?.status === 'delivered' || delivery?.status === 'dead',
    mapState: (delivery) => delivery ? {
      status: delivery.status,
      attempt_count: delivery.attempt_count,
      max_attempts: delivery.max_attempts,
      response_status: delivery.response_status,
      last_error: delivery.last_error
    } : null
  });
  const final = terminalPoll.value;
  if (!final) {
    throw new Error(
      `timeout waiting for webhook delivery terminal state within ${waitTimeoutMs}ms; metrics=${JSON.stringify(terminalPoll.metrics)} mockReceived=${received}`
    );
  }
  if (terminalPoll.metrics.timedOut) {
    throw new Error(
      `timeout waiting for webhook delivery terminal state within ${waitTimeoutMs}ms; metrics=${JSON.stringify(terminalPoll.metrics)} mockReceived=${received}`
    );
  }

  if (expectDead) {
    if (final.status !== 'dead') {
      throw new Error(`expected dead, got ${final.status} attempts=${final.attempt_count}`);
    }
    const deliveryMaxAttempts = Number(final.max_attempts || maxAttempts);
    if ((final.attempt_count || 0) !== deliveryMaxAttempts) {
      throw new Error(`expected dead-letter attempts=${deliveryMaxAttempts}, got ${final.attempt_count}`);
    }
  } else {
    if (final.status !== 'delivered') {
      throw new Error(`expected delivered, got ${final.status} attempts=${final.attempt_count}`);
    }
    if ((final.attempt_count || 0) < failCountBeforeSuccess + 1) {
      throw new Error(`expected at least ${failCountBeforeSuccess + 1} attempts, got ${final.attempt_count}`);
    }
  }

  const signatureSeen = requests.some((r) => Boolean(r.headers['x-testharbor-signature']));
  if (!signatureSeen) {
    throw new Error('expected x-testharbor-signature header on at least one webhook request');
  }

  const output = {
    ok: true,
    workspaceId,
    projectId,
    runId,
    target,
    webhookTargetHost,
    maxAttemptsConfigured: maxAttempts,
    deliveryMaxAttempts: final.max_attempts,
    expectDead,
    waitTimeoutMs,
    pollMetrics: terminalPoll.metrics,
    signatureSeen,
    mockReceived: received,
    cleanupMode: cleanupSettings.seededDataMode,
    finalDelivery: {
      id: final.id,
      status: final.status,
      attemptCount: final.attempt_count,
      responseStatus: final.response_status,
      lastError: final.last_error
    },
    auth: { apiAuthTokenConfigured: Boolean(apiAuthToken), ingestAuthTokenConfigured: Boolean(ingestAuthToken) },
    requestSamples: requests.slice(0, 3).map((r) => ({
      n: r.n,
      event: r.headers['x-testharbor-event'],
      signaturePresent: Boolean(r.headers['x-testharbor-signature'])
    }))
  };
  const artifactPath = await maybeWriteArtifact(output);
  if (artifactPath) {
    const withPath = { ...output, artifactPath };
    await fs.writeFile(artifactPath, JSON.stringify(withPath, null, 2));
    console.log(JSON.stringify(withPath, null, 2));
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
} finally {
  await cleanupWebhookSmokeSeededData({
    organizationId,
    workspaceId,
    projectId,
    endpointId,
    disableEndpoint,
    log: (message) => console.error(message)
  });
  await new Promise((resolve) => server.close(resolve));
}
