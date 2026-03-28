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


## Webhook smoke evidence (Batch6B/6C)

Validated runtime paths:
- `npm run smoke:webhooks` → delivered path with retries + signature header
- `npm run smoke:webhooks:dead` → dead-letter path at max attempts

Useful commands:
- `npm run smoke:webhooks:suite` (runs delivered + dead + clear-secret checks and writes combined JSON artifact)
- `npm run smoke:webhooks:auth` (requires `API_AUTH_TOKEN` + `INGEST_AUTH_TOKEN`)
- `npm run smoke:webhooks:dead:auth` (requires `API_AUTH_TOKEN` + `INGEST_AUTH_TOKEN`)

Artifact persistence:
- Set `WEBHOOK_ARTIFACT_DIR` (default for suite: `artifacts/webhooks`)
- Harness now writes per-run artifact when `WEBHOOK_ARTIFACT_DIR` is set

Teardown hygiene:
- Harness disables the created webhook endpoint on exit (`WEBHOOK_DISABLE_ENDPOINT_ON_EXIT=0` to opt out).

## Batch 6 wrap-up status (2026-03-28)

Batch 6 webhook reliability validation is complete.

Verified green lanes:
- `npm run smoke:webhooks` (delivered path with retries)
- `npm run smoke:webhooks:dead` (dead-letter path at max attempts)
- `npm run smoke:webhooks:auth` (auth-enabled delivered path)
- `npm run smoke:webhooks:dead:auth` (auth-enabled dead-letter path)

Evidence:
- Combined suite artifact generated via `npm run smoke:webhooks:suite`
- Example artifact path: `artifacts/webhooks/webhook-smoke-suite-*.json`

Decision:
- Batch 6 (B/6C scope) is closed for runtime verification.
- Proceed to Batch 7 planning/implementation.

## Batch 7 kickoff checks

Webhook endpoint patch semantics hardening:
- `npm run smoke:webhooks:clear-secret`
  - verifies signature exists before `PATCH secret:null`
  - verifies signature is absent after secret is cleared


- To skip clear-secret in suite: `WEBHOOK_INCLUDE_CLEAR_SECRET=0 npm run smoke:webhooks:suite`
