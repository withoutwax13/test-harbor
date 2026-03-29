#!/usr/bin/env bash
set -euo pipefail

echo "[1/4] Starting local infra + services..."
docker compose up -d postgres redis minio ingest api worker web

echo "[2/4] Applying migrations in container..."
npm run db:migrate:container

echo "[3/4] Seeding workspace/project..."
npm run seed:local

echo "[4/4] Running end-to-end smoke..."
npm run smoke:all

echo "Done. Local smoke-all passed."
