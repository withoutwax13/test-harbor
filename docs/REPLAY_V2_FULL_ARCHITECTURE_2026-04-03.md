# Replay V2 Full Plan Architecture

Replay V2 now follows a contract-first pipeline with a stable target identity layer and synchronized read models across reporter, ingest, API, and web viewer.

## Phase A

- `ReplayEventV2` is normalized around `kind` categories: `command`, `dom`, `network`, `console`, `lifecycle`.
- Target references use `targetRef = { targetId, selectorVersion }`.
- The target registry lifecycle is explicit:
  - `TARGET_DECLARE`
  - `TARGET_BIND`
  - `TARGET_REBIND`
  - `TARGET_ORPHAN`
- Selector bundles are stored as bundles, not single selectors:
  - primary IDs: `data-cy`, `data-testid`, app IDs
  - accessibility fallback: role/name/label/aria path
  - structural fallback: CSS path/xpath/nth
  - text fallback: text/proximity/near-text
  - context anchors: frame/shadow paths and parent/sibling fingerprints
  - DOM signature hash
- Resolution order is deterministic and version-bumped on rebind.

## Phase B

- `setupNodeEvents` now starts a dedicated WS transport server on port `9223` by default.
- Replay chunks are appended to segmented `.harbor` files beneath `.harbor/replay-v2/<run>/<stream>/` as length-prefixed MessagePack frames.
- Transport metadata is persisted on replay chunks.
- FIN/ACK is represented as lifecycle protocol events and persisted into stream/chunk state.

## Phase C

Capture layering is recorded in order at session start:

1. Cypress command lifecycle with target snapshots at command boundaries
2. rrweb incremental DOM configuration (`recordShadowDom: true`, `inlineStylesheet: true`)
3. CDP auto-attach declaration (`Target.setAutoAttach`) plus network/console/runtime intent
4. screencast explicitly deferred until stability gates pass

Browser-side capture emission is available through `cy.task()` hooks under the `testharbor:replay:*` namespace.

## Phase D

- Replay payload asset URLs are rewritten to `cas://sha256/<digest>` when they pass the allowlist.
- CAS metadata is persisted in `replay_v2_assets_cas`.
- Sensitive URL/MIME patterns are blocked and retained with block reasons instead of rewritten.

## Phase E

- `replay_v2_seek_index` stores checkpoint snapshots every stride and on target lifecycle boundaries.
- Seek uses nearest checkpoint plus forward deltas from `replay_v2_events`.
- Target resolution at an arbitrary sequence is driven by `replay_v2_target_registry`.
- Live Inspect exposes the resolved selector bundle and DOM signature for the latest target-backed event at or before the requested sequence.

## Gate Instrumentation

Persisted stream counters now expose:

- `actionable_command_count`
- `aligned_command_count`
- `target_resolved_count`
- `orphan_count`
- `final_received`
- `ack_received`

Derived gates:

- seq continuity: zero gaps required
- FIN/ACK success: `final_received && ack_received`
- command-to-DOM alignment: `aligned / actionable`
- target stability: `resolved / actionable`
- orphan spam: `orphan_count` within 1% of total event volume

## Static Verification

Use:

- `node scripts/replay-v2-gate-artifacts.mjs`
- `node scripts/replay-v2-fin-ack-check.mjs <segment-dir>` (exits non-zero unless both FIN and ACK are present and correlated)
- `node --check <touched-js-file>`
- `git diff --check`
