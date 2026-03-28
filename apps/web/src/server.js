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
    if (expired) setCookies(reply, [clearCookie(SESSION_COOKIE), clearCookie(WORKSPACE_COOKIE), clearCookie(PROJECT_COOKIE)]);
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

function renderSnippet(workspace, project) {
  if (!workspace || !project) {
    return '<div class="empty-state"><h3>Connect snippet unavailable</h3><p>Create or select a workspace and project first.</p></div>';
  }

  const runId = '${RUN_ID:-$(uuidgen)}';
  const snippet = `export INGEST_BASE_URL="${INGEST_PUBLIC_BASE_URL}"
export INGEST_AUTH_TOKEN="replace-me"

curl -X POST "$INGEST_BASE_URL/v1/ingest/events" \\
  -H "Authorization: Bearer $INGEST_AUTH_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "type":"run.started",
    "idempotencyKey":"'"${crypto.randomUUID()}"'",
    "payload":{
      "runId":"${runId}",
      "workspaceId":"${workspace.id}",
      "projectId":"${project.id}",
      "branch":"main",
      "commitSha":"local-smoke",
      "ciProvider":"manual"
    }
  }'`;

  return `<section class="panel">
    <div class="panel-header">
      <div>
        <h2>Connect snippet</h2>
        <p>Drop this into a shell or CI job to send the first event for ${escapeHtml(project.name)}.</p>
      </div>
      ${badge(project.provider || 'custom', 'neutral')}
    </div>
    <pre class="code-block">${escapeHtml(snippet)}</pre>
  </section>`;
}

function renderOnboardingPage(shell) {
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
          <p>Authenticate, create a workspace, choose a project, then copy the connect snippet. This page intentionally keeps the first-run path linear.</p>
        </div>
        <div class="hero-metrics">
          ${summaryCard('Workspaces', workspaceStats, 'Available to this user')}
          ${summaryCard('Projects', projectStats, shell.selectedWorkspace ? `Inside ${shell.selectedWorkspace.name}` : 'Create one to continue')}
          ${summaryCard('Session', shell.session?.user?.email || 'No session', 'Local auth token')}
        </div>
      </section>
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
        ${renderSnippet(shell.selectedWorkspace, shell.selectedProject)}
      </div>`
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

function renderConnectPage(shell, status, latestRun) {
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
          <p>Service health is aggregated server-side so this page works for local Docker and for remote deployments behind private service URLs.</p>
        </div>
        <div class="hero-metrics">
          ${summaryCard('Recent runs', String(status.metrics.recentRuns24h), 'Last 24 hours')}
          ${summaryCard('Latest run', latestRun?.status || 'none', latestRun ? formatDate(latestRun.created_at) : 'No run in selected project')}
        </div>
      </section>
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
              <p>Queue a notification test against the selected workspace to validate API to worker to webhook delivery.</p>
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
      ${renderSnippet(shell.selectedWorkspace, shell.selectedProject)}`
  });
}

