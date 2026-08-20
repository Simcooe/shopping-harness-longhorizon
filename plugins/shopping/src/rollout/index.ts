/**
 * rollout 模块出口（冻结层）。
 */

export {
  FORBIDDEN_RECORD_KEYS,
  RolloutRecorder,
  ROLLOUT_SCHEMA_VERSION,
  makeRunId,
  sanitizeForRecord,
  type RolloutEvent,
  type RolloutRecord,
  type RolloutRecorderOptions,
  type StepRecord,
  type TerminalRecord,
  type ToolCallRecord,
} from "./recorder.ts";

export {
  TaskSourceError,
  assertInjectedTaskId,
  loadDevelopmentTaskSource,
  type DevelopmentTaskSource,
} from "./task_source.ts";

export {
  LiveConfigError,
  REQUIRED_MODEL_ENV_KEYS,
  assertMetadataHasNoSecrets,
  buildRunMetadata,
  missingModelEnvKeys,
  validateLiveTaskConfig,
  type LiveTaskConfig,
  type RunMetadata,
} from "./live_config.ts";
