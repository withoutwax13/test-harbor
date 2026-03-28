import Fastify from 'fastify';
import pg from 'pg';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 4000);
const databaseUrl = process.env.DATABASE_URL || 'postgres://testharbor:testharbor@localhost:5432/testharbor';

const pool = new pg.Pool({ connectionString: databaseUrl });


const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || '';

function parseBearerToken(headerValue) {
  if (!headerValue) return null;
  const [scheme, token] = String(headerValue).split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

app.addHook('onRequest', async (request, reply) => {
  if (!API_AUTH_TOKEN) return;
  if (request.url.startsWith('/healthz')) return;

  const token = parseBearerToken(request.headers.authorization);
  if (token !== API_AUTH_TOKEN) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

app.get('/healthz', async () => {
  let db = 'down';
  try {
    await query('select 1');
    db = 'up';
  } catch {
    db = 'down';
  }
  return { ok: true, service: '@testharbor/api', db };
});

app.get('/v1/workspaces', async () => {
  const { rows } = await query(
    `select w.id, w.name, w.slug, w.timezone, w.retention_days, w.created_at, o.id as organization_id, o.name as organization_name
     from workspaces w
     join organizations o on o.id = w.organization_id
     order by w.created_at desc`
  );
  return { items: rows };
});

app.post('/v1/workspaces', async (request, reply) => {
  const { organizationName, organizationSlug, name, slug, timezone = 'UTC', retentionDays = 30 } = request.body || {};
  if (!organizationName || !organizationSlug || !name || !slug) {
    return reply.code(400).send({ error: 'organizationName, organizationSlug, name, slug are required' });
  }

  const org = await query(
    `insert into organizations(name, slug)
     values ($1, $2)
     on conflict (slug) do update set name = excluded.name
     returning id, name, slug`,
    [organizationName, organizationSlug]
  );

  const ws = await query(
    `insert into workspaces(organization_id, name, slug, timezone, retention_days)
     values ($1, $2, $3, $4, $5)
     on conflict (organization_id, slug)
     do update set name = excluded.name, timezone = excluded.timezone, retention_days = excluded.retention_days
     returning *`,
    [org.rows[0].id, name, slug, timezone, retentionDays]
  );

  return reply.code(201).send({
    item: {
      ...ws.rows[0],
      organization_id: org.rows[0].id,
      organization_slug: org.rows[0].slug
    }
  });
});

app.get('/v1/projects', async (request, reply) => {
  const { workspaceId } = request.query || {};
  if (!workspaceId) {
    return reply.code(400).send({ error: 'workspaceId is required' });
  }

  const { rows } = await query(
    `select id, workspace_id, name, slug, provider, repo_url, default_branch, created_at
     from projects
     where workspace_id = $1
     order by created_at desc`,
    [workspaceId]
  );

  return { items: rows };
});

app.post('/v1/projects', async (request, reply) => {
  const { workspaceId, name, slug, provider = null, repoUrl = null, defaultBranch = 'main' } = request.body || {};
  if (!workspaceId || !name || !slug) {
    return reply.code(400).send({ error: 'workspaceId, name, slug are required' });
  }

  const { rows } = await query(
    `insert into projects(workspace_id, name, slug, provider, repo_url, default_branch)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (workspace_id, slug)
     do update set name = excluded.name, provider = excluded.provider, repo_url = excluded.repo_url, default_branch = excluded.default_branch
     returning *`,
    [workspaceId, name, slug, provider, repoUrl, defaultBranch]
  );

  return reply.code(201).send({ item: rows[0] });
});

app.get('/v1/projects/:id', async (request, reply) => {
  const { id } = request.params;
  const { rows } = await query(
    `select id, workspace_id, name, slug, provider, repo_url, default_branch, created_at
     from projects where id = $1`,
    [id]
  );
  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return { item: rows[0] };
});

app.patch('/v1/projects/:id', async (request, reply) => {
  const { id } = request.params;
  const { name, provider, repoUrl, defaultBranch } = request.body || {};

  const { rows } = await query(
    `update projects
     set name = coalesce($2, name),
         provider = coalesce($3, provider),
         repo_url = coalesce($4, repo_url),
         default_branch = coalesce($5, default_branch)
     where id = $1
     returning *`,
    [id, name ?? null, provider ?? null, repoUrl ?? null, defaultBranch ?? null]
  );

  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return { item: rows[0] };
});

app.delete('/v1/projects/:id', async (request, reply) => {
  const { id } = request.params;
  const { rows } = await query(
    `delete from projects
     where id = $1
     returning id`,
    [id]
  );

  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return reply.code(204).send();
});


app.get('/v1/projects/:id/latest-run', async (request, reply) => {
  const { id } = request.params;
  const { rows } = await query(
    `select id, workspace_id, project_id, status, branch, commit_sha, started_at, finished_at,
            total_specs, total_tests, pass_count, fail_count, flaky_count, created_at
     from runs
     where project_id = $1
     order by created_at desc
     limit 1`,
    [id]
  );
  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return { item: rows[0] };
});

app.get('/v1/runs/:id/summary', async (request, reply) => {
  const { id } = request.params;

  const run = await query(
    `select id, workspace_id, project_id, status, branch, commit_sha, started_at, finished_at,
            total_specs, total_tests, pass_count, fail_count, flaky_count, created_at
     from runs where id = $1`,
    [id]
  );
  if (!run.rows.length) return reply.code(404).send({ error: 'not_found' });

  const specStats = await query(
    `select
      count(*)::int as spec_count,
      coalesce(sum(duration_ms), 0)::int as total_spec_duration_ms,
      coalesce(max(duration_ms), 0)::int as slowest_spec_duration_ms,
      coalesce((array_agg(spec_path order by duration_ms desc nulls last))[1], null) as slowest_spec_path
     from spec_runs
     where run_id = $1`,
    [id]
  );

  const testStats = await query(
    `select
      count(*)::int as test_count,
      count(*) filter (where status = 'passed')::int as passed,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'flaky')::int as flaky,
      coalesce(sum(duration_ms), 0)::int as total_test_duration_ms
     from test_results tr
     join spec_runs sr on sr.id = tr.spec_run_id
     where sr.run_id = $1`,
    [id]
  );

  const artifactStats = await query(
    `select count(*)::int as artifact_count,
            coalesce(sum(byte_size), 0)::bigint as total_artifact_bytes
     from artifacts where run_id = $1`,
    [id]
  );

  return {
    item: run.rows[0],
    summary: {
      specs: specStats.rows[0],
      tests: testStats.rows[0],
      artifacts: artifactStats.rows[0]
    }
  };
});


app.get('/v1/webhook-endpoints', async (request, reply) => {
  const { workspaceId } = request.query || {};
  if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });

  const { rows } = await query(
    `select id, workspace_id, type, target_url, enabled, created_at
     from webhook_endpoints
     where workspace_id = $1
     order by created_at desc`,
    [workspaceId]
  );
  return { items: rows };
});

app.post('/v1/webhook-endpoints', async (request, reply) => {
  const { workspaceId, type, targetUrl, secret = null, enabled = true } = request.body || {};
  if (!workspaceId || !type || !targetUrl) {
    return reply.code(400).send({ error: 'workspaceId, type, targetUrl are required' });
  }

  const { rows } = await query(
    `insert into webhook_endpoints(workspace_id, type, target_url, secret, enabled)
     values ($1, $2, $3, $4, $5)
     returning id, workspace_id, type, target_url, enabled, created_at`,
    [workspaceId, type, targetUrl, secret, enabled]
  );

  return reply.code(201).send({ item: rows[0] });
});

app.patch('/v1/webhook-endpoints/:id', async (request, reply) => {
  const { id } = request.params;
  const body = request.body || {};

  const hasTargetUrl = Object.prototype.hasOwnProperty.call(body, 'targetUrl');
  const hasSecret = Object.prototype.hasOwnProperty.call(body, 'secret');
  const hasEnabled = Object.prototype.hasOwnProperty.call(body, 'enabled');

  const { targetUrl, secret, enabled } = body;

  if (!hasTargetUrl && !hasSecret && !hasEnabled) {
    return reply.code(400).send({ error: 'at least one of targetUrl, secret, enabled is required' });
  }

  if (hasTargetUrl && (!targetUrl || typeof targetUrl !== 'string')) {
    return reply.code(400).send({ error: 'targetUrl must be a non-empty string when provided' });
  }

  if (hasEnabled && typeof enabled !== 'boolean') {
    return reply.code(400).send({ error: 'enabled must be boolean when provided' });
  }

  if (hasSecret && !(secret === null || typeof secret === 'string')) {
    return reply.code(400).send({ error: 'secret must be string|null when provided' });
  }

  const { rows } = await query(
    `update webhook_endpoints
     set target_url = case when $2::boolean then $3 else target_url end,
         secret = case when $4::boolean then $5 else secret end,
         enabled = case when $6::boolean then $7 else enabled end
     where id = $1
     returning id, workspace_id, type, target_url, enabled, created_at`,
    [
      id,
      hasTargetUrl,
      hasTargetUrl ? targetUrl : null,
      hasSecret,
      hasSecret ? secret : null,
      hasEnabled,
      hasEnabled ? enabled : null
    ]
  );

  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return { item: rows[0] };
});

app.delete('/v1/webhook-endpoints/:id', async (request, reply) => {
  const { id } = request.params;
  const { rows } = await query(
    `delete from webhook_endpoints
     where id = $1
     returning id`,
    [id]
  );

  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return reply.code(204).send();
});

app.get('/v1/webhook-deliveries', async (request, reply) => {
  const { workspaceId, status, limit = 50 } = request.query || {};
  if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });

  const capped = Math.min(Number(limit) || 50, 200);
  const { rows } = await query(
    `select id, notification_event_id, webhook_endpoint_id, event_type, target_url,
            attempt_count, max_attempts, status, next_retry_at, last_attempt_at, delivered_at,
            response_status, last_error, created_at, updated_at
     from webhook_deliveries
     where workspace_id = $1 and ($2::text is null or status = $2)
     order by created_at desc
     limit $3`,
    [workspaceId, status ?? null, capped]
  );

  return { items: rows };
});