function renderRunsPage(shell, runsResp) {
  const items = runsResp.items || [];
  const pageInfo = runsResp.pageInfo || { page: 1, totalPages: 1, total: items.length };
  return renderLayout({
    title: 'Runs',
    shell,
    currentPath: '/app/runs',
    content: `<section class="panel">
        <div class="panel-header">
          <div>
            <h2>Run list</h2>
            <p>Filterable browser list for the selected project.</p>
          </div>
          ${badge(`${pageInfo.total} total`, 'neutral')}
        </div>
        <form class="filters" method="get" action="/app/runs">
          <input type="hidden" name="workspaceId" value="${escapeHtml(shell.selectedWorkspace?.id || '')}" />
          <input type="hidden" name="projectId" value="${escapeHtml(shell.selectedProject?.id || '')}" />
          <label>Branch<input name="branch" value="${escapeHtml(shell.ctx.branch || '')}" /></label>
          <label>Status<input name="status" value="${escapeHtml(shell.ctx.runStatus || '')}" /></label>
          <label>Page<input type="number" min="1" name="page" value="${escapeHtml(shell.ctx.page || '1')}" /></label>
          <button class="button button-secondary" type="submit">Apply filters</button>
        </form>
        ${items.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Created</th><th>Status</th><th>Branch</th><th>Commit</th><th>Specs</th><th>Tests</th><th></th></tr></thead>
          <tbody>
            ${items.map((run) => `<tr>
              <td>${escapeHtml(formatDate(run.created_at))}</td>
              <td>${badge(run.status, run.status === 'passed' ? 'success' : run.status === 'failed' ? 'danger' : 'warning')}</td>
              <td>${escapeHtml(run.branch || 'n/a')}</td>
              <td><code>${escapeHtml((run.commit_sha || 'n/a').slice(0, 12))}</code></td>
              <td>${escapeHtml(`${run.total_specs}/${run.pass_count + run.fail_count + run.flaky_count || run.total_specs}`)}</td>
              <td>${escapeHtml(`${run.total_tests} total`)}</td>
              <td><a class="text-link" href="/app/runs/${run.id}">Open</a></td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="empty-state"><h3>No runs yet</h3><p>Use the onboarding snippet or the connect page to start sending ingest events.</p></div>'}
      </section>`
  });
}

function renderRunDetailPage(shell, runDetail) {
  const item = runDetail.item;
  const summary = runDetail.summary;
  const specs = runDetail.specs || [];
  const tests = runDetail.tests || [];
  const artifacts = runDetail.artifacts || [];

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
              ${specs.map((spec) => `<tr><td>${escapeHtml(spec.spec_path)}</td><td>${badge(spec.status, spec.status === 'passed' ? 'success' : spec.status === 'failed' ? 'danger' : 'warning')}</td><td>${escapeHtml(spec.attempts || 0)}</td><td>${escapeHtml(formatDuration(spec.duration_ms))}</td></tr>`).join('')}
            </tbody>
          </table></div>
        </section>
        <section class="panel">
          <div class="panel-header"><div><h2>Failures & flakes</h2><p>Fast browser triage for the most important failing tests.</p></div></div>
          ${tests.filter((test) => ['failed', 'flaky'].includes(test.status)).length
            ? tests.filter((test) => ['failed', 'flaky'].includes(test.status)).slice(0, 20).map((test) => `<article class="failure-row">
                <div><strong>${escapeHtml(test.test_title)}</strong><p>${escapeHtml(test.file_path)}</p></div>
                <div>${badge(test.status, test.status === 'failed' ? 'danger' : 'warning')}</div>
                <pre>${escapeHtml(test.error_message || 'No error message')}</pre>
              </article>`).join('')
            : '<div class="empty-state"><h3>No failing tests</h3><p>This run has no failed or flaky test results.</p></div>'}
        </section>
      </div>
      <section class="panel">
        <div class="panel-header"><div><h2>Artifacts</h2><p>Every artifact registered against this run. Open individual entries for signed access metadata.</p></div></div>
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

function renderAdminPage(shell, hooksResp, deliveriesResp, logsResp) {
  const hooks = hooksResp.items || [];
  const deliveries = deliveriesResp.items || [];
  const logs = logsResp.items || [];

  return renderLayout({
    title: 'Admin & Webhooks',
    shell,
    currentPath: '/app/admin',
    content: `<div class="grid two-up">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Create webhook endpoint</h2>
              <p>Basic admin surface for notification delivery and smoke validation.</p>
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
        <div class="panel-header"><div><h2>Webhook endpoints</h2><p>Enable, disable, or remove endpoints without dropping to raw API calls.</p></div></div>
        ${hooks.length ? hooks.map((hook) => `<article class="hook-card">
            <div>
              <strong>${escapeHtml(hook.type)}</strong>
              <p>${escapeHtml(hook.target_url)}</p>
              <small>${escapeHtml(formatDate(hook.created_at))}</small>
            </div>
            <div class="hook-actions">
              ${badge(hook.enabled ? 'enabled' : 'disabled', hook.enabled ? 'success' : 'warning')}
              <form data-json-form action="/app/webhooks/${hook.id}/update" method="post">
                <input type="hidden" name="enabled" value="${hook.enabled ? 'false' : 'true'}" />
                <button class="button button-secondary" type="submit">${hook.enabled ? 'Disable' : 'Enable'}</button>
              </form>
              <form data-json-form data-confirm="Delete this webhook endpoint?" action="/app/webhooks/${hook.id}/delete" method="post">
                <button class="button button-danger" type="submit">Delete</button>
              </form>
            </div>
          </article>`).join('') : '<div class="empty-state"><h3>No endpoints</h3><p>Create one above to start receiving notification tests.</p></div>'}
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Recent deliveries</h2><p>Browser view over delivery attempts for the selected workspace.</p></div></div>
        ${deliveries.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Status</th><th>Event</th><th>Attempts</th><th>Target</th><th>Last error</th><th>Updated</th></tr></thead>
          <tbody>
            ${deliveries.map((delivery) => `<tr>
              <td>${badge(delivery.status, delivery.status === 'delivered' ? 'success' : delivery.status === 'dead' ? 'danger' : 'warning')}</td>
              <td>${escapeHtml(delivery.event_type)}</td>
              <td>${escapeHtml(`${delivery.attempt_count}/${delivery.max_attempts}`)}</td>
              <td>${escapeHtml(delivery.target_url)}</td>
              <td>${escapeHtml(delivery.last_error || 'n/a')}</td>
              <td>${escapeHtml(formatDate(delivery.updated_at))}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="empty-state"><h3>No deliveries yet</h3><p>Use the connect page to queue a notification test.</p></div>'}
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

  const cookies = [buildCookie(SESSION_COOKIE, login.token)];
  const firstWorkspace = login.memberships?.[0]?.workspace_id || '';
  if (firstWorkspace) cookies.push(buildCookie(WORKSPACE_COOKIE, firstWorkspace));
  return jsonRedirect(reply, '/app/onboarding?notice=Signed in.', cookies);
});

app.post('/logout', async (_request, reply) => jsonRedirect(reply, '/login?notice=Signed out.', [
  clearCookie(SESSION_COOKIE),
  clearCookie(WORKSPACE_COOKIE),
  clearCookie(PROJECT_COOKIE)
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
  if (projectId) cookies.push(buildCookie(PROJECT_COOKIE, projectId));
  if (!projectId) cookies.push(clearCookie(PROJECT_COOKIE));
  return jsonRedirect(reply, `${returnTo}?notice=Context updated.`, cookies);
});

app.get('/app/onboarding', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);
  return reply.type('text/html').send(renderOnboardingPage(shell));
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
    clearCookie(PROJECT_COOKIE)
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
    buildCookie(PROJECT_COOKIE, created.item.id)
  ]);
});

app.get('/app/connect', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);

  const status = await apiFetch('/v1/system/status', { token: shell.session.token });
  const latestRun = shell.selectedProject
    ? (await apiFetch(`/v1/projects/${shell.selectedProject.id}/latest-run`, { token: shell.session.token }).catch(() => ({ item: null }))).item
    : null;

  return reply.type('text/html').send(renderConnectPage(shell, status, latestRun));
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

app.get('/app/runs', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);
  if (!shell.selectedWorkspace || !shell.selectedProject) {
    return reply.redirect('/app/onboarding?error=Create or select a workspace and project before opening runs.');
  }

  const params = new URLSearchParams({
    workspaceId: shell.selectedWorkspace.id,
    projectId: shell.selectedProject.id,
    ...(request.query?.branch ? { branch: String(request.query.branch) } : {}),
    ...(request.query?.status ? { status: String(request.query.status) } : {}),
    page: String(request.query?.page || '1'),
    limit: '20'
  });
  const runsResp = await apiFetch(`/v1/runs?${params.toString()}`, { token: shell.session.token });
  shell.ctx.branch = String(request.query?.branch || '');
  shell.ctx.runStatus = String(request.query?.status || '');
  shell.ctx.page = String(request.query?.page || '1');
  return reply.type('text/html').send(renderRunsPage(shell, runsResp));
});

app.get('/app/runs/:id', async (request, reply) => {
  const shell = await loadShellData(request);
  if (!shell.session) return requireSession(request, reply);
  const detail = await apiFetch(`/v1/runs/${request.params.id}`, { token: shell.session.token });
  return reply.type('text/html').send(renderRunDetailPage(shell, detail));
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
    apiFetch(`/v1/webhook-deliveries?workspaceId=${encodeURIComponent(workspaceId)}&limit=20`, { token: shell.session.token }),
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
