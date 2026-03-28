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
const apiAuthToken = process.env.API_AUTH_TOKEN || '';
const artifactDir = process.env.WEBHOOK_ARTIFACT_DIR || '';
const cleanupSettings = getWebhookSmokeCleanupSettings();

if (!apiAuthToken) {
  throw new Error('API_AUTH_TOKEN is required for smoke:webhooks:route-contract');
}

await assertWebhookApiRoutesAvailable();

async function maybeWriteArtifact(payload) {
  if (!artifactDir) return null;
  const outDir = path.resolve(artifactDir);
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `webhook-route-contract-${artifactStamp()}.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2));
  return file;
}

const seeded = await seedWebhookWorkspaceProject({
  organizationName: 'Webhook Route Contract Org',
  workspaceName: 'Webhook Route Contract Workspace',
  projectName: 'Webhook Route Contract Project'
});

let endpointId = null;

const call = (url, init = {}) => fetchJsonWithStatus(url, init, apiAuthToken);

try {
  const checks = [];

  const missingWorkspace = await call(`${apiBase}/v1/webhook-endpoints`);
  checks.push({
    name: 'listEndpoints.workspaceRequired',
    expectedStatus: 400,
    gotStatus: missingWorkspace.status,
    pass: missingWorkspace.status === 400
  });

  const create = await call(`${apiBase}/v1/webhook-endpoints`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: seeded.workspaceId,
      type: 'run.finished',
      targetUrl: 'http://127.0.0.1:9/hook',
      secret: 'route-contract-secret',
      enabled: true
    })
  });

  endpointId = create.body?.item?.id || null;
  checks.push({
    name: 'createEndpoint.success',
    expectedStatus: 201,
    gotStatus: create.status,
    endpointId,
    pass: create.status === 201 && Boolean(endpointId)
  });

  const patchEmpty = await call(`${apiBase}/v1/webhook-endpoints/${endpointId}`, {
    method: 'PATCH',
    body: JSON.stringify({})
  });
  checks.push({
    name: 'patchEndpoint.emptyBodyRejected',
    expectedStatus: 400,
    gotStatus: patchEmpty.status,
    pass: patchEmpty.status === 400
  });

  const patchDisable = await call(`${apiBase}/v1/webhook-endpoints/${endpointId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false })
  });
  checks.push({
    name: 'patchEndpoint.enabledFalse',
    expectedStatus: 200,
    gotStatus: patchDisable.status,
    pass: patchDisable.status === 200 && patchDisable.body?.item?.enabled === false
  });

  const patchClearSecret = await call(`${apiBase}/v1/webhook-endpoints/${endpointId}`, {
    method: 'PATCH',
    body: JSON.stringify({ secret: null })
  });
  checks.push({
    name: 'patchEndpoint.secretClearAccepted',
    expectedStatus: 200,
    gotStatus: patchClearSecret.status,
    pass: patchClearSecret.status === 200
  });

  const patchEnable = await call(`${apiBase}/v1/webhook-endpoints/${endpointId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: true })
  });
  checks.push({
    name: 'patchEndpoint.enabledTrue',
    expectedStatus: 200,
    gotStatus: patchEnable.status,
    pass: patchEnable.status === 200 && patchEnable.body?.item?.enabled === true
  });

  const deleteEndpoint = await call(`${apiBase}/v1/webhook-endpoints/${endpointId}`, {
    method: 'DELETE'
  });
  checks.push({
    name: 'deleteEndpoint.success',
    expectedStatus: 204,
    gotStatus: deleteEndpoint.status,
    pass: deleteEndpoint.status === 204
  });

  const deleteAgain = await call(`${apiBase}/v1/webhook-endpoints/${endpointId}`, {
    method: 'DELETE'
  });
  checks.push({
    name: 'deleteEndpoint.idempotentNotFound',
    expectedStatus: 404,
    gotStatus: deleteAgain.status,
    pass: deleteAgain.status === 404 && deleteAgain.body?.error === 'not_found'
  });

  endpointId = null;

  const deliveriesMissingWorkspace = await call(`${apiBase}/v1/webhook-deliveries`);
  checks.push({
    name: 'listDeliveries.workspaceRequired',
    expectedStatus: 400,
    gotStatus: deliveriesMissingWorkspace.status,
    pass: deliveriesMissingWorkspace.status === 400
  });

  const deliveriesList = await call(`${apiBase}/v1/webhook-deliveries?workspaceId=${seeded.workspaceId}`);
  checks.push({
    name: 'listDeliveries.success',
    expectedStatus: 200,
    gotStatus: deliveriesList.status,
    pass: deliveriesList.status === 200 && Array.isArray(deliveriesList.body?.items)
  });

  const failed = checks.filter((c) => !c.pass);
  const output = {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    cleanupMode: cleanupSettings.seededDataMode,
    workspaceId: seeded.workspaceId,
    projectId: seeded.projectId,
    endpointId,
    checks,
    failedChecks: failed
  };

  const artifactPath = await maybeWriteArtifact(output);
  const withPath = artifactPath ? { ...output, artifactPath } : output;

  if (!withPath.ok) {
    console.error(JSON.stringify(withPath, null, 2));
    process.exitCode = 1;
  }

  console.log(JSON.stringify(withPath, null, 2));
} finally {
  await cleanupWebhookSmokeSeededData({
    organizationId: seeded.organizationId,
    workspaceId: seeded.workspaceId,
    projectId: seeded.projectId,
    endpointId,
    disableEndpoint: async (id) => {
      await fetchJsonWithStatus(`${apiBase}/v1/webhook-endpoints/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false })
      }, apiAuthToken);
    }
  });
}
