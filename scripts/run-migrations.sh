#!/usr/bin/env bash
set -euo pipefail
psql "${DATABASE_URL}" -f infra/db/migrations/001_init.sql
