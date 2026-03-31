import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';

const app = Fastify({ logger: true });

function setNoStoreCache(reply) {
  reply.header('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
  reply.header('pragma', 'no-cache');
  reply.header('expires', '0');
}

app.addHook('onSend', async (request, reply, payload) => {
  if (String(request.url).startsWith('/app/')) {
    setNoStoreCache(reply);
  }
  return payload;
});
const port = Number(process.env.PORT || 3000);
const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
const INGEST_PUBLIC_BASE_URL = (process.env.INGEST_PUBLIC_BASE_URL || 'http://localhost:4010').replace(/\/+$/, '');
const SESSION_COOKIE = 'th_session';
const WORKSPACE_COOKIE = 'th_workspace';
const PROJECT_COOKIE = 'th_project';
const NEW_PROJECT_TOKEN_COOKIE = 'th_new_project_token';
const stylesPath = path.join(process.cwd(), 'apps/web/src/styles.css');
const scriptPath = path.join(process.cwd(), 'apps/web/src/web.js');
const stylesCss = await fs.readFile(stylesPath, 'utf8');
const appJs = await fs.readFile(scriptPath, 'utf8');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) return 'n/a';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(new Date(value));
}

function toDatetimeLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function toIsoFromDatetimeLocal(value) {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function parseJsonCookie(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatTokenState(token) {
  return String(token?.state || 'unknown').toLowerCase();
}

function formatDeliveryState(status) {
  if (status === 'delivered') return 'success';
  if (status === 'dead') return 'danger';
  return 'warning';
}

function formatRunState(status) {
  if (status === 'passed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'flaky') return 'warning';
  return 'neutral';
}

function formatDeltaFromNow(value) {
  if (!value) return 'n/a';
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return 'n/a';
  const deltaMs = ts - Date.now();
  const absMs = Math.abs(deltaMs);
  const minutes = Math.round(absMs / 60000);
  if (minutes < 1) return deltaMs >= 0 ? 'in <1m' : '<1m ago';
  if (minutes < 60) return deltaMs >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return deltaMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return deltaMs >= 0 ? `in ${days}d` : `${days}d ago`;
}

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (!value) return '0 ms';
  if (value < 1000) return `${value} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60000).toFixed(1)} min`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = units[0];
  for (const next of units) {
    unit = next;
    if (size < 1024 || next === units.at(-1)) break;
    size /= 1024;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${unit}`;
}

function slugify(value, fallback = 'item') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function parseCookies(headerValue) {
  const result = {};
  for (const chunk of String(headerValue || '').split(';')) {
    const index = chunk.indexOf('=');
    if (index === -1) continue;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}

function buildCookie(name, value, { maxAge = 60 * 60 * 24 * 30 } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function setCookies(reply, cookies) {
  reply.raw.setHeader('Set-Cookie', cookies);
}

async function apiFetch(pathname, { method = 'GET', token = '', body = null } = {}) {
  const res = await fetch(`${API_BASE_URL}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    const error = new Error(payload.error || payload.detail || `request_failed_${res.status}`);
    error.statusCode = res.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function apiFetchRaw(pathname, { method = 'GET', token = '', headers = {}, body } = {}) {
  return fetch(`${API_BASE_URL}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body !== undefined ? { body } : {})
  });
}

function jsonRedirect(reply, redirectTo, cookies = []) {
  if (cookies.length) setCookies(reply, cookies);
  return reply.send({ ok: true, redirectTo });
}

function getRequestContext(request) {
  const cookies = parseCookies(request.headers.cookie);
  const notice = request.query?.notice ? String(request.query.notice) : '';
  const error = request.query?.error ? String(request.query.error) : '';
  return {
    cookies,
    token: cookies[SESSION_COOKIE] || '',
    selectedWorkspaceId: request.query?.workspaceId || cookies[WORKSPACE_COOKIE] || '',
    selectedProjectId: request.query?.projectId || cookies[PROJECT_COOKIE] || '',
    newProjectToken: parseJsonCookie(cookies[NEW_PROJECT_TOKEN_COOKIE]),
    notice,
    error
  };
}

async function getSession(request) {
  const ctx = getRequestContext(request);
  if (!ctx.token) return { ctx, session: null };

  try {
    const me = await apiFetch('/v1/me', { token: ctx.token });
    return {
      ctx,
      session: {
        token: ctx.token,
        user: me.user,
        memberships: me.memberships || []
      }
    };
  } catch (error) {
    if (error.statusCode === 401) {
      return { ctx, session: null, expired: true };
    }
    throw error;
  }
}

async function requireSession(request, reply) {
  const { ctx, session, expired } = await getSession(request);
  if (!session) {
    if (expired) setCookies(reply, [clearCookie(SESSION_COOKIE), clearCookie(WORKSPACE_COOKIE), clearCookie(PROJECT_COOKIE), clearCookie(NEW_PROJECT_TOKEN_COOKIE)]);
    return reply.redirect(`/login${expired ? '?error=Session expired. Sign in again.' : ''}`);
  }
  return { ctx, session };
}

async function loadShellData(request) {
  const { ctx, session } = await getSession(request);
  if (!session) return { ctx, session: null, workspaces: [], projects: [], selectedWorkspace: null, selectedProject: null };

  const workspaceResp = await apiFetch('/v1/workspaces', { token: session.token });
  const workspaces = workspaceResp.items || [];
  const selectedWorkspace = workspaces.find((item) => item.id === ctx.selectedWorkspaceId) || workspaces[0] || null;
  const projects = selectedWorkspace
    ? (await apiFetch(`/v1/projects?workspaceId=${encodeURIComponent(selectedWorkspace.id)}`, { token: session.token })).items || []
    : [];
  const selectedProject = projects.find((item) => item.id === ctx.selectedProjectId) || projects[0] || null;

  return {
    ctx,
    session,
    workspaces,
    projects,
    selectedWorkspace,
    selectedProject
  };
}

function badge(label, tone = 'neutral') {
  return `<span class="badge badge-${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function summaryCard(label, value, detail = '') {
  return `<article class="summary-card"><span class="summary-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`;
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderLayout({ title, shell, currentPath, content }) {
  const user = shell.session?.user;
  const workspaceName = shell.selectedWorkspace?.name || 'No workspace';
  const projectName = shell.selectedProject?.name || 'No project';
  const navItems = [
    ['/app/onboarding', 'Onboarding'],
    ['/app/connect', 'Connect'],
    ['/app/team', 'Team'],
    ['/app/runs', 'Runs'],
    ['/app/admin', 'Admin'],
    ['/session', 'Session']
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · TestHarbor</title>
  <link rel="stylesheet" href="/assets/styles.css" />
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="/app/onboarding">
        <span class="brand-mark">TH</span>
        <span>
          <strong>TestHarbor</strong>
          <small>Browser operator shell</small>
        </span>
      </a>
      <div class="sidebar-context">
        <p>${escapeHtml(workspaceName)}</p>
        <small>${escapeHtml(projectName)}</small>
      </div>
      <nav class="nav">
        ${navItems.map(([href, label]) => `<a class="${currentPath.startsWith(href) ? 'active' : ''}" href="${href}">${escapeHtml(label)}</a>`).join('')}
      </nav>
      <form class="sidebar-logout" data-json-form action="/logout" method="post">
        <button type="submit" class="button button-secondary button-full">Sign out</button>
      </form>
    </aside>
    <main class="content">
      <header class="topbar">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(user?.name || 'Anonymous')}</p>
        </div>
        <div class="topbar-badges">
          ${shell.selectedWorkspace ? badge(shell.selectedWorkspace.slug, 'success') : ''}
          ${shell.selectedProject ? badge(shell.selectedProject.slug, 'warning') : ''}
        </div>
      </header>
      ${shell.ctx.notice ? `<div class="flash flash-notice">${escapeHtml(shell.ctx.notice)}</div>` : ''}
      ${shell.ctx.error ? `<div class="flash flash-error">${escapeHtml(shell.ctx.error)}</div>` : ''}
      ${content}
    </main>
  </div>
  <script src="/assets/web.js" defer></script>
</body>
</html>`;
}

function renderSelectContextCard(shell, returnTo) {
  return `<section class="panel">
    <div class="panel-header">
      <div>
        <h2>Current context</h2>
        <p>Choose the workspace and project this browser session should operate against.</p>
      </div>
    </div>
    <form class="stack" data-json-form action="/app/context" method="post">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
      <label>
        Workspace
        <select name="workspaceId">
          ${shell.workspaces.map((workspace) => `<option value="${workspace.id}" ${workspace.id === shell.selectedWorkspace?.id ? 'selected' : ''}>${escapeHtml(workspace.name)} · ${escapeHtml(workspace.organization_slug || workspace.organization_name || 'org')}</option>`).join('')}
        </select>
      </label>
      <label>
        Project
        <select name="projectId">
          <option value="">Select a project</option>
          ${shell.projects.map((project) => `<option value="${project.id}" ${project.id === shell.selectedProject?.id ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('')}
        </select>
      </label>
      <button class="button" type="submit">Save context</button>
    </form>
  </section>`;
}

function renderProgressSteps(shell, tokens, latestRun) {
  const hasContext = Boolean(shell.selectedWorkspace && shell.selectedProject);
  const hasToken = tokens.some((token) => formatTokenState(token) === 'active');
  const hasVerificationRun = Boolean(latestRun);
  const steps = [
    {
      title: 'Workspace + project',
      done: hasContext,
      detail: hasContext
        ? `${shell.selectedWorkspace.name} / ${shell.selectedProject.name}`
        : 'Select or create both in onboarding'
    },
    {
      title: 'Project ingest token',
      done: hasToken,
      detail: hasToken ? `${tokens.filter((token) => formatTokenState(token) === 'active').length} active token(s)` : 'Mint a token before wiring Cypress'
    },
    {
      title: 'Cypress reporter config',
      done: hasContext && hasToken,
      detail: hasContext && hasToken ? 'Use the snippet below in CI or local Cypress' : 'Needs context and an active token'
    },
    {
      title: 'Verify run ingestion',
      done: hasVerificationRun,
      detail: hasVerificationRun
        ? `${latestRun.status} · ${formatDate(latestRun.created_at)}`
        : 'Trigger run.started and confirm it appears in /app/runs'
    }
  ];

  return `<section class="panel">
    <div class="panel-header">
      <div>
        <h2>Progress</h2>
        <p>Move left-to-right: context → token → Cypress wiring → verify run.</p>
      </div>
    </div>
    <ol class="step-list">
      ${steps.map((step, index) => `<li class="${step.done ? 'done' : 'todo'}">
        <span class="step-index">${index + 1}</span>
        <div>
          <strong>${escapeHtml(step.title)}</strong>
          <small>${escapeHtml(step.detail)}</small>
        </div>
        ${badge(step.done ? 'done' : 'todo', step.done ? 'success' : 'warning')}
      </li>`).join('')}
    </ol>
  </section>`;
}

function renderTokenPanel(shell, tokens, { returnTo = '/app/connect', newTokenBundle = null } = {}) {
  if (!shell.selectedWorkspace || !shell.selectedProject) {
    return '<section class="panel"><div class="empty-state"><h3>Project token controls unavailable</h3><p>Select a workspace and project first.</p></div></section>';
  }

  const items = tokens || [];
  const activeCount = items.filter((item) => formatTokenState(item) === 'active').length;
  const oneTimeToken = newTokenBundle?.token || '';

  return `<section class="panel">
    <div class="panel-header">
      <div>
        <h2>Project ingest tokens</h2>
        <p>Tokens are project-scoped. The raw token is shown once at creation, then only hash + hint are retained.</p>
      </div>
      ${badge(`${activeCount} active`, activeCount ? 'success' : 'warning')}
    </div>
    ${oneTimeToken ? `<div class="flash flash-notice">
      <strong>Token created — copy it now.</strong>
      <pre class="code-block">${escapeHtml(oneTimeToken)}</pre>
      <p>This value is not recoverable after this page render.</p>
    </div>` : ''}
    <div class="grid two-up compact-grid">
      <form class="stack" data-json-form action="/app/project-ingest-tokens" method="post">
        <input type="hidden" name="projectId" value="${escapeHtml(shell.selectedProject.id)}" />
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
        <label>Label<input name="label" placeholder="cypress-ci" required /></label>
        <label>TTL (days)<input name="ttlDays" type="number" min="1" max="365" value="90" /></label>
        <button class="button" type="submit">Create token</button>
      </form>
      <div class="stack">
        <small>Recommended naming: environment + runner + purpose (for example <code>gha-e2e-main</code>).</small>
        <small>Rotate by creating a new token, updating CI secret, then revoking the old token.</small>
        <small>Token hint is the last characters only; the plaintext token is never returned again.</small>
      </div>
    </div>
    ${items.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Label</th><th>Hint</th><th>State</th><th>Expires</th><th>Last used</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${items.map((item) => {
          const state = formatTokenState(item);
          const tone = state === 'active' ? 'success' : state === 'expired' ? 'warning' : 'danger';
          return `<tr>
            <td>${escapeHtml(item.label || 'token')}</td>
            <td><code>…${escapeHtml(item.token_hint || '')}</code></td>
            <td>${badge(state, tone)}</td>
            <td>${escapeHtml(formatDate(item.expires_at))}</td>
            <td>${escapeHtml(formatDate(item.last_used_at))}</td>
            <td>${escapeHtml(formatDate(item.created_at))}</td>
            <td>
              ${state === 'revoked' ? '' : `<form data-json-form data-confirm="Revoke token ${escapeHtml(item.label || item.id)}?" action="/app/project-ingest-tokens/${item.id}/revoke" method="post">
                <input type="hidden" name="projectId" value="${escapeHtml(shell.selectedProject.id)}" />
                <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
                <button class="button button-danger" type="submit">Revoke</button>
              </form>`}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>` : '<div class="empty-state"><h3>No project tokens</h3><p>Create the first token to unlock the Cypress snippet.</p></div>'}
  </section>`;
}

function renderSnippet(shell, { tokens = [], latestRun = null, newTokenBundle = null } = {}) {
  const workspace = shell.selectedWorkspace;
  const project = shell.selectedProject;
  if (!workspace || !project) {
    return '<div class="empty-state"><h3>Connect snippet unavailable</h3><p>Create or select a workspace and project first.</p></div>';
  }

  const activeToken = newTokenBundle?.token || (tokens.find((item) => formatTokenState(item) === 'active') ? '\${TESTHARBOR_INGEST_TOKEN}' : '<create-a-project-token>');
  const snippet = `# Only one ID is required in cypress.config: projectId
# Token and ingest URL come from env (CI secret + URL)
export TESTHARBOR_INGEST_URL="${INGEST_PUBLIC_BASE_URL}/v1/ingest/events"
export TESTHARBOR_INGEST_TOKEN="${activeToken}"

import { defineConfig } from 'cypress';
import { withTestHarborCypress } from '@testharbor/cypress-reporter';

export default defineConfig({
  e2e: {
    setupNodeEvents: withTestHarborCypress({
      projectId: '${project.id}'
    })
  }
});`;

  return `<section class="panel">
    <div class="panel-header">
      <div>
        <h2>Cypress-first connect snippet</h2>
        <p>ProjectId-centric setup: paste one projectId in config, keep token/base URL in env.</p>
      </div>
      ${badge(project.provider || 'custom', 'neutral')}
    </div>
    <pre class="code-block">${escapeHtml(snippet)}</pre>
    <div class="stack">
      <small><strong>Minimal setupNodeEvents:</strong> no manual run/spec/test wiring required.</small>
      <small><strong>Workspace ID optional:</strong> ingest resolves workspace from projectId when omitted.</small>
      <small><strong>Artifacts:</strong> helper auto-registers screenshots/videos from Cypress results.</small>
    </div>
    ${latestRun ? `<p>Latest run: <a class="text-link" href="/app/runs/${latestRun.id}">${escapeHtml(latestRun.id.slice(0, 8))}</a> · ${badge(latestRun.status, formatRunState(latestRun.status))}</p>` : '<p>No run yet. Run Cypress once to verify end-to-end auth and ingest.</p>'}
  </section>`;
}

function renderOnboardingPage(shell, { tokens = [], latestRun = null, newTokenBundle = null } = {}) {
  const workspaceStats = `${shell.workspaces.length} workspace${shell.workspaces.length === 1 ? '' : 's'}`;
  const projectStats = `${shell.projects.length} project${shell.projects.length === 1 ? '' : 's'}`;

  return renderLayout({
    title: 'Onboarding',
    shell,
    currentPath: '/app/onboarding',
    content: `<section class="hero">
        <div>
          <p class="eyebrow">Batches 19-26 productized</p>
          <h2>Stand up the real user flow</h2>
          <p>Authenticate, create a workspace, choose a project, mint a project token, wire Cypress, and verify the first run.</p>
        </div>
        <div class="hero-metrics">
          ${summaryCard('Workspaces', workspaceStats, 'Available to this user')}
          ${summaryCard('Projects', projectStats, shell.selectedWorkspace ? `Inside ${shell.selectedWorkspace.name}` : 'Create one to continue')}
          ${summaryCard('Session', shell.session?.user?.email || 'No session', 'Local auth token')}
        </div>
      </section>
      ${renderProgressSteps(shell, tokens, latestRun)}
      <div class="grid two-up">
        ${renderSelectContextCard(shell, '/app/onboarding')}
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Create workspace</h2>
              <p>Organization and workspace are created together so the operator can move immediately to project setup.</p>
            </div>
          </div>
          <form class="stack" data-json-form action="/app/workspaces" method="post">
            <label>Organization name<input name="organizationName" placeholder="Acme Inc" required /></label>
            <label>Organization slug<input name="organizationSlug" placeholder="acme-inc" required /></label>
            <label>Workspace name<input name="name" placeholder="Platform QA" required /></label>
            <label>Workspace slug<input name="slug" placeholder="platform-qa" required /></label>
            <label>Timezone<input name="timezone" value="UTC" /></label>
            <label>Retention days<input name="retentionDays" type="number" min="1" value="30" /></label>
            <button class="button" type="submit">Create workspace</button>
          </form>
        </section>
      </div>
      <div class="grid two-up">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Create project</h2>
              <p>Bind the selected workspace to a repo so runs and artifacts have a real home.</p>
            </div>
          </div>
          <form class="stack" data-json-form action="/app/projects" method="post">
            <input type="hidden" name="workspaceId" value="${escapeHtml(shell.selectedWorkspace?.id || '')}" />
            <label>Project name<input name="name" placeholder="web-e2e" required /></label>
            <label>Project slug<input name="slug" placeholder="web-e2e" required /></label>
            <label>Provider<input name="provider" placeholder="github-actions" /></label>
            <label>Repo URL<input name="repoUrl" placeholder="https://github.com/acme/repo" /></label>
            <label>Default branch<input name="defaultBranch" value="main" /></label>
            <button class="button" type="submit" ${shell.selectedWorkspace ? '' : 'disabled'}>Create project</button>
          </form>
        </section>
        ${renderTokenPanel(shell, tokens, { returnTo: '/app/onboarding', newTokenBundle })}
      </div>
      ${renderSnippet(shell, { tokens, latestRun, newTokenBundle, returnTo: '/app/onboarding' })}`
  });
}

function renderStatusCard(label, status, detail, tone) {
  return `<article class="status-card">
    <div class="status-head">
      <div>
        <h3>${escapeHtml(label)}</h3>
        <p>${escapeHtml(detail)}</p>
      </div>
      ${badge(status, tone)}
    </div>
  </article>`;
}

function renderConnectPage(shell, status, latestRun, { tokens = [], newTokenBundle = null } = {}) {
  const apiStatus = status.services.api;
  const ingestStatus = status.services.ingest;
  const workerStatus = status.services.worker;

  return renderLayout({
    title: 'Connect & Health',
    shell,
    currentPath: '/app/connect',
    content: `<section class="hero compact">
        <div>
          <p class="eyebrow">Operator checks</p>
          <h2>Verify that TestHarbor is ready to receive events</h2>
          <p>Service health is aggregated server-side so this page works for local Docker and remote deployments behind private URLs.</p>
        </div>
        <div class="hero-metrics">
          ${summaryCard('Recent runs', String(status.metrics.recentRuns24h), 'Last 24 hours')}
          ${summaryCard('Latest run', latestRun?.status || 'none', latestRun ? formatDate(latestRun.created_at) : 'No run in selected project')}
        </div>
      </section>
      ${renderProgressSteps(shell, tokens, latestRun)}
      <div class="grid three-up">
        ${renderStatusCard('API', apiStatus.state, `DB: ${apiStatus.db}, storage: ${apiStatus.storageBackend}`, apiStatus.ok ? 'success' : 'danger')}
        ${renderStatusCard('Ingest', ingestStatus.state, `Base URL: ${ingestStatus.baseUrl}`, ingestStatus.ok ? 'success' : 'danger')}
        ${renderStatusCard('Worker', workerStatus.state, workerStatus.heartbeat ? `Last heartbeat ${formatDate(workerStatus.heartbeat.last_seen_at)}` : 'No heartbeat recorded yet', workerStatus.ok ? 'success' : 'warning')}
      </div>
      <div class="grid two-up">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Queue health</h2>
              <p>Worker freshness and webhook backlog from the same status read used by the app shell.</p>
            </div>
          </div>
          <div class="metrics-grid">
            ${metric('Queued', workerStatus.queue?.queued || 0)}
            ${metric('Retrying', workerStatus.queue?.retry_scheduled || 0)}
            ${metric('Delivering', workerStatus.queue?.delivering || 0)}
            ${metric('Dead', workerStatus.queue?.dead || 0)}
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Send test event</h2>
              <p>Queue a notification test against the selected workspace to validate API → worker → webhook delivery.</p>
            </div>
          </div>
          <form class="stack" data-json-form action="/app/connect/test-event" method="post">
            <input type="hidden" name="workspaceId" value="${escapeHtml(shell.selectedWorkspace?.id || '')}" />
            <input type="hidden" name="runId" value="${escapeHtml(latestRun?.id || '')}" />
            <label>Channel
              <select name="channel">
                <option value="slack">slack</option>
                <option value="discord">discord</option>
              </select>
            </label>
            <label>Message<textarea name="message" rows="3">TestHarbor browser smoke from /app/connect</textarea></label>
            <button class="button" type="submit" ${shell.selectedWorkspace ? '' : 'disabled'}>Queue test event</button>
          </form>
        </section>
      </div>
      <div class="grid two-up">
        ${renderTokenPanel(shell, tokens, { returnTo: '/app/connect', newTokenBundle })}
        ${renderSnippet(shell, { tokens, latestRun, newTokenBundle, returnTo: '/app/connect' })}
      </div>`
  });
}

function renderRunsPage(shell, runsResp) {
  const items = runsResp.items || [];
  const pageInfo = runsResp.pageInfo || { page: 1, totalPages: 1, total: items.length };
  const failureFirst = items.filter((run) => (Number(run.fail_count || 0) + Number(run.flaky_count || 0)) > 0 || ['failed', 'flaky'].includes(run.status));
  const failureOnly = shell.ctx.focus === 'failure';
  const visibleItems = failureOnly ? failureFirst : items;

  const paramsBase = new URLSearchParams({
    workspaceId: shell.selectedWorkspace?.id || '',
    projectId: shell.selectedProject?.id || '',
    ...(shell.ctx.branch ? { branch: shell.ctx.branch } : {}),
    ...(shell.ctx.runStatus ? { status: shell.ctx.runStatus } : {}),
    ...(shell.ctx.from ? { from: shell.ctx.from } : {}),
    ...(shell.ctx.to ? { to: shell.ctx.to } : {}),
    ...(shell.ctx.page ? { page: shell.ctx.page } : {})
  });
  const allHref = `/app/runs?${new URLSearchParams([...paramsBase, ['focus', 'all']]).toString()}`;
  const failureHref = `/app/runs?${new URLSearchParams([...paramsBase, ['focus', 'failure']]).toString()}`;

  return renderLayout({
    title: 'Runs',
    shell,
    currentPath: '/app/runs',
    content: `<section class="panel">
        <div class="panel-header">
          <div>
            <h2>Run list</h2>
            <p>Filterable browser list for the selected project, including date windows for triage slices.</p>
          </div>
          <div class="topbar-badges">
            ${badge(`${pageInfo.total} total`, 'neutral')}
            ${badge(`${failureFirst.length} failing/flaky`, failureFirst.length ? 'warning' : 'neutral')}
          </div>
        </div>
        <form class="filters filters-wide" method="get" action="/app/runs">
          <input type="hidden" name="workspaceId" value="${escapeHtml(shell.selectedWorkspace?.id || '')}" />
          <input type="hidden" name="projectId" value="${escapeHtml(shell.selectedProject?.id || '')}" />
          <label>Branch<input name="branch" value="${escapeHtml(shell.ctx.branch || '')}" /></label>
          <label>Status<input name="status" value="${escapeHtml(shell.ctx.runStatus || '')}" /></label>
          <label>From (UTC)<input type="datetime-local" name="from" value="${escapeHtml(shell.ctx.from || '')}" /></label>
          <label>To (UTC)<input type="datetime-local" name="to" value="${escapeHtml(shell.ctx.to || '')}" /></label>
          <label>Page<input type="number" min="1" name="page" value="${escapeHtml(shell.ctx.page || '1')}" /></label>
          <label>Focus
            <select name="focus">
              <option value="all" ${failureOnly ? '' : 'selected'}>all runs</option>
              <option value="failure" ${failureOnly ? 'selected' : ''}>failing/flaky only</option>
            </select>
          </label>
          <button class="button button-secondary" type="submit">Apply filters</button>
        </form>
        ${failureFirst.length ? `<div class="failure-quick-view">
          <div class="panel-header">
            <h3>Failure-first quick view</h3>
            <div class="topbar-badges">
              <a class="button button-secondary" href="${escapeHtml(allHref)}">All runs</a>
              <a class="button button-secondary" href="${escapeHtml(failureHref)}">Failures only</a>
            </div>
          </div>
          <div class="metrics-grid">
            ${failureFirst.slice(0, 6).map((run) => `<article class="metric">
              <span>${escapeHtml(formatDate(run.created_at))}</span>
              <strong><a class="text-link" href="/app/runs/${run.id}">${escapeHtml((run.branch || 'n/a').slice(0, 32))}</a></strong>
              <small>${badge(run.status, formatRunState(run.status))} · ${escapeHtml(`${run.fail_count || 0} failed / ${run.flaky_count || 0} flaky`)}</small>
            </article>`).join('')}
          </div>
        </div>` : ''}
        ${visibleItems.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Created</th><th>Status</th><th>Branch</th><th>Commit</th><th>Specs</th><th>Tests</th><th></th></tr></thead>
          <tbody>
            ${visibleItems.map((run) => `<tr>
              <td>${escapeHtml(formatDate(run.created_at))}</td>
              <td>${badge(run.status, formatRunState(run.status))}</td>
              <td>${escapeHtml(run.branch || 'n/a')}</td>
              <td><code>${escapeHtml((run.commit_sha || 'n/a').slice(0, 12))}</code></td>
              <td>${escapeHtml(`${run.total_specs}/${run.pass_count + run.fail_count + run.flaky_count || run.total_specs}`)}</td>
              <td>${escapeHtml(`${run.total_tests} total`)}</td>
              <td><a class="text-link" href="/app/runs/${run.id}">Open</a></td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="empty-state"><h3>No runs for this filter</h3><p>Try clearing filters or switching focus back to all runs.</p></div>'}
      </section>`
  });
}

function renderRunDetailPage(shell, runDetail) {
  const item = runDetail.item;
  const summary = runDetail.summary;
  const specs = runDetail.specs || [];
  const tests = runDetail.tests || [];
  const artifacts = runDetail.artifacts || [];
  const failingOrFlaky = tests.filter((test) => ['failed', 'flaky'].includes(test.status));

  const flakyByTest = Object.values(
    tests.reduce((acc, test) => {
      const key = test.test_case_id || test.test_title || test.id;
      if (!acc[key]) {
        acc[key] = {
          test_case_id: test.test_case_id,
          test_title: test.test_title,
          file_path: test.file_path,
          flakyCount: 0,
          failedCount: 0
        };
      }
      if (test.status === 'flaky') acc[key].flakyCount += 1;
      if (test.status === 'failed') acc[key].failedCount += 1;
      return acc;
    }, {})
  )
    .filter((row) => row.flakyCount > 0)
    .sort((a, b) => b.flakyCount - a.flakyCount)
    .slice(0, 10);

  const mediaArtifacts = artifacts.filter((artifact) => {
    const type = String(artifact.type || '').toLowerCase();
    const contentType = String(artifact.content_type || '').toLowerCase();
    return type.includes('screenshot')
      || type.includes('video')
      || contentType.startsWith('image/')
      || contentType.startsWith('video/');
  });
  const mediaWithContent = mediaArtifacts.filter((artifact) => artifact.has_content === true);
  const mediaWithoutContent = mediaArtifacts.filter((artifact) => artifact.has_content !== true);
  const screenshotCount = mediaArtifacts.filter((artifact) => {
    const type = String(artifact.type || '').toLowerCase();
    const contentType = String(artifact.content_type || '').toLowerCase();
    return type.includes('screenshot') || contentType.startsWith('image/');
  }).length;
  const videoCount = mediaArtifacts.filter((artifact) => {
    const type = String(artifact.type || '').toLowerCase();
    const contentType = String(artifact.content_type || '').toLowerCase();
    return type.includes('video') || contentType.startsWith('video/');
  }).length;

  const errorLogs = failingOrFlaky.filter((test) => test.error_message || test.stacktrace);

  const timeline = [
    ...specs.map((spec) => ({
      ts: spec.finished_at || spec.started_at || spec.created_at,
      kind: `spec.${spec.status || 'event'}`,
      title: spec.spec_path,
      detail: `attempts=${spec.attempts || 0}, duration=${formatDuration(spec.duration_ms)}`
    })),
    ...tests.map((test) => ({
      ts: test.created_at,
      kind: `test.${test.status || 'event'}`,
      title: test.test_title || test.test_case_id || test.id,
      detail: `${test.file_path || 'n/a'}${test.error_message ? ` • ${test.error_message.slice(0, 140)}` : ''}`
    })),
    ...artifacts.map((artifact) => ({
      ts: artifact.created_at,
      kind: 'artifact.registered',
      title: artifact.type,
      detail: `${artifact.content_type || 'application/octet-stream'} • ${formatBytes(artifact.byte_size)}`
    }))
  ]
    .filter((entry) => entry.ts)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, 120);

  return renderLayout({
    title: `Run ${item.id.slice(0, 8)}`,
    shell,
    currentPath: '/app/runs',
    content: `<section class="hero compact">
        <div>
          <p class="eyebrow">Run detail</p>
          <h2>${escapeHtml(item.status)} on ${escapeHtml(item.branch || 'n/a')}</h2>
          <p>Commit <code>${escapeHtml(item.commit_sha || 'n/a')}</code> · started ${escapeHtml(formatDate(item.started_at || item.created_at))}</p>
        </div>
        <div class="hero-metrics">
          ${summaryCard('Specs', String(summary.specs.spec_count || 0), `Slowest: ${summary.specs.slowest_spec_path || 'n/a'}`)}
          ${summaryCard('Tests', String(summary.tests.test_count || 0), `${summary.tests.failed || 0} failed / ${summary.tests.flaky || 0} flaky`)}
          ${summaryCard('Artifacts', String(summary.artifacts.artifact_count || 0), formatBytes(summary.artifacts.total_artifact_bytes))}
        </div>
      </section>
      <div class="grid two-up">
        <section class="panel">
          <div class="panel-header"><div><h2>Specs</h2><p>All spec runs recorded for this run.</p></div></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Spec</th><th>Status</th><th>Attempts</th><th>Duration</th></tr></thead>
            <tbody>
              ${specs.map((spec) => `<tr><td>${escapeHtml(spec.spec_path)}</td><td>${badge(spec.status, formatRunState(spec.status))}</td><td>${escapeHtml(spec.attempts || 0)}</td><td>${escapeHtml(formatDuration(spec.duration_ms))}</td></tr>`).join('')}
            </tbody>
          </table></div>
        </section>
        <section class="panel">
          <div class="panel-header"><div><h2>Flaky hotspots</h2><p>Top test cases with flaky outcomes in this run.</p></div></div>
          ${flakyByTest.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Test</th><th>Spec path</th><th>Flaky</th><th>Failed</th><th></th></tr></thead>
            <tbody>
              ${flakyByTest.map((row) => `<tr>
                <td>${escapeHtml(row.test_title || row.test_case_id || 'test')}</td>
                <td>${escapeHtml(row.file_path || 'n/a')}</td>
                <td>${escapeHtml(row.flakyCount)}</td>
                <td>${escapeHtml(row.failedCount)}</td>
                <td>${row.test_case_id ? `<a class="text-link" href="/app/tests/${row.test_case_id}/history?workspaceId=${encodeURIComponent(shell.selectedWorkspace?.id || '')}">History</a>` : ''}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>` : '<div class="empty-state"><h3>No flaky hotspots</h3><p>No flaky test outcomes recorded for this run.</p></div>'}
        </section>
      </div>
      <section class="panel">
        <div class="panel-header"><div><h2>Failures & flakes</h2><p>Fast browser triage for failing tests. Includes captured error message and stacktrace preview.</p></div></div>
        ${failingOrFlaky.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Status</th><th>Test</th><th>Spec</th><th>Error</th><th></th></tr></thead>
          <tbody>
            ${failingOrFlaky.slice(0, 80).map((test) => `<tr>
              <td>${badge(test.status, test.status === 'failed' ? 'danger' : 'warning')}</td>
              <td>${escapeHtml(test.test_title || 'test')}</td>
              <td>${escapeHtml(test.file_path || 'n/a')}</td>
              <td>${escapeHtml((test.error_message || 'No error message').slice(0, 180))}${test.stacktrace ? '<br/><small>stacktrace captured</small>' : ''}</td>
              <td>${test.test_case_id ? `<a class="text-link" href="/app/tests/${test.test_case_id}/history?workspaceId=${encodeURIComponent(shell.selectedWorkspace?.id || '')}">History</a>` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="empty-state"><h3>No failing tests</h3><p>This run has no failed or flaky test results.</p></div>'}
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Error logs</h2><p>Expanded error message + stacktrace for quick debugging without leaving the run page.</p></div></div>
        ${errorLogs.length ? `<div class="stack">${errorLogs.slice(0, 30).map((test, idx) => `<details>
          <summary>${escapeHtml(test.test_title || `test-${idx + 1}`)} · ${escapeHtml(test.file_path || 'n/a')}</summary>
          <pre class="code-block">${escapeHtml(`${test.error_message || 'No error message'}

${test.stacktrace || 'No stacktrace captured'}`)}</pre>
        </details>`).join('')}</div>` : '<div class="empty-state"><h3>No error logs captured</h3><p>When test.result events include error_message/stacktrace, details appear here.</p></div>'}
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Artifacts</h2><p>Screenshots/videos render inline when binary content is uploaded by the reporter.</p></div></div>
        <div class="metrics-grid">
          ${metric('Media artifacts', mediaArtifacts.length)}
          ${metric('Screenshots', screenshotCount)}
          ${metric('Videos', videoCount)}
          ${metric('Inline-ready', mediaWithContent.length)}
          ${metric('Metadata-only', mediaWithoutContent.length)}
        </div>
        ${mediaWithContent.length ? `<div class="grid two-up artifact-preview-grid">
          ${mediaWithContent.slice(0, 24).map((artifact) => {
            const contentType = String(artifact.content_type || '').toLowerCase();
            const type = String(artifact.type || '').toLowerCase();
            const isVideo = type.includes('video') || contentType.startsWith('video/');
            const inlineUrl = `/app/artifacts/${artifact.id}/content`;
            return `<article class="panel artifact-preview-card">
              <div class="panel-header compact"><strong>${escapeHtml(artifact.type)}</strong><small>${escapeHtml(formatDate(artifact.created_at))}</small></div>
              ${isVideo
                ? `<video class="artifact-preview-media" controls preload="metadata" src="${escapeHtml(inlineUrl)}"></video>`
                : `<img class="artifact-preview-media" loading="lazy" src="${escapeHtml(inlineUrl)}" alt="${escapeHtml(artifact.type)}" />`}
              <small>${escapeHtml(artifact.content_type || 'application/octet-stream')} · ${escapeHtml(formatBytes(artifact.byte_size))}</small>
              <a class="text-link" href="/app/artifacts/${artifact.id}">Details</a>
            </article>`;
          }).join('')}
        </div>` : '<div class="empty-state"><h3>No inline media yet</h3><p>Reporter must upload artifact bytes (not metadata only) for in-app previews.</p></div>'}
        ${mediaWithoutContent.length ? `<div class="empty-state"><h3>${mediaWithoutContent.length} media artifact(s) have metadata only</h3><p>Binary bytes were not uploaded for these entries. Check reporter logs and ingest body limit (INGEST_BODY_LIMIT_BYTES).</p></div>` : ''}
        ${artifacts.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>Content type</th><th>Size</th><th>Binary</th><th>Created</th><th></th></tr></thead>
          <tbody>
            ${artifacts.map((artifact) => `<tr>
              <td>${escapeHtml(artifact.type)}</td>
              <td>${escapeHtml(artifact.content_type || 'application/octet-stream')}</td>
              <td>${escapeHtml(formatBytes(artifact.byte_size))}</td>
              <td>${artifact.has_content ? badge('available', 'success') : badge('missing', 'warning')}</td>
              <td>${escapeHtml(formatDate(artifact.created_at))}</td>
              <td><a class="text-link" href="/app/artifacts/${artifact.id}">View</a></td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="empty-state"><h3>No artifacts</h3><p>Artifacts appear here after reporter registration/upload.</p></div>'}
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Replay</h2><p>Interactive run replay (DOM snapshots, console logs, and network activity when reporter replay hooks are enabled).</p></div>
          <a class="button button-secondary" href="/app/runs/${item.id}/replay">Open replay</a>
        </div>
        <div class="metrics-grid">
          ${metric('Replay events', Number(runDetail.replay?.event_count || 0))}
          ${metric('First event', formatDate(runDetail.replay?.first_event_at))}
          ${metric('Last event', formatDate(runDetail.replay?.last_event_at))}
          ${metric('Timeline entries', timeline.length)}
        </div>
        ${timeline.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Time</th><th>Event</th><th>Title</th><th>Detail</th></tr></thead>
          <tbody>
            ${timeline.map((entry) => `<tr>
              <td>${escapeHtml(formatDate(entry.ts))}</td>
              <td><code>${escapeHtml(entry.kind)}</code></td>
              <td>${escapeHtml(entry.title || 'n/a')}</td>
              <td>${escapeHtml(entry.detail || '')}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="empty-state"><h3>No timeline events</h3><p>Events appear after run/spec/test/artifact/replay ingest activity.</p></div>'}
      </section>`
  });
}

function renderRunReplayPage(shell, replayDetail, runId) {
  const events = Array.isArray(replayDetail?.events) ? replayDetail.events : [];

  const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const asArray = (value) => (Array.isArray(value) ? value : (value == null ? [] : [value]));
  const firstText = (...values) => {
    for (const value of values) {
      if (value == null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  };
  const normalizePayload = (value) => {
    if (typeof value === 'string') {
      try {
        return asObject(JSON.parse(value));
      } catch {
        return { raw: value };
      }
    }
    return asObject(value);
  };

  const normalized = events.map((row) => {
    const payload = normalizePayload(row?.payload);
    const nestedPayload = asObject(payload.payload);

    const consoleItems = Array.isArray(payload.console)
      ? payload.console
      : (Array.isArray(nestedPayload.console) ? nestedPayload.console : asArray(payload.console).filter(Boolean));

    const networkItems = Array.isArray(payload.network)
      ? payload.network
      : (Array.isArray(nestedPayload.network) ? nestedPayload.network : asArray(payload.network).filter(Boolean));

    const domSnapshot = firstText(payload.domSnapshot, nestedPayload.domSnapshot) || null;

    return {
      id: row?.id,
      ts: row?.event_ts || row?.created_at || payload.ts || payload.at || nestedPayload.ts || nestedPayload.at || null,
      type: row?.event_type || payload.type || nestedPayload.type || 'replay.event',
      title: firstText(payload.title, payload.name, nestedPayload.title, nestedPayload.name) || null,
      detail: firstText(payload.detail, payload.message, nestedPayload.detail, nestedPayload.message) || null,
      command: firstText(payload.command, nestedPayload.command) || null,
      specRunId: firstText(row?.spec_run_id, payload.specRunId, nestedPayload.specRunId) || null,
      specPath: firstText(payload.specPath, nestedPayload.specPath) || null,
      testResultId: firstText(row?.test_result_id, payload.testResultId, nestedPayload.testResultId) || null,
      testTitle: firstText(payload.testTitle, nestedPayload.testTitle) || null,
      console: consoleItems,
      network: networkItems,
      domSnapshot,
      payload,
      nestedPayload
    };
  });

  const extractConsole = (event) => {
    if (!event || typeof event !== 'object') return [];
    if (Array.isArray(event.console) && event.console.length) return event.console;
    if (Array.isArray(event.payload?.console) && event.payload.console.length) return event.payload.console;
    if (Array.isArray(event.nestedPayload?.console) && event.nestedPayload.console.length) return event.nestedPayload.console;
    return [];
  };

  const extractNetwork = (event) => {
    if (!event || typeof event !== 'object') return [];
    if (Array.isArray(event.network) && event.network.length) return event.network;
    if (Array.isArray(event.payload?.network) && event.payload.network.length) return event.payload.network;
    if (Array.isArray(event.nestedPayload?.network) && event.nestedPayload.network.length) return event.nestedPayload.network;
    return [];
  };

  const extractDom = (event) => {
    if (!event || typeof event !== 'object') return '';
    return firstText(event.domSnapshot, event.payload?.domSnapshot, event.nestedPayload?.domSnapshot);
  };

  const extractRunnerLine = (event) => {
    if (!event || typeof event !== 'object') return null;
    const type = String(event.type || '').toLowerCase();
    const include = type.startsWith('replay.command')
      || type.startsWith('replay.log')
      || type.startsWith('replay.test')
      || type.startsWith('replay.spec')
      || type.startsWith('replay.run')
      || type.startsWith('replay.js.error')
      || type.startsWith('replay.console')
      || type.startsWith('replay.network');
    if (!include) return null;
    return {
      ts: event.ts,
      type: event.type || 'replay.event',
      title: firstText(event.title, event.command, event.payload?.name, event.payload?.command) || 'n/a',
      detail: firstText(event.detail, event.payload?.message, event.nestedPayload?.message)
    };
  };

  const collectUpTo = (index, extractor, limit = 200) => {
    const values = [];
    const safeIndex = Math.min(Math.max(Number(index) || 0, 0), Math.max(normalized.length - 1, 0));
    for (let i = 0; i <= safeIndex && i < normalized.length; i += 1) {
      const extracted = extractor(normalized[i]);
      if (!extracted) continue;
      if (Array.isArray(extracted)) values.push(...extracted);
      else values.push(extracted);
    }
    return values.length > limit ? values.slice(values.length - limit) : values;
  };

  const findDomAtOrBefore = (index) => {
    const safeIndex = Math.min(Math.max(Number(index) || 0, 0), Math.max(normalized.length - 1, 0));
    for (let i = safeIndex; i >= 0; i -= 1) {
      const dom = extractDom(normalized[i]);
      if (dom) return { dom, index: i };
    }
    return null;
  };

  const computeInitialIndex = () => {
    if (!normalized.length) return 0;
    let bestIndex = normalized.length - 1;
    let bestScore = -1;
    for (let i = 0; i < normalized.length; i += 1) {
      let score = 0;
      if (extractDom(normalized[i])) score += 8;
      if (extractConsole(normalized[i]).length) score += 5;
      if (extractNetwork(normalized[i]).length) score += 5;
      if (extractRunnerLine(normalized[i])) score += 2;
      if (score >= bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  };

  const initialIndex = computeInitialIndex();
  const initialEvent = normalized[initialIndex] || null;
  const initialDomRef = findDomAtOrBefore(initialIndex);
  const initialDomSnapshot = initialDomRef?.dom || null;
  const initialConsoleEvents = collectUpTo(initialIndex, extractConsole, 200);
  const initialNetworkEvents = collectUpTo(initialIndex, extractNetwork, 200);
  const initialRunnerLines = collectUpTo(initialIndex, extractRunnerLine, 300);

  const initialTitle = initialEvent
    ? firstText(initialEvent.title, initialEvent.command, initialEvent.type, 'replay.event')
    : 'n/a';
  const initialDetail = initialEvent
    ? firstText(initialEvent.detail, initialEvent.payload?.message, initialEvent.nestedPayload?.message, 'No detail captured')
    : 'No detail captured';

  const initialDomFallback = `<html><body style="font-family:system-ui,sans-serif;padding:16px;color:#111827;">
      <h3>No DOM snapshot available at this step</h3>
      <p><strong>Step:</strong> ${escapeHtml(initialTitle)}</p>
      <p><strong>Detail:</strong> ${escapeHtml(initialDetail)}</p>
      <p>Try moving the slider to steps near <code>replay.dom.snapshot</code> events.</p>
    </body></html>`;

  const initialDomSrcDoc = initialDomFallback;
  const initialReplayTitle = initialEvent
    ? `${initialEvent.type || 'replay.event'} @ ${formatDate(initialEvent.ts)}`
    : '';

  const initialConsoleText = initialConsoleEvents.length
    ? JSON.stringify(initialConsoleEvents, null, 2)
    : `No console payload up to this step (${initialIndex + 1}).`;

  const initialNetworkText = initialNetworkEvents.length
    ? JSON.stringify(initialNetworkEvents, null, 2)
    : `No network payload up to this step (${initialIndex + 1}).`;

  const initialRunnerText = initialRunnerLines.length
    ? initialRunnerLines.map((line) => `${line.ts || 'n/a'} | ${line.type || 'replay.event'} | ${line.title || 'n/a'}${line.detail ? ` | ${line.detail}` : ''}`).join('\n')
    : `No runner log payload up to this step (${initialIndex + 1}).`;

  const initialStepListHtml = normalized.map((event, idx) => {
    const typeLabel = event?.type || 'replay.event';
    const typeShort = String(typeLabel).replace(/^replay\./, '');
    const titleLabel = firstText(event?.title, event?.command, event?.payload?.name, event?.payload?.command, event?.detail) || typeShort;
    const detailLabel = firstText(event?.detail, event?.payload?.message, event?.nestedPayload?.message);
    const typeLower = String(typeLabel).toLowerCase();
    const detailLower = String(detailLabel || '').toLowerCase();
    const kind = detailLower.includes('failed') || typeLower.includes('error') || typeLower.includes('failed')
      ? 'failure'
      : (typeLower.startsWith('replay.command')
        ? 'command'
        : (typeLower.startsWith('replay.network')
          ? 'network'
          : (typeLower.startsWith('replay.console')
            ? 'console'
            : (typeLower.startsWith('replay.log') ? 'log' : 'event'))));
    const activeClass = idx === initialIndex ? ' replay-step-active' : '';
    return `<button type="button" data-step="${idx}" class="button button-secondary replay-step-button replay-step-kind-${escapeHtml(kind)}${activeClass}">
      <span class="replay-step-index">${idx + 1}</span>
      <span class="replay-step-body">
        <strong class="replay-step-command">${escapeHtml(String(titleLabel).slice(0, 120))}</strong>
        <small class="replay-step-meta-line">${escapeHtml(typeShort)}${detailLabel ? ` · ${escapeHtml(String(detailLabel).slice(0, 120))}` : ''} · ${escapeHtml(formatDate(event?.ts))}</small>
      </span>
    </button>`;
  }).join('');

  const replayJsonBase64 = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64');

  const consoleEntryCount = normalized.reduce((n, event) => n + extractConsole(event).length, 0);
  const networkEntryCount = normalized.reduce((n, event) => n + extractNetwork(event).length, 0);
  const domEntryCount = normalized.reduce((n, event) => n + (extractDom(event) ? 1 : 0), 0);
  const replaySpecCount = new Set(normalized.map((event) => firstText(event?.specRunId, event?.specPath)).filter(Boolean)).size;

  return renderLayout({
    title: `Replay ${runId.slice(0, 8)}`,
    shell,
    currentPath: '/app/runs',
    content: `<section class="hero compact">
        <div>
          <p class="eyebrow">Replay</p>
          <h2>Run ${escapeHtml(runId)} replay</h2>
          <p>Step through Cypress runner events with cumulative console/network logs and nearest DOM snapshots.</p>
        </div>
        <div class="hero-metrics">
          ${summaryCard('Captured events', String(normalized.length), normalized.length ? `From ${formatDate(normalized[0]?.ts)} to ${formatDate(normalized.at(-1)?.ts)}` : 'No replay events yet')}
          ${summaryCard('Spec attempts', String(replaySpecCount), replaySpecCount ? 'Selectable in replay toolbar' : 'No spec-level metadata yet')}
          ${summaryCard('Console entries', String(consoleEntryCount), 'Cumulative up to selected step')}
          ${summaryCard('Network entries', String(networkEntryCount), 'Cumulative up to selected step')}
          ${summaryCard('DOM snapshots', String(domEntryCount), 'Nearest snapshot rendered for each step')}
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Time travel</h2>
            <p>Pick a spec/attempt, then scrub or play the timeline. Panels show Cypress-style command context, DOM, console, network, and runner logs for that selection.</p>
          </div>
          <a class="button button-secondary" href="/app/runs/${escapeHtml(runId)}">Back to run detail</a>
        </div>
        ${normalized.length ? `<div id="replay-shell" class="stack replay-shell">
          <div class="grid three-up replay-toolbar">
            <label>Spec / attempt
              <select id="replay-spec-select"></select>
            </label>
            <label>Playback speed
              <select id="replay-speed">
                <option value="0.5">0.5x</option>
                <option value="1" selected>1x</option>
                <option value="1.5">1.5x</option>
                <option value="2">2x</option>
                <option value="3">3x</option>
              </select>
            </label>
            <div class="row-actions" style="align-items:flex-end; justify-content:flex-end;">
              <button type="button" class="button button-secondary" id="replay-play-pause">Play</button>
              <button type="button" class="button button-secondary" id="replay-step-prev">Prev</button>
              <button type="button" class="button button-secondary" id="replay-step-next">Next</button>
              <button type="button" class="button button-secondary" id="replay-toggle-modal">Focus mode</button>
            </div>
          </div>
          <input id="replay-step" type="range" min="0" max="${Math.max(0, normalized.length - 1)}" value="${initialIndex}" />
          <div class="replay-main-layout">
            <div class="panel replay-column replay-column-left">
              <div class="panel-header compact"><strong>Command Log</strong><small id="replay-step-meta">${initialIndex + 1} / ${normalized.length}</small></div>
              <div id="replay-step-list" class="stack">${initialStepListHtml}</div>
            </div>
            <div class="panel replay-column replay-column-center">
              <div class="panel-header compact"><strong>Application under test</strong><small id="replay-event-title">${escapeHtml(initialReplayTitle)}</small></div>
              <div id="replay-frame-stage" class="replay-frame-stage">
                <iframe id="replay-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" srcdoc="${escapeHtml(initialDomSrcDoc)}"></iframe>
              </div>
              <small class="replay-fit-note">Auto-fit keeps the full viewport visible at each step.</small>
            </div>
            <div class="panel replay-column replay-column-right">
              <div class="panel-header compact"><strong>Console (cumulative)</strong></div>
              <pre id="replay-console" class="code-block replay-side-log">${escapeHtml(initialConsoleText)}</pre>
              <div class="panel-header compact"><strong>Network (cumulative)</strong></div>
              <pre id="replay-network" class="code-block replay-side-log">${escapeHtml(initialNetworkText)}</pre>
              <div class="panel-header compact"><strong>Cypress Runner Log (cumulative)</strong></div>
              <pre id="replay-runner-log" class="code-block replay-side-log">${escapeHtml(initialRunnerText)}</pre>
            </div>
          </div>
        </div>` : '<div class="empty-state"><h3>No replay events found</h3><p>Enable replay hooks in your Cypress support file to capture DOM/network/console data, then rerun tests.</p></div>'}
      </section>
      <script id="replay-data" type="text/plain">${replayJsonBase64}</script>`
  });
}


function renderArtifactPage(shell, detail) {
  const contentType = String(detail?.item?.content_type || '').toLowerCase();
  const type = String(detail?.item?.type || '').toLowerCase();
  const isImage = type.includes('image') || contentType.startsWith('image/');
  const isVideo = type.includes('video') || contentType.startsWith('video/');
  const hasContent = detail?.item?.has_content === true;
  const inlineUrl = `/app/artifacts/${detail?.item?.id || ''}/content`;

  return renderLayout({
    title: 'Artifact Viewer',
    shell,
    currentPath: '/app/runs',
    content: `<section class="panel">
        <div class="panel-header">
          <div>
            <h2>${escapeHtml(detail?.item?.type || 'artifact')}</h2>
            <p>Artifact ${escapeHtml(detail?.item?.id || '')} for this run.</p>
          </div>
          ${badge(detail?.download?.backend || 'unknown', 'neutral')}
        </div>
        <div class="metrics-grid">
          ${metric('Content type', detail?.item?.content_type || 'application/octet-stream')}
          ${metric('Size', formatBytes(detail?.item?.byte_size))}
          ${metric('Created', formatDate(detail?.item?.created_at))}
          ${metric('Download expires', formatDate(detail?.download?.expiresAt))}
        </div>
        ${isImage || isVideo
          ? (hasContent
            ? `<div class="panel">
              <div class="panel-header compact"><strong>Inline preview</strong></div>
              ${isVideo
                ? `<video class="artifact-detail-media" controls preload="metadata" src="${escapeHtml(inlineUrl)}"></video>`
                : `<img class="artifact-detail-media" loading="lazy" src="${escapeHtml(inlineUrl)}" alt="${escapeHtml(detail?.item?.type || 'artifact')}" />`}
              <div class="stack two-up" style="margin-top: 12px;">
                <a class="button" href="${escapeHtml(inlineUrl)}" target="_blank" rel="noreferrer">Open media</a>
                <a class="button button-secondary" href="${escapeHtml(inlineUrl)}" download>Download</a>
              </div>
            </div>`
            : '<div class="empty-state"><h3>Binary content missing</h3><p>This artifact currently has metadata only. Re-run with reporter binary upload enabled and ensure ingest body limit allows payload size.</p></div>')
          : '<div class="empty-state"><h3>Inline preview not available for this artifact type.</h3></div>'}
        <div class="panel">
          <div class="panel-header compact"><strong>Artifact metadata</strong></div>
          <pre class="code-block">${escapeHtml(JSON.stringify(detail, null, 2))}</pre>
        </div>
      </section>`
  });
}

function renderTeamPage(shell, membersResp) {
  const members = membersResp.items || [];
  return renderLayout({
    title: 'Team',
    shell,
    currentPath: '/app/team',
    content: `<div class="grid two-up">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Add or invite member</h2>
            <p>Add by email, assign role, and keep ownership explicitly managed.</p>
          </div>
        </div>
        <form class="stack" data-json-form action="/app/team/add" method="post">
          <input type="hidden" name="workspaceId" value="${escapeHtml(shell.selectedWorkspace?.id || '')}" />
          <label>Email<input type="email" name="email" placeholder="qa@example.com" required /></label>
          <label>Name<input name="name" placeholder="QA Engineer" /></label>
          <label>Role
            <select name="role">
              ${['viewer', 'member', 'admin', 'owner'].map((role) => `<option value="${role}">${role}</option>`).join('')}
            </select>
          </label>
          <button class="button" type="submit" ${shell.selectedWorkspace ? '' : 'disabled'}>Upsert member</button>
        </form>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Role guide</h2>
            <p>Viewer read-only, member can submit project changes, admin manages members/tokens/webhooks, owner can delete workspace.</p>
          </div>
        </div>
        <div class="stack">
          <small>Keep at least one owner in each workspace.</small>
          <small>Prefer project-level ingest tokens over sharing a global ingest secret.</small>
          <small>Role updates and removals are audit logged.</small>
        </div>
      </section>
    </div>
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Workspace members</h2>
          <p>Update roles or remove members in place.</p>
        </div>
        ${badge(`${members.length} members`, 'neutral')}
      </div>
      ${members.length ? `<div class="table-wrap"><table>
        <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Added</th><th>Actions</th></tr></thead>
        <tbody>
          ${members.map((member) => `<tr>
            <td>${escapeHtml(member.name || member.user_id)}</td>
            <td>${escapeHtml(member.email || 'n/a')}</td>
            <td>${badge(member.role, member.role === 'owner' ? 'success' : member.role === 'admin' ? 'warning' : 'neutral')}</td>
            <td>${escapeHtml(formatDate(member.created_at))}</td>
            <td>
              <div class="row-actions">
                <form class="inline-form" data-json-form action="/app/team/${member.user_id}/role" method="post">
                  <input type="hidden" name="workspaceId" value="${escapeHtml(shell.selectedWorkspace?.id || '')}" />
                  <select name="role">
                    ${['viewer', 'member', 'admin', 'owner'].map((role) => `<option value="${role}" ${role === member.role ? 'selected' : ''}>${role}</option>`).join('')}
                  </select>
                  <button class="button button-secondary" type="submit">Update</button>
                </form>
                <form class="inline-form" data-json-form data-confirm="Remove ${escapeHtml(member.email || member.user_id)} from workspace?" action="/app/team/${member.user_id}/remove" method="post">
                  <input type="hidden" name="workspaceId" value="${escapeHtml(shell.selectedWorkspace?.id || '')}" />
                  <button class="button button-danger" type="submit">Remove</button>
                </form>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : '<div class="empty-state"><h3>No members</h3><p>Add teammates to unlock role-scoped collaboration.</p></div>'}
    </section>`
  });
}

function renderTestHistoryPage(shell, testCaseId, historyResp) {
  const items = historyResp.items || [];
  const pageInfo = historyResp.pageInfo || { total: items.length };
  return renderLayout({
    title: `Test history ${String(testCaseId).slice(0, 8)}`,
    shell,
    currentPath: '/app/runs',
    content: `<section class="panel">
      <div class="panel-header">
        <div>
          <h2>Test history</h2>
          <p>Historical outcomes for test case <code>${escapeHtml(testCaseId)}</code>.</p>
        </div>
        ${badge(`${pageInfo.total} results`, 'neutral')}
      </div>
      ${items.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Created</th><th>Status</th><th>Run</th><th>Spec</th><th>Duration</th><th>Error</th></tr></thead>
        <tbody>
          ${items.map((item) => `<tr>
            <td>${escapeHtml(formatDate(item.created_at))}</td>
            <td>${badge(item.status, formatRunState(item.status))}</td>
            <td><a class="text-link" href="/app/runs/${item.run_id}">${escapeHtml(item.run_id.slice(0, 8))}</a></td>
            <td>${escapeHtml(item.spec_path || 'n/a')}</td>
            <td>${escapeHtml(formatDuration(item.duration_ms))}</td>
            <td>${escapeHtml((item.error_message || '').slice(0, 180) || 'n/a')}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : '<div class="empty-state"><h3>No history</h3><p>No test results found for this test case yet.</p></div>'}
    </section>`
  });
}

function renderAdminPage(shell, hooksResp, deliveriesResp, logsResp) {
  const hooks = hooksResp.items || [];
  const deliveries = deliveriesResp.items || [];
  const logs = logsResp.items || [];

  const groupedDeliveries = Object.entries(
    deliveries.reduce((acc, delivery) => {
      const key = delivery.event_type || 'unknown';
      if (!acc[key]) acc[key] = [];
      acc[key].push(delivery);
      return acc;
    }, {})
  )
    .map(([eventType, items]) => ({
      eventType,
      items: items.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    }))
    .sort((a, b) => b.items.length - a.items.length);

  const deliverySummary = {
    delivered: deliveries.filter((item) => item.status === 'delivered').length,
    retrying: deliveries.filter((item) => item.status === 'retry_scheduled' || item.status === 'queued' || item.status === 'delivering').length,
    dead: deliveries.filter((item) => item.status === 'dead').length
  };

  return renderLayout({
    title: 'Admin & Webhooks',
    shell,
    currentPath: '/app/admin',
    content: `<div class="grid two-up">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Create webhook endpoint</h2>
              <p>Admin surface for notification delivery and smoke validation.</p>
            </div>
          </div>
          <form class="stack" data-json-form action="/app/webhooks" method="post">
            <input type="hidden" name="workspaceId" value="${escapeHtml(shell.selectedWorkspace?.id || '')}" />
            <label>Event type<input name="type" placeholder="notification.test" value="notification.test" required /></label>
            <label>Target URL<input name="targetUrl" placeholder="https://example.com/webhooks/testharbor" required /></label>
            <label>Secret<input name="secret" placeholder="optional signing secret" /></label>
            <label class="checkbox"><input type="checkbox" name="enabled" value="true" checked /> Enabled</label>
            <button class="button" type="submit" ${shell.selectedWorkspace ? '' : 'disabled'}>Create endpoint</button>
          </form>
        </section>
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Retention & audit</h2>
              <p>Manual retention run plus the latest audit log entries for the current workspace.</p>
            </div>
          </div>
          <form data-json-form action="/app/admin/retention" method="post">
            <input type="hidden" name="workspaceId" value="${escapeHtml(shell.selectedWorkspace?.id || '')}" />
            <button class="button button-secondary" type="submit" ${shell.selectedWorkspace ? '' : 'disabled'}>Run retention purge now</button>
          </form>
          <div class="audit-feed">
            ${logs.length ? logs.map((log) => `<article><strong>${escapeHtml(log.action)}</strong><p>${escapeHtml(log.entity_type)} · ${escapeHtml(log.entity_id)}</p><small>${escapeHtml(formatDate(log.ts))}</small></article>`).join('') : '<p>No audit entries yet.</p>'}
          </div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-header"><div><h2>Webhook endpoints</h2><p>Enable/disable endpoints and rotate/clear secrets with confirmation safeguards.</p></div></div>
        ${hooks.length ? hooks.map((hook) => `<article class="hook-card stack">
            <div class="hook-row">
              <div>
                <strong>${escapeHtml(hook.type)}</strong>
                <p>${escapeHtml(hook.target_url)}</p>
                <small>${escapeHtml(formatDate(hook.created_at))}</small>
              </div>
              <div>${badge(hook.enabled ? 'enabled' : 'disabled', hook.enabled ? 'success' : 'warning')}</div>
            </div>
            <div class="row-actions">
              <form class="inline-form" data-json-form action="/app/webhooks/${hook.id}/update" method="post">
                <input type="hidden" name="enabled" value="${hook.enabled ? 'false' : 'true'}" />
                <button class="button button-secondary" type="submit">${hook.enabled ? 'Disable' : 'Enable'}</button>
              </form>
              <form class="inline-form" data-json-form data-confirm="Rotate webhook secret for ${escapeHtml(hook.target_url)}?" action="/app/webhooks/${hook.id}/secret" method="post">
                <input name="secret" placeholder="new secret" required />
                <button class="button button-secondary" type="submit">Rotate secret</button>
              </form>
              <form class="inline-form" data-json-form data-confirm="Clear webhook secret for ${escapeHtml(hook.target_url)}? Existing signatures will stop validating." action="/app/webhooks/${hook.id}/secret" method="post">
                <input type="hidden" name="clear" value="true" />
                <button class="button button-secondary" type="submit">Clear secret</button>
              </form>
              <form class="inline-form" data-json-form data-confirm="Delete this webhook endpoint?" action="/app/webhooks/${hook.id}/delete" method="post">
                <button class="button button-danger" type="submit">Delete</button>
              </form>
            </div>
          </article>`).join('') : '<div class="empty-state"><h3>No endpoints</h3><p>Create one above to start receiving notification tests.</p></div>'}
      </section>
      <section class="panel">
        <div class="panel-header">
          <div><h2>Delivery timeline</h2><p>Grouped by event type with state buckets for faster admin triage.</p></div>
          <div class="topbar-badges">
            ${badge(`${deliverySummary.delivered} delivered`, 'success')}
            ${badge(`${deliverySummary.retrying} retrying`, 'warning')}
            ${badge(`${deliverySummary.dead} dead`, 'danger')}
          </div>
        </div>
        ${groupedDeliveries.length ? groupedDeliveries.map((group) => `<section class="timeline-group">
            <h3>${escapeHtml(group.eventType)}</h3>
            <div class="table-wrap"><table>
              <thead><tr><th>Status</th><th>Attempts</th><th>Target</th><th>Last error</th><th>Updated</th><th>When</th></tr></thead>
              <tbody>
                ${group.items.map((delivery) => `<tr>
                  <td>${badge(delivery.status, formatDeliveryState(delivery.status))}</td>
                  <td>${escapeHtml(`${delivery.attempt_count}/${delivery.max_attempts}`)}</td>
                  <td>${escapeHtml(delivery.target_url)}</td>
                  <td>${escapeHtml(delivery.last_error || 'n/a')}</td>
                  <td>${escapeHtml(formatDate(delivery.updated_at))}</td>
                  <td>${escapeHtml(formatDeltaFromNow(delivery.updated_at))}</td>
                </tr>`).join('')}
              </tbody>
            </table></div>
          </section>`).join('') : '<div class="empty-state"><h3>No deliveries yet</h3><p>Use the connect page to queue a notification test.</p></div>'}
      </section>`
  });
}

app.get('/assets/styles.css', async (_request, reply) => {
  reply.header('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
  reply.type('text/css').send(stylesCss);
});

app.get('/assets/web.js', async (_request, reply) => {
  reply.header('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
  reply.type('application/javascript').send(appJs);
});

app.get('/healthz', async () => ({ ok: true, service: '@testharbor/web', apiBaseUrl: API_BASE_URL }));

app.get('/', async (request, reply) => {
  const { session } = await getSession(request);
  return reply.redirect(session ? '/app/onboarding' : '/login');
});

app.get('/login', async (request, reply) => {
  const { session } = await getSession(request);
  if (session) return reply.redirect('/app/onboarding');

  const ctx = getRequestContext(request);
  return reply.type('text/html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in · TestHarbor</title>
  <link rel="stylesheet" href="/assets/styles.css" />
</head>
<body class="login-body">
  <main class="login-shell">
    <section class="login-panel">
      <p class="eyebrow">TestHarbor Lane A shell</p>
      <h1>Sign in with local session auth</h1>
      <p>This browser shell uses the API’s local-dev auth token. No opaque mock page here: successful login creates a real session against <code>${escapeHtml(API_BASE_URL)}</code>.</p>
      ${ctx.notice ? `<div class="flash flash-notice">${escapeHtml(ctx.notice)}</div>` : ''}
      ${ctx.error ? `<div class="flash flash-error">${escapeHtml(ctx.error)}</div>` : ''}
      <form class="stack" data-json-form action="/login" method="post">
        <label>Name<input name="name" placeholder="Taylor QA" required /></label>
        <label>Email<input name="email" type="email" placeholder="taylor@example.com" required /></label>
        <label>Avatar URL<input name="avatarUrl" placeholder="https://example.com/avatar.png" /></label>
        <button class="button" type="submit">Sign in</button>
      </form>
    </section>
  </main>
  <script src="/assets/web.js" defer></script>
</body>
</html>`);
});

app.post('/login', async (request, reply) => {
  const body = request.body || {};
  const email = String(body.email || '').trim();
  const name = String(body.name || '').trim();
  const avatarUrl = String(body.avatarUrl || '').trim() || null;

  if (!email || !name) {
    return reply.code(400).send({ ok: false, error: 'Name and email are required.' });
  }

  const login = await apiFetch('/v1/auth/login', {
    method: 'POST',
    body: { email, name, avatarUrl }
  });

  const cookies = [buildCookie(SESSION_COOKIE, login.token), clearCookie(NEW_PROJECT_TOKEN_COOKIE)];
  const firstWorkspace = login.memberships?.[0]?.workspace_id || '';
  if (firstWorkspace) cookies.push(buildCookie(WORKSPACE_COOKIE, firstWorkspace));
  return jsonRedirect(reply, '/app/onboarding?notice=Signed in.', cookies);
});

app.post('/logout', async (_request, reply) => jsonRedirect(reply, '/login?notice=Signed out.', [
  clearCookie(SESSION_COOKIE),
  clearCookie(WORKSPACE_COOKIE),
  clearCookie(PROJECT_COOKIE),
  clearCookie(NEW_PROJECT_TOKEN_COOKIE)
]));

app.get('/session', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);

  return reply.type('text/html').send(renderLayout({
    title: 'Session',
    shell,
    currentPath: '/session',
    content: `<section class="panel">
      <div class="panel-header"><div><h2>Session details</h2><p>Real API-backed user identity and memberships.</p></div></div>
      <div class="metrics-grid">
        ${metric('User', shell.session.user.name)}
        ${metric('Email', shell.session.user.email)}
        ${metric('Memberships', shell.session.memberships.length)}
      </div>
      <pre class="code-block">${escapeHtml(JSON.stringify({
        user: shell.session.user,
        memberships: shell.session.memberships,
        selectedWorkspaceId: shell.selectedWorkspace?.id || null,
        selectedProjectId: shell.selectedProject?.id || null
      }, null, 2))}</pre>
    </section>`
  }));
});

app.post('/app/context', async (request, reply) => {
  const body = request.body || {};
  const workspaceId = String(body.workspaceId || '');
  const projectId = String(body.projectId || '');
  const returnTo = String(body.returnTo || '/app/onboarding');
  const cookies = [];
  if (workspaceId) cookies.push(buildCookie(WORKSPACE_COOKIE, workspaceId));
  if (projectId) {
    cookies.push(buildCookie(PROJECT_COOKIE, projectId));
  } else {
    cookies.push(clearCookie(PROJECT_COOKIE));
    cookies.push(clearCookie(NEW_PROJECT_TOKEN_COOKIE));
  }
  return jsonRedirect(reply, `${returnTo}?notice=Context updated.`, cookies);
});

app.get('/app/onboarding', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);

  const [tokensResp, latestRunResp] = await Promise.all([
    shell.selectedProject
      ? apiFetch(`/v1/projects/${shell.selectedProject.id}/ingest-tokens?limit=50`, { token: shell.session.token }).catch(() => ({ items: [] }))
      : Promise.resolve({ items: [] }),
    shell.selectedProject
      ? apiFetch(`/v1/projects/${shell.selectedProject.id}/latest-run`, { token: shell.session.token }).catch(() => ({ item: null }))
      : Promise.resolve({ item: null })
  ]);

  const html = renderOnboardingPage(shell, {
    tokens: tokensResp.items || [],
    latestRun: latestRunResp.item || null,
    newTokenBundle: shell.ctx.newProjectToken
  });

  if (shell.ctx.newProjectToken?.token) {
    setCookies(reply, [clearCookie(NEW_PROJECT_TOKEN_COOKIE)]);
  }

  return reply.type('text/html').send(html);
});

app.post('/app/workspaces', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const body = request.body || {};
  const name = String(body.name || '').trim();
  const organizationName = String(body.organizationName || '').trim();
  const organizationSlug = slugify(body.organizationSlug || organizationName, 'org');
  const slug = slugify(body.slug || name, 'workspace');
  const timezone = String(body.timezone || 'UTC').trim() || 'UTC';
  const retentionDays = Math.max(1, Number(body.retentionDays || 30));

  const created = await apiFetch('/v1/workspaces', {
    method: 'POST',
    token: shell.session.token,
    body: { organizationName, organizationSlug, name, slug, timezone, retentionDays }
  });

  return jsonRedirect(reply, '/app/onboarding?notice=Workspace created.', [
    buildCookie(WORKSPACE_COOKIE, created.item.id),
    clearCookie(PROJECT_COOKIE),
    clearCookie(NEW_PROJECT_TOKEN_COOKIE)
  ]);
});

app.post('/app/projects', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const body = request.body || {};
  const workspaceId = String(body.workspaceId || shell.selectedWorkspace?.id || '');
  if (!workspaceId) return reply.code(400).send({ ok: false, error: 'Select a workspace before creating a project.' });

  const created = await apiFetch('/v1/projects', {
    method: 'POST',
    token: shell.session.token,
    body: {
      workspaceId,
      name: String(body.name || '').trim(),
      slug: slugify(body.slug || body.name, 'project'),
      provider: String(body.provider || '').trim() || null,
      repoUrl: String(body.repoUrl || '').trim() || null,
      defaultBranch: String(body.defaultBranch || 'main').trim() || 'main'
    }
  });

  return jsonRedirect(reply, '/app/onboarding?notice=Project created.', [
    buildCookie(WORKSPACE_COOKIE, workspaceId),
    buildCookie(PROJECT_COOKIE, created.item.id),
    clearCookie(NEW_PROJECT_TOKEN_COOKIE)
  ]);
});



app.post('/app/project-ingest-tokens', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const body = request.body || {};
  const projectId = String(body.projectId || shell.selectedProject?.id || '');
  const returnTo = String(body.returnTo || '/app/connect');
  if (!projectId) return reply.code(400).send({ ok: false, error: 'Select a project first.' });

  const created = await apiFetch(`/v1/projects/${projectId}/ingest-tokens`, {
    method: 'POST',
    token: shell.session.token,
    body: {
      label: String(body.label || '').trim(),
      ttlDays: body.ttlDays === undefined || body.ttlDays === null || body.ttlDays === '' ? undefined : Number(body.ttlDays)
    }
  });

  const payload = JSON.stringify({
    token: created.token,
    item: created.item,
    createdAt: new Date().toISOString()
  });

  return jsonRedirect(reply, `${returnTo}?notice=Project token created. Copy it now.`, [
    buildCookie(NEW_PROJECT_TOKEN_COOKIE, payload, { maxAge: 60 * 5 })
  ]);
});

app.post('/app/project-ingest-tokens/:tokenId/revoke', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const body = request.body || {};
  const projectId = String(body.projectId || shell.selectedProject?.id || '');
  const returnTo = String(body.returnTo || '/app/connect');
  if (!projectId) return reply.code(400).send({ ok: false, error: 'Select a project first.' });

  await apiFetch(`/v1/projects/${projectId}/ingest-tokens/${request.params.tokenId}/revoke`, {
    method: 'POST',
    token: shell.session.token
  });

  return jsonRedirect(reply, `${returnTo}?notice=Project token revoked.`);
});
app.get('/app/connect', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);

  const [status, latestRunResp, tokensResp] = await Promise.all([
    apiFetch('/v1/system/status', { token: shell.session.token }),
    shell.selectedProject
      ? apiFetch(`/v1/projects/${shell.selectedProject.id}/latest-run`, { token: shell.session.token }).catch(() => ({ item: null }))
      : Promise.resolve({ item: null }),
    shell.selectedProject
      ? apiFetch(`/v1/projects/${shell.selectedProject.id}/ingest-tokens?limit=50`, { token: shell.session.token }).catch(() => ({ items: [] }))
      : Promise.resolve({ items: [] })
  ]);

  const html = renderConnectPage(shell, status, latestRunResp.item || null, {
    tokens: tokensResp.items || [],
    newTokenBundle: shell.ctx.newProjectToken
  });

  if (shell.ctx.newProjectToken?.token) {
    setCookies(reply, [clearCookie(NEW_PROJECT_TOKEN_COOKIE)]);
  }

  return reply.type('text/html').send(html);
});

app.post('/app/connect/test-event', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const body = request.body || {};
  const workspaceId = String(body.workspaceId || shell.selectedWorkspace?.id || '');
  if (!workspaceId) return reply.code(400).send({ ok: false, error: 'Select a workspace first.' });

  await apiFetch('/v1/notifications/test', {
    method: 'POST',
    token: shell.session.token,
    body: {
      workspaceId,
      runId: String(body.runId || '') || null,
      channel: String(body.channel || 'slack'),
      message: String(body.message || 'TestHarbor browser smoke')
    }
  });

  return jsonRedirect(reply, '/app/connect?notice=Queued a notification test event.');
});



app.get('/app/team', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);
  if (!shell.selectedWorkspace) {
    return reply.redirect('/app/onboarding?error=Select a workspace before opening team.');
  }

  const membersResp = await apiFetch(`/v1/workspaces/${shell.selectedWorkspace.id}/members`, { token: shell.session.token });
  return reply.type('text/html').send(renderTeamPage(shell, membersResp));
});

app.post('/app/team/add', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });

  const body = request.body || {};
  const workspaceId = String(body.workspaceId || shell.selectedWorkspace?.id || '');
  if (!workspaceId) return reply.code(400).send({ ok: false, error: 'Select a workspace first.' });

  await apiFetch(`/v1/workspaces/${workspaceId}/members`, {
    method: 'POST',
    token: shell.session.token,
    body: {
      email: String(body.email || '').trim(),
      name: String(body.name || '').trim() || 'Workspace Member',
      role: String(body.role || 'member')
    }
  });

  return jsonRedirect(reply, '/app/team?notice=Member upserted.');
});

app.post('/app/team/:userId/role', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });

  const body = request.body || {};
  const workspaceId = String(body.workspaceId || shell.selectedWorkspace?.id || '');
  if (!workspaceId) return reply.code(400).send({ ok: false, error: 'Select a workspace first.' });

  await apiFetch(`/v1/workspaces/${workspaceId}/members/${request.params.userId}`, {
    method: 'PATCH',
    token: shell.session.token,
    body: {
      role: String(body.role || '').trim()
    }
  });

  return jsonRedirect(reply, '/app/team?notice=Member role updated.');
});

app.post('/app/team/:userId/remove', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });

  const body = request.body || {};
  const workspaceId = String(body.workspaceId || shell.selectedWorkspace?.id || '');
  if (!workspaceId) return reply.code(400).send({ ok: false, error: 'Select a workspace first.' });

  await apiFetch(`/v1/workspaces/${workspaceId}/members/${request.params.userId}`, {
    method: 'DELETE',
    token: shell.session.token
  });

  return jsonRedirect(reply, '/app/team?notice=Member removed.');
});
app.get('/app/runs', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);
  if (!shell.selectedWorkspace || !shell.selectedProject) {
    return reply.redirect('/app/onboarding?error=Create or select a workspace and project before opening runs.');
  }

  const fromInput = String(request.query?.from || '');
  const toInput = String(request.query?.to || '');
  const fromIso = toIsoFromDatetimeLocal(fromInput) || '';
  const toIso = toIsoFromDatetimeLocal(toInput) || '';

  const params = new URLSearchParams({
    workspaceId: shell.selectedWorkspace.id,
    projectId: shell.selectedProject.id,
    ...(request.query?.branch ? { branch: String(request.query.branch) } : {}),
    ...(request.query?.status ? { status: String(request.query.status) } : {}),
    ...(fromIso ? { from: fromIso } : {}),
    ...(toIso ? { to: toIso } : {}),
    page: String(request.query?.page || '1'),
    limit: '20'
  });
  const runsResp = await apiFetch(`/v1/runs?${params.toString()}`, { token: shell.session.token });
  shell.ctx.branch = String(request.query?.branch || '');
  shell.ctx.runStatus = String(request.query?.status || '');
  shell.ctx.from = fromInput;
  shell.ctx.to = toInput;
  shell.ctx.page = String(request.query?.page || '1');
  shell.ctx.focus = String(request.query?.focus || 'all');
  return reply.type('text/html').send(renderRunsPage(shell, runsResp));
});

