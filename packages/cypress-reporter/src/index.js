import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  INGEST_EVENT_TYPES,
  REPLAY_V2_EVENT_KINDS,
  REPLAY_V2_LIFECYCLE_EVENTS,
  REPLAY_V2_SCHEMA_VERSION,
  assertReplayV2ChunkPayload,
  assertReplayV2EventPayload,
  createReplayV2MonotonicClock,
  createReplayV2SequenceTracker,
  createReplayV2TargetRegistry,
  encodeMessagePack,
  decodeMessagePack,
  getStableReplayV2TargetId,
  normalizeReplayV2SelectorBundle
} from '@testharbor/shared';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIso(value = new Date()) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) return new Date().toISOString();
  return asDate.toISOString();
}

function asTrimmedString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeFileSize(filePath) {
  if (!filePath) return null;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

function stableTestKey(specPath, title) {
  return crypto.createHash('sha1').update(`${specPath}::${title}`).digest('hex');
}

function hashErrorMessage(message) {
  if (!message) return null;
  return crypto.createHash('sha256').update(String(message)).digest('hex');
}

function normalizeResultState(state) {
  const raw = String(state || '').toLowerCase();
  if (raw === 'passed' || raw === 'pass') return 'passed';
  if (raw === 'failed' || raw === 'fail') return 'failed';
  if (raw === 'pending' || raw === 'skipped' || raw === 'skip') return 'skipped';
  return 'skipped';
}

function findSpecRunId(specRunIds, candidate) {
  if (!candidate) return null;
  if (specRunIds.has(candidate)) return specRunIds.get(candidate);
  const normalizedCandidate = String(candidate);
  for (const [specPath, specRunId] of specRunIds.entries()) {
    if (
      specPath === normalizedCandidate
      || specPath.endsWith(normalizedCandidate)
      || normalizedCandidate.endsWith(specPath)
    ) {
      return specRunId;
    }
  }
  return null;
}

function specPathFromSpec(spec) {
  return asTrimmedString(spec?.relative)
    || asTrimmedString(spec?.specName)
    || asTrimmedString(spec?.name)
    || 'unknown-spec';
}

function runStatusFromSummary(results, fallbackFailedCount) {
  const failed = toNumber(results?.totalFailed, fallbackFailedCount);
  return failed > 0 ? 'failed' : 'passed';
}

function specStatusFromSummary(results, fallbackFailedCount) {
  const failures = toNumber(results?.stats?.failures, fallbackFailedCount);
  return failures > 0 ? 'failed' : 'passed';
}

function extractFailure(attempt) {
  if (!attempt) return { message: null, stacktrace: null };

  const err = attempt.error || attempt.err || null;
  if (!err) return { message: null, stacktrace: null };

  if (typeof err === 'string') return { message: err.slice(0, 1000), stacktrace: err.slice(0, 8000) };

  const message = asTrimmedString(err.message)
    || asTrimmedString(err.name)
    || asTrimmedString(JSON.stringify(err).slice(0, 1000));
  const stacktrace = asTrimmedString(err.stack)
    || (message ? message : null);

  return {
    message: message ? message.slice(0, 1000) : null,
    stacktrace: stacktrace ? stacktrace.slice(0, 12000) : null
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeReplayPayload(input) {
  return JSON.parse(JSON.stringify(input));
}

class HarborSegmentWriter {
  constructor({ rootDir, maxBytes = 1024 * 1024 } = {}) {
    this.rootDir = rootDir || path.join(process.cwd(), '.harbor', 'replay-v2');
    this.maxBytes = maxBytes;
    this.segmentIndex = 0;
    this.currentBytes = 0;
    ensureDir(this.rootDir);
  }

  appendFrame(frame) {
    const payload = encodeMessagePack(normalizeReplayPayload(frame));
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);
    const segmentPath = path.join(this.rootDir, `${String(this.segmentIndex).padStart(6, '0')}.harbor`);
    if (this.currentBytes + header.length + payload.length > this.maxBytes && this.currentBytes > 0) {
      this.segmentIndex += 1;
      this.currentBytes = 0;
      return this.appendFrame(frame);
    }
    const byteOffset = this.currentBytes;
    fs.appendFileSync(segmentPath, Buffer.concat([header, payload]));
    this.currentBytes += header.length + payload.length;
    return {
      segmentPath,
      segmentIndex: this.segmentIndex,
      byteOffset,
      byteLength: header.length + payload.length
    };
  }
}

function createWebSocketAccept(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function writeWebSocketFrame(socket, data) {
  const payload = Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x82, payload.length]);
  } else {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function parseWebSocketFrames(buffer, onFrame) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    }
    if (masked) {
      if (cursor + 4 > buffer.length) break;
    }
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    onFrame({ opcode, payload });
    offset = cursor + length;
  }
  return buffer.subarray(offset);
}

