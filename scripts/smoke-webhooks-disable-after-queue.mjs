import crypto from 'node:crypto';
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
  seedWebhookWorkspaceProject,
  sleep
} from './webhook-smoke-helpers.mjs';

const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const apiAuthToken = process.env.API_AUTH_TOKEN || '';

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
const cleanupSettings = getWebhookSmokeCleanupSettings();

async function maybeWriteArtifact(payload) {
  if (!artifactDir) return null;
  const outDir = path.resolve(artifactDir);
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `webhook-smoke-${artifactStamp()}-disable-after-queue.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2));
  return file;
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
let organizationId = null;

try {
  await assertWebhookApiRoutesAvailable();
  ({ organizationId, workspaceId, projectId } = await seedWebhookWorkspaceProject());
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
  await postIngestEvent('run.started', {
    runId,
    workspaceId,
    projectId,
    branch: 'main',
    commitSha: 'webhook-disable-after-queue',
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

  const firstAttemptPoll = await pollUntil({
    label: 'webhook.disable-after-queue.first-retry',
    timeoutMs: waitTimeoutMs,
    intervalMs: 200,
    poll: async () => {
      const deliveries = await listDeliveries(workspaceId);
      return (deliveries.items || []).find((item) => item.event_type === 'run.finished') || null;
    },
    isDone: (delivery) => Boolean(delivery && delivery.attempt_count >= 1 && delivery.status === 'retry_scheduled'),
    mapState: (delivery) => delivery ? {
      id: delivery.id,
      status: delivery.status,
      attempt_count: delivery.attempt_count,
      last_error: delivery.last_error
    } : null
  });
  const delivery = firstAttemptPoll.value;

  if (!delivery || delivery.status !== 'retry_scheduled') {
    throw new Error(
      `expected first failed attempt before disabling endpoint; metrics=${JSON.stringify(firstAttemptPoll.metrics)}`
    );
  }

  await disableEndpoint(endpointId);

  const terminalPoll = await pollUntil({
    label: 'webhook.disable-after-queue.dead-terminal',
    timeoutMs: waitTimeoutMs,
    intervalMs: 250,
    poll: async () => {
      const deliveries = await listDeliveries(workspaceId);
      return (deliveries.items || []).find((item) => item.id === delivery.id) || null;
    },
    isDone: (current) => current?.status === 'dead',
    mapState: (current) => current ? {
      id: current.id,
      status: current.status,
      attempt_count: current.attempt_count,
      last_error: current.last_error,
      response_status: current.response_status
    } : null
  });
  const final = terminalPoll.value;

  if (!final || terminalPoll.metrics.timedOut) {
    throw new Error(
      `timeout waiting for disabled endpoint delivery to become dead; metrics=${JSON.stringify(terminalPoll.metrics)}`
    );
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
    cleanupMode: cleanupSettings.seededDataMode,
    pollMetrics: {
      firstRetry: firstAttemptPoll.metrics,
      terminal: terminalPoll.metrics
    },
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
}
