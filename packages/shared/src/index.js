export const INGEST_EVENT_TYPES = {
  RUN_STARTED: 'run.started',
  RUN_FINISHED: 'run.finished',
  SPEC_STARTED: 'spec.started',
  SPEC_FINISHED: 'spec.finished',
  TEST_RESULT: 'test.result',
  ARTIFACT_REGISTERED: 'artifact.registered',
  HEARTBEAT: 'heartbeat',
  REPLAY_V2_CHUNK: 'replay.v2.chunk'
};

export function isValidIngestType(type) {
  return Object.values(INGEST_EVENT_TYPES).includes(type);
}

export {
  REPLAY_V2_SCHEMA_VERSION,
  REPLAY_V2_EVENT_KINDS,
  normalizeReplayV2SelectorBundle,
  getStableReplayV2TargetId,
  createReplayV2MonotonicClock,
  createReplayV2SequenceTracker,
  createReplayV2TargetRegistry,
  assertReplayV2EventPayload,
  assertReplayV2ChunkPayload
} from './replay-v2.js';
