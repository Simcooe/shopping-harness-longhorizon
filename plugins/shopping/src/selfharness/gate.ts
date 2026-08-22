/**
 * candidate gate v1（纯逻辑，可离线测试，冻结基础设施）。
 *
 * success 语义严格 evaluator-grounded：成功仅当 reward_valid=true 且
 * reward_type ∈ {gold_purchase, valid_alternative_purchase}；environment done
 * 绝不等于成功。gate 只读 held-in/held-out 的 outcome 汇总，绝不读原始
 * trace / evaluator record / Final-200。
 */

export const SUCCESS_REWARD_TYPES = [
  "gold_purchase",
  "valid_alternative_purchase",
] as const;

/** gate 读到的单个 outcome（已脱敏汇总，无 goal/gold/reward 数值/purchase）。 */
export interface EvalOutcome {
  task_id: number;
  status: string;
  reward_valid: boolean | null;
  reward_type: string | null;
}

export function isSuccess(outcome: EvalOutcome): boolean {
  return outcome.reward_valid === true
    && (SUCCESS_REWARD_TYPES as readonly string[]).includes(outcome.reward_type ?? "");
}

export function isInfraFailure(outcome: EvalOutcome): boolean {
  return outcome.status === "runner_failure" || outcome.status === "missing_evaluator_record";
}

export function countSuccess(outcomes: EvalOutcome[]): number {
  return outcomes.filter(isSuccess).length;
}

export function countInfraFailures(outcomes: EvalOutcome[]): number {
  return outcomes.filter(isInfraFailure).length;
}

export interface GateRuleResult {
  rule: string;
  pass: boolean;
  reason: string;
}

export interface GateDecision {
  decision: "accepted" | "rejected";
  rules: GateRuleResult[];
  base_held_in_success: number;
  base_held_out_success: number | null;
  candidate_held_in_success: number;
  candidate_held_out_success: number | null;
}

export interface GateInput {
  baseHeldIn: EvalOutcome[];
  /** base held-out baseline；null 表示尚未运行（gate 必须拒绝）。 */
  baseHeldOut: EvalOutcome[] | null;
  candidateHeldIn: EvalOutcome[];
  candidateHeldOut: EvalOutcome[] | null;
  /** candidate 实际修改的文件（来自 patch.json 的 edits）。 */
  editedFiles: string[];
  /** candidate 是否已通过 loadHarness 校验（schema + 冻结边界）。 */
  candidateValidated: boolean;
  /** 合法 editable surface 白名单（默认系统固定 4 个）。 */
  editableSurfaces?: readonly string[];
}

const DEFAULT_EDITABLE_SURFACES = [
  "system-prompt.md",
  "tool-surface.yml",
  "runtime-policy.yml",
  "verification-policy.yml",
] as const;

/** 评估 gate v1；返回逐项 pass/fail 与最终 decision。 */
export function evaluateGateV1(input: GateInput): GateDecision {
  const surfaces = input.editableSurfaces ?? DEFAULT_EDITABLE_SURFACES;
  const baseHeldInSuccess = countSuccess(input.baseHeldIn);
  const baseHeldOutSuccess = input.baseHeldOut === null ? null : countSuccess(input.baseHeldOut);
  const candidateHeldInSuccess = countSuccess(input.candidateHeldIn);
  const candidateHeldOutSuccess = input.candidateHeldOut === null ? null : countSuccess(input.candidateHeldOut);

  const rules: GateRuleResult[] = [];

  rules.push(
    input.baseHeldOut === null
      ? { rule: "held_out_baseline_present", pass: false, reason: "缺少 base held-out baseline，无法比较 held-out；不得用 held-in 代替" }
      : { rule: "held_out_baseline_present", pass: true, reason: "base held-out baseline 已提供" },
  );

  rules.push(
    input.candidateValidated
      ? { rule: "candidate_schema_frozen_boundary", pass: true, reason: "candidate 已通过 loadHarness 校验" }
      : { rule: "candidate_schema_frozen_boundary", pass: false, reason: "candidate 未通过 schema/冻结边界校验" },
  );

  const editedOutside = input.editedFiles.filter((file) => !surfaces.includes(file));
  rules.push(
    editedOutside.length === 0
      ? { rule: "editable_surfaces_only", pass: true, reason: `仅修改声明面: [${input.editedFiles.join(", ") || "无"}]` }
      : { rule: "editable_surfaces_only", pass: false, reason: `修改了声明面之外的文件: ${editedOutside.join(", ")}` },
  );

  const heldInImproved = candidateHeldInSuccess > baseHeldInSuccess;
  rules.push(
    heldInImproved
      ? { rule: "held_in_improved", pass: true, reason: `candidate held-in 成功 ${candidateHeldInSuccess} > base ${baseHeldInSuccess}` }
      : { rule: "held_in_improved", pass: false, reason: `candidate held-in 成功 ${candidateHeldInSuccess} 未严格大于 base ${baseHeldInSuccess}` },
  );

  const heldOutNonDegraded = baseHeldOutSuccess === null || candidateHeldOutSuccess === null
    ? false
    : candidateHeldOutSuccess >= baseHeldOutSuccess;
  rules.push(
    heldOutNonDegraded
      ? { rule: "held_out_non_degraded", pass: true, reason: `candidate held-out 成功 ${candidateHeldOutSuccess} >= base ${baseHeldOutSuccess}` }
      : { rule: "held_out_non_degraded", pass: false, reason: baseHeldOutSuccess === null || candidateHeldOutSuccess === null
        ? "缺少 held-out 成功数据"
        : `candidate held-out 成功 ${candidateHeldOutSuccess} < base ${baseHeldOutSuccess}` },
  );

  const baseHeldInInfra = countInfraFailures(input.baseHeldIn);
  const baseHeldOutInfra = input.baseHeldOut === null ? 0 : countInfraFailures(input.baseHeldOut);
  const candidateHeldInInfra = countInfraFailures(input.candidateHeldIn);
  const candidateHeldOutInfra = input.candidateHeldOut === null ? 0 : countInfraFailures(input.candidateHeldOut);
  const noNewInfra = candidateHeldInInfra <= baseHeldInInfra && candidateHeldOutInfra <= baseHeldOutInfra;
  rules.push(
    noNewInfra
      ? { rule: "no_new_infra_failure", pass: true, reason: `candidate infra(held-in=${candidateHeldInInfra}, held-out=${candidateHeldOutInfra}) 未超过 base(${baseHeldInInfra}, ${baseHeldOutInfra})` }
      : { rule: "no_new_infra_failure", pass: false, reason: `candidate 新增 runner_failure/missing_evaluator_record（held-in ${baseHeldInInfra}→${candidateHeldInInfra}, held-out ${baseHeldOutInfra}→${candidateHeldOutInfra}）` },
  );

  const decision: GateDecision["decision"] = rules.every((rule) => rule.pass) ? "accepted" : "rejected";

  return {
    decision,
    rules,
    base_held_in_success: baseHeldInSuccess,
    base_held_out_success: baseHeldOutSuccess,
    candidate_held_in_success: candidateHeldInSuccess,
    candidate_held_out_success: candidateHeldOutSuccess,
  };
}
