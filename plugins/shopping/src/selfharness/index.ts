/**
 * self-harness 模块出口（冻结基础设施：gate / lineage / profile patch）。
 */

export {
  SUCCESS_REWARD_TYPES,
  countInfraFailures,
  countSuccess,
  evaluateGateV1,
  isInfraFailure,
  isSuccess,
  type EvalOutcome,
  type GateDecision,
  type GateInput,
  type GateRuleResult,
} from "./gate.ts";

export {
  buildLineage,
  type BuildLineageInput,
  type LineageMetrics,
  type LineageModelIdentity,
  type LineageRecord,
} from "./lineage.ts";

export {
  MODEL_PROVIDER,
  buildEffectiveProfilePatch,
  parseProfilePatchText,
  renderProfilePatch,
  type BuildEffectiveProfilePatchOptions,
} from "./profile_patch.ts";
