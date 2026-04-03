import fs from 'node:fs/promises';
import path from 'node:path';

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
      const payload = buffer.subarray(offset, offset + len);
      offset += len;
      frames.push(JSON.parse(payload.toString('utf8')));
    }
  }

  return frames;
}

const segmentDir = process.argv[2];
if (!segmentDir) {
  console.error('usage: node scripts/replay-v2-fin-ack-check.mjs <segment-dir>');
  process.exit(1);
}

const frames = await readHarborFrames(segmentDir);
const finFrame = frames.find((frame) => frame.type === 'TRANSPORT_FIN'
  || frame.events?.some((event) => event.payload?.eventType === 'TRANSPORT_FIN')
  || frame.final === true) || null;
const ackFrame = frames.find((frame) => frame.type === 'TRANSPORT_ACK'
  || frame.events?.some((event) => event.payload?.eventType === 'TRANSPORT_ACK')) || null;

const result = {
  ok: Boolean(finFrame),
  frameCount: frames.length,
  finSeen: Boolean(finFrame),
  ackSeen: Boolean(ackFrame)
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.finSeen ? 0 : 2);
