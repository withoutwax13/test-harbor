#!/usr/bin/env bash
set -euo pipefail

bash scripts/activate-local.sh

printf '%s\n' "[4/4] Running end-to-end smoke..."
npm run smoke:all

printf '%s\n' "Done. Local smoke-all passed."
