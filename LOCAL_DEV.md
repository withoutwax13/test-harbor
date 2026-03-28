# Local Dev Quickstart (Windows-safe defaults)

## Ports used
- Web: `3000`
- API: `4000`
- Ingest: `4010`
- Postgres: `5433 -> 5432` (container)
- Redis: `6380 -> 6379` (container)
- MinIO: `9000`, console `9001`

## One-command validation

```bash
./scripts/smoke-all.sh
```

This runs:
1. `docker compose up -d postgres redis minio ingest api worker web`
2. `npm run db:migrate:container`
3. `npm run seed:local`
4. `npm run smoke:all`

## Manual fallback

```bash
docker compose up -d postgres redis minio ingest api worker web
npm run db:migrate:container
npm run seed:local
npm run smoke:all
```

## Troubleshooting
- **Docker daemon unavailable**: start Docker Desktop first.
- **Port conflicts** on 5432/6379: keep the compose remaps (5433/6380).
- **`psql: command not found`**: use `npm run db:migrate:container` (no host psql needed).
- **API unreachable**: `docker compose up -d api && docker compose logs --tail=120 api`.

## Browser flow

1. Open `http://localhost:3000/login`.
2. Sign in with a local name and email.
3. Use `/app/onboarding` to create or select a workspace and project.
4. Copy the connect snippet into a shell or CI job.
5. Use `/app/connect` to inspect API, ingest, and worker health, then queue a test event.
6. Use `/app/runs` and `/app/runs/:id` for browser triage.
7. Use `/app/admin` for webhook endpoint and delivery basics.

Browser smoke:

```bash
npm run smoke:web-shell
```

## Auth (optional)
Set these in `.env` to enforce bearer auth:
- `API_AUTH_TOKEN`
- `INGEST_AUTH_TOKEN`
- `LOCAL_AUTH_REQUIRED=1`
- `REQUIRE_WORKSPACE_AUTH=1`
- `LOCAL_AUTH_SECRET=change-me`

When `API_AUTH_TOKEN` is set, `/v1/*` accepts either the service bearer token or a local-dev user token issued by `POST /v1/auth/login`.
When `LOCAL_AUTH_REQUIRED=1`, local user auth is mandatory for API routes.
When `REQUIRE_WORKSPACE_AUTH=1`, workspace-scoped routes also require membership and role checks (`owner`, `admin`, `member`, `viewer`).
`/healthz`, `POST /v1/auth/login`, and signed artifact proxy URLs remain open for liveness and local artifact flows.

- Full local bootstrap: `npm run smoke:bootstrap`

## Batch 11-18 additions

Key API lanes now available:
- Auth and workspace guard lanes: `POST /v1/auth/login`, `GET /v1/me`, `POST /v1/workspaces/:id/members`
- Artifact signing lanes: `POST /v1/artifacts/sign-upload`, `GET /v1/artifacts/:id/sign-download`
- Explorer and analytics lanes: `GET /v1/runs/:runId/specs`, `GET /v1/spec-runs/:id/tests`, `GET /v1/tests/:testCaseId/history`, `GET /v1/analytics/flaky`, `GET /v1/analytics/failures/clusters`
- Orchestrator and notification lanes: `POST /v1/orchestrator/plan`, `GET /v1/orchestrator/runs/:runId/shards`, `POST /v1/orchestrator/retry-failures/:runId`, `POST /v1/notifications/format`, `POST /v1/notifications/pr-feedback`, `POST /v1/notifications/test`
- Retention and audit lanes: `POST /v1/retention/run`, `GET /v1/audit-logs`

New smoke scripts:
- `npm run smoke:auth-explorer`
- `npm run smoke:notifications-retention`

Recommended hardened local run:

```bash
export LOCAL_AUTH_REQUIRED=1
export REQUIRE_WORKSPACE_AUTH=1
export API_AUTH_TOKEN=local-api-token
export INGEST_AUTH_TOKEN=local-ingest-token
docker compose up -d postgres redis minio ingest api worker
npm run db:migrate:container
npm run smoke:auth-explorer
npm run smoke:notifications-retention
```

## Artifact signing and storage portability

Storage env toggles:
- `STORAGE_BACKEND=minio|s3`
- `STORAGE_BUCKET=testharbor`
- `STORAGE_PREFIX=artifacts`
- `STORAGE_PUBLIC_BASE_URL=http://localhost:4000`
- `ARTIFACT_SIGN_TTL_SEC=900`
- `ARTIFACT_PROXY_MODE=json`

Current local mode is adapter-first:
- `sign-upload` and `sign-download` persist grants in `artifact_access_tokens`
- returned URLs are stable proxy contracts that validate the signed grant before acknowledging upload/download
- MinIO/S3 portability is driven by the adapter env surface above, so local compose can stay on MinIO while deployment docs/scripts can switch to S3-compatible endpoints without changing API consumers


