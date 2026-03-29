# test-harbor

TestHarbor is a local-first test telemetry stack with API, ingest, worker, and browser surfaces.

## Productized operator flow

1. Start the stack with `docker compose up -d postgres redis minio ingest api worker web`.
2. Apply migrations with `npm run db:migrate:container`.
3. Seed a baseline workspace and project with `npm run seed:local` or create your own from the browser.
4. Open `http://localhost:3000/login`.
5. Use `/app/onboarding` to create/select workspace + project.
6. Mint a **project ingest token** from onboarding/connect and copy it immediately (raw token is shown once).
7. Use the Cypress-first snippet to emit `run.started` and verify ingestion.
8. Use `/app/connect` for API/ingest/worker status and notification test events.
9. Use `/app/team`, `/app/runs`, `/app/runs/:id`, `/app/tests/:id/history`, `/app/artifacts/:id`, and `/app/admin` for day-to-day operation.

## Project ingest token lifecycle

- API routes: `GET|POST /v1/projects/:id/ingest-tokens`, `PATCH /v1/projects/:id/ingest-tokens/:tokenId`, `POST /v1/projects/:id/ingest-tokens/:tokenId/revoke`
- Stored fields are hash + hint only (`token_hash`, `token_hint`); plaintext token is only returned on create.
- Ingest auth accepts either:
  - global `INGEST_AUTH_TOKEN`
  - active project token scoped to the run/project context.

## Parity evidence pack

Generate parity artifacts and static verifier output:

```bash
npm run parity:pack
```

Optional HTML capture for key shell pages:

```bash
PARITY_CAPTURE_BASE_URL=http://localhost:3000 \
PARITY_CAPTURE_COOKIE='th_session=...' \
npm run parity:pack
```

Artifacts are written to `artifacts/parity/` (manifest + static verify log + optional HTML captures).

## Smoke coverage

- `npm run smoke:all` for API and ingest basics
- `npm run smoke:auth-explorer` for auth, artifacts, analytics, and explorer routes
- `npm run smoke:web-shell` for the browser shell flow
- `npm run smoke:webhooks:suite` for webhook delivery behavior
