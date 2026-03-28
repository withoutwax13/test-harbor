import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  artifactStamp,
  assertWebhookApiRoutesAvailable,
  fetchJsonWithStatus
} from './webhook-smoke-helpers.mjs';

const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const ingestBase = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const expectedApiToken = process.env.API_AUTH_TOKEN || '';
const expectedIngestToken = process.env.INGEST_AUTH_TOKEN || '';
const artifactDir = process.env.WEBHOOK_ARTIFACT_DIR || '';
const badSuffix = `-invalid-${Date.now()}`;

if (!expectedApiToken || !expectedIngestToken) {
  throw new Error('API_AUTH_TOKEN and INGEST_AUTH_TOKEN are required for smoke:webhooks:auth:negative');
}

await assertWebhookApiRoutesAvailable();

async function maybeWriteArtifact(payload) {
  if (!artifactDir) return null;
  const outDir = path.resolve(artifactDir);
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `webhook-auth-negative-${artifactStamp()}.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2));
  return file;
}

async function checkCase({ name, url, method = 'GET', body, tokenType, missingExpected = 401, invalidExpected = 401 }) {
  const goodToken = tokenType === 'api' ? expectedApiToken : expectedIngestToken;
  const invalidToken = `${goodToken}${badSuffix}`;
  const baseInit = {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  };

  const missing = await fetchJsonWithStatus(url, baseInit, '');
  if (missing.status !== missingExpected) {
    throw new Error(`${name} expected ${missingExpected} without auth, got ${missing.status} body=${JSON.stringify(missing.body)}`);
  }

  const invalid = await fetchJsonWithStatus(url, baseInit, invalidToken);
  if (invalid.status !== invalidExpected) {
    throw new Error(`${name} expected ${invalidExpected} with invalid auth, got ${invalid.status} body=${JSON.stringify(invalid.body)}`);
  }

  return {
    name,
    tokenType,
    missingStatus: missing.status,
    invalidStatus: invalid.status
  };
}

const dummyWorkspaceId = '00000000-0000-0000-0000-000000000000';
const dummyEndpointId = '00000000-0000-0000-0000-000000000001';
const results = [];

results.push(await checkCase({
  name: 'api.listWebhookEndpoints',
  url: `${apiBase}/v1/webhook-endpoints?workspaceId=${dummyWorkspaceId}`,
  tokenType: 'api'
}));
results.push(await checkCase({
  name: 'api.createWebhookEndpoint',
  url: `${apiBase}/v1/webhook-endpoints`,
  method: 'POST',
  body: {
    workspaceId: dummyWorkspaceId,
    type: 'run.finished',
    targetUrl: 'http://127.0.0.1:9/hook',
    enabled: true
  },
  tokenType: 'api'
}));
results.push(await checkCase({
  name: 'api.patchWebhookEndpoint',
  url: `${apiBase}/v1/webhook-endpoints/${dummyEndpointId}`,
  method: 'PATCH',
  body: { enabled: false },
  tokenType: 'api'
}));
results.push(await checkCase({
  name: 'api.deleteWebhookEndpoint',
  url: `${apiBase}/v1/webhook-endpoints/${dummyEndpointId}`,
  method: 'DELETE',
  tokenType: 'api'
}));
results.push(await checkCase({
  name: 'api.listWebhookDeliveries',
  url: `${apiBase}/v1/webhook-deliveries?workspaceId=${dummyWorkspaceId}`,
  tokenType: 'api'
}));
results.push(await checkCase({
  name: 'ingest.postEvent',
  url: `${ingestBase}/v1/ingest/events`,
  method: 'POST',
  body: {
    type: 'run.finished',
    idempotencyKey: crypto.randomUUID(),
    payload: { runId: crypto.randomUUID(), status: 'passed' }
  },
  tokenType: 'ingest'
}));

const output = {
  ok: true,
  generatedAt: new Date().toISOString(),
  results
};
const artifactPath = await maybeWriteArtifact(output);
if (artifactPath) output.artifactPath = artifactPath;
console.log(JSON.stringify(output, null, 2));
