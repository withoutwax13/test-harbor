import crypto from 'node:crypto';

const webBase = process.env.WEB_BASE_URL || 'http://localhost:3000';
const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
const ingestBase = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const ingestAuthToken = process.env.INGEST_AUTH_TOKEN || '';

function cookieHeader(jar) {
  return Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
}

function updateCookies(response, jar) {
  const cookieHeaders = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);

  for (const header of cookieHeaders) {
    const first = String(header).split(';', 1)[0];
    const index = first.indexOf('=');
    if (index === -1) continue;
    jar[first.slice(0, index)] = first.slice(index + 1);
  }
}

async function fetchJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) throw new Error(`${url} ${response.status} ${JSON.stringify(payload)}`);
  return { response, payload };
}

async function fetchHtml(url, headers = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} ${response.status} ${text}`);
  return text;
}

const now = Date.now();
const user = {
  email: `web-shell-${now}@example.com`,
  name: 'Web Shell Smoke'
};
const cookies = {};

const webLogin = await fetchJson(`${webBase}/login`, { method: 'POST', body: user });
updateCookies(webLogin.response, cookies);

const apiLogin = await fetchJson(`${apiBase}/v1/auth/login`, { method: 'POST', body: user });
const userToken = apiLogin.payload.token;

const workspaceSlug = `web-shell-workspace-${now}`;
const projectSlug = `web-shell-project-${now}`;

const workspaceCreate = await fetchJson(`${webBase}/app/workspaces`, {
  method: 'POST',
  headers: { cookie: cookieHeader(cookies) },
  body: {
    organizationName: `Web Shell Org ${now}`,
    organizationSlug: `web-shell-org-${now}`,
    name: `Web Shell Workspace ${now}`,
    slug: workspaceSlug,
    timezone: 'UTC',
    retentionDays: 7
  }
});
updateCookies(workspaceCreate.response, cookies);

const workspaces = await fetchJson(`${apiBase}/v1/workspaces`, {
  headers: { authorization: `Bearer ${userToken}` }
});
const workspace = workspaces.payload.items.find((item) => item.slug === workspaceSlug);
if (!workspace) throw new Error('workspace_not_found_after_create');

const projectCreate = await fetchJson(`${webBase}/app/projects`, {
  method: 'POST',
  headers: { cookie: cookieHeader(cookies) },
  body: {
    workspaceId: workspace.id,
    name: `Web Shell Project ${now}`,
    slug: projectSlug,
    provider: 'github-actions',
    repoUrl: 'https://example.com/web-shell.git',
    defaultBranch: 'main'
  }
});
updateCookies(projectCreate.response, cookies);

const projects = await fetchJson(`${apiBase}/v1/projects?workspaceId=${encodeURIComponent(workspace.id)}`, {
  headers: { authorization: `Bearer ${userToken}` }
});
const project = projects.payload.items.find((item) => item.slug === projectSlug);
if (!project) throw new Error('project_not_found_after_create');

const ingestHeaders = ingestAuthToken ? { authorization: `Bearer ${ingestAuthToken}` } : {};
const runId = crypto.randomUUID();
const specRunId = crypto.randomUUID();
const testResultId = crypto.randomUUID();

for (const event of [
  {
    type: 'run.started',
    payload: { runId, workspaceId: workspace.id, projectId: project.id, branch: 'main', commitSha: 'webshell123', ciProvider: 'web-smoke' }
  },
  {
    type: 'spec.started',
    payload: { specRunId, runId, specPath: 'cypress/e2e/web-shell.cy.ts' }
  },
  {
    type: 'test.result',
    payload: {
      testResultId,
      specRunId,
      projectId: project.id,
      stableTestKey: 'cypress/e2e/web-shell.cy.ts::browser pages load',
      title: 'browser pages load',
      filePath: 'cypress/e2e/web-shell.cy.ts',
      suitePath: 'Web Shell Smoke',
      status: 'passed',
      attemptNo: 1,
      durationMs: 333
    }
  },
  {
    type: 'spec.finished',
    payload: { specRunId, status: 'passed', durationMs: 777, attempts: 1 }
  },
  {
    type: 'run.finished',
    payload: { runId, status: 'passed', totalSpecs: 1, totalTests: 1, passCount: 1, failCount: 0, flakyCount: 0 }
  }
]) {
  await fetchJson(`${ingestBase}/v1/ingest/events`, {
    method: 'POST',
    headers: ingestHeaders,
    body: { type: event.type, idempotencyKey: crypto.randomUUID(), payload: event.payload }
  });
}

const signedArtifact = await fetchJson(`${apiBase}/v1/artifacts/sign-upload`, {
  method: 'POST',
  headers: { authorization: `Bearer ${userToken}` },
  body: {
    workspaceId: workspace.id,
    runId,
    specRunId,
    testResultId,
    type: 'screenshot',
    fileName: 'web-shell.png',
    contentType: 'image/png',
    byteSize: 1024
  }
});
await fetchJson(signedArtifact.payload.upload.url, {
  method: 'PUT',
  headers: {
    'x-testharbor-artifact-token': signedArtifact.payload.upload.headers['x-testharbor-artifact-token']
  },
  body: { fake: true }
});

const artifactId = signedArtifact.payload.item.id;
const pageChecks = [
  ['/app/onboarding', 'Stand up the real user flow'],
  ['/app/connect', 'Verify that TestHarbor is ready to receive events'],
  ['/app/runs', 'Run list'],
  [`/app/runs/${runId}`, 'Run detail'],
  [`/app/artifacts/${artifactId}`, 'Artifact Viewer'],
  ['/app/admin', 'Admin & Webhooks'],
  ['/session', 'Session details']
];

for (const [route, marker] of pageChecks) {
  const html = await fetchHtml(`${webBase}${route}`, { cookie: cookieHeader(cookies) });
  if (!html.includes(marker)) throw new Error(`missing_marker ${route} ${marker}`);
}

console.log(JSON.stringify({
  ok: true,
  webBase,
  workspaceId: workspace.id,
  projectId: project.id,
  runId,
  artifactId,
  checkedPages: pageChecks.map(([route]) => route)
}, null, 2));
