import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const REPLAY_V2_SCHEMA_VERSION = '2.0';

export const REPLAY_V2_EVENT_KINDS = {
  SESSION_START: 'session.start',
  SESSION_END: 'session.end',
  TARGET_DECLARED: 'target.declared',
  TARGET_REBOUND: 'target.rebound',
  TARGET_ORPHANED: 'target.orphaned',
  DOM_SNAPSHOT: 'dom.snapshot',
  DOM_MUTATION: 'dom.mutation',
  POINTER: 'pointer',
  KEYBOARD: 'keyboard',
  INPUT: 'input',
  SCROLL: 'scroll',
  VIEWPORT: 'viewport',
  NAVIGATION: 'navigation',
  ASSERTION: 'assertion',
  LOG: 'log',
  CUSTOM: 'custom'
};

const REPLAY_V2_EVENT_KIND_SET = new Set(Object.values(REPLAY_V2_EVENT_KINDS));
const REPLAY_V2_SELECTOR_KEYS = [
  'css',
  'xpath',
  'text',
  'testId',
  'role',
  'label',
  'placeholder',
  'altText',
  'title',
  'name',
  'value',
  'framePath'
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }

  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalizeJson(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function normalizeScalarSelectorValue(value) {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeSelectorValue(value) {
  if (Array.isArray(value)) {
    const normalizedValues = [...new Set(value.map((item) => normalizeScalarSelectorValue(item)).filter(Boolean))].sort();
    return normalizedValues.length ? normalizedValues : null;
  }

  return normalizeScalarSelectorValue(value);
}

export function normalizeReplayV2SelectorBundle(bundle = {}) {
  assert(isPlainObject(bundle), 'replay_v2_selector_bundle_invalid', { bundle });

  const normalized = {};
  for (const key of REPLAY_V2_SELECTOR_KEYS) {
    const value = normalizeSelectorValue(bundle[key]);
    if (value !== null) normalized[key] = value;
  }

  if (Number.isInteger(bundle.nth) && bundle.nth >= 0) {
    normalized.nth = bundle.nth;
  }

  return canonicalizeJson(normalized);
}

export function getStableReplayV2TargetId(input = {}) {
  const normalizedSelectors = normalizeReplayV2SelectorBundle(input.selectors || input.selectorBundle || {});
  const normalizedIdentity = canonicalizeJson({
    framePath: normalizeSelectorValue(input.framePath) ?? null,
    kind: normalizeScalarSelectorValue(input.kind) ?? null,
    name: normalizeScalarSelectorValue(input.name) ?? null,
    selectors: normalizedSelectors
  });
  const digest = crypto.createHash('sha256').update(JSON.stringify(normalizedIdentity)).digest('hex');
  return `rv2_tgt_${digest.slice(0, 20)}`;
}

export function createReplayV2MonotonicClock({ startedAt = new Date().toISOString() } = {}) {
  const startedAtMs = Date.parse(startedAt);
  assert(Number.isFinite(startedAtMs), 'replay_v2_started_at_invalid', { startedAt });

  const origin = performance.now();
  let lastMs = 0;

  return {
    startedAt,
    now() {
      const elapsed = Math.max(0, Math.round(performance.now() - origin));
      lastMs = Math.max(lastMs, elapsed);
      return lastMs;
    }
  };
}

export function createReplayV2SequenceTracker({ initialSeq = 1, previousSeq = 0 } = {}) {
  assert(Number.isInteger(initialSeq) && initialSeq >= 1, 'replay_v2_initial_seq_invalid', { initialSeq });
  assert(Number.isInteger(previousSeq) && previousSeq >= 0, 'replay_v2_previous_seq_invalid', { previousSeq });

  let nextSeq = initialSeq;
  let lastSeq = previousSeq;

  return {
    peek() {
      return nextSeq;
    },
    last() {
      return lastSeq;
    },
    assign() {
      assert(nextSeq === lastSeq + 1, 'replay_v2_sequence_gap', { expected: lastSeq + 1, actual: nextSeq });
      const seq = nextSeq;
      lastSeq = seq;
      nextSeq += 1;
      return seq;
    },
    assertChunkRange(seqStart, seqEnd, eventCount) {
      assert(Number.isInteger(seqStart) && Number.isInteger(seqEnd), 'replay_v2_chunk_seq_invalid', { seqStart, seqEnd });
      assert(seqStart >= 1 && seqEnd >= seqStart, 'replay_v2_chunk_seq_range_invalid', { seqStart, seqEnd });
      assert(seqEnd - seqStart + 1 === eventCount, 'replay_v2_chunk_sequence_count_mismatch', {
        seqStart,
        seqEnd,
        eventCount
      });
      if (lastSeq > 0) {
        assert(seqStart === lastSeq + 1, 'replay_v2_chunk_sequence_discontinuity', { expected: lastSeq + 1, seqStart });
      }
      lastSeq = seqEnd;
      nextSeq = seqEnd + 1;
    }
  };
}

export function createReplayV2TargetRegistry() {
  const targets = new Map();

  function requireTarget(targetId) {
    const target = targets.get(targetId);
    assert(target, 'replay_v2_target_unknown', { targetId });
    return target;
  }

  return {
    declare({ targetId, selectors = {}, framePath = null, metadata = null } = {}) {
      assert(typeof targetId === 'string' && targetId.length > 0, 'replay_v2_target_id_invalid', { targetId });
      const normalizedSelectors = normalizeReplayV2SelectorBundle(selectors);
      const record = {
        targetId,
        selectors: normalizedSelectors,
        framePath: normalizeSelectorValue(framePath),
        metadata: metadata ?? null,
        state: 'active'
      };
      targets.set(targetId, record);
      return record;
    },
    rebind({ targetId, selectors = {}, framePath = null, metadata = null } = {}) {
      const current = requireTarget(targetId);
      const updated = {
        ...current,
        selectors: normalizeReplayV2SelectorBundle(selectors),
        framePath: normalizeSelectorValue(framePath),
        metadata: metadata ?? current.metadata ?? null,
        state: 'active'
      };
      targets.set(targetId, updated);
      return updated;
    },
    orphan({ targetId, reason = null } = {}) {
      const current = requireTarget(targetId);
      const updated = {
        ...current,
        state: 'orphaned',
        orphanedReason: normalizeScalarSelectorValue(reason)
      };
      targets.set(targetId, updated);
      return updated;
    },
    assertUsable(targetId) {
      const current = requireTarget(targetId);
      assert(current.state === 'active', 'replay_v2_target_orphaned', { targetId });
      return current;
    },
    get(targetId) {
      return targets.get(targetId) || null;
    }
  };
}

function assertString(value, message, details) {
  assert(typeof value === 'string' && value.length > 0, message, details);
}

function assertOptionalString(value, message, details) {
  if (value == null) return;
  assert(typeof value === 'string' && value.length > 0, message, details);
}

export function assertReplayV2EventPayload(event) {
  assert(isPlainObject(event), 'replay_v2_event_invalid', { event });
  assertString(event.kind, 'replay_v2_event_kind_invalid', { kind: event.kind });
  assert(REPLAY_V2_EVENT_KIND_SET.has(event.kind), 'replay_v2_event_kind_unsupported', { kind: event.kind });
  assertString(event.runId, 'replay_v2_event_run_id_missing', { event });
  assertString(event.streamId, 'replay_v2_event_stream_id_missing', { event });
  assert(Number.isInteger(event.seq) && event.seq >= 1, 'replay_v2_event_seq_invalid', { seq: event.seq });
  assert(Number.isInteger(event.monotonicMs) && event.monotonicMs >= 0, 'replay_v2_event_monotonic_invalid', {
    monotonicMs: event.monotonicMs
  });
  assertString(event.ts, 'replay_v2_event_ts_invalid', { ts: event.ts });
  assert(Number.isFinite(Date.parse(event.ts)), 'replay_v2_event_ts_unparseable', { ts: event.ts });
  assertOptionalString(event.targetId, 'replay_v2_event_target_id_invalid', { targetId: event.targetId });
  if (event.selectorBundle != null) {
    event.selectorBundle = normalizeReplayV2SelectorBundle(event.selectorBundle);
  }
  if (event.data != null) {
    assert(isPlainObject(event.data) || Array.isArray(event.data), 'replay_v2_event_data_invalid', { data: event.data });
  }
  return event;
}

export function assertReplayV2ChunkPayload(payload) {
  assert(isPlainObject(payload), 'replay_v2_chunk_invalid', { payload });
  assertString(payload.runId, 'replay_v2_chunk_run_id_missing', { payload });
  assertString(payload.streamId, 'replay_v2_chunk_stream_id_missing', { payload });
  assert(Number.isInteger(payload.seqStart) && payload.seqStart >= 1, 'replay_v2_chunk_seq_start_invalid', {
    seqStart: payload.seqStart
  });
  assert(Number.isInteger(payload.seqEnd) && payload.seqEnd >= payload.seqStart, 'replay_v2_chunk_seq_end_invalid', {
    seqEnd: payload.seqEnd,
    seqStart: payload.seqStart
  });
  assert(Array.isArray(payload.events) && payload.events.length > 0, 'replay_v2_chunk_events_invalid', {
    events: payload.events
  });

  if (payload.schemaVersion != null) {
    assert(payload.schemaVersion === REPLAY_V2_SCHEMA_VERSION, 'replay_v2_chunk_schema_version_invalid', {
      schemaVersion: payload.schemaVersion
    });
  }

  let expectedSeq = payload.seqStart;
  let previousMonotonicMs = -1;

  for (const event of payload.events) {
    assertReplayV2EventPayload(event);
    assert(event.runId === payload.runId, 'replay_v2_chunk_run_id_parity_error', {
      chunkRunId: payload.runId,
      eventRunId: event.runId
    });
    assert(event.streamId === payload.streamId, 'replay_v2_chunk_stream_id_parity_error', {
      chunkStreamId: payload.streamId,
      eventStreamId: event.streamId
    });
    assert(event.seq === expectedSeq, 'replay_v2_chunk_sequence_discontinuity', {
      expectedSeq,
      actualSeq: event.seq
    });
    assert(event.monotonicMs >= previousMonotonicMs, 'replay_v2_chunk_monotonic_regression', {
      previousMonotonicMs,
      monotonicMs: event.monotonicMs
    });
    previousMonotonicMs = event.monotonicMs;
    expectedSeq += 1;
  }

  assert(payload.events[0].seq === payload.seqStart, 'replay_v2_chunk_seq_start_parity_error', {
    seqStart: payload.seqStart,
    firstEventSeq: payload.events[0].seq
  });
  assert(payload.events[payload.events.length - 1].seq === payload.seqEnd, 'replay_v2_chunk_seq_end_parity_error', {
    seqEnd: payload.seqEnd,
    lastEventSeq: payload.events[payload.events.length - 1].seq
  });
  assert(payload.seqEnd - payload.seqStart + 1 === payload.events.length, 'replay_v2_chunk_event_count_mismatch', {
    seqStart: payload.seqStart,
    seqEnd: payload.seqEnd,
    count: payload.events.length
  });

  return payload;
}
