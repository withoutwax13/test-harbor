# Replay V2 Phase C

Replay V2 Phase C adds the first read model and browser viewer on top of the persisted tables from migration `008_replay_v2_storage.sql`.

## API Endpoints

### `GET /v1/runs/:id/replay-v2/streams`

Viewer-guarded through run-based workspace resolution.

Response shape:

```json
{
  "items": [
    {
      "stream_id": "default",
      "schema_version": "2.0",
      "started_at": "2026-04-03T12:00:00.000Z",
      "first_seq": 1,
      "last_seq": 42,
      "chunk_count": 3,
      "event_count": 42,
      "final_received": true,
      "updated_at": "2026-04-03T12:00:04.000Z"
    }
  ],
  "pageInfo": {
    "page": 1,
    "limit": 1,
    "total": 1,
    "totalPages": 1
  }
}
```

### `GET /v1/runs/:id/replay-v2/events`

Viewer-guarded through run-based workspace resolution.

Query params:

- `streamId` required
- `fromSeq` optional
- `toSeq` optional
- `limit` optional, default `300`, max `1000`

Response shape:

```json
{
  "items": [
    {
      "seq": 1,
      "kind": "session.start",
      "ts": "2026-04-03T12:00:00.000Z",
      "monotonic_ms": 0,
      "target_id": null,
      "selector_bundle": null,
      "data_json": {
        "url": "https://example.test"
      },
      "chunk_id": "9b4b0b0d-8d8b-40e5-8d95-5ab5f1d0b5e1",
      "chunk_index": 0,
      "final": false
    }
  ],
  "pageInfo": {
    "page": 1,
    "limit": 300,
    "total": 42,
    "totalPages": 1,
    "streamId": "default",
    "fromSeq": null,
    "toSeq": null
  }
}
```

## Web Viewer

Route: `GET /app/runs/:id/replay-v2`

Behavior:

- fetches replay stream summaries for the run
- selects `?streamId=` when provided, otherwise defaults to the first stream
- fetches ordered events for the selected stream
- renders empty states when the run has no replay streams or the selected stream has no events

The existing run detail page now links to the Replay V2 viewer.

## Manual Verification

1. Start the API and web apps against a database with migration `008` applied.
2. Ensure a run exists with persisted Replay V2 rows in `replay_v2_streams`, `replay_v2_chunks`, and `replay_v2_events`.
3. Call `GET /v1/runs/:id/replay-v2/streams` and confirm the stream aggregate fields match the stored rows.
4. Call `GET /v1/runs/:id/replay-v2/events?streamId=<stream-id>` and confirm:
   - events are ordered by `seq` ascending
   - `chunk_index` and `final` are present when the owning chunk row exists
   - `limit`, `fromSeq`, and `toSeq` constrain results as expected
5. Open `/app/runs/:id`, follow the Replay V2 link, and confirm:
   - stream summary cards render
   - the first stream is selected by default
   - changing `?streamId=` changes the event table
   - no-stream and no-event cases show explicit empty-state messages
6. Run:
   - `node --check apps/api/src/index.js`
   - `node --check apps/web/src/server.js`
   - `git diff --check`