function decodeTransportMessage(opcode, payload) {
  if (!Buffer.isBuffer(payload) || payload.length === 0) return null;
  try {
    if (opcode === 0x2) return decodeMessagePack(payload);
    if (opcode === 0x1) return JSON.parse(payload.toString('utf8'));
  } catch {
    try {
      return JSON.parse(payload.toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

class ReplayTransportServer {
  constructor({ port = 9223 } = {}) {
    this.port = port;
    this.server = null;
    this.clients = new Set();
    this.pendingFin = new Map();
  }

  start() {
    if (this.server) return;
    this.server = http.createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'upgrade_required' }));
    });
    this.server.on('upgrade', (request, socket) => {
      const key = request.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
        '',
        ''
      ].join('\r\n'));

      socket._thBuffer = Buffer.alloc(0);
      this.clients.add(socket);
      socket.on('data', (chunk) => {
        socket._thBuffer = parseWebSocketFrames(Buffer.concat([socket._thBuffer, chunk]), ({ opcode, payload }) => {
          if (opcode === 0x8) {
            socket.end();
            return;
          }
          if (opcode !== 0x2 && opcode !== 0x1) return;
          const message = decodeTransportMessage(opcode, payload);
          if (message?.type === 'TRANSPORT_ACK' && message.finId) {
            this.acknowledgeFin(message.finId, { clientAck: true, ts: new Date().toISOString() });
          }
        });
      });
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
    });
    this.server.listen(this.port, '0.0.0.0');
  }

  broadcast(frame) {
    const payload = encodeMessagePack(frame);
    for (const client of this.clients) {
      writeWebSocketFrame(client, payload);
    }
  }

  requestFinAck(finId, meta = {}) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingFin.get(finId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingFin.delete(finId);
        pending.resolve({
          ok: false,
          finId,
          timeoutFallback: true,
          timeoutMs: 250,
          ...meta
        });
      }, 250);
      this.pendingFin.set(finId, { resolve, timeout });
      this.broadcast({ type: 'TRANSPORT_FIN', finId, meta });
    });
  }

  acknowledgeFin(finId, meta = {}) {
    const pending = this.pendingFin.get(finId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingFin.delete(finId);
    this.broadcast({ type: 'TRANSPORT_ACK', finId, meta });
    pending.resolve({ ok: true, finId, ...meta });
  }
}

export class TestHarborReporterClient {
  constructor({ ingestUrl, token = null, maxRetries = 3, replayChunkSize, replayTransportPort = 9223, harborRoot = null } = {}) {
    this.ingestUrl = ingestUrl || process.env.TESTHARBOR_INGEST_URL || 'http://localhost:4010/v1/ingest/events';
    this.token = token || process.env.TESTHARBOR_INGEST_TOKEN || null;
    this.maxRetries = maxRetries;
    this.replayChunkSize = Number(process.env.TESTHARBOR_REPLAY_CHUNK_SIZE || replayChunkSize || 100);
    this.replayTransportPort = Number(process.env.TESTHARBOR_REPLAY_WS_PORT || replayTransportPort || 9223);
    this.harborRoot = harborRoot || process.env.TESTHARBOR_REPLAY_HARBOR_ROOT || path.join(process.cwd(), '.harbor', 'replay-v2');
    this.transportServer = new ReplayTransportServer({ port: this.replayTransportPort });
    this.transportServer.start();
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

      if (res.ok) {
        const text = await res.text();
        if (!text) return { ok: true };
        try {
          return JSON.parse(text);
        } catch {
          return { ok: true, raw: text };
        }
      }

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
      harborWriter: new HarborSegmentWriter({
        rootDir: path.join(this.harborRoot, runId, streamId)
      }),
      pendingEvents: [],
      chunkCount: 0
    };

