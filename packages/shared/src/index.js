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
  REPLAY_V2_SCHEMA_VERSION_COMPAT,
  REPLAY_V2_SEEK_STRIDE,
  REPLAY_V2_TARGET_RESOLUTION_ORDER,
  REPLAY_V2_EVENT_KINDS,
  REPLAY_V2_LIFECYCLE_EVENTS,
  normalizeReplayV2SelectorBundle,
  getStableReplayV2TargetId,
  createReplayV2MonotonicClock,
  createReplayV2SequenceTracker,
  createReplayV2TargetRegistry,
  normalizeReplayV2EventPayload,
  assertReplayV2EventPayload,
  assertReplayV2ChunkPayload,
  applyReplayV2EventToTargetRegistry,
  buildReplayV2SeekIndex,
  resolveReplayV2TargetStateAtSeq,
  evaluateReplayV2GateMetrics,
  encodeMessagePack,
  decodeMessagePack
} from './replay-v2.js';
