export const INGEST_EVENT_TYPES = {
  RUN_STARTED: 'run.started',
  RUN_FINISHED: 'run.finished',
  SPEC_STARTED: 'spec.started',
  SPEC_FINISHED: 'spec.finished',
  TEST_RESULT: 'test.result',
  ARTIFACT_REGISTERED: 'artifact.registered',
  REPLAY_CHUNK: 'replay.chunk',
  HEARTBEAT: 'heartbeat'
};

export function isValidIngestType(type) {
  return Object.values(INGEST_EVENT_TYPES).includes(type);
}