app.get('/app/runs/:id', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);
  const detail = await apiFetch(`/v1/runs/${request.params.id}`, { token: shell.session.token });
  return reply.type('text/html').send(renderRunDetailPage(shell, detail));
});



app.get('/app/runs/:id/replay', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);

  const replay = await apiFetch(`/v1/runs/${request.params.id}/replay`, { token: shell.session.token });
  return reply.type('text/html').send(renderRunReplayPage(shell, replay, request.params.id));
});

app.get('/app/artifacts/:id/content', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);

  const artifactId = String(request.params.id);
  const upstream = await apiFetchRaw(`/v1/artifacts/${artifactId}/content`, {
    headers: {
      authorization: `Bearer ${shell.session.token}`
    }
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    return reply.code(upstream.status).send({
      error: `artifact_content_proxy_failed_${upstream.status}`,
      message: text || 'artifact_content_proxy_failed'
    });
  }

  const bytes = await upstream.arrayBuffer();
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const contentLength = upstream.headers.get('content-length');

  reply.code(200).header('content-type', contentType);
  if (contentLength) reply.header('content-length', contentLength);
  reply.header('cache-control', 'private, max-age=60');
  return reply.send(Buffer.from(bytes));
});

app.get('/app/tests/:id/history', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);

  const workspaceId = String(request.query?.workspaceId || shell.selectedWorkspace?.id || '');
  if (!workspaceId) {
    return reply.redirect('/app/runs?error=Select a workspace before opening test history.');
  }

  const params = new URLSearchParams({
    workspaceId,
    page: String(request.query?.page || '1'),
    limit: String(request.query?.limit || '50'),
    ...(request.query?.status ? { status: String(request.query.status) } : {})
  });

  const historyResp = await apiFetch(`/v1/tests/${request.params.id}/history?${params.toString()}`, { token: shell.session.token });
  return reply.type('text/html').send(renderTestHistoryPage(shell, request.params.id, historyResp));
});
app.get('/app/artifacts/:id', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);
  const detail = await apiFetch(`/v1/artifacts/${request.params.id}/sign-download`, { token: shell.session.token });
  return reply.type('text/html').send(renderArtifactPage(shell, detail));
});

