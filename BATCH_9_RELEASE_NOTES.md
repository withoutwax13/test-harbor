# Batch 9 Release Notes

## Scope
- CI stabilization for webhook smokes and artifact upload
- Safe teardown handling for seeded webhook organizations
- Negative-path auth coverage for webhook API and ingest routes
- Shared polling utilities and timing diagnostics for flake resistance

## Commits
- `55bd282` Improve webhook smoke polling diagnostics (B9 utility hardening and suite outputs)
- `a4f9130` Add safe webhook smoke cleanup and auth checks (B9 hygiene + auth-negative)
- `be70c3c` Add Batch 9 release notes
- `0e26dfd` Fix smoke helper auth reference and intermediary release notes
- `9b6c1f3` Finalize Batch 9 notes and auth-negative preflight

## Commands
```bash
npm run smoke:webhooks:suite
npm run smoke:webhooks:auth:negative
npm run smoke:webhooks:auth
npm run smoke:webhooks:dead:auth
node --check apps/api/src/index.js
node --check scripts/webhook-smoke-helpers.mjs
node --check scripts/smoke-webhooks.mjs
node --check scripts/smoke-webhooks-negative-auth.mjs
node --check scripts/smoke-webhooks-disable-after-queue.mjs
node --check scripts/smoke-webhooks-clear-secret.mjs
```

## Evidence Artifacts
- GitHub Actions upload artifact: `webhook-smoke-artifacts`
- Local/CI directory: `artifacts/webhooks`
- Combined suite artifact pattern: `artifacts/webhooks/webhook-smoke-suite-*.json`
- Negative auth artifact pattern: `artifacts/webhooks/webhook-auth-negative-*.json`

## Known Limits
- Safe org cleanup is opt-in and only applies to isolated `webhook-org-*` trees with bounded smoke slug patterns.
- Auth-negative checks cover bearer enforcement on webhook-related API routes plus ingest submission; they do not validate every non-webhook API route.
- Poll timing metrics are diagnostic-only and intended for later timeout tuning, not pass/fail thresholds.


## Runtime proof captured
The following were observed on local runtime during Batch 9 execution:
- `smoke:webhooks` lane passed (delivered/dead)
- `smoke:webhooks:clear-secret` passed after clean rebuild
- `smoke:webhooks:disable-after-queue` passed
- `smoke:webhooks:auth` passed with configured tokens
- `smoke:webhooks:dead:auth` passed with configured tokens

Artifacts:
- `webhook-smoke-suite-<timestamp>.json`
- `webhook-smoke-clear-secret-<timestamp>.json` (if enabled)
- `webhook-smoke-disable-after-queue-<timestamp>.json` (if enabled)
