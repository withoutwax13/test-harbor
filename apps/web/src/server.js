import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';

const app = Fastify({ logger: true });
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

function formatJsonInline(value) {
  if (value === undefined || value === null) return '<span class="muted">n/a</span>';
  return `<details><summary>view</summary><pre class="code-block">${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`;
}

function sanitizeSnapshotHtml(value) {
  const html = String(value || '');
  if (!html) return '';
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function getReplaySnapshot(event) {
  const payload = event?.payload_json || event?.data_json || null;
  return payload?.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : null;
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
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Replay V2</h2>
            <p>Open the persisted replay viewer for stream summaries and ordered replay events.</p>
          </div>
          <a class="button button-secondary" href="/app/runs/${item.id}/replay-v2">Open Replay V2</a>
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
        <div class="panel-header"><div><h2>Artifacts</h2><p>Screenshots/videos are listed here once registered by the Cypress reporter helper.</p></div></div>
        <div class="metrics-grid">
          ${metric('Media artifacts', mediaArtifacts.length)}
          ${metric('Screenshots', screenshotCount)}
          ${metric('Videos', videoCount)}
          ${metric('All artifacts', artifacts.length)}
        </div>
        ${artifacts.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>Content type</th><th>Size</th><th>Created</th><th></th></tr></thead>
          <tbody>
            ${artifacts.map((artifact) => `<tr>
              <td>${escapeHtml(artifact.type)}</td>
              <td>${escapeHtml(artifact.content_type || 'application/octet-stream')}</td>
              <td>${escapeHtml(formatBytes(artifact.byte_size))}</td>
              <td>${escapeHtml(formatDate(artifact.created_at))}</td>
              <td><a class="text-link" href="/app/artifacts/${artifact.id}">View</a></td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="empty-state"><h3>No artifacts</h3><p>Artifacts appear here after the ingest client registers them.</p></div>'}
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Replay-like timeline</h2><p>Event timeline for run/spec/test/artifact activity (lightweight Cypress Cloud-style trace).</p></div></div>
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
        </table></div>` : '<div class="empty-state"><h3>No timeline events</h3><p>Events appear after run/spec/test/artifact ingest activity.</p></div>'}
      </section>`
  });
}

function renderReplayV2Page(shell, runId, streamsResp, eventsResp, selectedStreamId, metricsResp, targetsResp, seekResp, seekSeq, selectionMeta = {}, eventSeq = '') {
  const streams = streamsResp.items || [];
  const events = eventsResp.items || [];
  const pageInfo = eventsResp.pageInfo || { total: events.length, limit: events.length };
  const selectedStream = streams.find((stream) => stream.stream_id === selectedStreamId) || streams[0] || null;
  const requestedStreamId = String(selectionMeta?.requestedStreamId || '').trim();
  const requestedStreamFound = Boolean(selectionMeta?.requestedStreamFound);
  const fallbackUsed = Boolean(selectionMeta?.fallbackUsed);
  const metrics = metricsResp?.item || null;
  const targets = targetsResp?.items || [];
  const seek = seekResp?.item || null;
  const inspect = seek?.liveInspect || null;
  const alignmentPct = metrics ? `${Math.round((metrics.commandToDomAlignment || 0) * 100)}%` : 'n/a';
  const targetPct = metrics ? `${Math.round((metrics.targetStability || 0) * 100)}%` : 'n/a';
  const seqContinuityText = metrics
    ? (metrics.seqContinuity?.zeroGaps ? 'zero gaps' : `${metrics.seqContinuity?.gapCount || 0} gaps`)
    : 'n/a';

  const requestedEventSeq = Number.parseInt(String(eventSeq || '').trim(), 10);
  const hasRequestedEventSeq = Number.isFinite(requestedEventSeq) && requestedEventSeq > 0;
  let activeEventIndex = -1;
  if (events.length) {
    if (hasRequestedEventSeq) {
      activeEventIndex = events.findIndex((event) => Number(event.seq) === requestedEventSeq);
    }
    if (activeEventIndex === -1) activeEventIndex = events.length - 1;
  }
  const activeEvent = activeEventIndex >= 0 ? events[activeEventIndex] : null;
  const activeEventSeq = activeEvent ? Number(activeEvent.seq) : null;
  const prevEvent = activeEventIndex > 0 ? events[activeEventIndex - 1] : null;
  const nextEvent = activeEventIndex >= 0 && activeEventIndex < events.length - 1 ? events[activeEventIndex + 1] : null;
  const activeSnapshot = getReplaySnapshot(activeEvent);
  const activeSnapshotMeta = activeSnapshot?.metadata || {};
  const sanitizedSnapshotHtml = sanitizeSnapshotHtml(activeSnapshot?.html || '');

  const baseReplayPath = `/app/runs/${encodeURIComponent(String(runId))}/replay-v2`;
  const buildReplayHref = ({ streamId = selectedStreamId, seq = seekSeq, eventSeq: nextEventSeq = activeEventSeq } = {}) => {
    const params = new URLSearchParams();
    if (streamId) params.set('streamId', String(streamId));
    if (seq) params.set('seq', String(seq));
    if (nextEventSeq !== null && nextEventSeq !== undefined && String(nextEventSeq).trim() !== '') {
      params.set('eventSeq', String(nextEventSeq));
    }
    const query = params.toString();
    return query ? `${baseReplayPath}?${query}` : baseReplayPath;
  };

  const prevHref = prevEvent ? buildReplayHref({ eventSeq: prevEvent.seq }) : '';
  const nextHref = nextEvent ? buildReplayHref({ eventSeq: nextEvent.seq }) : '';

  return renderLayout({
    title: `Replay V2 ${String(runId).slice(0, 8)}`,
    shell,
    currentPath: '/app/runs',
    content: `<section class="hero compact">
        <div>
          <p class="eyebrow">Replay V2</p>
          <h2>Persisted replay streams for run <code>${escapeHtml(String(runId))}</code></h2>
          <p>Read model over replay_v2_streams, replay_v2_chunks, and replay_v2_events for basic browser inspection.</p>
        </div>
        <div class="hero-metrics">
          ${summaryCard('Streams', String(streams.length), selectedStream ? `Selected: ${selectedStream.stream_id}` : 'No replay streams')}
          ${summaryCard('Events shown', String(events.length), `${pageInfo.total || 0} matching rows`)}
          ${summaryCard('Selection', selectedStreamId || 'none', selectedStream ? `Seq ${selectedStream.first_seq || 'n/a'}-${selectedStream.last_seq || 'n/a'}` : 'Select a stream')}
          ${summaryCard('Requested', requestedStreamId || 'none', requestedStreamId ? (requestedStreamFound ? 'Matched stream' : 'Not found, showing first available stream') : 'No streamId query')}
          ${summaryCard('Active Event', activeEvent ? String(activeEvent.seq) : 'none', activeEvent ? `${activeEvent.kind} @ ${formatDate(activeEvent.ts)}` : 'Pick a stream with events')}
          ${summaryCard('Seek', seekSeq || 'n/a', inspect?.targetId ? `Inspect ${inspect.targetId}` : 'Nearest checkpoint resolution')}
        </div>
      </section>
      ${fallbackUsed ? `<section class="panel" style="border-color:#f59e0b;"><div class="panel-header"><div><h2>Requested stream unavailable</h2><p>Requested stream <code>${escapeHtml(requestedStreamId)}</code> was not found for this run. Showing <code>${escapeHtml(selectedStreamId || 'none')}</code> instead.</p></div></div></section>` : ''}
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Streams</h2>
            <p>Each card summarizes one persisted replay stream for this run.</p>
          </div>
          <a class="button button-secondary" href="/app/runs/${escapeHtml(String(runId))}">Back to run</a>
        </div>
        ${streams.length ? `<form method="GET" action="/app/runs/${encodeURIComponent(String(runId))}/replay-v2" style="display:flex; gap:0.75rem; align-items:end; margin:0 0 1rem;">
          <label style="display:flex; flex-direction:column; gap:0.25rem;">Stream
            <select name="streamId">
              ${streams.map((stream) => `<option value="${escapeHtml(stream.stream_id)}"${stream.stream_id === selectedStreamId ? ' selected' : ''}>${escapeHtml(stream.stream_id)}</option>`).join('')}
            </select>
          </label>
          ${seekSeq ? `<input type="hidden" name="seq" value="${escapeHtml(seekSeq)}" />` : ''}
          <button class="button" type="submit">Open stream</button>
        </form><div class="metrics-grid">
          ${streams.map((stream) => `<article class="summary-card">
            <span class="summary-label">${stream.stream_id === selectedStreamId ? 'Selected stream' : 'Replay stream'}</span>
            <strong><a class="text-link" href="/app/runs/${encodeURIComponent(String(runId))}/replay-v2?streamId=${encodeURIComponent(stream.stream_id)}">${escapeHtml(stream.stream_id)}</a></strong>
            <small>Schema ${escapeHtml(stream.schema_version || '2.0')} · started ${escapeHtml(formatDate(stream.started_at))}</small>
            <small>Seq ${escapeHtml(stream.first_seq ?? 'n/a')} → ${escapeHtml(stream.last_seq ?? 'n/a')}</small>
            <small>${escapeHtml(stream.event_count)} events · ${escapeHtml(stream.chunk_count)} chunks · final ${stream.final_received ? 'yes' : 'no'}</small>
            <small>${escapeHtml(stream.transport_kind || 'ws+msgpack')} · ACK ${stream.ack_received ? 'yes' : 'no'} · stride ${escapeHtml(stream.seek_stride ?? '50')}</small>
            <small>Updated ${escapeHtml(formatDate(stream.updated_at))}</small>
          </article>`).join('')}
        </div>` : '<div class="empty-state"><h3>No replay streams</h3><p>No persisted <code>replay.v2.chunk</code> data exists for this run. Verify browser-side replay capture and chunk ingest for this run.</p></div>'}
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Stream Player</h2>
            <p>Step through the selected stream event-by-event and inspect the active replay payload.</p>
          </div>
          ${activeEvent ? badge(`Seq ${activeEvent.seq}`, 'neutral') : ''}
        </div>
        ${!selectedStream ? '<div class="empty-state"><h3>No stream selected</h3><p>Select a replay stream first.</p></div>' : !events.length ? '<div class="empty-state"><h3>No replay events</h3><p>This stream has no events to step through yet.</p></div>' : `<div class="metrics-grid"> 
          ${summaryCard('Position', `${activeEventIndex + 1}/${events.length}`, `Total ${pageInfo.total || events.length} matching rows`)}
          ${summaryCard('Event Kind', activeEvent?.kind || 'n/a', activeEvent?.lifecycle_event || 'No lifecycle marker')}
          ${summaryCard('Target', activeEvent?.target_id || 'n/a', activeEvent?.selector_version ? `Selector v${activeEvent.selector_version}` : 'No selector version')}
          ${summaryCard('Monotonic', activeEvent ? `${activeEvent.monotonic_ms} ms` : 'n/a', activeEvent?.command_id ? `Command ${activeEvent.command_id}` : 'No command id')}
        </div>
        <div class="row-actions" style="margin-top:1rem;">
          ${prevEvent ? `<a class="button button-secondary" href="${escapeHtml(prevHref)}">← Prev</a>` : '<button class="button button-secondary" type="button" disabled>← Prev</button>'}
          ${nextEvent ? `<a class="button button-secondary" href="${escapeHtml(nextHref)}">Next →</a>` : '<button class="button button-secondary" type="button" disabled>Next →</button>'}
          <form method="GET" action="${baseReplayPath}" class="inline-form">
            <input type="hidden" name="streamId" value="${escapeHtml(selectedStreamId)}" />
            ${seekSeq ? `<input type="hidden" name="seq" value="${escapeHtml(seekSeq)}" />` : ''}
            <label style="display:flex; flex-direction:column; gap:4px;">Event Seq
              <input name="eventSeq" type="number" min="${escapeHtml(String(events[0]?.seq || 1))}" max="${escapeHtml(String(events[events.length - 1]?.seq || 1))}" value="${escapeHtml(String(activeEventSeq || events[events.length - 1]?.seq || ''))}" />
            </label>
            <button class="button" type="submit">Go</button>
          </form>
        </div>
        <div class="table-wrap" style="margin-top:1rem;"><table>
          <thead><tr><th>Field</th><th>Value</th></tr></thead>
          <tbody>
            <tr><td>Seq</td><td><code>${escapeHtml(activeEvent?.seq || 'n/a')}</code></td></tr>
            <tr><td>Kind</td><td><code>${escapeHtml(activeEvent?.kind || 'n/a')}</code></td></tr>
            <tr><td>Timestamp</td><td>${escapeHtml(formatDate(activeEvent?.ts || ''))}</td></tr>
            <tr><td>Target</td><td>${activeEvent?.target_id ? `<code>${escapeHtml(activeEvent.target_id)}</code>` : 'n/a'}</td></tr>
            <tr><td>Payload</td><td>${formatJsonInline(activeEvent?.payload_json || activeEvent?.data_json)}</td></tr>
          </tbody>
        </table></div>`}
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Visual Playback</h2>
            <p>Renders the active event snapshot captured in-browser and stored in replay payloads.</p>
          </div>
          ${activeSnapshot ? badge(activeSnapshot.truncated ? 'Snapshot truncated' : 'Snapshot ready', activeSnapshot.truncated ? 'warning' : 'success') : ''}
        </div>
        ${!selectedStream ? '<div class="empty-state"><h3>No stream selected</h3><p>Select a replay stream to inspect visual playback.</p></div>' : !activeEvent ? '<div class="empty-state"><h3>No active event</h3><p>Select an event sequence to inspect its snapshot.</p></div>' : !activeSnapshot || !sanitizedSnapshotHtml ? '<div class="empty-state"><h3>No visual snapshot</h3><p>The active event does not include a browser HTML snapshot.</p></div>' : `<div class="metrics-grid">
          ${summaryCard('URL', activeSnapshotMeta.url || 'n/a', activeSnapshotMeta.title || 'No document title')}
          ${summaryCard('Viewport', activeSnapshotMeta.viewport ? `${activeSnapshotMeta.viewport.width || 0}×${activeSnapshotMeta.viewport.height || 0}` : 'n/a', activeSnapshotMeta.viewport?.devicePixelRatio ? `DPR ${activeSnapshotMeta.viewport.devicePixelRatio}` : 'No DPR')}
          ${summaryCard('Scroll', activeSnapshotMeta.scroll ? `${activeSnapshotMeta.scroll.x || 0}, ${activeSnapshotMeta.scroll.y || 0}` : 'n/a', activeSnapshotMeta.readyState || 'No readyState')}
          ${summaryCard('Snapshot Size', activeSnapshot.originalSize ? `${activeSnapshot.originalSize} chars` : 'n/a', activeSnapshot.capturedAt ? `Captured ${formatDate(activeSnapshot.capturedAt)}` : 'No capture time')}
        </div>
        <div style="margin-top:1rem; border:1px solid rgba(15, 23, 42, 0.12); border-radius:20px; overflow:hidden; background:#fff;">
          <iframe
            title="Replay visual snapshot"
            sandbox=""
            referrerpolicy="no-referrer"
            srcdoc="${escapeHtml(sanitizedSnapshotHtml)}"
            style="display:block; width:100%; min-height:420px; border:0; background:#fff;"
          ></iframe>
        </div>`}
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Gate Metrics</h2>
            <p>Acceptance-gate read model for FIN/ACK, alignment, target stability, and orphan pressure.</p>
          </div>
          ${metrics ? badge(metrics.finAckSuccess ? 'FIN/ACK ok' : 'FIN/ACK pending', metrics.finAckSuccess ? 'success' : 'warning') : ''}
        </div>
        ${metrics ? `<div class="metrics-grid">
          ${summaryCard('FIN/ACK', metrics.finAckSuccess ? '100%' : 'pending', `FIN ${metrics.fin_seq || 'n/a'} · ACK ${metrics.ack_seq || 'n/a'}`)}
          ${summaryCard('Seq continuity', seqContinuityText, metrics.seqContinuity?.zeroGaps ? 'No missing sequence numbers' : 'Investigate replay chunk ordering')}
          ${summaryCard('Cmd→DOM', alignmentPct, `${metrics.aligned_command_count || 0}/${metrics.actionable_command_count || 0} actionable`)}
          ${summaryCard('Target Stability', targetPct, `${metrics.target_resolved_count || 0}/${metrics.actionable_command_count || 0} resolved`)}
          ${summaryCard('Orphans', String(metrics.orphan_count || 0), metrics.orphanSpamRisk ? 'Above normal-run threshold' : 'Within normal-run threshold')}
        </div>` : '<div class="empty-state"><h3>No metrics</h3><p>Select a replay stream to inspect gate metrics.</p></div>'}
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Seek + Live Inspect</h2>
            <p>Nearest checkpoint plus forward deltas. Target resolution is evaluated at the requested sequence.</p>
          </div>
          ${selectedStream ? `<form method="GET" action="/app/runs/${encodeURIComponent(String(runId))}/replay-v2" style="display:flex; gap:0.75rem; align-items:end;">
            <input type="hidden" name="streamId" value="${escapeHtml(selectedStreamId)}" />
            ${activeEventSeq ? `<input type="hidden" name="eventSeq" value="${escapeHtml(String(activeEventSeq))}" />` : ''}
            <label>Seq<input name="seq" type="number" min="1" value="${escapeHtml(String(seekSeq || selectedStream.last_seq || 1))}" /></label>
            <button class="button" type="submit">Seek</button>
          </form>` : ''}
        </div>
        ${seek ? `<div class="metrics-grid">
          ${summaryCard('Checkpoint', String(seek.checkpoint?.checkpoint_seq || seek.seq), seek.checkpoint ? `${seek.deltas.length} forward deltas` : 'No prior checkpoint')}
          ${summaryCard('Resolved targets', String(seek.resolvedTargets.length), inspect?.targetId ? `Inspecting ${inspect.targetId}` : 'No target at seek seq')}
          ${summaryCard('Live Inspect', inspect?.domSignatureHash ? inspect.domSignatureHash.slice(0, 12) : 'n/a', inspect?.selectorBundle ? 'Selector bundle ready' : 'No inspect target')}
        </div>
        ${inspect ? `<div class="table-wrap"><table>
          <thead><tr><th>Seq</th><th>Target</th><th>DOM signature</th><th>Selector bundle</th><th>Payload</th></tr></thead>
          <tbody><tr>
            <td>${escapeHtml(inspect.seq)}</td>
            <td><code>${escapeHtml(inspect.targetId)}</code></td>
            <td>${escapeHtml(inspect.domSignatureHash || 'n/a')}</td>
            <td>${formatJsonInline(inspect.selectorBundle)}</td>
            <td>${formatJsonInline(inspect.payload)}</td>
          </tr></tbody>
        </table></div>` : '<div class="empty-state"><h3>No inspect target</h3><p>No target-backed event exists at or before the selected sequence.</p></div>'}` : '<div class="empty-state"><h3>No seek state</h3><p>Select a stream and sequence to compute synchronized replay state.</p></div>'}
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Events</h2>
            <p>Ordered replay events for the selected stream. Default selection is the first stream for the run.</p>
          </div>
          ${selectedStream ? badge(`${pageInfo.total || 0} matching`, 'neutral') : ''}
        </div>
        ${!selectedStream ? '<div class="empty-state"><h3>No stream selected</h3><p>Select a replay stream to inspect ordered events.</p></div>' : events.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Seq</th><th>Kind</th><th>Timestamp</th><th>Monotonic</th><th>Command</th><th>Target</th><th>Payload</th><th>Chunk</th></tr></thead>
          <tbody>
            ${events.map((event) => {
              const rowStyles = [];
              if (inspect?.targetId && event.target_id === inspect.targetId) rowStyles.push('background: rgba(245, 158, 11, 0.12);');
              if (activeEvent && Number(event.seq) === Number(activeEvent.seq)) rowStyles.push('outline: 2px solid rgba(28, 76, 99, 0.35); outline-offset: -2px;');
              return `<tr${rowStyles.length ? ` style="${rowStyles.join(' ')}"` : ''}>
              <td><a class="text-link" href="${escapeHtml(buildReplayHref({ eventSeq: event.seq }))}">${escapeHtml(event.seq)}</a></td>
              <td><code>${escapeHtml(event.kind)}</code></td>
              <td>${escapeHtml(formatDate(event.ts))}</td>
              <td>${escapeHtml(`${event.monotonic_ms} ms`)}</td>
              <td>${escapeHtml(event.command_id || 'n/a')}</td>
              <td>${event.target_id ? `<div><code>${escapeHtml(event.target_id)}</code><br/><small>v${escapeHtml(event.selector_version || '1')} · ${escapeHtml(event.lifecycle_event || 'active')}</small></div>` : 'n/a'}</td>
              <td>${formatJsonInline(event.payload_json || event.data_json)}</td>
              <td>${event.chunk_id ? `<div><code>${escapeHtml(String(event.chunk_id).slice(0, 8))}</code><br/><small>index ${escapeHtml(event.chunk_index ?? 'n/a')} · final ${event.final ? 'yes' : 'no'}</small></div>` : 'n/a'}</td>
            </tr>`;
            }).join('')}
          </tbody>
        </table></div>` : '<div class="empty-state"><h3>No replay events</h3><p>The selected stream has no persisted events in the requested range.</p></div>'}
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Target Registry</h2>
            <p>Resolved logical targets at the selected sequence with selector bundle versions and DOM signatures.</p>
          </div>
          ${selectedStream ? badge(`${targets.length} targets`, 'neutral') : ''}
        </div>
        ${!selectedStream ? '<div class="empty-state"><h3>No stream selected</h3><p>Select a replay stream to inspect target registry state.</p></div>' : targets.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Target</th><th>Version</th><th>State</th><th>Lifecycle</th><th>Seq</th><th>DOM signature</th><th>Selectors</th></tr></thead>
          <tbody>
            ${targets.map((target) => `<tr${inspect?.targetId && target.target_id === inspect.targetId ? ' style="background: rgba(59, 130, 246, 0.12);"' : ''}>
              <td><code>${escapeHtml(target.target_id)}</code></td>
              <td>${escapeHtml(target.selector_version)}</td>
              <td>${escapeHtml(target.state)}</td>
              <td>${escapeHtml(target.lifecycle_event)}</td>
              <td>${escapeHtml(target.event_seq)}</td>
              <td>${escapeHtml(target.dom_signature_hash || 'n/a')}</td>
              <td>${formatJsonInline(target.selector_bundle)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="empty-state"><h3>No targets</h3><p>No target registry rows exist for the selected stream and sequence.</p></div>'}
      </section>`
  });
}

function renderArtifactPage(shell, detail) {
  return renderLayout({
    title: 'Artifact Viewer',
    shell,
    currentPath: '/app/runs',
    content: `<section class="panel">
        <div class="panel-header">
          <div>
            <h2>${escapeHtml(detail.item.type)}</h2>
            <p>Signed download contract and metadata for artifact ${escapeHtml(detail.item.id)}.</p>
          </div>
          ${badge(detail.download.backend || 'unknown', 'neutral')}
        </div>
        <div class="metrics-grid">
          ${metric('Content type', detail.item.content_type || 'application/octet-stream')}
          ${metric('Size', formatBytes(detail.item.byte_size))}
          ${metric('Created', formatDate(detail.item.created_at))}
          ${metric('Download expires', formatDate(detail.download.expiresAt))}
        </div>
        <pre class="code-block">${escapeHtml(JSON.stringify(detail, null, 2))}</pre>
        <p><a class="button button-secondary" target="_blank" rel="noreferrer" href="${escapeHtml(detail.download.url)}">Open signed download</a></p>
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
  reply.type('text/css').send(stylesCss);
});

app.get('/assets/web.js', async (_request, reply) => {
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

app.get('/app/runs/:id/replay-v2', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);

  const streamsResp = await apiFetch(`/v1/runs/${request.params.id}/replay-v2/streams`, { token: shell.session.token });
  const streams = streamsResp.items || [];
  const requestedStreamId = String(request.query?.streamId || '').trim();
  const requestedStreamIdKey = requestedStreamId.toLowerCase();
  const matchedRequestedStream = requestedStreamId
    ? streams.find((stream) => String(stream.stream_id || '').toLowerCase() === requestedStreamIdKey)
    : null;
  const selectedStreamId = String((matchedRequestedStream || streams[0] || {}).stream_id || '');
  const selectionMeta = {
    requestedStreamId,
    requestedStreamFound: Boolean(matchedRequestedStream),
    fallbackUsed: Boolean(requestedStreamId) && !matchedRequestedStream && Boolean(selectedStreamId)
  };

  let eventsResp = { items: [], pageInfo: { total: 0, limit: 300 } };
  let metricsResp = { item: null };
  let targetsResp = { items: [] };
  let seekResp = { item: null };
  const seekSeq = String(request.query?.seq || '').trim();
  const eventSeq = String(request.query?.eventSeq || '').trim();
  if (selectedStreamId) {
    try {
      eventsResp = await apiFetch(`/v1/runs/${request.params.id}/replay-v2/events?${new URLSearchParams({
        streamId: selectedStreamId,
        limit: '300'
      }).toString()}`, { token: shell.session.token });
      metricsResp = await apiFetch(`/v1/runs/${request.params.id}/replay-v2/metrics?${new URLSearchParams({
        streamId: selectedStreamId
      }).toString()}`, { token: shell.session.token });
      targetsResp = await apiFetch(`/v1/runs/${request.params.id}/replay-v2/targets?${new URLSearchParams({
        streamId: selectedStreamId,
        ...(seekSeq ? { seq: seekSeq } : {})
      }).toString()}`, { token: shell.session.token });
      seekResp = await apiFetch(`/v1/runs/${request.params.id}/replay-v2/seek?${new URLSearchParams({
        streamId: selectedStreamId,
        seq: seekSeq || String(streams.find((stream) => stream.stream_id === selectedStreamId)?.last_seq || 1)
      }).toString()}`, { token: shell.session.token });
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
  }

  return reply.type('text/html').send(renderReplayV2Page(
    shell,
    request.params.id,
    streamsResp,
    eventsResp,
    selectedStreamId,
    metricsResp,
    targetsResp,
    seekResp,
    seekSeq,
    selectionMeta,
    eventSeq
  ));
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
