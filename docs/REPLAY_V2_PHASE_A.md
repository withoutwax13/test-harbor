# Replay V2 Phase A

Replay V2 Phase A defines the reporter-to-ingest wire contract for chunked replay streams. Storage and replay rendering are intentionally out of scope in this phase.

## Chunk Contract

Ingest event type: `replay.v2.chunk`

Required payload fields:

- `runId`: owning run identifier. The ingest service rejects chunks for unknown runs.
- `streamId`: stable identifier for one replay stream within the run.
- `seqStart`: first event sequence number in the chunk.
- `seqEnd`: last event sequence number in the chunk.
- `events`: non-empty ordered array of Replay V2 events.

Optional header fields currently emitted by the reporter:

- `schemaVersion`: current value `2.0`
- `startedAt`: replay stream wall-clock origin timestamp
- `chunkIndex`: zero-based chunk counter
- `final`: marks the terminal flushed chunk

Validation rules:

- `events` must be non-empty.
- Every event must carry the same `runId` and `streamId` as the chunk header.
- Event `seq` values must be strictly contiguous with no gaps.
- `seqStart` must equal the first event sequence.
- `seqEnd` must equal the last event sequence.
- `seqEnd - seqStart + 1` must equal `events.length`.
- Event `monotonicMs` must never move backwards inside a chunk.

## Event Shape

Each event includes:

- `kind`: Replay V2 event kind
- `runId`
- `streamId`
- `seq`
- `monotonicMs`
- `ts`

Optional fields:

- `targetId`
- `selectorBundle`
- `data`

Phase A recognizes these event kinds:

- `session.start`
- `session.end`
- `target.declared`
- `target.rebound`
- `target.orphaned`
- `dom.snapshot`
- `dom.mutation`
- `pointer`
- `keyboard`
- `input`
- `scroll`
- `viewport`
- `navigation`
- `assertion`
- `log`
- `custom`

## Selector Bundles And Stable Target IDs

Selector bundles are normalized before hashing or validation:

- known selector fields are trimmed
- array selectors are deduplicated and sorted
- empty values are removed
- `nth` is preserved only when it is a non-negative integer

Stable target IDs are derived from normalized selector data plus optional target identity hints. This allows the reporter to redeclare the same logical target deterministically across retries or rebinding.

## Target Lifecycle

The Phase A reporter exposes four target lifecycle operations:

1. `declareReplayTarget`
2. `rebindReplayTarget`
3. `markReplayTargetOrphan`
4. `queueReplayEvent` for events that reference an active target

Lifecycle expectations:

- A target is active immediately after declaration.
- Rebinding updates the normalized selector bundle for an existing target and returns it to active state.
- Orphaning marks the target unusable for future non-lifecycle events.
- Events that reference a target must use an active target ID, except for `target.declared` and `target.orphaned` lifecycle events themselves.

## Reporter Behavior

The reporter maintains:

- a monotonic clock anchored to `startedAt`
- a strict event sequence counter beginning at `1`
- a strict chunk continuity tracker across flushes
- a target registry enforcing active versus orphaned usage

When the pending event queue reaches `TESTHARBOR_REPLAY_CHUNK_SIZE` (default `100`), the reporter flushes a validated `replay.v2.chunk` payload to ingest.
