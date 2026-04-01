import { spawnSync } from "node:child_process";

const dbUser = process.env.POSTGRES_USER || "testharbor";
const dbName = process.env.POSTGRES_DB || "testharbor";

const files = [
  "infra/db/migrations/001_init.sql",
  "infra/db/migrations/002_core_extensions.sql",
  "infra/db/migrations/003_ingest_idempotency.sql",
  "infra/db/migrations/004_webhook_deliveries.sql",
  "infra/db/migrations/005_batches_11_18.sql",
  "infra/db/migrations/006_batches_19_26.sql",
  "infra/db/migrations/007_project_ingest_tokens.sql",
  "infra/db/migrations/008_artifact_blobs_replay.sql",
  "infra/db/migrations/009_replay_event_ordering.sql",
  "infra/db/migrations/010_replay_chunk_telemetry.sql"
];

for (const file of files) {
  console.log(`Applying ${file} ...`);
  const cmd = `docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U ${dbUser} -d ${dbName} < ${file}`;
  const r = spawnSync(cmd, { stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("Migrations applied in postgres container.");
