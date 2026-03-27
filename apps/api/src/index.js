import Fastify from 'fastify';
import pg from 'pg';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 4000);
const databaseUrl = process.env.DATABASE_URL || 'postgres://testharbor:testharbor@localhost:5432/testharbor';

const pool = new pg.Pool({ connectionString: databaseUrl });

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

  return reply.code(201).send({ item: ws.rows[0] });
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

app.setErrorHandler((error, _req, reply) => {
  app.log.error(error);
  if (error.code === '23505') return reply.code(409).send({ error: 'conflict', detail: error.detail });
  return reply.code(500).send({ error: 'internal_error' });
});

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
