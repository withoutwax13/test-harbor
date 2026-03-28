import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const ingestBase = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const apiAuthToken = process.env.API_AUTH_TOKEN || '';
const ingestAuthToken = process.env.INGEST_AUTH_TOKEN || '';

const maxAttempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5);
const workerBaseBackoffMs = Number(process.env.WEBHOOK_BASE_BACKOFF_MS || 2000);
const workerPollMs = Number(process.env.WEBHOOK_WORKER_POLL_MS || 1500);
const workerRequestTimeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 6000);

function retryDelayMs(attemptCount) {
  const exp = Math.min(attemptCount, 6);
  return workerBaseBackoffMs * (2 ** exp);
}

function defaultWaitTimeoutMs() {
  const initialClaimBudget = workerPollMs * 2;
  const firstAttemptBudget = workerRequestTimeoutMs;
  const firstRetryDelayBudget = retryDelayMs(1);
  const disabledRetryClaimBudget = workerPollMs * 2;
  const disabledRetryAttemptBudget = workerRequestTimeoutMs;
  const stabilizationBudget = Math.max(workerPollMs * 2, 2500);
  const jitterBudget = 10000;

  return Math.max(
    30000,
    initialClaimBudget
      + firstAttemptBudget
      + firstRetryDelayBudget
      + disabledRetryClaimBudget
      + disabledRetryAttemptBudget
      + stabilizationBudget
      + jitterBudget
  );
}

const waitTimeoutMs = Number(process.env.WEBHOOK_WAIT_TIMEOUT_MS || defaultWaitTimeoutMs());
const artifactDir = process.env.WEBHOOK_ARTIFACT_DIR || '';
const disableEndpointOnExit = process.env.WEBHOOK_DISABLE_ENDPOINT_ON_EXIT !== '0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function artifactStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function maybeWriteArtifact(payload) {
  if (!artifactDir) return null;
  const outDir = path.resolve(artifactDir);
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `webhook-smoke-${artifactStamp()}-disable-after-queue.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2));
  return file;
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
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(`${url} ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function postIngest(type, payload, idempotencyKey = crypto.randomUUID()) {
  return jsonFetch(
    `${ingestBase}/v1/ingest/events`,
    {
      method: 'POST',
      body: JSON.stringify({ type, idempotencyKey, payload })
    },
    ingestAuthToken
  );
}

async function seedWorkspaceProject() {
  const ws = await jsonFetch(
    `${apiBase}/v1/workspaces`,
    {
      method: 'POST',
      body: JSON.stringify({
        organizationName: 'Webhook Org',
        organizationSlug: `webhook-org-${Date.now()}`,
        name: 'Webhook Workspace',
        slug: `webhook-workspace-${Date.now()}`,
        timezone: 'UTC',
        retentionDays: 30
      })
    },
    apiAuthToken
  );

  const project = await jsonFetch(
    `${apiBase}/v1/projects`,
    {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: ws.item.id,
        name: 'Webhook Project',
        slug: `webhook-project-${Date.now()}`,
        provider: 'github',
        repoUrl: 'https://example.com/repo.git',
        defaultBranch: 'main'
      })
    },
    apiAuthToken
  );

  return { workspaceId: ws.item.id, projectId: project.item.id };
}

async function createEndpoint(workspaceId, targetUrl, type, secret) {
  return jsonFetch(
    `${apiBase}/v1/webhook-endpoints`,
    {
      method: 'POST',
      body: JSON.stringify({ workspaceId, type, targetUrl, secret, enabled: true })
    },
    apiAuthToken
  );
}