## Webhook smoke closure

Validated lanes:
- `npm run smoke:webhooks` -> delivered path with retries plus signature header
- `npm run smoke:webhooks:dead` -> dead-letter path at max attempts
- `npm run smoke:webhooks:suite`
- `npm run smoke:webhooks:route-contract` (Batch 10 API route contract parity for webhook CRUD + deliveries query semantics; with token it validates business semantics (seeded data), without token it validates auth-required guards (no seeding))
- `npm run smoke:webhooks:auth:negative` -> missing/invalid bearer token checks across webhook API and ingest routes
- `npm run smoke:webhooks:auth` -> auth-enabled delivered path
- `npm run smoke:webhooks:dead:auth` -> auth-enabled dead-letter path

Runtime guardrails:
- The delivered/dead/disable-after-queue webhook smokes probe `GET /v1/webhook-endpoints` first and fail fast on `404` with a stale-runtime rebuild hint.
- `smoke:webhooks:clear-secret` also preflights `PATCH /v1/webhook-endpoints/:id` and expects `400` for `{}` before verifying `secret: null` behavior.

Artifact persistence:
- Set `WEBHOOK_ARTIFACT_DIR` to retain per-run JSON artifacts.
- Suite default artifact directory: `artifacts/webhooks`
- Poll timing metrics are included in the per-run JSON artifacts for timeout tuning.
- Skip the clear-secret leg if needed: `WEBHOOK_INCLUDE_CLEAR_SECRET=0 npm run smoke:webhooks:suite`

Teardown and data hygiene:
- Default-safe mode is `WEBHOOK_SEEDED_DATA_MODE=keep`. The harness disables the created endpoint on exit, but leaves the seeded workspace/project rows intact for inspection.
- Opt into full teardown with `WEBHOOK_SEEDED_DATA_MODE=teardown`. In that mode the harness deletes the seeded webhook endpoint, project, and workspace tree on exit.
- The seeded webhook runs create one organization per run with a `webhook-org-*` slug and one `webhook-workspace-*` workspace beneath it.
- Optional org cleanup is disabled by default. To allow bounded cascade cleanup for isolated smoke orgs only, set both `ALLOW_SMOKE_ORG_CLEANUP=1` on the API service and `WEBHOOK_DELETE_SMOKE_ORG_ON_EXIT=1` in the smoke environment.
- The safe org cleanup path only applies to a single-workspace `webhook-org-*` tree whose workspace and project slugs also match the webhook smoke prefixes. It will reject shared or non-smoke organizations.
- `WEBHOOK_DISABLE_ENDPOINT_ON_EXIT=0` still opts out of the endpoint-disable fallback when you need to inspect the live endpoint row after a run.

Green closure evidence snippet:

```bash
$ WEBHOOK_ARTIFACT_DIR=artifacts/webhooks WEBHOOK_SEEDED_DATA_MODE=teardown npm run smoke:webhooks:suite
$ WEBHOOK_ARTIFACT_DIR=artifacts/webhooks npm run smoke:webhooks:auth:negative
$ npm run smoke:webhooks:auth
$ npm run smoke:webhooks:dead:auth
```

```json
{
  "ok": true,
  "artifactPath": "artifacts/webhooks/webhook-smoke-suite-2026-03-28T12-00-00-000Z.json",
  "includeClearSecret": true
}
{
  "ok": true,
  "cleanupMode": "teardown",
  "finalDelivery": { "status": "delivered" }
}
{
  "ok": true,
  "cleanupMode": "teardown",
  "finalDelivery": { "status": "dead" }
}
```

Troubleshooting matrix:

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `Webhook API route missing ... (404)` | Stale `api` container/image or wrong `API_BASE_URL` target | `docker compose build --no-cache api ingest worker && docker compose up -d postgres redis api ingest worker` |
| `webhook PATCH contract preflight expected 400 ...` | API runtime does not include the latest webhook patch validation | Rebuild `api`, `ingest`, and `worker`, then rerun `npm run smoke:webhooks:clear-secret` or the suite |
| `401 unauthorized` in auth lanes | Missing or mismatched `API_AUTH_TOKEN` / `INGEST_AUTH_TOKEN` | Export matching bearer tokens for API and ingest before running auth smokes |
| `timeout waiting for webhook delivery terminal state` | Worker not running, stale runtime, or retry window too short | Check `docker compose logs --tail=200 api ingest worker`; increase `WEBHOOK_WAIT_TIMEOUT_MS` only after confirming current images |
| Seeded webhook smoke rows remain after run | Running default-safe mode or org cleanup opt-in is off | Use `WEBHOOK_SEEDED_DATA_MODE=teardown`; add `ALLOW_SMOKE_ORG_CLEANUP=1` plus `WEBHOOK_DELETE_SMOKE_ORG_ON_EXIT=1` only for isolated smoke org cleanup |
