#!/usr/bin/env bash
set -euo pipefail

DB_USER=${POSTGRES_USER:-testharbor}
DB_NAME=${POSTGRES_DB:-testharbor}

for file in \
  infra/db/migrations/001_init.sql \
  infra/db/migrations/002_core_extensions.sql \
  infra/db/migrations/003_ingest_idempotency.sql \
  infra/db/migrations/004_webhook_deliveries.sql

do
  echo "Applying $file ..."
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$file"
done

echo "Migrations applied in postgres container."