async function disableEndpoint(endpointId) {
  return jsonFetch(
    `${apiBase}/v1/webhook-endpoints/${endpointId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false })
    },
    apiAuthToken
  );
}

async function listDeliveries(workspaceId) {
  return jsonFetch(`${apiBase}/v1/webhook-deliveries?workspaceId=${workspaceId}&limit=200`, undefined, apiAuthToken);
}

let workspaceId = null;
let projectId = null;
let endpointId = null;

try {
  ({ workspaceId, projectId } = await seedWorkspaceProject());
  if (!Number.isFinite(maxAttempts) || maxAttempts < 2) {
    throw new Error('WEBHOOK_MAX_ATTEMPTS must be >= 2 for disable-after-queue smoke');
  }
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 1000) {
    throw new Error('WEBHOOK_WAIT_TIMEOUT_MS must be >= 1000 when provided');
  }

  const target = process.env.WEBHOOK_DISABLED_RETRY_TARGET_URL || 'http://127.0.0.1:9/hook';
  const endpoint = await createEndpoint(workspaceId, target, 'run.finished', 'disable-after-queue-secret');
  endpointId = endpoint?.item?.id || null;

  const runId = crypto.randomUUID();
  await postIngest('run.started', {
    runId,
    workspaceId,
    projectId,
    branch: 'main',
    commitSha: 'webhook-disable-after-queue',
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

  let delivery = null;
  const firstAttemptDeadline = Date.now() + waitTimeoutMs;
  while (Date.now() < firstAttemptDeadline) {
    const deliveries = await listDeliveries(workspaceId);
    delivery = (deliveries.items || []).find((item) => item.event_type === 'run.finished') || null;
    if (delivery && delivery.attempt_count >= 1 && delivery.status === 'retry_scheduled') {
      break;
    }
    await sleep(200);
  }

  if (!delivery || delivery.status !== 'retry_scheduled') {
    throw new Error(
      `expected first failed attempt before disabling endpoint; delivery=${JSON.stringify(delivery)}`
    );
  }

  await disableEndpoint(endpointId);

  let final = null;
  const terminalDeadline = Date.now() + waitTimeoutMs;
  while (Date.now() < terminalDeadline) {
    const deliveries = await listDeliveries(workspaceId);
    const current = (deliveries.items || []).find((item) => item.id === delivery.id) || null;
    if (current && current.status === 'dead') {
      final = current;
      break;
    }
    await sleep(250);
  }

  if (!final) {
    throw new Error(`timeout waiting for disabled endpoint delivery to become dead; deliveryId=${delivery.id}`);
  }

  if (final.last_error !== 'endpoint_disabled') {
    throw new Error(`expected last_error=endpoint_disabled, got ${final.last_error}`);
  }
  if (final.attempt_count !== delivery.attempt_count + 1) {
    throw new Error(
      `expected disabled endpoint to terminate on the next claimed attempt, got attempt_count ${final.attempt_count} from ${delivery.attempt_count}`
    );
  }
  if (final.response_status !== null) {
    throw new Error(`expected disabled endpoint retry to skip HTTP response capture, got ${final.response_status}`);
  }

  await sleep(Math.max(workerPollMs * 2, 2500));
  const deliveriesAfterTerminal = await listDeliveries(workspaceId);
  const stable = (deliveriesAfterTerminal.items || []).find((item) => item.id === final.id) || null;
  if (!stable) {
    throw new Error(`delivery ${final.id} disappeared after terminal transition`);
  }
  if (stable.status !== 'dead') {
    throw new Error(`expected delivery to remain dead after disable, got ${stable.status}`);
  }
  if (stable.attempt_count !== final.attempt_count) {
    throw new Error(
      `expected no further attempts after endpoint disabled, got attempt_count ${stable.attempt_count} from ${final.attempt_count}`
    );
  }

  const output = {
    ok: true,
    workspaceId,
    projectId,
    endpointId,
    deliveryId: final.id,
    notificationEventId: final.notification_event_id,
    target,
    finalDelivery: {
      status: final.status,
      attemptCount: final.attempt_count,
      lastError: final.last_error,
      responseStatus: final.response_status
    },
    stableAfterTerminal: {
      status: stable.status,
      attemptCount: stable.attempt_count
    }
  };
  const artifactPath = await maybeWriteArtifact(output);
  if (artifactPath) output.artifactPath = artifactPath;
  console.log(JSON.stringify(output, null, 2));
} finally {
  if (endpointId && disableEndpointOnExit) {
    await disableEndpoint(endpointId).catch(() => {});
  }
}