app.get('/v1/runs', async (request, reply) => {
  const { workspaceId, projectId, limit = 20 } = request.query || {};
  if (!workspaceId || !projectId) {
    return reply.code(400).send({ error: 'workspaceId and projectId are required' });
  }

  const capped = Math.min(Number(limit) || 20, 200);
  const { rows } = await query(
    `select id, workspace_id, project_id, status, branch, commit_sha, started_at, finished_at,
            total_specs, total_tests, pass_count, fail_count, flaky_count, created_at
     from runs
     where workspace_id = $1 and project_id = $2
     order by created_at desc
     limit $3`,
    [workspaceId, projectId, capped]
  );

  return { items: rows };
});

app.get('/v1/runs/:id', async (request, reply) => {
  const { id } = request.params;
  const run = await query(
    `select id, workspace_id, project_id, status, branch, commit_sha, started_at, finished_at,
            total_specs, total_tests, pass_count, fail_count, flaky_count, created_at
     from runs where id = $1`,
    [id]
  );
  if (!run.rows.length) return reply.code(404).send({ error: 'not_found' });

  const specs = await query(
    `select id, run_id, spec_path, status, attempts, duration_ms, started_at, finished_at
     from spec_runs where run_id = $1 order by created_at asc`,
    [id]
  );

  const tests = await query(
    `select tr.id, tr.spec_run_id, tr.test_case_id, tr.attempt_no, tr.status, tr.duration_ms, tr.error_hash, tr.error_message, tr.created_at,
            tc.title as test_title, tc.file_path
     from test_results tr
     join test_cases tc on tc.id = tr.test_case_id
     where tr.spec_run_id = any($1::uuid[])
     order by tr.created_at asc`,
    [specs.rows.map((s) => s.id)]
  );

  const artifacts = await query(
    `select id, run_id, spec_run_id, test_result_id, type, storage_key, content_type, byte_size, created_at
     from artifacts where run_id = $1 order by created_at asc`,
    [id]
  );

  return {
    item: run.rows[0],
    specs: specs.rows,
    tests: tests.rows,
    artifacts: artifacts.rows
  };
});

