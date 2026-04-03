# Replay V2 Phase B

Replay V2 Phase B stores validated `replay.v2.chunk` payloads durably in Postgres during ingest.

## What Is Persisted

- `replay_v2_streams` stores one aggregate row per `(run_id, stream_id)` with schema version, stream timestamps, counters, and terminal-state tracking.
- `replay_v2_chunks` stores each accepted chunk header plus the original validated `payload_json`, keyed by ingest `idempotencyKey`.
- `replay_v2_events` stores one ordered row per replay event sequence with normalized selector bundles, event data, and the owning chunk reference.

## Continuity Semantics

- Replay persistence is transactional and serialized per `(run_id, stream_id)`.
- The next accepted chunk must start at `coalesce(last_seq, 0) + 1`.
- If a chunk starts after the expected sequence, ingest rejects it with `replay_v2_seq_gap_persisted`.
- If a chunk starts before the expected sequence and extends past the persisted tail, ingest rejects it with `replay_v2_seq_overlap_conflict`.

## Duplicate Handling

- If a retried chunk is fully covered by the persisted stream tail (`seqEnd <= last_seq`), ingest treats it as a duplicate replay and leaves the replay tables unchanged.
- If the same ingest `idempotencyKey` already exists in `replay_v2_chunks`, persistence is skipped and the existing outer ingest idempotency envelope remains unchanged.
- Accepted chunks still record the normal ingest idempotency outcome in `ingest_events`.

## Phase C

Phase C still needs replay read models and API/web viewer work on top of these persisted tables.
