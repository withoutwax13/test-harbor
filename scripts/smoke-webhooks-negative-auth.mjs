import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  artifactStamp,
  assertWebhookApiRoutesAvailable,
  cleanupWebhookSmokeSeededData,
  fetchJsonWithStatus,
  getWebhookSmokeCleanupSettings,
  seedWebhookWorkspaceProject
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

async function checkGoodAuth({ name, url, method = 'GET', body, tokenType }) {
  const goodToken = tokenType === 'api' ? expectedApiToken : expectedIngestToken;
  const init = {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  };
  const good = await fetchJsonWithStatus(url, init, goodToken);
  if (good.status === 401 || good.status === 403 || good.status >= 500) {
    throw new Error(`${name} expected authenticated token to be accepted without auth-layer rejection, got ${good.status}`);
  }
  return {
    name,
    tokenType,
    goodStatus: good.status,
    body: good.body
  };
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

const cleanupSettings = getWebhookSmokeCleanupSettings();
const seeded = await seedWebhookWorkspaceProject({ suffix: `auth-negative-${Date.now()}` });
const dummyWorkspaceId = seeded.workspaceId;
const dummyEndpointId = seeded.endpointId || '00000000-0000-0000-0000-000000000001';
const results = [];

try {

results.push(await checkGoodAuth({
  name: 'api.listWebhookEndpoints',
  url: `${apiBase}/v1/webhook-endpoints?workspaceId=${dummyWorkspaceId}`,
  tokenType: 'api'
}));
results.push(await checkCase({
  name: 'api.listWebhookEndpoints',
  url: `${apiBase}/v1/webhook-endpoints?workspaceId=${dummyWorkspaceId}`,
  tokenType: 'api'
}));

const createPayload = {
  workspaceId: dummyWorkspaceId,
  type: 'run.finished',
  targetUrl: 'http://127.0.0.1:9/hook',
  enabled: true
};
const createGood = await checkGoodAuth({
  name: 'api.createWebhookEndpoint',
  url: `${apiBase}/v1/webhook-endpoints`,
  method: 'POST',
  body: createPayload,
  tokenType: 'api'
});
results.push(createGood);
const createdEndpointId = createGood.body?.id || dummyEndpointId;
results.push(await checkCase({
  name: 'api.createWebhookEndpoint',
  url: `${apiBase}/v1/webhook-endpoints`,
  method: 'POST',
  body: createPayload,
  tokenType: 'api'
}));

results.push(await checkGoodAuth({
  name: 'api.patchWebhookEndpoint',
  url: `${apiBase}/v1/webhook-endpoints/${createdEndpointId}`,
  method: 'PATCH',
  body: { enabled: false },
  tokenType: 'api'
}));
results.push(await checkCase({
  name: 'api.patchWebhookEndpoint',
  url: `${apiBase}/v1/webhook-endpoints/${createdEndpointId}`,
  method: 'PATCH',
  body: { enabled: false },
  tokenType: 'api'
}));

results.push(await checkGoodAuth({
  name: 'api.deleteWebhookEndpoint',
  url: `${apiBase}/v1/webhook-endpoints/${createdEndpointId}`,
  method: 'DELETE',
  tokenType: 'api'
}));
results.push(await checkCase({
  name: 'api.deleteWebhookEndpoint',
  url: `${apiBase}/v1/webhook-endpoints/${createdEndpointId}`,
  method: 'DELETE',
  tokenType: 'api'
}));

results.push(await checkGoodAuth({
  name: 'api.listWebhookDeliveries',
  url: `${apiBase}/v1/webhook-deliveries?workspaceId=${dummyWorkspaceId}`,
  tokenType: 'api'
}));
results.push(await checkCase({
  name: 'api.listWebhookDeliveries',
  url: `${apiBase}/v1/webhook-deliveries?workspaceId=${dummyWorkspaceId}`,
  tokenType: 'api'
}));

const ingestPayload = {
  type: 'run.finished',
  idempotencyKey: crypto.randomUUID(),
  payload: { runId: crypto.randomUUID(), status: 'passed' }
};
results.push(await checkGoodAuth({
  name: 'ingest.postEvent',
  url: `${ingestBase}/v1/ingest/events`,
  method: 'POST',
  body: ingestPayload,
  tokenType: 'ingest'
}));
results.push(await checkCase({
  name: 'ingest.postEvent',
  url: `${ingestBase}/v1/ingest/events`,
  method: 'POST',
  body: {
    ...ingestPayload,
    idempotencyKey: crypto.randomUUID()
  },
  tokenType: 'ingest'
}));


const output = {
  ok: true,
  generatedAt: new Date().toISOString(),
  workspaceId: dummyWorkspaceId,
  endpointId: typeof createdEndpointId !== 'undefined' ? createdEndpointId : null,
  cleanupMode: cleanupSettings.seededDataMode,
  results
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
    organizationId: seeded.organizationId,
    workspaceId: seeded.workspaceId,
    projectId: seeded.projectId,
    endpointId: typeof createdEndpointId !== 'undefined' ? createdEndpointId : null,
    cleanupSettings
  });
}
