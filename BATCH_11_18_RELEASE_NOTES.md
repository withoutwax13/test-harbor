# Batch 11-18 Release Notes

## Scope

This pass closes the docs backlog batches 11 through 18 against the current local-first codebase.

## Batch 11

- Added `POST /v1/auth/login` for local/dev bearer tokens.
- Added `GET /v1/me`.
- Enforced workspace membership and minimal role-aware guards (`owner`, `admin`, `member`, `viewer`) behind `LOCAL_AUTH_REQUIRED` and `REQUIRE_WORKSPACE_AUTH`.
- Added `POST /v1/workspaces/:id/members`.

## Batch 12

- Added artifact signing persistence via `artifact_access_tokens`.
- Added `POST /v1/artifacts/sign-upload`.
- Added `GET /v1/artifacts/:id/sign-download`.
- Added signed proxy validation endpoints for local upload/download acknowledgement.
- Added storage adapter env surface for MinIO/S3 portability.

## Batch 13

- Aligned run explorer reads with consistent pagination/filter semantics:
  - `GET /v1/runs`
  - `GET /v1/runs/:runId/specs`
  - `GET /v1/spec-runs/:id/tests`
  - `GET /v1/tests/:testCaseId/history`

## Batch 14

- Added deterministic analytics endpoints:
  - `GET /v1/analytics/flaky`
  - `GET /v1/analytics/failures/clusters`
- Persisted computed values into `flake_scores` and `failure_clusters`.

## Batch 15

- Added orchestrator endpoints:
  - `POST /v1/orchestrator/plan`
  - `GET /v1/orchestrator/runs/:runId/shards`
  - `POST /v1/orchestrator/retry-failures/:runId`
- Planning uses timing history first and deterministic seeded fallbacks when history is missing.

## Batch 16

- Added notification formatter endpoints:
  - `POST /v1/notifications/format`
  - `POST /v1/notifications/pr-feedback`
  - enhanced `POST /v1/notifications/test`
- Added webhook route aliases under `/v1/webhooks`.
- Added webhook/mock smoke coverage for formatter and fanout paths.

## Batch 17

- Added retention purge worker loop.
- Added manual retention trigger endpoint: `POST /v1/retention/run`.
- Added `GET /v1/audit-logs`.
- Added audit logging for destructive workspace/project/webhook operations and retention purges.

## Batch 18

- Added env toggles for auth hardening and storage portability.
- Documented MinIO/S3 adapter surface in `LOCAL_DEV.md`.
- Added smoke scripts for the new auth/explorer and notifications/retention lanes.
- Added light CI wiring for syntax checks and new smoke lanes.

## Verification lanes

- `node --check` on modified JS files
- workspace tests via `npm test`
- existing smoke lanes
- new smoke lanes:
  - `npm run smoke:auth-explorer`
  - `npm run smoke:notifications-retention`
