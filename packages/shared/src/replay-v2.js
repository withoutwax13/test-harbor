import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const REPLAY_V2_SCHEMA_VERSION = '2.1';
export const REPLAY_V2_SCHEMA_VERSION_COMPAT = new Set(['2.0', '2.1']);
export const REPLAY_V2_SEEK_STRIDE = 50;
export const REPLAY_V2_TARGET_RESOLUTION_ORDER = [
  'test-id',
  'accessibility',
  'structural-css',
  'text-proximity'
];

export const REPLAY_V2_EVENT_KINDS = {
  COMMAND: 'command',
  DOM: 'dom',
  NETWORK: 'network',
  CONSOLE: 'console',
  LIFECYCLE: 'lifecycle'
};

export const REPLAY_V2_LIFECYCLE_EVENTS = {
  SESSION_START: 'SESSION_START',
  SESSION_END: 'SESSION_END',
  TARGET_DECLARE: 'TARGET_DECLARE',
  TARGET_BIND: 'TARGET_BIND',
  TARGET_REBIND: 'TARGET_REBIND',
  TARGET_ORPHAN: 'TARGET_ORPHAN',
  CAPTURE_COMMAND: 'CAPTURE_COMMAND',
  CAPTURE_RRWEB: 'CAPTURE_RRWEB',
  CAPTURE_CDP: 'CAPTURE_CDP',
  CAPTURE_SCREENCAST_DEFERRED: 'CAPTURE_SCREENCAST_DEFERRED',
  TRANSPORT_FIN: 'TRANSPORT_FIN',
  TRANSPORT_ACK: 'TRANSPORT_ACK'
};

const REPLAY_V2_EVENT_KIND_SET = new Set(Object.values(REPLAY_V2_EVENT_KINDS));
const LEGACY_EVENT_KIND_TO_V2 = {
  'session.start': { kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE, eventType: REPLAY_V2_LIFECYCLE_EVENTS.SESSION_START },
  'session.end': { kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE, eventType: REPLAY_V2_LIFECYCLE_EVENTS.SESSION_END },
  'target.declared': { kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE, eventType: REPLAY_V2_LIFECYCLE_EVENTS.TARGET_DECLARE },
  'target.rebound': { kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE, eventType: REPLAY_V2_LIFECYCLE_EVENTS.TARGET_REBIND },
  'target.orphaned': { kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE, eventType: REPLAY_V2_LIFECYCLE_EVENTS.TARGET_ORPHAN },
  'dom.snapshot': { kind: REPLAY_V2_EVENT_KINDS.DOM, eventType: 'SNAPSHOT' },
  'dom.mutation': { kind: REPLAY_V2_EVENT_KINDS.DOM, eventType: 'MUTATION' },
  pointer: { kind: REPLAY_V2_EVENT_KINDS.COMMAND, eventType: 'POINTER' },
  keyboard: { kind: REPLAY_V2_EVENT_KINDS.COMMAND, eventType: 'KEYBOARD' },
  input: { kind: REPLAY_V2_EVENT_KINDS.COMMAND, eventType: 'INPUT' },
  scroll: { kind: REPLAY_V2_EVENT_KINDS.COMMAND, eventType: 'SCROLL' },
  viewport: { kind: REPLAY_V2_EVENT_KINDS.DOM, eventType: 'VIEWPORT' },
  navigation: { kind: REPLAY_V2_EVENT_KINDS.DOM, eventType: 'NAVIGATION' },
  assertion: { kind: REPLAY_V2_EVENT_KINDS.COMMAND, eventType: 'ASSERTION' },
  log: { kind: REPLAY_V2_EVENT_KINDS.CONSOLE, eventType: 'LOG' },
  custom: { kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE, eventType: 'CUSTOM' }
};

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
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));

  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        const normalized = canonicalizeJson(value[key]);
        if (normalized !== undefined) acc[key] = normalized;
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

function normalizeStringArray(value) {
  const normalized = normalizeSelectorValue(value);
  if (normalized == null) return [];
  return Array.isArray(normalized) ? normalized : [normalized];
}

function optionalJson(value) {
  return value == null ? null : canonicalizeJson(value);
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalizeJson(value))).digest('hex');
}

