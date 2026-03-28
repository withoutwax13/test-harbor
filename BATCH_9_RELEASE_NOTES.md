# Batch 9 Release Notes

## Scope
- CI stabilization for webhook smokes and artifact upload
- Safe teardown handling for seeded webhook organizations
- Negative-path auth coverage for webhook API and ingest routes
- Shared polling utilities and timing diagnostics for flake resistance

## Commit Placeholders
- `<commit-hash-1>` CI and webhook smoke utility updates
- `<commit-hash-2>` Safe teardown and auth negative-path expansion
- `<commit-hash-3>` Release notes and final wiring

## Commands
```bash
npm run smoke:webhooks:suite
npm run smoke:webhooks:auth:negative
npm run smoke:webhooks:auth
npm run smoke:webhooks:dead:auth
node --check apps/api/src/index.js
node --check scripts/webhook-smoke-helpers.mjs
node --check scripts/smoke-webhooks.mjs
node --check scripts/smoke-webhooks-disable-after-queue.mjs
node --check scripts/smoke-webhooks-clear-secret.mjs
node --check scripts/smoke-webhooks-negative-auth.mjs
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
