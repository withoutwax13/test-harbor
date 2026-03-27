import crypto from "node:crypto";
const ingestBase = process.env.INGEST_BASE_URL || 'http://localhost:4010';
const workspaceId = process.env.SMOKE_WORKSPACE_ID || '00000000-0000-0000-0000-000000000001';
const projectId = process.env.SMOKE_PROJECT_ID || '00000000-0000-0000-0000-000000000002';

async function post(body) {
  const res = await fetch(`${ingestBase}/v1/ingest/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const runId = crypto.randomUUID();
const specRunId = crypto.randomUUID();
const idempotencyKey = `contract-${crypto.randomUUID()}`;

// 0) ensure parent run exists (FK-safe for spec.started)
const runStart = await post({
  type: 'run.started',
  idempotencyKey: `contract-run-${crypto.randomUUID()}`,
  payload: {
    runId,
    workspaceId,
    projectId,
    branch: 'contract',
    commitSha: 'contract-smoke',
    ciProvider: 'local'
  }
});
assert(runStart.status === 202, `expected 202 run.started, got ${runStart.status} ${JSON.stringify(runStart.body)}`);

// 1) first acceptance
const first = await post({
  type: 'spec.started',
  idempotencyKey,
  payload: {
    specRunId,
    runId,
    specPath: 'contract/spec.cy.ts'
  }
});
assert(first.status === 202, `expected 202 first, got ${first.status} ${JSON.stringify(first.body)}`);
assert(first.body?.ok === true && first.body?.duplicate === false, 'first response shape mismatch');

// 2) duplicate idempotency
const dup = await post({
  type: 'spec.started',
  idempotencyKey,
  payload: {
    specRunId,
    runId,
    specPath: 'contract/spec.cy.ts'
  }
});
assert(dup.status === 200, `expected 200 duplicate, got ${dup.status} ${JSON.stringify(dup.body)}`);
assert(dup.body?.ok === true && dup.body?.duplicate === true, 'duplicate response shape mismatch');

// 3) unsupported event type
const badType = await post({
  type: 'not.a.real.type',
  idempotencyKey: `bad-type-${crypto.randomUUID()}`,
  payload: { x: 1 }
});
assert(badType.status === 400, `expected 400 for bad type, got ${badType.status} ${JSON.stringify(badType.body)}`);
assert(String(badType.body?.error || '').startsWith('unsupported_event_type:'), 'bad type error mismatch');

// 4) missing payload for valid type
const badPayload = await post({
  type: 'run.started',
  idempotencyKey: `bad-payload-${crypto.randomUUID()}`,
  payload: {
    runId: crypto.randomUUID()
  }
});
assert(badPayload.status === 400, `expected 400 for invalid payload, got ${badPayload.status} ${JSON.stringify(badPayload.body)}`);
assert(badPayload.body?.error === 'validation_error', 'invalid payload error envelope mismatch');
assert(Array.isArray(badPayload.body?.details?.missing), 'missing fields detail not present');

console.log(JSON.stringify({
  ok: true,
  checks: {
    runStarted: runStart.status,
    firstAccepted: first.status,
    duplicateAccepted: dup.status,
    badTypeRejected: badType.status,
    badPayloadRejected: badPayload.status
  },
  ingestBase
}, null, 2));
