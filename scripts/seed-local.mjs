const api = process.env.API_BASE_URL || 'http://localhost:4000';
const authToken = process.env.API_AUTH_TOKEN || '';

const ORG_NAME = process.env.SEED_ORG_NAME || 'Local Org';
const ORG_SLUG = process.env.SEED_ORG_SLUG || 'local-org';
const WS_NAME = process.env.SEED_WORKSPACE_NAME || 'Local Workspace';
const WS_SLUG = process.env.SEED_WORKSPACE_SLUG || 'local-workspace';
const PROJECT_NAME = process.env.SEED_PROJECT_NAME || 'Local Project';
const PROJECT_SLUG = process.env.SEED_PROJECT_SLUG || 'local-project';
const PROJECT_REPO_URL = process.env.SEED_PROJECT_REPO_URL || 'https://example.com/repo.git';
const PROJECT_DEFAULT_BRANCH = process.env.SEED_PROJECT_DEFAULT_BRANCH || 'main';

async function jsonFetch(path, init) {
  const res = await fetch(`${api}${path}`, {
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
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const wsResp = await jsonFetch('/v1/workspaces', {
  method: 'POST',
  body: JSON.stringify({
    organizationName: ORG_NAME,
    organizationSlug: ORG_SLUG,
    name: WS_NAME,
    slug: WS_SLUG,
    timezone: 'UTC',
    retentionDays: 30
  })
});

const workspaceId = wsResp.item.id;

const projResp = await jsonFetch('/v1/projects', {
  method: 'POST',
  body: JSON.stringify({
    workspaceId,
    name: PROJECT_NAME,
    slug: PROJECT_SLUG,
    repoUrl: PROJECT_REPO_URL,
    defaultBranch: PROJECT_DEFAULT_BRANCH
  })
});

const projectId = projResp.item.id;

console.log(JSON.stringify({
  ok: true,
  workspaceId,
  projectId,
  api
}, null, 2));
