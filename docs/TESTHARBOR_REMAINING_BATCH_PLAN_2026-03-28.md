# TestHarbor Remaining Batch Plan (2026-03-28)

## Lane A scope

Batches 19-26 are being shipped as a pragmatic productization pass centered on the real user journey:

1. Auth and session pages in the web shell using the existing local auth API.
2. Onboarding wizard to create or select a workspace and project.
3. Connect and health page with API, ingest, and worker visibility plus a notification test action.
4. Browser-usable run list and run detail pages.
5. Artifact viewer basics using signed download metadata.
6. Admin and webhook basics for endpoint management, deliveries, audit, and retention.
7. Docs updates for the operator flow, including Cypress connect smoke references.

## True user flow

1. Start local services with `docker compose up -d postgres redis minio ingest api worker web`.
2. Open `http://localhost:3000/login` and sign in with a local dev email and name.
3. Complete onboarding:
   - create an organization and workspace
   - create a project in that workspace
   - copy the connect snippet
4. Send the first ingest event, then use `/app/connect` to verify health.
5. Open `/app/runs` and `/app/runs/:id` for run triage.
6. Open `/app/artifacts/:id` for artifact viewer basics.
7. Use `/app/admin` for webhook endpoint setup, delivery review, and retention actions.

## Cypress connect path

The browser productization work also establishes a Cypress connect story:

- use the onboarding connect snippet to seed a workspace and project for Cypress
- point Cypress CI at the ingest endpoint shown in the snippet
- publish metadata and artifacts through the shared ingest and artifact APIs
- verify the browser shell with `npm run smoke:web-shell`
