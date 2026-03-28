const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const apiAuthToken = process.env.API_AUTH_TOKEN || '';
const seededDataMode = (process.env.WEBHOOK_SEEDED_DATA_MODE || 'keep').toLowerCase();
const deleteSeededDataOnExit = seededDataMode === 'teardown';

export function getWebhookSmokeCleanupSettings() {
  if (!['keep', 'teardown'].includes(seededDataMode)) {
    throw new Error(`WEBHOOK_SEEDED_DATA_MODE must be one of keep|teardown, got ${seededDataMode}`);
  }

  return {
    seededDataMode,
    deleteSeededDataOnExit,
    disableEndpointOnExit: process.env.WEBHOOK_DISABLE_ENDPOINT_ON_EXIT !== '0'
  };
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

export async function cleanupWebhookSmokeSeededData({
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
      workspaceDeleted: false,
      projectDeleted: false,
      endpointDeleted: false
    };
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
    workspaceDeleted,
    projectDeleted,
    endpointDeleted
  };
}
