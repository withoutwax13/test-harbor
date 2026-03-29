# TestHarbor Cypress-Cloud Parity Closure Checklist (2026-03-29)

Run from repo root: `/tmp/testharbor-gapfix`

## Strict scoring rules

- **PASS** only if the proof command exits `0` **and** output matches **all** required patterns.
- Any missing required pattern, non-zero exit, or missing artifact = **FAIL**.
- No partial credit.

---

## 1) Project ingest token lifecycle (API + ingest + UI)

### Check PT-API-01 — Project token lifecycle endpoints exist
**Proof command**
```bash
bash -lc 'set -euo pipefail; \
  rg -n "app\\.get\\('/v1/projects/:(id|projectId)/ingest-tokens" apps/api/src/index.js; \
  rg -n "app\\.post\\('/v1/projects/:(id|projectId)/ingest-tokens" apps/api/src/index.js; \
  rg -n "app\\.delete\\('/v1/projects/:(id|projectId)/ingest-tokens/:tokenId" apps/api/src/index.js'
```
**Required PASS output patterns**
- `app.get('/v1/projects/:id/ingest-tokens` **or** `:projectId`
- `app.post('/v1/projects/:id/ingest-tokens` **or** `:projectId`
- `app.delete('/v1/projects/:id/ingest-tokens/:tokenId` **or** `:projectId`

### Check PT-INGEST-01 — Ingest validates project-scoped token lifecycle
**Proof command**
```bash
bash -lc 'set -euo pipefail; \
  rg -n "project_ingest_tokens|verifyProjectIngestToken|ingest token.*project|project_id" apps/ingest/src/index.js'
```
**Required PASS output patterns**
- At least one match indicating project-token verification logic (not only global token gate)
- Reference to project-scoped token storage/lookup (e.g., `project_ingest_tokens`)

### Check PT-UI-01 — UI exposes token create/rotate/revoke and no placeholder token UX
**Proof command**
```bash
bash -lc 'set -euo pipefail; \
  rg -n "Create token|Rotate token|Revoke token|Copy token|/v1/projects/.*/ingest-tokens" apps/web/src/server.js; \
  ! rg -n "INGEST_AUTH_TOKEN=\"replace-me\"" apps/web/src/server.js'
```
**Required PASS output patterns**
- Token lifecycle verbs visible in UI (`Create|Rotate|Revoke|Copy`)
- UI API call(s) referencing `/v1/projects/.../ingest-tokens`
- **No** `INGEST_AUTH_TOKEN="replace-me"` literal

---

## 2) Onboarding/connect stepper and token UX

### Check ONB-STEP-01 — Onboarding + connect stepper flow exists
**Proof command**
```bash
bash -lc 'set -euo pipefail; \
  rg -n "app\\.get\\('/app/onboarding'|app\\.get\\('/app/connect'" apps/web/src/server.js; \
  rg -n "Step 1|Step 2|Step 3|create .*workspace|create .*project|connect snippet|token" apps/web/src/server.js'
```
**Required PASS output patterns**
- Route handlers for `/app/onboarding` and `/app/connect`
- Stepper/onboarding guidance strings including workspace/project and token guidance

### Check ONB-RUNTIME-01 — Runtime onboarding and connect probes produce artifacts
**Proof commands**
```bash
TH_ONBOARDING_URL=http://localhost:3000/app/onboarding \
TH_ONBOARDING_EXPECT_TEXT='connect snippet' \
npm run verify:batch19-26:onboarding

TH_CYPRESS_CONNECT_URL=http://localhost:3000/app/connect \
TH_CYPRESS_EXPECT_TEXT='Create token' \
npm run verify:batch19-26:cypress
```
**Required PASS output patterns**
- Both commands print JSON containing `"ok": true`
- Artifact paths:
  - `artifacts/verifier/batch19-26-onboarding-*.json`
  - `artifacts/verifier/batch19-26-cypress-connect-*.json`

---

## 3) Team/member management (API + UI)

### Check TEAM-API-01 — Member management API is lifecycle-complete
**Proof command**
```bash
bash -lc 'set -euo pipefail; \
  rg -n "app\\.get\\('/v1/workspaces/:id/members" apps/api/src/index.js; \
  rg -n "app\\.post\\('/v1/workspaces/:id/members" apps/api/src/index.js; \
  rg -n "app\\.patch\\('/v1/workspaces/:id/members/:memberId" apps/api/src/index.js; \
  rg -n "app\\.delete\\('/v1/workspaces/:id/members/:memberId" apps/api/src/index.js'
```
**Required PASS output patterns**
- GET, POST, PATCH, DELETE member routes all present