    this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.SESSION_START, { metadata }, { flushIfNeeded: false });
    this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.CAPTURE_COMMAND, {
      order: 1,
      targetSnapshotsAtCommandBoundaries: true
    }, { flushIfNeeded: false });
    this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.CAPTURE_RRWEB, {
      order: 2,
      recordShadowDom: true,
      inlineStylesheet: true
    }, { flushIfNeeded: false });
    this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.CAPTURE_CDP, {
      order: 3,
      autoAttach: true,
      domains: ['Target', 'Network', 'Console', 'Runtime']
    }, { flushIfNeeded: false });
    return this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.CAPTURE_SCREENCAST_DEFERRED, {
      order: 4,
      deferred: true
    });
  }

  declareReplayTarget({ targetId, selectors = {}, framePath = null, metadata = null, name = null, kind = null } = {}) {
    const replay = this.#requireReplayV2Session();
    const resolvedTargetId = targetId || getStableReplayV2TargetId({ selectors, framePath, name, kind });
    const selectorBundle = normalizeReplayV2SelectorBundle({ ...selectors, framePath });
    replay.targetRegistry.declare({ targetId: resolvedTargetId, selectorBundle, metadata });
    this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.TARGET_DECLARE, {
      metadata: { framePath, metadata, name, kind },
      selectorBundle
    }, {
      targetRef: { targetId: resolvedTargetId, selectorVersion: 1 },
      flushIfNeeded: false
    });
    replay.targetRegistry.bind({ targetId: resolvedTargetId, selectorBundle, metadata });
    return this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.TARGET_BIND, {
      metadata: { framePath, metadata, name, kind },
      selectorBundle
    }, {
      targetRef: { targetId: resolvedTargetId, selectorVersion: 1 }
    });
  }

  bindReplayTarget({ targetId, selectors = {}, framePath = null, metadata = null } = {}) {
    const replay = this.#requireReplayV2Session();
    const selectorBundle = normalizeReplayV2SelectorBundle({ ...selectors, framePath });
    const bound = replay.targetRegistry.bind({ targetId, selectorBundle, metadata });
    return this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.TARGET_BIND, {
      metadata: { framePath, metadata },
      selectorBundle
    }, {
      targetRef: { targetId, selectorVersion: bound.selectorVersion }
    });
  }

  rebindReplayTarget({ targetId, selectors = {}, framePath = null, metadata = null } = {}) {
    const replay = this.#requireReplayV2Session();
    const selectorBundle = normalizeReplayV2SelectorBundle({ ...selectors, framePath });
    const rebound = replay.targetRegistry.rebind({ targetId, selectorBundle, metadata });
    return this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.TARGET_REBIND, {
      metadata: { framePath, metadata },
      selectorBundle
    }, {
      targetRef: { targetId, selectorVersion: rebound.selectorVersion }
    });
  }

  markReplayTargetOrphan({ targetId, reason = null } = {}) {
    const replay = this.#requireReplayV2Session();
    const orphaned = replay.targetRegistry.orphan({ targetId, reason });
    return this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.TARGET_ORPHAN, {
      reason
    }, {
      targetRef: { targetId, selectorVersion: orphaned.selectorVersion }
    });
  }

  queueReplayLifecycle(eventType, payload = {}, options = {}) {
    const { flushIfNeeded = true, ...eventOptions } = options;
    return this.queueReplayEvent({
      kind: REPLAY_V2_EVENT_KINDS.LIFECYCLE,
      payload: {
        eventType,
        ...payload
      },
      ...eventOptions
    }, { flushIfNeeded });
  }

  queueCommandEvent({ commandId, targetId = null, selectors = null, payload = {} } = {}, options = {}) {
    const targetRef = targetId
      ? {
        targetId,
        selectorVersion: this.replayV2?.targetRegistry?.get(targetId)?.selectorVersion || 1
      }
      : null;
    const targetSnapshot = targetId ? this.replayV2?.targetRegistry?.get(targetId) || null : null;
    return this.queueReplayEvent({
      kind: REPLAY_V2_EVENT_KINDS.COMMAND,
      commandId: commandId || crypto.randomUUID(),
      targetRef,
      payload: {
        ...payload,
        selectorBundle: selectors ? normalizeReplayV2SelectorBundle(selectors) : targetSnapshot?.selectorBundle || null,
        targetSnapshot
      }
    }, options);
  }

  queueDomEvent(payload = {}, options = {}) {
    return this.queueReplayEvent({
      kind: REPLAY_V2_EVENT_KINDS.DOM,
      payload
    }, options);
  }

  queueNetworkEvent(payload = {}, options = {}) {
    return this.queueReplayEvent({
      kind: REPLAY_V2_EVENT_KINDS.NETWORK,
      payload
    }, options);
  }

  queueConsoleEvent(payload = {}, options = {}) {
    return this.queueReplayEvent({
      kind: REPLAY_V2_EVENT_KINDS.CONSOLE,
      payload
    }, options);
  }

  async queueReplayEvent(event = {}, { flushIfNeeded = true } = {}) {
    const replay = this.#requireReplayV2Session();
    const monotonicTs = replay.clock.now();
    const seq = replay.eventSequence.assign();
    const ts = new Date(Date.parse(replay.startedAt) + monotonicTs).toISOString();
    const normalizedSelectorBundle = event.payload?.selectorBundle
      ? normalizeReplayV2SelectorBundle(event.payload.selectorBundle)
      : null;
    const normalizedEvent = {
      schemaVersion: REPLAY_V2_SCHEMA_VERSION,
      runId: replay.runId,
      streamId: replay.streamId,
      seq,
      monotonicTs,
      ts,
      ...event,
      targetRef: event.targetRef || null,
      payload: {
        ...(event.payload || {}),
        ...(normalizedSelectorBundle ? { selectorBundle: normalizedSelectorBundle } : {})
      }
    };

    if (normalizedEvent.targetRef?.targetId) {
      const lifecycleType = normalizedEvent.payload?.eventType;
      if (
        normalizedEvent.kind !== REPLAY_V2_EVENT_KINDS.LIFECYCLE
        || ![
          REPLAY_V2_LIFECYCLE_EVENTS.TARGET_DECLARE,
          REPLAY_V2_LIFECYCLE_EVENTS.TARGET_ORPHAN
        ].includes(lifecycleType)
      ) {
        replay.targetRegistry.assertUsable(normalizedEvent.targetRef.targetId);
      }
    }

    const assertedEvent = assertReplayV2EventPayload(normalizedEvent);
    replay.pendingEvents.push(assertedEvent);
    this.transportServer.broadcast({
      type: 'event',
      streamId: replay.streamId,
      seq: assertedEvent.seq,
      kind: assertedEvent.kind
    });

    if (flushIfNeeded && replay.pendingEvents.length >= this.#getReplayChunkSize()) {
      return this.flushReplayV2Chunk();
    }

    return assertedEvent;
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
      seekStride: 50,
      transport: {
        kind: 'ws+msgpack',
        codec: 'msgpack',
        harborRoot: path.join(this.harborRoot, replay.runId, replay.streamId)
      },
      events: replay.pendingEvents
    };

    const segmentMeta = replay.harborWriter.appendFrame({
      type: 'replay.v2.chunk',
      runId: replay.runId,
      streamId: replay.streamId,
      seqStart,
      seqEnd,
      final,
      events: replay.pendingEvents
    });
    payload.transport = {
      ...payload.transport,
      ...segmentMeta
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
    const finId = crypto.randomUUID();
    await this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.TRANSPORT_FIN, {
      finId,
      status,
      metadata
    }, { flushIfNeeded: false });
    await this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.SESSION_END, {
      status,
      metadata
    }, { flushIfNeeded: false });
    const result = await this.flushReplayV2Chunk({ final: true });
    const ack = await this.transportServer.requestFinAck(finId, {
      runId: replay.runId,
      streamId: replay.streamId
    });

    let ackSegment = null;
    let ackResult = null;
    if (ack?.ok) {
      await this.queueReplayLifecycle(REPLAY_V2_LIFECYCLE_EVENTS.TRANSPORT_ACK, {
        finId,
        ack
      }, { flushIfNeeded: false });
      ackSegment = replay.harborWriter.appendFrame({ type: 'TRANSPORT_ACK', finId, ack });
      ackResult = await this.flushReplayV2Chunk({ final: true });
    }

    this.replayV2 = null;
    return { ...result, ack, ackResult, ackSegment };
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