function normalizeFrameOrShadowPath(value) {
  if (Array.isArray(value)) return normalizeStringArray(value);
  return normalizeStringArray(value);
}

function normalizeDomSignature(bundle = {}) {
  const normalized = canonicalizeJson({
    tag: normalizeScalarSelectorValue(bundle.tag || bundle.tagName),
    keyAttrs: isPlainObject(bundle.keyAttrs) ? canonicalizeJson(bundle.keyAttrs) : null,
    relativePosition: normalizeScalarSelectorValue(bundle.relativePosition),
    hash: normalizeScalarSelectorValue(bundle.hash)
  });

  if (normalized.hash) return normalized;
  if (!normalized.tag && !normalized.keyAttrs && !normalized.relativePosition) return null;

  return {
    ...normalized,
    hash: hashJson({
      tag: normalized.tag || null,
      keyAttrs: normalized.keyAttrs || null,
      relativePosition: normalized.relativePosition || null
    })
  };
}

export function normalizeReplayV2SelectorBundle(bundle = {}) {
  assert(isPlainObject(bundle), 'replay_v2_selector_bundle_invalid', { bundle });

  const primary = canonicalizeJson({
    dataCy: normalizeSelectorValue(bundle?.primary?.dataCy ?? bundle.dataCy),
    dataTestId: normalizeSelectorValue(bundle?.primary?.dataTestId ?? bundle.dataTestId ?? bundle.testId),
    appId: normalizeSelectorValue(bundle?.primary?.appId ?? bundle.appId),
    stableId: normalizeSelectorValue(bundle?.primary?.stableId ?? bundle.stableId)
  });

  const accessibility = canonicalizeJson({
    role: normalizeSelectorValue(bundle?.accessibility?.role ?? bundle.role),
    name: normalizeSelectorValue(bundle?.accessibility?.name ?? bundle.name),
    label: normalizeSelectorValue(bundle?.accessibility?.label ?? bundle.label),
    ariaPath: normalizeSelectorValue(bundle?.accessibility?.ariaPath ?? bundle.ariaPath ?? bundle.xpath)
  });

  const structural = canonicalizeJson({
    cssPath: normalizeSelectorValue(bundle?.structural?.cssPath ?? bundle.cssPath ?? bundle.css),
    xpath: normalizeSelectorValue(bundle?.structural?.xpath ?? bundle.xpath),
    nth: Number.isInteger(bundle?.structural?.nth ?? bundle.nth) && (bundle?.structural?.nth ?? bundle.nth) >= 0
      ? (bundle?.structural?.nth ?? bundle.nth)
      : null
  });

  const text = canonicalizeJson({
    text: normalizeSelectorValue(bundle?.text?.text ?? bundle.text),
    proximity: normalizeSelectorValue(bundle?.text?.proximity ?? bundle.proximity),
    nearText: normalizeSelectorValue(bundle?.text?.nearText ?? bundle.nearText)
  });

  const context = canonicalizeJson({
    framePath: normalizeFrameOrShadowPath(bundle?.context?.framePath ?? bundle.framePath),
    shadowPath: normalizeFrameOrShadowPath(bundle?.context?.shadowPath ?? bundle.shadowPath),
    parentFingerprint: normalizeSelectorValue(bundle?.context?.parentFingerprint ?? bundle.parentFingerprint),
    siblingFingerprint: normalizeSelectorValue(bundle?.context?.siblingFingerprint ?? bundle.siblingFingerprint)
  });

  const domSignature = normalizeDomSignature(bundle?.domSignature || bundle);

  const normalized = canonicalizeJson({
    resolutionOrder: REPLAY_V2_TARGET_RESOLUTION_ORDER,
    primary: Object.values(primary).some(Boolean) ? primary : null,
    accessibility: Object.values(accessibility).some(Boolean) ? accessibility : null,
    structural: Object.values(structural).some((value) => value != null && value !== '') ? structural : null,
    text: Object.values(text).some(Boolean) ? text : null,
    context: (
      context.framePath.length
      || context.shadowPath.length
      || context.parentFingerprint
      || context.siblingFingerprint
    ) ? context : null,
    domSignature
  });

  return normalized;
}