app.get('/app/admin', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);
  if (!shell.selectedWorkspace) return reply.redirect('/app/onboarding?error=Select a workspace before opening admin.');

  const workspaceId = shell.selectedWorkspace.id;
  const [hooksResp, deliveriesResp, logsResp] = await Promise.all([
    apiFetch(`/v1/webhook-endpoints?workspaceId=${encodeURIComponent(workspaceId)}`, { token: shell.session.token }),
    apiFetch(`/v1/webhook-deliveries?workspaceId=${encodeURIComponent(workspaceId)}&limit=80`, { token: shell.session.token }),
    apiFetch(`/v1/audit-logs?workspaceId=${encodeURIComponent(workspaceId)}&limit=15`, { token: shell.session.token }).catch(() => ({ items: [] }))
  ]);

  return reply.type('text/html').send(renderAdminPage(shell, hooksResp, deliveriesResp, logsResp));
});

app.post('/app/webhooks', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const body = request.body || {};

  await apiFetch('/v1/webhook-endpoints', {
    method: 'POST',
    token: shell.session.token,
    body: {
      workspaceId: String(body.workspaceId || shell.selectedWorkspace?.id || ''),
      type: String(body.type || 'notification.test').trim(),
      targetUrl: String(body.targetUrl || '').trim(),
      secret: String(body.secret || '').trim() || null,
      enabled: body.enabled === true || body.enabled === 'true'
    }
  });

  return jsonRedirect(reply, '/app/admin?notice=Webhook endpoint created.');
});

