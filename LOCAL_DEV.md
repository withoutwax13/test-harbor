# Local Dev Quickstart (Windows-safe defaults)

## Ports used
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
1. `docker compose up -d postgres redis minio ingest api`
2. `npm run db:migrate:container`
3. `npm run seed:local`
4. `npm run smoke:all`

## Manual fallback

```bash
docker compose up -d postgres redis minio ingest api
npm run db:migrate:container
npm run seed:local
npm run smoke:all
```

## Troubleshooting
- **Docker daemon unavailable**: start Docker Desktop first.
- **Port conflicts** on 5432/6379: keep the compose remaps (5433/6380).
- **`psql: command not found`**: use `npm run db:migrate:container` (no host psql needed).
- **API unreachable**: `docker compose up -d api && docker compose logs --tail=120 api`.

## Auth (optional)
Set these in `.env` to enforce bearer auth:
- `API_AUTH_TOKEN`
- `INGEST_AUTH_TOKEN`

When set, all `/v1/*` routes require `Authorization: Bearer <token>`.
`/healthz` remains open for liveness checks.

- Full local bootstrap: `npm run smoke:bootstrap`


## Webhook smoke closure

Validated lanes:
- `npm run smoke:webhooks` -> delivered path with retries plus signature header
- `npm run smoke:webhooks:dead` -> dead-letter path at max attempts
- `npm run smoke:webhooks:suite` -> delivered + dead + disable-after-queue + clear-secret, with combined JSON artifact
- `npm run smoke:webhooks:auth` -> auth-enabled delivered path
- `npm run smoke:webhooks:dead:auth` -> auth-enabled dead-letter path

Runtime guardrails:
- The delivered/dead/disable-after-queue webhook smokes probe `GET /v1/webhook-endpoints` first and fail fast on `404` with a stale-runtime rebuild hint.
- `smoke:webhooks:clear-secret` also preflights `PATCH /v1/webhook-endpoints/:id` and expects `400` for `{}` before verifying `secret: null` behavior.

Artifact persistence:
- Set `WEBHOOK_ARTIFACT_DIR` to retain per-run JSON artifacts.
- Suite default artifact directory: `artifacts/webhooks`
- Skip the clear-secret leg if needed: `WEBHOOK_INCLUDE_CLEAR_SECRET=0 npm run smoke:webhooks:suite`

Teardown and data hygiene:
- Default-safe mode is `WEBHOOK_SEEDED_DATA_MODE=keep`. The harness disables the created endpoint on exit, but leaves the seeded workspace/project rows intact for inspection.
- Opt into full teardown with `WEBHOOK_SEEDED_DATA_MODE=teardown`. In that mode the harness deletes the seeded webhook endpoint, project, and workspace tree on exit (organization rows may remain if shared by other workspace slugs).
- `WEBHOOK_DISABLE_ENDPOINT_ON_EXIT=0` still opts out of the endpoint-disable fallback when you need to inspect the live endpoint row after a run.

Green closure evidence snippet:

```bash
$ WEBHOOK_ARTIFACT_DIR=artifacts/webhooks WEBHOOK_SEEDED_DATA_MODE=teardown npm run smoke:webhooks:suite
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
| Seeded webhook smoke rows remain after run | Running default-safe mode | Use `WEBHOOK_SEEDED_DATA_MODE=teardown` when you want the seeded workspace/project tree removed automatically |
