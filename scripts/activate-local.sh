#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "[1/3] Starting core TestHarbor services..."
docker compose up -d postgres redis minio ingest api worker web

printf '%s\n' "[2/3] Applying migrations in containers..."
npm run db:migrate:container

printf '%s\n' "[3/3] Seeding local workspace/project + sample data..."
npm run seed:local

printf '%s\n' "Local stack is active. Services are up, migrations applied, seed loaded."
printf '%s\n' "Run 'npm run smoke:all' for verification if you want a full end-to-end check."