app.post('/app/webhooks/:id/update', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const body = request.body || {};
  await apiFetch(`/v1/webhook-endpoints/${request.params.id}`, {
    method: 'PATCH',
    token: shell.session.token,
    body: { enabled: body.enabled === true || body.enabled === 'true' }
  });
  return jsonRedirect(reply, '/app/admin?notice=Webhook endpoint updated.');
});



app.post('/app/webhooks/:id/secret', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const body = request.body || {};
  const clear = body.clear === true || body.clear === 'true';
  const nextSecret = clear ? null : String(body.secret || '').trim();

  if (!clear && !nextSecret) {
    return reply.code(400).send({ ok: false, error: 'Secret is required unless clear=true.' });
  }

  await apiFetch(`/v1/webhook-endpoints/${request.params.id}`, {
    method: 'PATCH',
    token: shell.session.token,
    body: { secret: nextSecret }
  });

  return jsonRedirect(reply, `/app/admin?notice=${encodeURIComponent(clear ? 'Webhook secret cleared.' : 'Webhook secret rotated.')}`);
});
app.post('/app/webhooks/:id/delete', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  await apiFetch(`/v1/webhook-endpoints/${request.params.id}`, {
    method: 'DELETE',
    token: shell.session.token
  });
  return jsonRedirect(reply, '/app/admin?notice=Webhook endpoint deleted.');
});

app.post('/app/admin/retention', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const body = request.body || {};
  await apiFetch('/v1/retention/run', {
    method: 'POST',
    token: shell.session.token,
    body: { workspaceId: String(body.workspaceId || shell.selectedWorkspace?.id || '') }
  });
  return jsonRedirect(reply, '/app/admin?notice=Retention run finished.');
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  if (!reply.sent && reply.request.method === 'POST') {
    return reply.code(error.statusCode || 500).send({
      ok: false,
      error: error.payload?.error || error.message || 'Request failed.'
    });
  }
  if (!reply.sent) {
    return reply.code(error.statusCode || 500).type('text/html').send(`<!doctype html><html><body><pre>${escapeHtml(String(error.stack || error.message || error))}</pre></body></html>`);
  }
});

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