export function getStableReplayV2TargetId(input = {}) {
  const selectorBundle = normalizeReplayV2SelectorBundle(input.selectors || input.selectorBundle || {});
  const normalizedIdentity = canonicalizeJson({
    kind: normalizeScalarSelectorValue(input.kind),
    name: normalizeScalarSelectorValue(input.name),
    selectorBundle
  });
  return `tgt_${hashJson(normalizedIdentity).slice(0, 20)}`;
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

function cloneTargetRecord(record) {
  return record ? JSON.parse(JSON.stringify(record)) : null;
}

function createTargetHistoryEntry(type, seq, record, extra = {}) {
  return {
    seq,
    type,
    targetId: record.targetId,
    selectorVersion: record.selectorVersion,
    state: record.state,
    selectorBundle: cloneTargetRecord(record.selectorBundle),
    metadata: optionalJson(record.metadata),
    reason: record.reason || null,
    ...extra
  };
}

function compareSelectorBundles(a, b) {
  return JSON.stringify(canonicalizeJson(a || null)) === JSON.stringify(canonicalizeJson(b || null));
}

export function createReplayV2TargetRegistry({ initialState = [] } = {}) {
  const targets = new Map();
  const history = [];

  function requireTarget(targetId) {
    const target = targets.get(targetId);
    assert(target, 'replay_v2_target_unknown', { targetId });
    return target;
  }

  function writeRecord(record, historyType, seq, extra = {}) {
    targets.set(record.targetId, record);
    if (Number.isInteger(seq) && seq > 0) {
      history.push(createTargetHistoryEntry(historyType, seq, record, extra));
    }
    return cloneTargetRecord(record);
  }

  for (const item of initialState) {
    if (!item?.targetId) continue;
    targets.set(item.targetId, cloneTargetRecord(item));
  }

  return {
    declare({ targetId, selectorBundle = {}, metadata = null, seq = null } = {}) {
      assert(typeof targetId === 'string' && targetId.length > 0, 'replay_v2_target_id_invalid', { targetId });
      const current = targets.get(targetId);
      const record = {
        targetId,
        selectorVersion: current?.selectorVersion ?? 1,
        selectorBundle: current?.selectorBundle ?? normalizeReplayV2SelectorBundle(selectorBundle),
        metadata: metadata ?? current?.metadata ?? null,
        state: 'declared',
        reason: null
      };
      return writeRecord(record, REPLAY_V2_LIFECYCLE_EVENTS.TARGET_DECLARE, seq);
    },
    bind({ targetId, selectorBundle = {}, metadata = null, seq = null } = {}) {
      const current = requireTarget(targetId);
      const normalizedSelectorBundle = normalizeReplayV2SelectorBundle(selectorBundle);
      const selectorVersion = current.selectorVersion || 1;
      const record = {
        ...current,
        selectorVersion,
        selectorBundle: normalizedSelectorBundle,
        metadata: metadata ?? current.metadata ?? null,
        state: 'active',
        reason: null
      };
      return writeRecord(record, REPLAY_V2_LIFECYCLE_EVENTS.TARGET_BIND, seq);
    },
    rebind({ targetId, selectorBundle = {}, metadata = null, seq = null } = {}) {
      const current = requireTarget(targetId);
      const normalizedSelectorBundle = normalizeReplayV2SelectorBundle(selectorBundle);
      const selectorVersion = compareSelectorBundles(current.selectorBundle, normalizedSelectorBundle)
        ? current.selectorVersion
        : (current.selectorVersion || 1) + 1;
      const record = {
        ...current,
        selectorVersion,
        selectorBundle: normalizedSelectorBundle,
        metadata: metadata ?? current.metadata ?? null,
        state: 'active',
        reason: null
      };
      return writeRecord(record, REPLAY_V2_LIFECYCLE_EVENTS.TARGET_REBIND, seq, {
        changed: selectorVersion !== current.selectorVersion
      });
    },
    orphan({ targetId, reason = null, seq = null } = {}) {
      const current = requireTarget(targetId);
      const record = {
        ...current,
        state: 'orphaned',
        reason: normalizeScalarSelectorValue(reason)
      };
      return writeRecord(record, REPLAY_V2_LIFECYCLE_EVENTS.TARGET_ORPHAN, seq);
    },
    assertUsable(targetId) {
      const current = requireTarget(targetId);
      assert(current.state === 'active' || current.state === 'declared', 'replay_v2_target_orphaned', { targetId });
      return cloneTargetRecord(current);
    },
    get(targetId) {
      return cloneTargetRecord(targets.get(targetId) || null);
    },
    snapshot() {
      return [...targets.values()].map((record) => cloneTargetRecord(record));
    },
    history() {
      return history.map((entry) => optionalJson(entry));
    },
    resolveAtSeq(seq) {
      const state = new Map();
      for (const entry of history) {
        if (entry.seq > seq) break;
        state.set(entry.targetId, {
          targetId: entry.targetId,
          selectorVersion: entry.selectorVersion,
          selectorBundle: cloneTargetRecord(entry.selectorBundle),
          metadata: optionalJson(entry.metadata),
          state: entry.state,
          reason: entry.reason || null
        });
      }
      return [...state.values()];
    }
  };
}

function normalizeLegacyEventShape(event) {
  const legacy = LEGACY_EVENT_KIND_TO_V2[event.kind];
  if (!legacy) return event;

  const payload = isPlainObject(event.data) ? { ...event.data } : { value: event.data ?? null };
  if (legacy.eventType) payload.eventType = legacy.eventType;
  if (event.selectorBundle != null && payload.selectorBundle == null) {
    payload.selectorBundle = normalizeReplayV2SelectorBundle(event.selectorBundle);
  }

  return {
    ...event,
    kind: legacy.kind,
    payload,
    targetRef: event.targetId ? {
      targetId: event.targetId,
      selectorVersion: Number.isInteger(payload.selectorVersion) && payload.selectorVersion >= 1 ? payload.selectorVersion : 1
    } : event.targetRef
  };
}

function assertString(value, message, details) {
  assert(typeof value === 'string' && value.length > 0, message, details);
}

function assertOptionalString(value, message, details) {
  if (value == null) return;
  assert(typeof value === 'string' && value.length > 0, message, details);
}

export function normalizeReplayV2EventPayload(event = {}) {
  assert(isPlainObject(event), 'replay_v2_event_invalid', { event });
  const normalizedInput = normalizeLegacyEventShape({ ...event });

  const monotonicTs = Number.isInteger(normalizedInput.monotonicTs)
    ? normalizedInput.monotonicTs
    : normalizedInput.monotonicMs;
  const payload = isPlainObject(normalizedInput.payload)
    ? { ...normalizedInput.payload }
    : isPlainObject(normalizedInput.data)
      ? { ...normalizedInput.data }
      : {};

  const selectorVersion = Number.isInteger(normalizedInput.targetRef?.selectorVersion)
    ? normalizedInput.targetRef.selectorVersion
    : Number.isInteger(payload.selectorVersion)
      ? payload.selectorVersion
      : 1;

  const selectorBundle = payload.selectorBundle != null
    ? normalizeReplayV2SelectorBundle(payload.selectorBundle)
    : normalizedInput.selectorBundle != null
      ? normalizeReplayV2SelectorBundle(normalizedInput.selectorBundle)
      : null;

  if (selectorBundle && !payload.selectorBundle) {
    payload.selectorBundle = selectorBundle;
  }

  const targetId = normalizedInput.targetRef?.targetId || normalizedInput.targetId || null;
  if (targetId && !normalizedInput.targetRef) {
    normalizedInput.targetRef = { targetId, selectorVersion };
  }

  const normalizedEvent = canonicalizeJson({
    schemaVersion: normalizedInput.schemaVersion || REPLAY_V2_SCHEMA_VERSION,
    runId: normalizedInput.runId,
    streamId: normalizedInput.streamId,
    seq: normalizedInput.seq,
    monotonicTs,
    monotonicMs: monotonicTs,
    ts: normalizedInput.ts,
    kind: normalizedInput.kind,
    commandId: normalizeScalarSelectorValue(normalizedInput.commandId),
    targetRef: targetId ? {
      targetId,
      selectorVersion
    } : null,
    payload
  });

  if (selectorBundle) normalizedEvent.selectorBundle = selectorBundle;
  if (targetId) normalizedEvent.targetId = targetId;

  return normalizedEvent;
}

export function assertReplayV2EventPayload(event) {
  const normalized = normalizeReplayV2EventPayload(event);
  if (normalized.schemaVersion != null) {
    assert(REPLAY_V2_SCHEMA_VERSION_COMPAT.has(normalized.schemaVersion), 'replay_v2_event_schema_version_invalid', {
      schemaVersion: normalized.schemaVersion
    });
  }
  assertString(normalized.kind, 'replay_v2_event_kind_invalid', { kind: normalized.kind });
  assert(REPLAY_V2_EVENT_KIND_SET.has(normalized.kind), 'replay_v2_event_kind_unsupported', { kind: normalized.kind });
  assertString(normalized.runId, 'replay_v2_event_run_id_missing', { event: normalized });
  assertOptionalString(normalized.streamId, 'replay_v2_event_stream_id_invalid', { streamId: normalized.streamId });
  assert(Number.isInteger(normalized.seq) && normalized.seq >= 1, 'replay_v2_event_seq_invalid', { seq: normalized.seq });
  assert(Number.isInteger(normalized.monotonicTs) && normalized.monotonicTs >= 0, 'replay_v2_event_monotonic_invalid', {
    monotonicTs: normalized.monotonicTs
  });
  assertOptionalString(normalized.commandId, 'replay_v2_event_command_id_invalid', { commandId: normalized.commandId });
  assert(isPlainObject(normalized.payload), 'replay_v2_event_payload_invalid', { payload: normalized.payload });
  if (normalized.ts != null) {
    assertString(normalized.ts, 'replay_v2_event_ts_invalid', { ts: normalized.ts });
    assert(Number.isFinite(Date.parse(normalized.ts)), 'replay_v2_event_ts_unparseable', { ts: normalized.ts });
  }
  if (normalized.targetRef != null) {
    assertString(normalized.targetRef.targetId, 'replay_v2_target_id_invalid', { targetRef: normalized.targetRef });
    assert(Number.isInteger(normalized.targetRef.selectorVersion) && normalized.targetRef.selectorVersion >= 1, 'replay_v2_selector_version_invalid', {
      targetRef: normalized.targetRef
    });
  }
  return normalized;
}

export function assertReplayV2ChunkPayload(payload) {
  assert(isPlainObject(payload), 'replay_v2_chunk_invalid', { payload });
  assertString(payload.runId, 'replay_v2_chunk_run_id_missing', { payload });
  assertString(payload.streamId, 'replay_v2_chunk_stream_id_missing', { payload });
  assert(Number.isInteger(payload.seqStart) && payload.seqStart >= 1, 'replay_v2_chunk_seq_start_invalid', { seqStart: payload.seqStart });
  assert(Number.isInteger(payload.seqEnd) && payload.seqEnd >= payload.seqStart, 'replay_v2_chunk_seq_end_invalid', {
    seqEnd: payload.seqEnd,
    seqStart: payload.seqStart
  });
  assert(Array.isArray(payload.events) && payload.events.length > 0, 'replay_v2_chunk_events_invalid', { events: payload.events });
  if (payload.schemaVersion != null) {
    assert(REPLAY_V2_SCHEMA_VERSION_COMPAT.has(payload.schemaVersion), 'replay_v2_chunk_schema_version_invalid', {
      schemaVersion: payload.schemaVersion
    });
  }

  let expectedSeq = payload.seqStart;
  let previousMonotonicTs = -1;

  payload.events = payload.events.map((event) => {
    const normalizedEvent = assertReplayV2EventPayload({ ...event, streamId: event.streamId || payload.streamId });
    assert(normalizedEvent.runId === payload.runId, 'replay_v2_chunk_run_id_parity_error', {
      chunkRunId: payload.runId,
      eventRunId: normalizedEvent.runId
    });
    assert((normalizedEvent.streamId || payload.streamId) === payload.streamId, 'replay_v2_chunk_stream_id_parity_error', {
      chunkStreamId: payload.streamId,
      eventStreamId: normalizedEvent.streamId
    });
    assert(normalizedEvent.seq === expectedSeq, 'replay_v2_chunk_sequence_discontinuity', {
      expectedSeq,
      actualSeq: normalizedEvent.seq
    });
    assert(normalizedEvent.monotonicTs >= previousMonotonicTs, 'replay_v2_chunk_monotonic_regression', {
      previousMonotonicTs,
      monotonicTs: normalizedEvent.monotonicTs
    });
    previousMonotonicTs = normalizedEvent.monotonicTs;
    expectedSeq += 1;
    return normalizedEvent;
  });

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

export function applyReplayV2EventToTargetRegistry(registry, event) {
  const normalizedEvent = assertReplayV2EventPayload(event);
  const targetId = normalizedEvent.targetRef?.targetId || null;
  const selectorBundle = normalizedEvent.payload?.selectorBundle || normalizedEvent.selectorBundle || {};
  const metadata = normalizedEvent.payload?.metadata ?? null;
  const eventType = normalizedEvent.payload?.eventType || null;

  if (normalizedEvent.kind !== REPLAY_V2_EVENT_KINDS.LIFECYCLE || !targetId || !eventType) return null;
  if (eventType === REPLAY_V2_LIFECYCLE_EVENTS.TARGET_DECLARE) {
    return registry.declare({ targetId, selectorBundle, metadata, seq: normalizedEvent.seq });
  }
  if (eventType === REPLAY_V2_LIFECYCLE_EVENTS.TARGET_BIND) {
    return registry.bind({ targetId, selectorBundle, metadata, seq: normalizedEvent.seq });
  }
  if (eventType === REPLAY_V2_LIFECYCLE_EVENTS.TARGET_REBIND) {
    return registry.rebind({ targetId, selectorBundle, metadata, seq: normalizedEvent.seq });
  }
  if (eventType === REPLAY_V2_LIFECYCLE_EVENTS.TARGET_ORPHAN) {
    return registry.orphan({ targetId, reason: normalizedEvent.payload?.reason ?? null, seq: normalizedEvent.seq });
  }
  return null;
}

export function buildReplayV2SeekIndex(events = [], { stride = REPLAY_V2_SEEK_STRIDE } = {}) {
  const registry = createReplayV2TargetRegistry();
  const checkpoints = [];
  let lastCheckpointSeq = 0;

  for (const rawEvent of events) {
    const event = assertReplayV2EventPayload(rawEvent);
    applyReplayV2EventToTargetRegistry(registry, event);
    const shouldCheckpoint = checkpoints.length === 0
      || event.seq - lastCheckpointSeq >= stride
      || (event.kind === REPLAY_V2_EVENT_KINDS.LIFECYCLE && String(event.payload?.eventType || '').startsWith('TARGET_'));

    if (!shouldCheckpoint) continue;
    lastCheckpointSeq = event.seq;
    checkpoints.push({
      checkpointSeq: event.seq,
      monotonicTs: event.monotonicTs,
      eventSeq: event.seq,
      targetRegistryState: registry.snapshot()
    });
  }

  return checkpoints;
}

export function resolveReplayV2TargetStateAtSeq(events = [], seq = Number.MAX_SAFE_INTEGER) {
  const registry = createReplayV2TargetRegistry();
  for (const rawEvent of events) {
    const event = assertReplayV2EventPayload(rawEvent);
    if (event.seq > seq) break;
    applyReplayV2EventToTargetRegistry(registry, event);
  }
  return registry.snapshot();
}

function isActionableCommand(event) {
  return event.kind === REPLAY_V2_EVENT_KINDS.COMMAND && Boolean(event.commandId);
}

export function evaluateReplayV2GateMetrics(events = [], { finAckRequired = true } = {}) {
  const normalizedEvents = events.map((event) => assertReplayV2EventPayload(event)).sort((a, b) => a.seq - b.seq);
  const targetState = new Map();
  let lastSeq = 0;
  let seqGapCount = 0;
  let actionableCommands = 0;
  let alignedCommands = 0;
  let stableTargets = 0;
  let orphanEvents = 0;
  let finSeen = false;
  let ackSeen = false;

  for (const event of normalizedEvents) {
    if (lastSeq && event.seq !== lastSeq + 1) seqGapCount += 1;
    lastSeq = event.seq;

    if (isActionableCommand(event)) {
      actionableCommands += 1;
      if (event.payload?.targetSnapshot || event.targetRef?.targetId) alignedCommands += 1;
      const currentTarget = event.targetRef?.targetId ? targetState.get(event.targetRef.targetId) : null;
      if (!event.targetRef?.targetId || (currentTarget && currentTarget.state !== 'orphaned')) {
        stableTargets += 1;
      }
    }

    const registry = createReplayV2TargetRegistry({ initialState: [...targetState.values()] });
    const record = applyReplayV2EventToTargetRegistry(registry, event);
    if (record) {
      targetState.set(record.targetId, record);
      if (record.state === 'orphaned') orphanEvents += 1;
    }

    if (event.kind === REPLAY_V2_EVENT_KINDS.LIFECYCLE && event.payload?.eventType === REPLAY_V2_LIFECYCLE_EVENTS.TRANSPORT_FIN) {
      finSeen = true;
    }
    if (event.kind === REPLAY_V2_EVENT_KINDS.LIFECYCLE && event.payload?.eventType === REPLAY_V2_LIFECYCLE_EVENTS.TRANSPORT_ACK) {
      ackSeen = true;
    }
  }

  return {
    totals: {
      events: normalizedEvents.length,
      actionableCommands,
      orphanEvents
    },
    seqContinuity: {
      zeroGaps: seqGapCount === 0,
      gapCount: seqGapCount
    },
    finAck: {
      success: !finAckRequired || (finSeen && ackSeen),
      finSeen,
      ackSeen
    },
    commandToDomAlignment: actionableCommands === 0 ? 1 : alignedCommands / actionableCommands,
    targetStability: actionableCommands === 0 ? 1 : stableTargets / actionableCommands,
    orphanSpam: orphanEvents <= Math.max(1, Math.floor(normalizedEvents.length * 0.01))
  };
}

export function encodeMessagePack(value) {
  const chunks = [];

  function pushUInt(valueToWrite, byteLength, prefix8, prefix16, prefix32, prefix64) {
    const buffer = Buffer.allocUnsafe(1 + byteLength);
    buffer[0] = byteLength === 1 ? prefix8 : byteLength === 2 ? prefix16 : byteLength === 4 ? prefix32 : prefix64;
    if (byteLength === 1) buffer.writeUInt8(valueToWrite, 1);
    if (byteLength === 2) buffer.writeUInt16BE(valueToWrite, 1);
    if (byteLength === 4) buffer.writeUInt32BE(valueToWrite, 1);
    if (byteLength === 8) buffer.writeBigUInt64BE(BigInt(valueToWrite), 1);
    chunks.push(buffer);
  }

  function encodeAny(input) {
    if (input == null) {
      chunks.push(Buffer.from([0xc0]));
      return;
    }
    if (input === false) {
      chunks.push(Buffer.from([0xc2]));
      return;
    }
    if (input === true) {
      chunks.push(Buffer.from([0xc3]));
      return;
    }
    if (typeof input === 'number') {
      if (Number.isInteger(input) && input >= 0 && input <= 0x7f) {
        chunks.push(Buffer.from([input]));
        return;
      }
      if (Number.isInteger(input) && input >= -32 && input < 0) {
        chunks.push(Buffer.from([0xe0 | (input + 32)]));
        return;
      }
      if (Number.isInteger(input) && input >= 0 && input <= 0xff) return pushUInt(input, 1, 0xcc, 0xcd, 0xce, 0xcf);
      if (Number.isInteger(input) && input >= 0 && input <= 0xffff) return pushUInt(input, 2, 0xcc, 0xcd, 0xce, 0xcf);
      if (Number.isInteger(input) && input >= 0 && input <= 0xffffffff) return pushUInt(input, 4, 0xcc, 0xcd, 0xce, 0xcf);
      const buffer = Buffer.allocUnsafe(9);
      buffer[0] = 0xcb;
      buffer.writeDoubleBE(input, 1);
      chunks.push(buffer);
      return;
    }
    if (typeof input === 'string') {
      const data = Buffer.from(input, 'utf8');
      if (data.length <= 31) {
        chunks.push(Buffer.concat([Buffer.from([0xa0 | data.length]), data]));
        return;
      }
      if (data.length <= 0xff) {
        chunks.push(Buffer.concat([Buffer.from([0xd9, data.length]), data]));
        return;
      }
      const header = Buffer.allocUnsafe(3);
      header[0] = 0xda;
      header.writeUInt16BE(data.length, 1);
      chunks.push(Buffer.concat([header, data]));
      return;
    }
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
      const data = Buffer.from(input);
      if (data.length <= 0xff) {
        chunks.push(Buffer.concat([Buffer.from([0xc4, data.length]), data]));
        return;
      }
      const header = Buffer.allocUnsafe(3);
      header[0] = 0xc5;
      header.writeUInt16BE(data.length, 1);
      chunks.push(Buffer.concat([header, data]));
      return;
    }
    if (Array.isArray(input)) {
      const length = input.length;
      if (length <= 15) {
        chunks.push(Buffer.from([0x90 | length]));
      } else {
        const header = Buffer.allocUnsafe(3);
        header[0] = 0xdc;
        header.writeUInt16BE(length, 1);
        chunks.push(header);
      }
      for (const item of input) encodeAny(item);
      return;
    }
    if (isPlainObject(input)) {
      const entries = Object.entries(input).filter(([, value]) => value !== undefined);
      const length = entries.length;
      if (length <= 15) {
        chunks.push(Buffer.from([0x80 | length]));
      } else {
        const header = Buffer.allocUnsafe(3);
        header[0] = 0xde;
        header.writeUInt16BE(length, 1);
        chunks.push(header);
      }
      for (const [key, value] of entries) {
        encodeAny(String(key));
        encodeAny(value);
      }
      return;
    }

    throw new Error(`unsupported_messagepack_type:${typeof input}`);
  }

  encodeAny(value);
  return Buffer.concat(chunks);
}

export function decodeMessagePack(buffer) {
  const bytes = Buffer.from(buffer);
  let offset = 0;

  function read(len) {
    const next = bytes.subarray(offset, offset + len);
    offset += len;
    return next;
  }

  function decodeAny() {
    const prefix = bytes[offset];
    offset += 1;

    if (prefix <= 0x7f) return prefix;
    if (prefix >= 0xe0) return prefix - 0x100;
    if ((prefix & 0xf0) === 0x80) {
      const size = prefix & 0x0f;
      const obj = {};
      for (let i = 0; i < size; i += 1) {
        const key = decodeAny();
        obj[key] = decodeAny();
      }
      return obj;
    }
    if ((prefix & 0xf0) === 0x90) {
      const size = prefix & 0x0f;
      return Array.from({ length: size }, () => decodeAny());
    }
    if ((prefix & 0xe0) === 0xa0) {
      const size = prefix & 0x1f;
      return read(size).toString('utf8');
    }
    if (prefix === 0xc0) return null;
    if (prefix === 0xc2) return false;
    if (prefix === 0xc3) return true;
    if (prefix === 0xc4) return read(bytes[offset++]);
    if (prefix === 0xc5) {
      const size = bytes.readUInt16BE(offset);
      offset += 2;
      return read(size);
    }
    if (prefix === 0xcb) {
      const value = bytes.readDoubleBE(offset);
      offset += 8;
      return value;
    }
    if (prefix === 0xcc) return bytes[offset++];
    if (prefix === 0xcd) {
      const value = bytes.readUInt16BE(offset);
      offset += 2;
      return value;
    }
    if (prefix === 0xce) {
      const value = bytes.readUInt32BE(offset);
      offset += 4;
      return value;
    }
    if (prefix === 0xcf) {
      const value = Number(bytes.readBigUInt64BE(offset));
      offset += 8;
      return value;
    }
    if (prefix === 0xd9) return read(bytes[offset++]).toString('utf8');
    if (prefix === 0xda) {
      const size = bytes.readUInt16BE(offset);
      offset += 2;
      return read(size).toString('utf8');
    }
    if (prefix === 0xdc) {
      const size = bytes.readUInt16BE(offset);
      offset += 2;
      return Array.from({ length: size }, () => decodeAny());
    }
    if (prefix === 0xde) {
      const size = bytes.readUInt16BE(offset);
      offset += 2;
      const obj = {};
      for (let i = 0; i < size; i += 1) {
        const key = decodeAny();
        obj[key] = decodeAny();
      }
      return obj;
    }

    throw new Error(`unsupported_messagepack_prefix:${prefix}`);
  }

  return decodeAny();
}
