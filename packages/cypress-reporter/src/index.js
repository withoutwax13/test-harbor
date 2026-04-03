import crypto from 'node:crypto';
import {
  INGEST_EVENT_TYPES,
  REPLAY_V2_EVENT_KINDS,
  REPLAY_V2_SCHEMA_VERSION,
  assertReplayV2ChunkPayload,
  assertReplayV2EventPayload,
  createReplayV2MonotonicClock,
  createReplayV2SequenceTracker,
  createReplayV2TargetRegistry,
  getStableReplayV2TargetId,
  normalizeReplayV2SelectorBundle
} from '@testharbor/shared';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TestHarborReporterClient {
  constructor({ ingestUrl, token = null, maxRetries = 3, replayChunkSize } = {}) {
    this.ingestUrl = ingestUrl || process.env.TESTHARBOR_INGEST_URL || 'http://localhost:4010/v1/ingest/events';
    this.token = token || process.env.TESTHARBOR_INGEST_TOKEN || null;
    this.maxRetries = maxRetries;
    this.replayChunkSize = Number(process.env.TESTHARBOR_REPLAY_CHUNK_SIZE || replayChunkSize || 100);
    this.replayV2 = null;
  }

  async send(type, payload) {
    if (!Object.values(INGEST_EVENT_TYPES).includes(type)) {
      throw new Error(`Unsupported event type: ${type}`);
    }

    const body = { type, idempotencyKey: crypto.randomUUID(), payload, ts: new Date().toISOString() };
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      const res = await fetch(this.ingestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (res.ok) return await res.json();
      if (attempt === this.maxRetries) {
        const text = await res.text();
        throw new Error(`Ingest failed (${res.status}): ${text}`);
      }
      await sleep(250 * attempt);
    }

    throw new Error('Unreachable');
  }

  startReplayV2({ runId, streamId = crypto.randomUUID(), startedAt = new Date().toISOString(), metadata = null } = {}) {
    if (this.replayV2) {
      throw new Error('Replay V2 session already active');
    }

    this.replayV2 = {
      runId,
      streamId,
      startedAt,
      metadata,
      clock: createReplayV2MonotonicClock({ startedAt }),
      eventSequence: createReplayV2SequenceTracker(),
      chunkSequence: createReplayV2SequenceTracker(),
      targetRegistry: createReplayV2TargetRegistry(),
      pendingEvents: [],
      chunkCount: 0
    };

    return this.queueReplayEvent({
      kind: REPLAY_V2_EVENT_KINDS.SESSION_START,
      data: { metadata }
    });
  }

  declareReplayTarget({ targetId, selectors = {}, framePath = null, metadata = null, name = null, kind = null } = {}) {
    const replay = this.#requireReplayV2Session();
    const resolvedTargetId = targetId || getStableReplayV2TargetId({ selectors, framePath, name, kind });
    const selectorBundle = normalizeReplayV2SelectorBundle({ ...selectors, framePath });
    replay.targetRegistry.declare({ targetId: resolvedTargetId, selectors: selectorBundle, framePath, metadata });
    return this.queueReplayEvent({
      kind: REPLAY_V2_EVENT_KINDS.TARGET_DECLARED,
      targetId: resolvedTargetId,
      selectorBundle,
      data: { framePath, metadata, name, kind }
    });
  }

  rebindReplayTarget({ targetId, selectors = {}, framePath = null, metadata = null } = {}) {
    const replay = this.#requireReplayV2Session();
    const selectorBundle = normalizeReplayV2SelectorBundle({ ...selectors, framePath });
    replay.targetRegistry.rebind({ targetId, selectors: selectorBundle, framePath, metadata });
    return this.queueReplayEvent({
      kind: REPLAY_V2_EVENT_KINDS.TARGET_REBOUND,
      targetId,
      selectorBundle,
      data: { framePath, metadata }
    });
  }

  markReplayTargetOrphan({ targetId, reason = null } = {}) {
    const replay = this.#requireReplayV2Session();
    replay.targetRegistry.orphan({ targetId, reason });
    return this.queueReplayEvent({
      kind: REPLAY_V2_EVENT_KINDS.TARGET_ORPHANED,
      targetId,
      data: { reason }
    });
  }

  async queueReplayEvent(event = {}, { flushIfNeeded = true } = {}) {
    const replay = this.#requireReplayV2Session();
    const monotonicMs = replay.clock.now();
    const seq = replay.eventSequence.assign();
    const ts = new Date(Date.parse(replay.startedAt) + monotonicMs).toISOString();
    const normalizedEvent = {
      schemaVersion: REPLAY_V2_SCHEMA_VERSION,
      runId: replay.runId,
      streamId: replay.streamId,
      seq,
      monotonicMs,
      ts,
      ...event
    };

    if (normalizedEvent.selectorBundle != null) {
      normalizedEvent.selectorBundle = normalizeReplayV2SelectorBundle(normalizedEvent.selectorBundle);
    }
    if (
      normalizedEvent.targetId &&
      normalizedEvent.kind !== REPLAY_V2_EVENT_KINDS.TARGET_DECLARED &&
      normalizedEvent.kind !== REPLAY_V2_EVENT_KINDS.TARGET_ORPHANED
    ) {
      replay.targetRegistry.assertUsable(normalizedEvent.targetId);
    }

    assertReplayV2EventPayload(normalizedEvent);
    replay.pendingEvents.push(normalizedEvent);

    if (flushIfNeeded && replay.pendingEvents.length >= this.#getReplayChunkSize()) {
      return this.flushReplayV2Chunk();
    }

    return normalizedEvent;
  }

  async flushReplayV2Chunk({ final = false } = {}) {
    const replay = this.#requireReplayV2Session();
    if (replay.pendingEvents.length === 0) return null;

    const seqStart = replay.pendingEvents[0].seq;
    const seqEnd = replay.pendingEvents[replay.pendingEvents.length - 1].seq;
    const previousChunkSeq = replay.chunkSequence.last();
    replay.chunkSequence.assertChunkRange(seqStart, seqEnd, replay.pendingEvents.length);

    const payload = {
      schemaVersion: REPLAY_V2_SCHEMA_VERSION,
      runId: replay.runId,
      streamId: replay.streamId,
      seqStart,
      seqEnd,
      final,
      chunkIndex: replay.chunkCount,
      startedAt: replay.startedAt,
      events: replay.pendingEvents
    };

    assertReplayV2ChunkPayload(payload);
    let result;
    try {
      result = await this.send(INGEST_EVENT_TYPES.REPLAY_V2_CHUNK, payload);
    } catch (error) {
      replay.chunkSequence = createReplayV2SequenceTracker({
        initialSeq: previousChunkSeq + 1,
        previousSeq: previousChunkSeq
      });
      throw error;
    }
    replay.pendingEvents = [];
    replay.chunkCount += 1;
    return result;
  }

  async endReplayV2({ status = 'completed', metadata = null } = {}) {
    const replay = this.#requireReplayV2Session();
    await this.queueReplayEvent({
      kind: REPLAY_V2_EVENT_KINDS.SESSION_END,
      data: { status, metadata }
    }, { flushIfNeeded: false });
    const result = await this.flushReplayV2Chunk({ final: true });
    this.replayV2 = null;
    return result;
  }

  #requireReplayV2Session() {
    if (!this.replayV2) {
      throw new Error('Replay V2 session not started');
    }
    return this.replayV2;
  }

  #getReplayChunkSize() {
    return Number.isInteger(this.replayChunkSize) && this.replayChunkSize > 0 ? this.replayChunkSize : 100;
  }
}
