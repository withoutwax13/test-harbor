# TestHarbor Batch 19-26 Verifier

Authoring date: 2026-03-28

## Scope note

The requested source plan file, `docs/TESTHARBOR_REMAINING_BATCH_PLAN_2026-03-28.md`, is not present in this checkout or git history at authoring time. These verifier criteria are therefore derived from:

- the user request for Batches 19-26 productization verification
- current repo state as of branch `feat/batch19-26-productization-20260328`
- existing local-dev and smoke coverage through Batches 11-18

Before any Batch 19-26 lane is marked accepted, Lane A must reconcile these criteria against the missing plan document and either:

1. restore the source plan file unchanged, or
2. update this verifier doc with an explicit diff between the restored plan and the inferred gates below

## Acceptance criteria

Batch 19. Plan traceability and repo contract
- `docs/TESTHARBOR_REMAINING_BATCH_PLAN_2026-03-28.md` SHALL exist in-repo.
- Each Batch 19-26 deliverable SHALL map to concrete repo artifacts: code path, docs path, verification command, and expected evidence.
- A verifier run SHALL fail if the plan file is absent.

Batch 20. No-curl onboarding path
- A first-time local user SHALL be able to reach the onboarding flow without using `curl`.
- The onboarding path SHALL be documented as a command sequence using repo-native tooling (`npm`, `node`, `docker compose`) and/or browser navigation only.
- The onboarding surface SHALL return HTTP 200 from a stable local URL and SHALL include product guidance text that explains the next step for connecting a test framework.
- Evidence required once landed: local command transcript, HTTP probe artifact, and one screenshot or equivalent rendered HTML capture of the onboarding page.

Batch 21. Onboarding completion semantics
- The onboarding path SHALL capture or generate enough project/workspace context to continue into connect/setup without manual database edits.
- Any required auth or token handoff SHALL be documented and reproducible locally.
- Failure states SHALL be actionable: missing config, auth failure, missing workspace/project, and service-unavailable cases must produce deterministic messages.
- Evidence required once landed: happy-path transcript plus at least one negative-path transcript.

Batch 22. Cypress connect path
- A stable Cypress connect surface SHALL exist and be reachable without `curl`.
- The connect path SHALL document package/install/setup steps for `@testharbor/cypress-reporter` or its replacement.
- The connect path SHALL expose a machine-checkable endpoint or UI contract that can be probed by the verifier harness.
- Evidence required once landed: HTTP probe artifact for the connect surface and the exact setup command sequence.

Batch 23. Cypress end-to-end ingestion proof
- A sample Cypress run using the documented connect path SHALL produce visible TestHarbor data for a seeded workspace/project.
- The proof SHALL include at least one spec and one test case visible through existing API surfaces.
- The proof SHALL not require direct database writes outside existing migration/seed flows.
- Evidence required once landed: Cypress run transcript, API evidence for run/spec/test visibility, and artifact paths if generated.

Batch 24. Productization hardening
- Batch 19-23 flows SHALL work with the current local auth model when `LOCAL_AUTH_REQUIRED=1` and `REQUIRE_WORKSPACE_AUTH=1`.
- Missing or invalid auth for onboarding/connect flows SHALL fail cleanly and deterministically.
- The verifier harness SHALL include exact commands for both happy-path and auth-negative probes.
- Evidence required once landed: auth-enabled probe transcripts.

Batch 25. Operator repeatability
- All new setup and verification steps SHALL be executable from a clean local checkout using documented commands only.
- Commands SHALL avoid `curl` for onboarding/connect acceptance.
- New docs SHALL identify required environment variables, ports, and service dependencies.
- Evidence required once landed: clean-run command transcript from `docker compose up` through verifier completion.

Batch 26. Release sign-off package
- Release notes or equivalent SHALL summarize user-visible changes, known limitations, and the verification command set.
- The verifier output SHALL enumerate pass/fail/pending checks and artifact paths.
- A final acceptance pass SHALL include the exact commit SHA tested.

## Executable verification checklist

Run static verifier now:

```bash
npm run verify:batch19-26:static
```

Bring local stack up for future runtime verification:

```bash
docker compose up -d postgres redis minio ingest api worker web
npm run db:migrate:container
npm run seed:local
```

Validate the no-curl onboarding path once Lane A lands it:

```bash
TH_ONBOARDING_URL=http://localhost:3000/<onboarding-path> \
TH_ONBOARDING_EXPECT_TEXT='<expected-onboarding-text>' \
npm run verify:batch19-26:onboarding
```

Validate the Cypress connect path once Lane A lands it:

```bash
TH_CYPRESS_CONNECT_URL=http://localhost:4000/<connect-path> \
TH_CYPRESS_EXPECT_TEXT='<expected-connect-text-or-json-key>' \
npm run verify:batch19-26:cypress
```

Optional auth-enabled onboarding probe:

```bash
export LOCAL_AUTH_REQUIRED=1
export REQUIRE_WORKSPACE_AUTH=1
export API_AUTH_TOKEN=local-api-token
export INGEST_AUTH_TOKEN=local-ingest-token

TH_ONBOARDING_URL=http://localhost:3000/<onboarding-path> \
TH_ONBOARDING_EXPECT_TEXT='<expected-onboarding-text>' \
TH_AUTH_TOKEN=local-api-token \
npm run verify:batch19-26:onboarding
```

Optional auth-enabled Cypress connect probe:

```bash
export LOCAL_AUTH_REQUIRED=1
export REQUIRE_WORKSPACE_AUTH=1
export API_AUTH_TOKEN=local-api-token
export INGEST_AUTH_TOKEN=local-ingest-token

TH_CYPRESS_CONNECT_URL=http://localhost:4000/<connect-path> \
TH_CYPRESS_EXPECT_TEXT='<expected-connect-text-or-json-key>' \
TH_AUTH_TOKEN=local-api-token \
npm run verify:batch19-26:cypress
```

## Evidence to collect once features land

- Static verifier JSON artifact from `artifacts/verifier/`
- Onboarding HTTP probe JSON artifact from `artifacts/verifier/`
- Cypress connect HTTP probe JSON artifact from `artifacts/verifier/`
- Full command transcript from stack bootstrap through verification
- Screenshot or rendered-page capture of onboarding
- Exact commit SHA under test
- Any negative-path transcript required by Batch 21 and Batch 24

## Current repo-state findings

- The source plan file is missing.
- Current web surface is bootstrap-only in `apps/web/src/server.js`.
- Current repo contains no explicit onboarding artifact.
- Current repo contains no explicit Cypress connect route or document.
- Current repo does contain `@testharbor/cypress-reporter`, existing ingest smoke coverage, and local bootstrap docs through Batch 11-18.
