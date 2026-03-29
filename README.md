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

Token issue (admin/member with workspace access):

```bash
curl -X POST "http://localhost:4000/v1/projects/<projectId>/ingest-tokens" \
  -H "Authorization: Bearer <api-token>" \
  -H "Content-Type: application/json" \
  -d '{"label":"cypress-ci","ttlDays":90}'
```

Use returned token as `TESTHARBOR_INGEST_TOKEN` in Cypress reporter configuration.

## Parity evidence pack

Generate parity artifacts and static verifier output:

```bash
npm run parity:pack
```

Optional HTML capture for key shell pages:

```bash
TH_PARITY_WEB_BASE_URL=http://localhost:3000 \
TH_AUTH_TOKEN='<session-token-from-/v1/auth/login>' \
npm run parity:pack
```

Artifacts are written to `artifacts/parity/` (manifest + static verify log + optional HTML captures).

## Smoke coverage

- `npm run smoke:all` for API and ingest basics
- `npm run smoke:auth-explorer` for auth, artifacts, analytics, and explorer routes
- `npm run smoke:web-shell` for the browser shell flow
- `npm run smoke:webhooks:suite` for webhook delivery behavior

## Quick activation (one command)

Run this single command to bring up TestHarbor locally, run migrations, and seed baseline data:

```bash
npm run activate:local
```

This is the recommended "get to green" path when you just want local parity-ready services running.
If you want a full smoke validation immediately after activation, run:

```bash
npm run smoke:all
```

To force a clean docker cache rebuild on startup/restart (useful if the UI appears stale after code changes), use:

```bash
npm run activate:local:clean
```

Shell-specific alternatives:

```bash
# bash/zsh
TH_CLEAR_DOCKER_CACHE=1 npm run activate:local

# PowerShell
$env:TH_CLEAR_DOCKER_CACHE='1'; npm run activate:local

# cmd.exe
set TH_CLEAR_DOCKER_CACHE=1&& npm run activate:local
```

## Replay hooks (support file)

To capture richer DOM/network/console events in replay, add a small support-side hook file and call `cy.task('testharbor:replay', ...)`.

`cypress/support/e2e.{js,ts}`

```js
Cypress.on('command:end', (command) => {
  if (!command?.name) return;
  cy.task('testharbor:replay', {
    type: 'replay.command',
    title: command.name,
    payload: {
      state: command.state,
      message: command.message,
    },
  });
});

Cypress.on('fail', (error) => {
  cy.task('testharbor:replay', {
    type: 'replay.fail',
    title: 'Test failed',
    detail: String(error?.message || error)
  });
  throw error;
});
```

If you do not enable this support-side instrumentation, replay events will be limited.

## Cypress config UX (projectId-first)

Use the reporter helper with **only** projectId in your Cypress config.
Token and ingest URL stay in env and are pulled automatically.

```js
const { withTestHarborCypress } = require("@testharbor/cypress-reporter");

module.exports = defineConfig({
  e2e: {
    setupNodeEvents: withTestHarborCypress({
      projectId: process.env.TESTHARBOR_PROJECT_ID, // required: paste this in config
    }),
  },
});
```

Recommended env for runtime:

```bash
export TESTHARBOR_INGEST_URL="http://localhost:4010/v1/ingest/events"
export TESTHARBOR_INGEST_TOKEN="<project-ingest-token>"
```

If your project uses non-local branch/commit details, pass them directly:

```js
withTestHarborCypress({
  projectId: 'your-testharbor-project-id',
  branch: 'main',
  commitSha: process.env.GIT_COMMIT,
  runId: process.env.CI_RUN_ID,
})
```
