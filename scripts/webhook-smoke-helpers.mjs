const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const apiAuthToken = process.env.API_AUTH_TOKEN || '';
const ingestBase = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const ingestAuthToken = process.env.INGEST_AUTH_TOKEN || '';
const seededDataMode = (process.env.WEBHOOK_SEEDED_DATA_MODE || 'keep').toLowerCase();
const deleteSeededDataOnExit = seededDataMode === 'teardown';

export function getWebhookSmokeCleanupSettings() {
  if (!['keep', 'teardown'].includes(seededDataMode)) {
    throw new Error(`WEBHOOK_SEEDED_DATA_MODE must be one of keep|teardown, got ${seededDataMode}`);
  }

  return {
    seededDataMode,
    deleteSeededDataOnExit,
    disableEndpointOnExit: process.env.WEBHOOK_DISABLE_ENDPOINT_ON_EXIT !== '0',
    deleteSmokeOrganizationOnExit: process.env.WEBHOOK_DELETE_SMOKE_ORG_ON_EXIT === '1'
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function artifactStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function jsonFetch(url, init = {}, authToken = '') {
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

export async function fetchJsonWithStatus(url, init = {}, authToken = '') {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(init?.headers || {})
    }
  });
  const text = await res.text().catch(() => '');
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, ok: res.ok, body };
}

export async function deleteResource(url, authToken = '') {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {})
    }
  });

  if (res.status === 404) return false;
  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(`${url} ${res.status} ${text}`);
  }
  return true;
}

export async function assertWebhookApiRoutesAvailable() {
  const probeWorkspaceId = '00000000-0000-0000-0000-000000000000';
  const probeUrl = `${apiBase}/v1/webhook-endpoints?workspaceId=${probeWorkspaceId}`;
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

export async function postIngestEvent(type, payload, idempotencyKey) {
  return jsonFetch(`${ingestBase}/v1/ingest/events`, {
    method: 'POST',
    body: JSON.stringify({ type, idempotencyKey, payload })
  }, ingestAuthToken);
}

export async function seedWebhookWorkspaceProject({
  organizationName = 'Webhook Org',
  organizationSlug = `webhook-org-${Date.now()}`,
  workspaceName = 'Webhook Workspace',
  workspaceSlug = `webhook-workspace-${Date.now()}`,
  projectName = 'Webhook Project',
  projectSlug = `webhook-project-${Date.now()}`
} = {}) {
  const ws = await jsonFetch(`${apiBase}/v1/workspaces`, {
    method: 'POST',
    body: JSON.stringify({
      organizationName,
      organizationSlug,
      name: workspaceName,
      slug: workspaceSlug,
      timezone: 'UTC',
      retentionDays: 30
    })
  }, apiAuthToken);

  const project = await jsonFetch(`${apiBase}/v1/projects`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: ws.item.id,
      name: projectName,
      slug: projectSlug,
      provider: 'github',
      repoUrl: 'https://example.com/repo.git',
      defaultBranch: 'main'
    })
  }, apiAuthToken);

  return {
    organizationId: ws.item.organization_id || null,
    organizationSlug: ws.item.organization_slug || organizationSlug,
    workspaceId: ws.item.id,
    projectId: project.item.id
  };
}

export async function pollUntil({
  label,
  timeoutMs,
  intervalMs,
  poll,
  isDone,
  mapState = (value) => value,
  maxSamples = 20
}) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastValue = null;
  let lastState = null;
  const samples = [];

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const pollStartedAt = Date.now();
    const value = await poll();
    const pollDurationMs = Date.now() - pollStartedAt;
    lastValue = value;
    lastState = mapState(value);

    if (samples.length < maxSamples) {
      samples.push({
        attempt: attempts,
        elapsedMs: Date.now() - startedAt,
        pollDurationMs,
        state: lastState
      });
    }

    if (isDone(value)) {
      return {
        value,
        metrics: {
          label,
          timeoutMs,
          intervalMs,
          attempts,
          elapsedMs: Date.now() - startedAt,
          timedOut: false,
          lastState,
          samples
        }
      };
    }

    await sleep(intervalMs);
  }

  return {
    value: lastValue,
    metrics: {
      label,
      timeoutMs,
      intervalMs,
      attempts,
      elapsedMs: Date.now() - startedAt,
      timedOut: true,
      lastState,
      samples
    }
  };
}

export async function cleanupWebhookSmokeSeededData({
  organizationId,
  workspaceId,
  projectId,
  endpointId,
  disableEndpoint,
  log = () => {}
}) {
  const cleanupSettings = getWebhookSmokeCleanupSettings();

  if (endpointId && cleanupSettings.disableEndpointOnExit) {
    await disableEndpoint(endpointId).catch(() => {});
  }

  if (!cleanupSettings.deleteSeededDataOnExit) {
    return {
      mode: cleanupSettings.seededDataMode,
      organizationCleanupAttempted: false,
      organizationDeleted: false,
      workspaceDeleted: false,
      projectDeleted: false,
      endpointDeleted: false
    };
  }

  if (organizationId && cleanupSettings.deleteSmokeOrganizationOnExit) {
    const cleanupRes = await fetchJsonWithStatus(
      `${apiBase}/v1/organizations/${organizationId}/smoke-cleanup?confirm=delete-smoke-organization`,
      { method: 'DELETE' },
      apiAuthToken
    ).catch((error) => ({
      status: 0,
      ok: false,
      body: { error: error.message }
    }));

    if (cleanupRes.ok) {
      return {
        mode: cleanupSettings.seededDataMode,
        organizationCleanupAttempted: true,
        organizationDeleted: true,
        workspaceDeleted: true,
        projectDeleted: true,
        endpointDeleted: true
      };
    }

    log(
      `safe smoke organization cleanup skipped for organization ${organizationId}: status=${cleanupRes.status} body=${JSON.stringify(cleanupRes.body)}`
    );
  }

  let endpointDeleted = false;
  let projectDeleted = false;
  let workspaceDeleted = false;

  if (endpointId) {
    endpointDeleted = await deleteResource(`${apiBase}/v1/webhook-endpoints/${endpointId}`, apiAuthToken).catch((error) => {
      log(`failed to delete webhook endpoint ${endpointId}: ${error.message}`);
      return false;
    });
  }

  if (projectId) {
    projectDeleted = await deleteResource(`${apiBase}/v1/projects/${projectId}`, apiAuthToken).catch((error) => {
      log(`failed to delete project ${projectId}: ${error.message}`);
      return false;
    });
  }

  if (workspaceId) {
    workspaceDeleted = await deleteResource(`${apiBase}/v1/workspaces/${workspaceId}`, apiAuthToken).catch((error) => {
      log(`failed to delete workspace ${workspaceId}: ${error.message}`);
      return false;
    });
  }

  return {
    mode: cleanupSettings.seededDataMode,
    organizationCleanupAttempted: Boolean(organizationId && cleanupSettings.deleteSmokeOrganizationOnExit),
    organizationDeleted: false,
    workspaceDeleted,
    projectDeleted,
    endpointDeleted
  };
}
