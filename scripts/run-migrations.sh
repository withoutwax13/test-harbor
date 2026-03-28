#!/usr/bin/env bash
set -euo pipefail
psql "${DATABASE_URL}" -f infra/db/migrations/001_init.sql
psql "${DATABASE_URL}" -f infra/db/migrations/002_core_extensions.sql
psql "${DATABASE_URL}" -f infra/db/migrations/003_ingest_idempotency.sql
psql "${DATABASE_URL}" -f infra/db/migrations/004_webhook_deliveries.sql
psql "${DATABASE_URL}" -f infra/db/migrations/005_batches_11_18.sql
