#!/usr/bin/env bash
set -euo pipefail
psql "${DATABASE_URL}" -f infra/db/migrations/001_init.sql
psql "${DATABASE_URL}" -f infra/db/migrations/002_core_extensions.sql
