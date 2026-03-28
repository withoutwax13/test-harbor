# test-harbor

TestHarbor is a local-first test telemetry stack with API, ingest, worker, and browser surfaces.

## Productized operator flow

1. Start the stack with `docker compose up -d postgres redis minio ingest api worker web`.
2. Apply migrations with `npm run db:migrate:container`.
3. Seed a baseline workspace and project with `npm run seed:local` or create your own from the browser.
4. Open `http://localhost:3000/login`.
5. Use the onboarding flow to create or select a workspace and project, then copy the connect snippet.
6. Use `/app/connect` for API, ingest, and worker status plus a notification test.
7. Use `/app/runs`, `/app/runs/:id`, `/app/artifacts/:id`, and `/app/admin` for day-to-day operation.

## Smoke coverage

- `npm run smoke:all` for API and ingest basics
- `npm run smoke:auth-explorer` for auth, artifacts, analytics, and explorer routes
- `npm run smoke:web-shell` for the browser shell flow
- `npm run smoke:webhooks:suite` for webhook delivery behavior
