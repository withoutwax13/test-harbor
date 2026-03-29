#!/usr/bin/env bash
set -euo pipefail

STACK_SERVICES="postgres redis minio ingest api worker web"
REBUILD_MODE="${TH_CLEAR_DOCKER_CACHE:-0}"

if [[ "${REBUILD_MODE}" == "1" ]]; then
  echo "[1/4] Clearing/rebuilding local stack images for ${STACK_SERVICES}..."
  docker compose build --no-cache --pull ${STACK_SERVICES}
  echo "[2/4] Starting local services (force recreate, remove-orphans)..."
  docker compose up --force-recreate --remove-orphans -d ${STACK_SERVICES}
else
  echo "[1/4] Starting local services..."
  docker compose up -d ${STACK_SERVICES}
fi

echo "[3/4] Applying migrations in containers..."
npm run db:migrate:container

echo "[4/4] Seeding local workspace/project + sample data..."
npm run seed:local

echo "Local stack is active. Services are up, migrations applied, seed loaded."
echo "Run 'npm run smoke:all' for verification if you want a full end-to-end check."
