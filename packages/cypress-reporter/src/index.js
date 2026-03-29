import crypto from 'node:crypto';
import fs from 'node:fs';
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

    await sendSafe(INGEST_EVENT_TYPES.SPEC_FINISHED, {
      specRunId,
      status: specStatusFromSummary(results, runMetrics.failCount),
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
