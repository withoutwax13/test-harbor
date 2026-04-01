import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { INGEST_EVENT_TYPES } from '@testharbor/shared';

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
  const resolvedFilePath = resolveArtifactPath(filePath);
  if (!resolvedFilePath) return null;
  try {
    return fs.statSync(resolvedFilePath).size;
  } catch {
    return null;
  }
}

function resolveArtifactPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;

  const raw = String(filePath).trim();
  if (!raw) return null;

  const normalized = path.normalize(raw);
  const candidates = new Set();
  candidates.add(normalized);
  candidates.add(path.resolve(process.cwd(), normalized));

  if (!path.isAbsolute(normalized)) {
    candidates.add(path.join(process.cwd(), normalized));
    candidates.add(path.join(process.cwd(), 'cypress', normalized));
    candidates.add(path.join(process.cwd(), 'cypress', 'screenshots', path.basename(normalized)));
    candidates.add(path.join(process.cwd(), 'cypress', 'videos', path.basename(normalized)));
  }

  if (normalized.includes('..')) {
    const simplified = path.normalize(path.join(process.cwd(), normalized));
    candidates.add(simplified);
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }

  return null;
}

function readBinaryAsBase64(filePath, maxBytes = Number(process.env.TESTHARBOR_ARTIFACT_MAX_BASE64_BYTES || 100000000)) {
  const resolvedFilePath = resolveArtifactPath(filePath);
  if (!resolvedFilePath) return null;

  try {
    const buffer = fs.readFileSync(resolvedFilePath);
    const max = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Number.MAX_SAFE_INTEGER;
    if (!buffer || buffer.length === 0 || buffer.length > max) {
      return {
        buffer: null,
        byteSize: buffer.length || 0,
        reason: buffer.length > max ? 'size_limit' : 'empty',
        sourcePath: resolvedFilePath
      };
    }
    return {
      buffer,
      byteSize: buffer.length,
      contentBase64: buffer.toString('base64'),
      checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
      sourcePath: resolvedFilePath
    };
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

export class TestHarborReporterClient {
  constructor({ ingestUrl, token = null, maxRetries = 3 } = {}) {
    this.ingestUrl = ingestUrl || process.env.TESTHARBOR_INGEST_URL || 'http://localhost:4010/v1/ingest/events';
    this.token = token || process.env.TESTHARBOR_INGEST_TOKEN || null;
    this.maxRetries = maxRetries;
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
    maxRetries: toNumber(options.maxRetries, 3)
  });

  const specRunIds = new Map();
  const runMetrics = {
    passCount: 0,
    failCount: 0,
    flakyCount: 0,
    totalTests: 0,
    totalSpecs: 0
  };

  const artifactMaxBytes = toNumber(
    process.env.TESTHARBOR_ARTIFACT_MAX_BASE64_BYTES,
    100000000
  );
  const replayQueue = [];
  const registeredArtifactDedupeKeys = new Set();
  const replayFlushDebounceMs = Math.max(10, toNumber(process.env.TESTHARBOR_REPLAY_FLUSH_DEBOUNCE_MS, 200));
  const replayMaxEventsPerChunk = Math.max(10, toNumber(process.env.TESTHARBOR_REPLAY_MAX_EVENTS_PER_CHUNK, 200));
  const replayMaxChunkBytes = Math.max(8 * 1024, toNumber(process.env.TESTHARBOR_REPLAY_MAX_CHUNK_BYTES, 256 * 1024));
  let replayFlushTimer = null;
  let replayFlushInFlight = null;
  let replayFlushContext = {};
  let replayEventSeq = 0;
  let pendingReplayMeta = {
    clientChunkSeq: null,
    compression: 'none',
    encodedBytes: null,
    droppedEvents: 0,
    droppedEventsTotal: 0,
    truncatedEvents: 0
  };

  function pushReplayEvent(event = {}) {
    if (!event || typeof event !== 'object') return null;
    const payloadObj = event.payload && typeof event.payload === 'object' ? event.payload : null;
    let payloadPreview = null;
    if (payloadObj) {
      try {
        payloadPreview = asTrimmedString(JSON.stringify(payloadObj).slice(0, 1200));
      } catch {
        payloadPreview = '[payload_unserializable]';
      }
    }
    const detailFallback = asTrimmedString(event.detail)
      || asTrimmedString(event.message)
      || asTrimmedString(payloadObj?.detail)
      || asTrimmedString(payloadObj?.message)
      || payloadPreview;

    replayEventSeq += 1;
    const normalizedTs = toIso(event.ts || event.at || new Date());
    const providedSeq = Number.isFinite(Number(event.eventSeq ?? payloadObj?.eventSeq)) ? Number(event.eventSeq ?? payloadObj?.eventSeq) : null;
    const enriched = {
      type: asTrimmedString(event.type) || 'replay.event',
      event_type: asTrimmedString(event.event_type || payloadObj?.event_type) || asTrimmedString(event.type) || 'replay.event',
      ts: normalizedTs,
      title: asTrimmedString(event.title || event.name || event.command) || null,
      detail: detailFallback,
      command: event.command || payloadObj?.command || null,
      status: asTrimmedString(event.status || payloadObj?.status || payloadObj?.state) || null,
      eventId: asTrimmedString(event.eventId || payloadObj?.eventId) || null,
      eventSeq: providedSeq ?? replayEventSeq,
      seq: providedSeq ?? replayEventSeq,
      tsEpochMs: Number.isFinite(Number(event.tsEpochMs ?? payloadObj?.tsEpochMs)) ? Number(event.tsEpochMs ?? payloadObj?.tsEpochMs) : null,
      tsPerfMs: Number.isFinite(Number(event.tsPerfMs ?? payloadObj?.tsPerfMs)) ? Number(event.tsPerfMs ?? payloadObj?.tsPerfMs) : null,
      stepId: asTrimmedString(event.stepId || payloadObj?.stepId) || null,
      phase: asTrimmedString(event.phase || payloadObj?.phase) || null,
      runId,
      specRunId: asTrimmedString(event.specRunId || payloadObj?.specRunId || payloadObj?.spec_run_id) || null,
      specPath: asTrimmedString(event.specPath || payloadObj?.specPath || payloadObj?.spec_path) || null,
      testResultId: asTrimmedString(event.testResultId || payloadObj?.testResultId || payloadObj?.test_result_id) || null,
      payload: payloadObj || null,
      console: Array.isArray(event.console)
        ? event.console
        : Array.isArray(payloadObj?.console)
          ? payloadObj.console
          : [],
      network: Array.isArray(event.network)
        ? event.network
        : Array.isArray(payloadObj?.network)
          ? payloadObj.network
          : [],
      domSnapshot: asTrimmedString(event.domSnapshot || payloadObj?.domSnapshot) || null
    };
    replayQueue.push(enriched);
    return enriched;
  }


  function mergeReplayMeta(meta = {}) {
    if (!meta || typeof meta !== 'object') return;
    const asNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    pendingReplayMeta = {
      ...pendingReplayMeta,
      ...(meta.clientChunkSeq != null ? { clientChunkSeq: Number(meta.clientChunkSeq) } : {}),
      ...(meta.compression ? { compression: String(meta.compression) } : {}),
      ...(meta.encodedBytes != null && Number.isFinite(Number(meta.encodedBytes)) ? { encodedBytes: Number(meta.encodedBytes) } : {}),
      droppedEvents: Math.max(0, asNum(pendingReplayMeta.droppedEvents) + asNum(meta.droppedEvents)),
      droppedEventsTotal: Math.max(asNum(pendingReplayMeta.droppedEventsTotal), asNum(meta.droppedEventsTotal), asNum(meta.droppedEvents)),
      truncatedEvents: Math.max(0, asNum(pendingReplayMeta.truncatedEvents) + asNum(meta.truncatedEvents))
    };
  }

  function mergeReplayFlushContext(context = {}) {
    if (!context || typeof context !== 'object') return;
    replayFlushContext = {
      ...replayFlushContext,
      ...(context.specRunId ? { specRunId: context.specRunId } : {}),
      ...(context.testResultId ? { testResultId: context.testResultId } : {})
    };
    if (context.replayMeta) mergeReplayMeta(context.replayMeta);
  }


  function estimateEventBytes(event) {
    try {
      return Buffer.byteLength(JSON.stringify(event), 'utf8');
    } catch {
      return 1024;
    }
  }

  function drainReplayBatch() {
    if (!replayQueue.length) return [];
    const out = [];
    let bytes = 0;
    while (replayQueue.length && out.length < replayMaxEventsPerChunk) {
      const next = replayQueue[0];
      const nextBytes = estimateEventBytes(next);
      if (out.length > 0 && (bytes + nextBytes) > replayMaxChunkBytes) break;
      out.push(replayQueue.shift());
      bytes += nextBytes;
      if (bytes >= replayMaxChunkBytes) break;
    }
    return out;
  }


  function estimateEventsBytes(events = []) {
    try {
      return Buffer.byteLength(JSON.stringify(events), 'utf8');
    } catch {
      return 0;
    }
  }

  function clearReplayFlushTimer() {
    if (replayFlushTimer) {
      clearTimeout(replayFlushTimer);
      replayFlushTimer = null;
    }
  }

  function scheduleReplayFlush(context = {}) {
    mergeReplayFlushContext(context);
    if (replayFlushTimer) return;
    replayFlushTimer = setTimeout(() => {
      replayFlushTimer = null;
      void flushReplayChunk().catch(() => {});
    }, replayFlushDebounceMs);
  }

  async function flushReplayChunk(context = {}) {
    mergeReplayFlushContext(context);
    clearReplayFlushTimer();

    if (replayFlushInFlight) {
      await replayFlushInFlight;
    }

    if (!replayQueue.length) return;

    const flushContext = replayFlushContext;
    replayFlushContext = {};

    replayFlushInFlight = (async () => {
      let firstBatch = true;
      while (replayQueue.length) {
        const events = drainReplayBatch();
        if (!events.length) break;
        const encodedBytes = estimateEventsBytes(events);
        const batchMeta = {
          compression: pendingReplayMeta.compression || 'none',
          encodedBytes,
          droppedEvents: firstBatch ? Number(pendingReplayMeta.droppedEvents || 0) : 0,
          droppedEventsTotal: firstBatch ? Number(pendingReplayMeta.droppedEventsTotal || 0) : Number(pendingReplayMeta.droppedEventsTotal || 0),
          truncatedEvents: firstBatch ? Number(pendingReplayMeta.truncatedEvents || 0) : 0,
          ...(firstBatch && pendingReplayMeta.clientChunkSeq != null ? { clientChunkSeq: Number(pendingReplayMeta.clientChunkSeq) } : {})
        };
        await sendSafe(INGEST_EVENT_TYPES.REPLAY_CHUNK, {
          runId,
          ...(flushContext.specRunId ? { specRunId: flushContext.specRunId } : {}),
          ...(flushContext.testResultId ? { testResultId: flushContext.testResultId } : {}),
          events,
          meta: batchMeta
        });
        firstBatch = false;
      }
      pendingReplayMeta = {
        clientChunkSeq: null,
        compression: 'none',
        encodedBytes: null,
        droppedEvents: 0,
        droppedEventsTotal: Number(pendingReplayMeta.droppedEventsTotal || 0),
        truncatedEvents: 0
      };
    })();

    try {
      await replayFlushInFlight;
    } finally {
      replayFlushInFlight = null;
    }
  }

  async function registerArtifact(opts = {}) {
    const artifactId = opts.artifactId || crypto.randomUUID();
    const type = asTrimmedString(opts.type) || 'artifact';
    const filePath = asTrimmedString(opts.filePath);
    const dedupeKey = asTrimmedString(opts.dedupeKey);
    if (dedupeKey && registeredArtifactDedupeKeys.has(dedupeKey)) {
      return { artifactId, payload: null, uploaded: false, skipped: true, reason: 'duplicate' };
    }

    const payload = {
      artifactId,
      runId,
      ...(opts.specRunId ? { specRunId: opts.specRunId } : {}),
      ...(opts.testResultId ? { testResultId: opts.testResultId } : {}),
      type,
      storageKey: asTrimmedString(opts.storageKey) || `${type}/${Date.now()}.bin`,
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
      ...(opts.byteSize != null ? { byteSize: opts.byteSize } : {}),
      ...(opts.checksum ? { checksum: opts.checksum } : {})
    };

    const file = readBinaryAsBase64(filePath, artifactMaxBytes);
    if (file && file.contentBase64) {
      payload.contentBase64 = file.contentBase64;
      payload.byteSize = file.byteSize;
      payload.checksum = file.checksum;
    }

    await sendSafe(INGEST_EVENT_TYPES.ARTIFACT_REGISTERED, payload);
    if (dedupeKey) registeredArtifactDedupeKeys.add(dedupeKey);
    return {
      artifactId,
      payload,
      uploaded: Boolean(file && file.contentBase64),
      skipped: false,
      reason: file && !file.contentBase64 ? 'inline_skipped_or_missing' : null
    };
  }


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
      pushReplayEvent({ type: 'log', title: 'cy.task testharbor:log', detail: entry });
      return entry || null;
    },
    'testharbor:replay' (entry) {
      if (entry && typeof entry === 'object') {
        const fallbackSpecPath = asTrimmedString(entry.specPath);
        const fallbackSpecRunId = findSpecRunId(specRunIds, fallbackSpecPath) || null;
        const events = Array.isArray(entry.events)
          ? entry.events
          : [entry];

        let flushSpecRunId = fallbackSpecRunId;
        for (const event of events) {
          const eventSpecPath = asTrimmedString(event?.specPath) || fallbackSpecPath || null;
          const eventSpecRunId = findSpecRunId(specRunIds, eventSpecPath) || fallbackSpecRunId || null;
          if (eventSpecRunId) flushSpecRunId = eventSpecRunId;

          pushReplayEvent({
            ...event,
            ...(eventSpecPath ? { specPath: eventSpecPath } : {}),
            ...(eventSpecRunId ? { specRunId: eventSpecRunId } : {}),
            title: event?.title || event?.name,
            ts: toIso(event?.ts || entry?.at || new Date()),
            status: event?.status || event?.payload?.status || event?.payload?.state || null
          });
        }

        const replayMeta = entry.meta && typeof entry.meta === 'object' ? entry.meta : null;
        scheduleReplayFlush({
          ...(flushSpecRunId ? { specRunId: flushSpecRunId } : {}),
          ...(replayMeta ? { replayMeta } : {})
        });
        if (replayQueue.length >= replayMaxEventsPerChunk) {
          void flushReplayChunk({
            ...(flushSpecRunId ? { specRunId: flushSpecRunId } : {}),
            ...(replayMeta ? { replayMeta } : {})
          }).catch(() => {});
        }
      }
      return entry || null;
    }
  });

  on('before:run', async () => {
    pushReplayEvent({
      type: 'replay.run.started',
      title: 'Run started',
      detail: `Run ${runId} started`,
      payload: {
        runId,
        projectId,
        workspaceId: workspaceId || null,
        branch,
        commitSha,
        ciBuildId
      }
    });

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

    await flushReplayChunk();
  });

  on('before:spec', async (spec) => {
    const specPath = specPathFromSpec(spec);
    const specRunId = crypto.randomUUID();
    specRunIds.set(specPath, specRunId);
    runMetrics.totalSpecs += 1;

    pushReplayEvent({
      type: 'replay.spec.started',
      title: specPath,
      detail: 'Spec started',
      payload: { specPath, specRunId, runId }
    });

    await sendSafe(INGEST_EVENT_TYPES.SPEC_STARTED, {
      specRunId,
      runId,
      specPath,
      startedAt: toIso()
    });

    scheduleReplayFlush({ specRunId });
  });

  on('after:screenshot', async (details) => {
    const specPath = asTrimmedString(details?.specName) || asTrimmedString(details?.path) || 'unknown-spec';
    const specRunId = findSpecRunId(specRunIds, specPath);

    const storageKey = asTrimmedString(details?.path) || `screenshots/${Date.now()}.png`;
    const dedupeKey = `screenshot:${storageKey}:${runId}`;
    await registerArtifact({
      artifactId: crypto.randomUUID(),
      runId,
      specRunId,
      type: 'screenshot',
      storageKey,
      contentType: 'image/png',
      byteSize: safeFileSize(details?.path),
      filePath: details?.path,
      dedupeKey
    });

    pushReplayEvent({
      type: 'replay.screenshot',
      title: 'screenshot',
      detail: `screenshot ${storageKey}`,
      command: storageKey,
      payload: {
        path: storageKey
      }
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

      const testResultId = crypto.randomUUID();
      await sendSafe(INGEST_EVENT_TYPES.TEST_RESULT, {
        testResultId,
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

      pushReplayEvent({
        type: 'replay.test.result',
        title,
        detail: `${status.toUpperCase()} · ${durationMs ? `${durationMs}ms` : 'duration n/a'}`,
        payload: {
          runId,
          specRunId,
          testResultId,
          specPath,
          suitePath,
          status,
          durationMs,
          attemptNo: attempts.length,
          errorMessage: errorMessage || null
        }
      });
    }

    const screenshots = Array.isArray(results?.screenshots) ? results.screenshots : [];
    for (const shot of screenshots) {
      const shotPath = asTrimmedString(shot?.path) || asTrimmedString(shot?.name);
      const storageKey = shotPath || `screenshots/${Date.now()}.png`;
      const dedupeKey = `screenshot:${storageKey}:${runId}`;
      await registerArtifact({
        artifactId: crypto.randomUUID(),
        runId,
        specRunId,
        type: 'screenshot',
        storageKey,
        contentType: 'image/png',
        filePath: shotPath,
        dedupeKey
      });
    }

    if (results?.video) {
      const videoPath = asTrimmedString(results.video);
      const storageKey = videoPath || `videos/${Date.now()}.mp4`;
      await registerArtifact({
        artifactId: crypto.randomUUID(),
        runId,
        specRunId,
        type: 'video',
        storageKey,
        contentType: 'video/mp4',
        filePath: videoPath,
        dedupeKey: `video:${storageKey}:${runId}`
      });
      if (videoPath) {
        pushReplayEvent({
          type: 'replay.video',
          title: 'video',
          detail: `video ${videoPath}`,
          command: 'video-artifact',
          payload: { path: videoPath }
        });
      }
    }

    const specStatus = specStatusFromSummary(results, runMetrics.failCount);
    pushReplayEvent({
      type: 'replay.spec.finished',
      title: specPath,
      detail: `Spec ${specStatus}`,
      payload: {
        runId,
        specRunId,
        specPath,
        status: specStatus,
        testsInSpec: tests.length,
        passCount: tests.filter((t) => normalizeResultState((Array.isArray(t?.attempts) && t.attempts.length ? t.attempts.at(-1)?.state : t?.state)) === 'passed').length,
        failCount: tests.filter((t) => normalizeResultState((Array.isArray(t?.attempts) && t.attempts.length ? t.attempts.at(-1)?.state : t?.state)) === 'failed').length,
        screenshotCount: screenshots.length,
        hasVideo: Boolean(results?.video)
      }
    });

    await flushReplayChunk({ specRunId });

    await sendSafe(INGEST_EVENT_TYPES.SPEC_FINISHED, {
      specRunId,
      status: specStatus,
      durationMs: toNumber(results?.stats?.duration, null),
      attempts: toNumber(results?.stats?.attempts, 1),
      finishedAt: toIso()
    });
  });

  on('after:run', async (results) => {
    const totalSpecs = toNumber(results?.totalSuites, runMetrics.totalSpecs || specRunIds.size);
    const totalTests = toNumber(results?.totalTests, runMetrics.totalTests);
    const passCount = toNumber(results?.totalPassed, runMetrics.passCount);
    const failCount = toNumber(results?.totalFailed, runMetrics.failCount);
    const flakyCount = toNumber(results?.totalFlaky, runMetrics.flakyCount);
    const status = runStatusFromSummary(results, failCount);

    pushReplayEvent({
      type: 'replay.run.finished',
      title: `Run ${status}`,
      detail: `${totalTests} tests · ${passCount} passed · ${failCount} failed · ${flakyCount} flaky`,
      payload: {
        runId,
        status,
        totalSpecs,
        totalTests,
        passCount,
        failCount,
        flakyCount
      }
    });

    await flushReplayChunk();

    await sendSafe(INGEST_EVENT_TYPES.RUN_FINISHED, {
      runId,
      status,
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

export { installTestHarborReplayHooks } from './support.js';