app.delete('/v1/organizations/:id/smoke-cleanup', async (request, reply) => {
  if (!API_AUTH_TOKEN) {
    return reply.code(403).send({ error: 'smoke_org_cleanup_requires_api_token' });
  }
  if (process.env.ALLOW_SMOKE_ORG_CLEANUP !== '1') {
    return reply.code(403).send({ error: 'smoke_org_cleanup_disabled' });
  }

  if (request.query?.confirm !== 'delete-smoke-organization') {
    return reply.code(400).send({ error: 'confirm=delete-smoke-organization is required' });
  }

  const { id } = request.params;
  const orgRes = await query(
    `select id, slug, name, created_at
     from organizations
     where id = $1`,
    [id]
  );
  if (!orgRes.rows.length) return reply.code(404).send({ error: 'not_found' });

  const organization = orgRes.rows[0];
  if (!/^webhook-org-\d[\da-z-]*$/.test(organization.slug)) {
    return reply.code(400).send({ error: 'organization_not_eligible_for_smoke_cleanup', slug: organization.slug });
  }

  const workspaceRes = await query(
    `select id, slug
     from workspaces
     where organization_id = $1
     order by created_at asc`,
    [id]
  );
  if (workspaceRes.rows.length !== 1) {
    return reply.code(400).send({
      error: 'organization_not_isolated',
      workspaceCount: workspaceRes.rows.length
    });
  }

  const workspace = workspaceRes.rows[0];
  if (!/^webhook-workspace-\d[\da-z-]*$/.test(workspace.slug)) {
    return reply.code(400).send({ error: 'workspace_not_eligible_for_smoke_cleanup', slug: workspace.slug });
  }

  const projectRes = await query(
    `select id, slug
     from projects
     where workspace_id = $1
     order by created_at asc`,
    [workspace.id]
  );
  if (projectRes.rows.length > 3) {
    return reply.code(400).send({
      error: 'organization_not_bounded',
      projectCount: projectRes.rows.length
    });
  }
  if (projectRes.rows.some((project) => !/^webhook-project-\d[\da-z-]*$/.test(project.slug))) {
    return reply.code(400).send({ error: 'project_not_eligible_for_smoke_cleanup' });
  }

  await query(
    `delete from organizations
     where id = $1`,
    [id]
  );

  return reply.code(200).send({
    ok: true,
    organizationId: id,
    organizationSlug: organization.slug,
    deletedWorkspaceId: workspace.id,
    deletedProjectCount: projectRes.rows.length
  });
});

app.delete('/v1/workspaces/:id', async (request, reply) => {
  const { id } = request.params;
  const { rows } = await query(
    `delete from workspaces
     where id = $1
     returning id`,
    [id]
  );

  if (!rows.length) return reply.code(404).send({ error: 'not_found' });
  return reply.code(204).send();
});

app.setErrorHandler((error, _req, reply) => {
  app.log.error(error);
  if (error.code === '23505') return reply.code(409).send({ error: 'conflict', detail: error.detail });
  return reply.code(500).send({ error: 'internal_error' });
});

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
