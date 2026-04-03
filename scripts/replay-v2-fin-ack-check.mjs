import fs from 'node:fs/promises';
import path from 'node:path';
import {
  REPLAY_V2_EVENT_KINDS,
  REPLAY_V2_LIFECYCLE_EVENTS,
  decodeMessagePack
} from '../packages/shared/src/index.js';

function decodeHarborPayload(payload) {
  try {
    return decodeMessagePack(payload);
  } catch {
    try {
      return JSON.parse(payload.toString('utf8'));
    } catch {
      return null;
    }
  }
}

async function readHarborFrames(segmentDir) {
  const entries = (await fs.readdir(segmentDir))
    .filter((entry) => entry.endsWith('.harbor'))
    .sort();
  const frames = [];

  for (const entry of entries) {
    const filePath = path.join(segmentDir, entry);
    const buffer = await fs.readFile(filePath);
    let offset = 0;

    while (offset + 4 <= buffer.length) {
      const len = buffer.readUInt32BE(offset);
      offset += 4;
      if (len < 0 || offset + len > buffer.length) {
        throw new Error(`invalid_harbor_frame_length:${entry}:${len}`);
      }

      const payload = buffer.subarray(offset, offset + len);
      offset += len;

      const decoded = decodeHarborPayload(payload);
      if (decoded) {
        frames.push(decoded);
      }
    }
  }

  return frames;
}

function findLifecycleEvent(frame, expectedType) {
  const events = Array.isArray(frame?.events) ? frame.events : [];
  return events.find((event) => (
    event?.kind === REPLAY_V2_EVENT_KINDS.LIFECYCLE
    && event?.payload?.eventType === expectedType
  )) || null;
}

function extractFin(frame) {
  if (frame?.type === 'TRANSPORT_FIN') {
    return { source: 'transport', finId: frame.finId || null };
  }
  const lifecycle = findLifecycleEvent(frame, REPLAY_V2_LIFECYCLE_EVENTS.TRANSPORT_FIN);
  if (lifecycle) {
    return { source: 'lifecycle', finId: lifecycle?.payload?.finId || null };
  }
  return null;
}

function extractAck(frame) {
  if (frame?.type === 'TRANSPORT_ACK') {
    return { source: 'transport', finId: frame.finId || null };
  }
  const lifecycle = findLifecycleEvent(frame, REPLAY_V2_LIFECYCLE_EVENTS.TRANSPORT_ACK);
  if (lifecycle) {
    return { source: 'lifecycle', finId: lifecycle?.payload?.finId || null };
  }
  return null;
}

const segmentDir = process.argv[2];
if (!segmentDir) {
  console.error('usage: node scripts/replay-v2-fin-ack-check.mjs <segment-dir>');
  process.exit(1);
}

const frames = await readHarborFrames(segmentDir);
const finCandidates = frames.map(extractFin).filter(Boolean);
const ackCandidates = frames.map(extractAck).filter(Boolean);

const finSeen = finCandidates.length > 0;
const ackSeen = ackCandidates.length > 0;

function findCorrelatedPair(fins, acks) {
  for (const fin of fins) {
    for (const ack of acks) {
      if (!fin.finId || !ack.finId || fin.finId === ack.finId) {
        return { fin, ack, matched: true };
      }
    }
  }
  return { fin: fins[0] || null, ack: acks[0] || null, matched: false };
}

const correlation = findCorrelatedPair(finCandidates, ackCandidates);
const finInfo = correlation.fin;
const ackInfo = correlation.ack;
const finId = finInfo?.finId || null;
const ackFinId = ackInfo?.finId || null;
const finAckMatch = Boolean(finSeen && ackSeen && correlation.matched);

const result = {
  ok: Boolean(finSeen && ackSeen && finAckMatch),
  frameCount: frames.length,
  finSeen,
  ackSeen,
  finId,
  ackFinId,
  finAckMatch,
  finCandidateCount: finCandidates.length,
  ackCandidateCount: ackCandidates.length,
  finSource: finInfo?.source || null,
  ackSource: ackInfo?.source || null
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
