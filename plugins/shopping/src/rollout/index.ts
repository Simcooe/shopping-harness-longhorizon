/**
 * rollout 模块出口（冻结层）。
 */

export {
  ACTOR_TRACE_SCHEMA_VERSION,
  FORBIDDEN_RECORD_KEYS,
  RolloutRecorder,
  makeRunId,
  sanitizeForRecord,
  type ActorEvent,
  type ActorRecord,
  type ActorRecordBase,
  type GuardRejectionRecord,
  type ObservationRecord,
  type RolloutRecorderOptions,
  type RunStartRecord,
  type TaskInstructionRecord,
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

export {
  EVALUATOR_SCHEMA_VERSION,
  EvaluatorCollector,
  FAILURE_LABELS,
  writeEvaluatorRecord,
  type EvaluatorRecord,
  type FailureLabel,
} from "./evaluator_record.ts";

export {
  BOOTSTRAP_SCHEMA_VERSION,
  BootstrapAlreadyExistsError,
  BootstrapError,
  BootstrapNotFoundError,
  BootstrapReadError,
  assertValidOutputPath,
  assertValidRunId,
  buildBootstrap,
  buildInitialTaskPrompt,
  buildReleasePayload,
  loadBootstrap,
  resolveBootstrapPath,
  resolveRecoveryPath,
  writeBootstrap,
  writeRecoveryRecord,
  type BootstrapErrorCode,
  type BootstrapSession,
} from "./bootstrap.ts";
