# Local Dev Quickstart (Windows-safe defaults)

## Ports used
- API: `4000`
- Ingest: `4010`
- Postgres: `5433 -> 5432` (container)
- Redis: `6380 -> 6379` (container)
- MinIO: `9000`, console `9001`

## One-command validation

```bash
./scripts/smoke-all.sh
```

This runs:
1. `docker compose up -d postgres redis minio ingest api`
2. `npm run db:migrate:container`
3. `npm run seed:local`
4. `npm run smoke:all`

## Manual fallback

```bash
docker compose up -d postgres redis minio ingest api
npm run db:migrate:container
npm run seed:local
npm run smoke:all
```

## Troubleshooting
- **Docker daemon unavailable**: start Docker Desktop first.
- **Port conflicts** on 5432/6379: keep the compose remaps (5433/6380).
- **`psql: command not found`**: use `npm run db:migrate:container` (no host psql needed).
- **API unreachable**: `docker compose up -d api && docker compose logs --tail=120 api`.
