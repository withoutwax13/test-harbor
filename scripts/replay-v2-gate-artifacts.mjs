import fs from 'node:fs/promises';
import path from 'node:path';
import {
  REPLAY_V2_EVENT_KINDS,
  REPLAY_V2_LIFECYCLE_EVENTS,
  buildReplayV2SeekIndex,
  evaluateReplayV2GateMetrics
} from '../packages/shared/src/index.js';

const outDir = process.argv[2] || path.join(process.cwd(), 'artifacts');
await fs.mkdir(outDir, { recursive: true });

const runId = '00000000-0000-4000-8000-000000000001';
const streamId = 'gate-sample';
const targetId = 'tgt_sample_primary';
const startedAt = new Date('2026-04-03T00:00:00.000Z').getTime();

const events = [];
let seq = 1;
function push(kind, payload = {}, extra = {}) {
  events.push({
    runId,
    streamId,
    seq,
    monotonicTs: seq * 10,
    ts: new Date(startedAt + (seq * 10)).toISOString(),
    kind,
    payload,
    ...extra
  });
  seq += 1;
}

push(REPLAY_V2_EVENT_KINDS.LIFECYCLE, { eventType: REPLAY_V2_LIFECYCLE_EVENTS.SESSION_START });
push(REPLAY_V2_EVENT_KINDS.LIFECYCLE, { eventType: REPLAY_V2_LIFECYCLE_EVENTS.TARGET_DECLARE, selectorBundle: { primary: { dataTestId: 'checkout-button' } } }, {
  targetRef: { targetId, selectorVersion: 1 }
});
push(REPLAY_V2_EVENT_KINDS.LIFECYCLE, { eventType: REPLAY_V2_LIFECYCLE_EVENTS.TARGET_BIND, selectorBundle: { primary: { dataTestId: 'checkout-button' } } }, {
  targetRef: { targetId, selectorVersion: 1 }
});

for (let index = 0; index < 294; index += 1) {
  push(REPLAY_V2_EVENT_KINDS.COMMAND, {
    eventType: 'CLICK',
    targetSnapshot: { targetId }
  }, {
    commandId: `cmd_${index + 1}`,
    targetRef: { targetId, selectorVersion: 1 }
  });
}

push(REPLAY_V2_EVENT_KINDS.LIFECYCLE, { eventType: REPLAY_V2_LIFECYCLE_EVENTS.TRANSPORT_FIN, finId: 'fin_sample' });
push(REPLAY_V2_EVENT_KINDS.LIFECYCLE, { eventType: REPLAY_V2_LIFECYCLE_EVENTS.TRANSPORT_ACK, finId: 'fin_sample' });
push(REPLAY_V2_EVENT_KINDS.LIFECYCLE, { eventType: REPLAY_V2_LIFECYCLE_EVENTS.SESSION_END });

const metrics = evaluateReplayV2GateMetrics(events);
const seekIndex = buildReplayV2SeekIndex(events, { stride: 50 });
const artifact = {
  generatedAt: new Date().toISOString(),
  runId,
  streamId,
  eventCount: events.length,
  seekCheckpointCount: seekIndex.length,
  metrics,
  thresholds: {
    replayLoadUnder3s: 'deferred-to-runtime',
    commandToDomAlignmentMin: 0.95,
    targetStabilityMin: 0.98
  }
};

const outPath = path.join(outDir, 'replay-v2-gate-artifacts.json');
await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, outPath, eventCount: events.length, checkpointCount: seekIndex.length }, null, 2));