/**
 * Minimal Cypress node-events helper.
 *
 * Usage:
 *   setupNodeEvents(on, config) {
 *     return setupTestHarbor(on, config, { projectId: '<testharbor-project-id>' });
 *   }
 */
export function setupTestHarbor(on, config, options = {}) {
  if (typeof on !== 'function') {
    throw new Error('setupTestHarbor requires Cypress on() as first argument');
  }

  const projectId = asTrimmedString(options.projectId)
    || asTrimmedString(config?.env?.TESTHARBOR_PROJECT_ID)
    || asTrimmedString(process.env.TESTHARBOR_PROJECT_ID);

  if (!projectId) {
    throw new Error('setupTestHarbor requires projectId (options.projectId or TESTHARBOR_PROJECT_ID)');
  }

  const workspaceId = asTrimmedString(options.workspaceId)
    || asTrimmedString(config?.env?.TESTHARBOR_WORKSPACE_ID)
    || asTrimmedString(process.env.TESTHARBOR_WORKSPACE_ID);

  const ingestUrl = asTrimmedString(options.ingestUrl)
    || asTrimmedString(config?.env?.TESTHARBOR_INGEST_URL)
    || asTrimmedString(process.env.TESTHARBOR_INGEST_URL)
    || 'http://localhost:4010/v1/ingest/events';

  const token = asTrimmedString(options.token)
    || asTrimmedString(config?.env?.TESTHARBOR_INGEST_TOKEN)
    || asTrimmedString(process.env.TESTHARBOR_INGEST_TOKEN);

  const branch = asTrimmedString(options.branch)
    || asTrimmedString(process.env.GITHUB_REF_NAME)
    || asTrimmedString(process.env.CI_COMMIT_BRANCH)
    || asTrimmedString(process.env.BRANCH_NAME)
    || 'local';

  const commitSha = asTrimmedString(options.commitSha)
    || asTrimmedString(process.env.GITHUB_SHA)
    || asTrimmedString(process.env.CI_COMMIT_SHA)
    || 'local';

  const ciBuildId = asTrimmedString(options.ciBuildId)
    || asTrimmedString(process.env.GITHUB_RUN_ID)
    || asTrimmedString(process.env.CI_BUILD_ID)
    || asTrimmedString(process.env.BUILD_ID)
    || null;

  const runId = asTrimmedString(options.runId)
    || asTrimmedString(config?.env?.TESTHARBOR_RUN_ID)
    || asTrimmedString(process.env.TESTHARBOR_RUN_ID)
    || crypto.randomUUID();

  const client = new TestHarborReporterClient({
    ingestUrl,
    token,
    maxRetries: toNumber(options.maxRetries, 3),
    replayTransportPort: toNumber(options.replayTransportPort || config?.env?.TESTHARBOR_REPLAY_WS_PORT, 9223),
    harborRoot: asTrimmedString(options.harborRoot || config?.env?.TESTHARBOR_REPLAY_HARBOR_ROOT)
  });

  const specRunIds = new Map();
  const runMetrics = {
    passCount: 0,
    failCount: 0,
    flakyCount: 0,
    totalTests: 0,
    totalSpecs: 0
  };

  const sendSafe = async (type, payload) => {
    try {
      await client.send(type, payload);
    } catch (error) {
      const msg = String(error?.message || error);
      // eslint-disable-next-line no-console
      console.error(`[testharbor] failed to send ${type}: ${msg}`);
    }
  };

  on('task', {
    'testharbor:log'(entry) {
      // Keep API stable for tests that want to emit custom logs through cy.task().
      return entry || null;
    },
    async 'testharbor:replay:event'(entry) {
      return client.queueReplayEvent(entry || {});
    },
    async 'testharbor:replay:command'(entry) {
      return client.queueCommandEvent(entry || {});
    },
    async 'testharbor:replay:dom'(entry) {
      return client.queueDomEvent(entry || {});
    },
    async 'testharbor:replay:network'(entry) {
      return client.queueNetworkEvent(entry || {});
    },
    async 'testharbor:replay:console'(entry) {
      return client.queueConsoleEvent(entry || {});
    },
    async 'testharbor:replay:target:declare'(entry) {
      return client.declareReplayTarget(entry || {});
    },
    async 'testharbor:replay:target:bind'(entry) {
      return client.bindReplayTarget(entry || {});
    },
    async 'testharbor:replay:target:rebind'(entry) {
      return client.rebindReplayTarget(entry || {});
    },
    async 'testharbor:replay:target:orphan'(entry) {
      return client.markReplayTargetOrphan(entry || {});
    },
    async 'testharbor:replay:flush'() {
      return client.flushReplayV2Chunk();
    },
    async 'testharbor:replay:fin'(entry) {
      return client.endReplayV2(entry || {});
    }
  });

  on('before:run', async () => {
    await sendSafe(INGEST_EVENT_TYPES.RUN_STARTED, {
      runId,
      projectId,
      ...(workspaceId ? { workspaceId } : {}),
      ciProvider: 'cypress',
      ciBuildId,
      commitSha,
      branch,
      startedAt: toIso(),
      source: 'cypress.setupNodeEvents'
    });
  });

  on('before:spec', async (spec) => {
    const specPath = specPathFromSpec(spec);
    const specRunId = crypto.randomUUID();
    specRunIds.set(specPath, specRunId);
    runMetrics.totalSpecs += 1;

    client.startReplayV2({
      runId,
      streamId: specRunId,
      metadata: {
        specPath,
        transportPort: client.replayTransportPort
      }
    });
    await client.queueDomEvent({
      eventType: 'SPEC_BOUNDARY',
      phase: 'before:spec',
      specPath
    }, { flushIfNeeded: false });

    await sendSafe(INGEST_EVENT_TYPES.SPEC_STARTED, {
      specRunId,
      runId,
      specPath,
      startedAt: toIso()
    });
  });

  on('after:screenshot', async (details) => {
    const specPath = asTrimmedString(details?.specName) || asTrimmedString(details?.path) || 'unknown-spec';
    const specRunId = findSpecRunId(specRunIds, specPath);

    await sendSafe(INGEST_EVENT_TYPES.ARTIFACT_REGISTERED, {
      artifactId: crypto.randomUUID(),
      runId,
      ...(specRunId ? { specRunId } : {}),
      type: 'screenshot',
      storageKey: asTrimmedString(details?.path) || `screenshots/${Date.now()}.png`,
      contentType: 'image/png',
      byteSize: safeFileSize(details?.path)
    });

    return details;
  });

  on('after:spec', async (spec, results) => {
    const specPath = specPathFromSpec(spec);
    let specRunId = specRunIds.get(specPath) || findSpecRunId(specRunIds, specPath);

    if (!specRunId) {
      specRunId = crypto.randomUUID();
      specRunIds.set(specPath, specRunId);
      await sendSafe(INGEST_EVENT_TYPES.SPEC_STARTED, {
        specRunId,
        runId,
        specPath,
        startedAt: toIso()
      });
    }

    const tests = Array.isArray(results?.tests) ? results.tests : [];
    for (const test of tests) {
      const titleParts = Array.isArray(test?.title) ? test.title : [asTrimmedString(test?.title) || 'test'];
      const title = titleParts.join(' › ');
      const suitePath = titleParts.length > 1 ? titleParts.slice(0, -1).join(' › ') : null;

      const attempts = Array.isArray(test?.attempts) && test.attempts.length
        ? test.attempts
        : [{ state: test?.state, wallClockDuration: test?.wallClockDuration, error: test?.err }];

      const finalAttempt = attempts[attempts.length - 1] || null;
      const normalizedFinalState = normalizeResultState(finalAttempt?.state || test?.state);
      const hadFailure = attempts.some((attempt) => normalizeResultState(attempt?.state) === 'failed');

      let status = normalizedFinalState;
      if (normalizedFinalState === 'passed' && hadFailure) status = 'flaky';

      if (status === 'passed') runMetrics.passCount += 1;
      if (status === 'failed') runMetrics.failCount += 1;
      if (status === 'flaky') runMetrics.flakyCount += 1;
      runMetrics.totalTests += 1;

      const failureAttempt = attempts.find((attempt) => normalizeResultState(attempt?.state) === 'failed') || null;
      const fallbackFailure = extractFailure({ error: test?.displayError || test?.err });
      const extractedFailure = extractFailure(failureAttempt);
      const errorMessage = extractedFailure.message || fallbackFailure.message;
      const stacktrace = extractedFailure.stacktrace || fallbackFailure.stacktrace;

      const durationMs = attempts.reduce(
        (sum, attempt) => sum + toNumber(attempt?.wallClockDuration || attempt?.duration, 0),
        0
      ) || toNumber(test?.wallClockDuration, 0) || null;

      await sendSafe(INGEST_EVENT_TYPES.TEST_RESULT, {
        testResultId: crypto.randomUUID(),
        specRunId,
        projectId,
        stableTestKey: stableTestKey(specPath, title),
        title,
        filePath: specPath,
        suitePath,
        attemptNo: attempts.length,
        status,
        durationMs,
        errorHash: hashErrorMessage(errorMessage),
        errorMessage,
        stacktrace
      });
    }

    const screenshots = Array.isArray(results?.screenshots) ? results.screenshots : [];
    for (const shot of screenshots) {
      await sendSafe(INGEST_EVENT_TYPES.ARTIFACT_REGISTERED, {
        artifactId: crypto.randomUUID(),
        runId,
        specRunId,
        type: 'screenshot',
        storageKey: asTrimmedString(shot?.path) || asTrimmedString(shot?.name) || `screenshots/${Date.now()}.png`,
        contentType: 'image/png',
        byteSize: safeFileSize(shot?.path)
      });
    }

    if (results?.video) {
      await sendSafe(INGEST_EVENT_TYPES.ARTIFACT_REGISTERED, {
        artifactId: crypto.randomUUID(),
        runId,
        specRunId,
        type: 'video',
        storageKey: String(results.video),
        contentType: 'video/mp4',
        byteSize: safeFileSize(results.video)
      });
    }

    if (client.replayV2) {
      await client.queueDomEvent({
        eventType: 'SPEC_BOUNDARY',
        phase: 'after:spec',
        specPath
      }, { flushIfNeeded: false });
      await client.endReplayV2({
        status: specStatusFromSummary(results, runMetrics.failCount),
        metadata: {
          specPath,
          screenshots: screenshots.length,
          video: Boolean(results?.video)
        }
      });
    }

    await sendSafe(INGEST_EVENT_TYPES.SPEC_FINISHED, {
      specRunId,
      status: specStatusFromSummary(results, runMetrics.failCount),
      durationMs: toNumber(results?.stats?.duration, null),
      attempts: toNumber(results?.stats?.attempts, 1),
      finishedAt: toIso()
    });
  });

  on('after:run', async (results) => {
    if (client.replayV2) {
      await client.endReplayV2({
        status: runStatusFromSummary(results, runMetrics.failCount),
        metadata: { forcedClose: true }
      });
    }
    const totalSpecs = toNumber(results?.totalSuites, runMetrics.totalSpecs || specRunIds.size);
    const totalTests = toNumber(results?.totalTests, runMetrics.totalTests);
    const passCount = toNumber(results?.totalPassed, runMetrics.passCount);
    const failCount = toNumber(results?.totalFailed, runMetrics.failCount);
    const flakyCount = toNumber(results?.totalFlaky, runMetrics.flakyCount);

    await sendSafe(INGEST_EVENT_TYPES.RUN_FINISHED, {
      runId,
      status: runStatusFromSummary(results, failCount),
      totalSpecs,
      totalTests,
      passCount,
      failCount,
      flakyCount,
      finishedAt: toIso()
    });
  });

  config.env = {
    ...(config.env || {}),
    TESTHARBOR_RUN_ID: runId,
    TESTHARBOR_PROJECT_ID: projectId,
    ...(workspaceId ? { TESTHARBOR_WORKSPACE_ID: workspaceId } : {})
  };

  return config;
}

export const wireTestHarbor = setupTestHarbor;
export const setupTestHarborNodeEvents = setupTestHarbor;

export function withTestHarborCypress(options = {}) {
  return function setupNodeEvents(on, config) {
    return setupTestHarbor(on, config, options);
  };
}
