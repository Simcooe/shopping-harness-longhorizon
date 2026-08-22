/**
 * evidence 模块出口（冻结基础设施）。
 */

export {
  AGENT_SYMPTOMS,
  CANDIDATE_EDITABLE_SURFACES,
  EVIDENCE_FORBIDDEN_KEYS,
  EVIDENCE_RUN_ID_PATTERN,
  EVIDENCE_SCHEMA_VERSION,
  EVALUATOR_RECORD_ALLOWED_KEYS,
  EXECUTION_STATUSES,
  FAILURE_REWARD_TYPES,
  H0_TOOL_NAMES,
  SAFE_TERMINAL_REASONS,
  SUCCESS_REWARD_TYPES,
  type AgentSymptom,
  type EvidenceManifest,
  type EvidenceScope,
  type EvidenceSource,
  type ExecutionStatus,
  type FailureCluster,
  type FailureSignature,
  type HeldInEvidence,
  type H0ToolName,
  type RepresentativeRun,
  type SafeTerminalReason,
  type SafeTraceSummary,
} from "./schema.ts";

export {
  EvidenceBuildError,
  buildFailureEvidence,
  buildHeldInEvidence,
  writeEvidenceBundle,
  type BuildFailureEvidenceOptions,
  type BuildFailureEvidenceResult,
} from "./build.ts";