### Check TEAM-UI-01 — Team management UI route + actions exist
**Proof command**
```bash
bash -lc 'set -euo pipefail; \
  rg -n "app\\.get\\('/app/(team|members)'" apps/web/src/server.js; \
  rg -n "Invite member|Remove member|Change role|owner|admin|member|viewer" apps/web/src/server.js; \
  rg -n "/v1/workspaces/.*/members" apps/web/src/server.js'
```
**Required PASS output patterns**
- Team page route exists (`/app/team` or `/app/members`)
- UI contains invite/remove/change-role actions
- UI calls workspace members API

---

## 4) Run triage + test history

### Check TRIAGE-API-01 — Run/spec/test history API lanes are present
**Proof command**
```bash
bash -lc 'set -euo pipefail; \
  rg -n "app\\.get\\('/v1/runs'" apps/api/src/index.js; \
  rg -n "app\\.get\\('/v1/runs/:id'" apps/api/src/index.js; \
  rg -n "app\\.get\\('/v1/runs/:runId/specs'" apps/api/src/index.js; \
  rg -n "app\\.get\\('/v1/spec-runs/:id/tests'" apps/api/src/index.js; \
  rg -n "app\\.get\\('/v1/tests/:testCaseId/history'" apps/api/src/index.js'
```
**Required PASS output patterns**
- All five API routes are present

### Check TRIAGE-RUNTIME-01 — Browser triage runtime smoke passes
**Proof command**
```bash
npm run smoke:web-shell
```
**Required PASS output patterns**
- JSON includes `"ok": true`
- JSON includes checked pages for run triage (`/app/runs` and `/app/runs/<id>`)

---

## 5) Admin webhook UX safety

### Check WEBHOOK-RUNTIME-01 — Webhook suite passes and emits artifact
**Proof command**
```bash
npm run smoke:webhooks:suite
```
**Required PASS output patterns**
- JSON includes `"ok": true`
- `artifactPath` matches `artifacts/webhooks/webhook-smoke-suite-*.json`

### Check WEBHOOK-AUTH-01 — Negative auth safety enforced
**Proof command**
```bash
API_AUTH_TOKEN=local-api-token \
INGEST_AUTH_TOKEN=local-ingest-token \
npm run smoke:webhooks:auth:negative
```
**Required PASS output patterns**
- JSON includes `"ok": true`
- Result set contains missing/invalid auth rejection statuses (`401`)

### Check WEBHOOK-UI-01 — Admin UI exposes safe controls
**Proof command**
```bash
bash -lc 'set -euo pipefail; \
  rg -n "app\\.get\\('/app/admin'" apps/web/src/server.js; \
  rg -n "Clear secret|Disable|Retention|Audit|Deliveries|webhook" apps/web/src/server.js'
```
**Required PASS output patterns**
- Admin page route exists
- UI text shows safety/operability controls (clear secret, disable, retention, audit, deliveries)

---

## 6) Parity evidence pack + docs updates

### Check EVIDENCE-01 — Evidence pack is complete
**Proof command**
```bash
bash -lc 'set -euo pipefail; \
  ls -1 artifacts/verifier/batch19-26-static-*.json | tail -n1; \
  ls -1 artifacts/verifier/batch19-26-onboarding-*.json | tail -n1; \
  ls -1 artifacts/verifier/batch19-26-cypress-connect-*.json | tail -n1; \
  ls -1 artifacts/webhooks/webhook-smoke-suite-*.json | tail -n1'
```
**Required PASS output patterns**
- All four artifact classes resolve to files

### Check DOCS-01 — Operator docs include parity closures
**Proof command**
```bash
bash -lc 'set -euo pipefail; \
  rg -n "project ingest token|/v1/projects/:id/ingest-tokens|/app/team|/app/members|verify:batch19-26:onboarding|verify:batch19-26:cypress|smoke:web-shell|smoke:webhooks:suite" README.md LOCAL_DEV.md docs/TESTHARBOR_REMAINING_BATCH_PLAN_2026-03-28.md'
```
**Required PASS output patterns**
- Docs mention token lifecycle API
- Docs mention team/member UI route(s)
- Docs include verifier/smoke commands used for closure

---

## Final gate

Mark parity as **CLOSED** only if **all checks above PASS** with archived command output and artifact paths.
