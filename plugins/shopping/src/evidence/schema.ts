/**
 * held-in failure evidence bundle 的 schema 与词汇表（冻结基础设施）。
 *
 * 本模块是 Self-Harness 闭环的"证据分类"层：它只定义类型、成功/失败/未知
 * 的词汇，以及聚类签名。它**不是**未来 harness 的可编辑面；proposer 读到的
 * evidence bundle 由本层确定性生成，绝不经过模型。
 *
 * 语义红线（与 harnesses/base/verification-policy.yml 一致）：
 *   - environment done 只说明环境终止，绝不等于任务成功；
 *   - shop_finish 更不等于成功；
 *   - 成功/失败/未知 只以 evaluator 侧证据为准（reward_type / reward_valid /
 *     failure label）；证据不足一律 unknown，绝不伪造 pass。
 */

export const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * 成功 reward 类型（evaluator 明确判定任务达成）。
 * 注意：这些是"类别名"，不是 gold/purchase 的取值；evidence 里绝不含
 * gold asin / purchase asin / reward 数值本身。
 */
export const SUCCESS_REWARD_TYPES = [
  "gold_purchase",
  "valid_alternative_purchase",
] as const;

/** 失败 reward 类型 / failure label（evaluator 明确判定任务失败）。 */
export const FAILURE_REWARD_TYPES = [
  "wrong_purchase",
  "repeat_loop",
  "max_steps",
  "early_abstain",
  "graceful_stop",
  "environment_error",
  "tool_error",
] as const;

/** 执行/证据基础设施状态（描述"为什么拿不到干净的 evaluator 结论"）。 */
export const EXECUTION_STATUSES = [
  "runner_failure",
  "missing_evaluator_record",
  "evaluator_record_corrupt",
  "terminated_without_done",
  "evaluator_failure",
  "evaluator_inconclusive",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** agent 侧 trace 症状（确定性推导，不使用 LLM）。 */
export const AGENT_SYMPTOMS = [
  "max_steps",
  "guard_rejection",
  "tool_error",
  "repeated_primitive",
  "early_finish",
] as const;

export type AgentSymptom = (typeof AGENT_SYMPTOMS)[number];

/** h0 的三个 primitive 工具名（tool_counts 的固定键）。 */
export const H0_TOOL_NAMES = [
  "shop_search",
  "shop_click",
  "shop_finish",
] as const;

export type H0ToolName = (typeof H0_TOOL_NAMES)[number];

/** safe_trace_summary.terminal_reason 的允许取值（固定词汇，绝不透传原文）。 */
export const SAFE_TERMINAL_REASONS = [
  "environment_done",
  "session_over",
  "max_steps",
  "tool_error",
  "no_terminal_event",
  "trace_missing",
  "trace_corrupt",
] as const;

export type SafeTerminalReason = (typeof SAFE_TERMINAL_REASONS)[number];

/** 可编辑面白名单（声明性；不是 patch 建议，也不是自动修改指令）。 */
export const CANDIDATE_EDITABLE_SURFACES = [
  "system-prompt.md",
  "tool-surface.yml",
  "runtime-policy.yml",
  "verification-policy.yml",
] as const;

export const EVIDENCE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface EvidenceSource {
  baseline_run_id: string;
  benchmark_id: string;
  split: "held-in";
  harness_id: string;
  harness_version: string;
  tool_surface_digest: string;
}

export interface EvidenceScope {
  task_count: number;
  eligible_failure_count: number;
  excluded_success_count: number;
  unknown_count: number;
  infra_failure_count: number;
  held_out_included: boolean;
}

export interface FailureSignature {
  evaluator_outcome: string;
  execution_status: string;
  agent_symptoms: string[];
}

export interface SafeTraceSummary {
  tool_counts: Record<H0ToolName, number>;
  guard_rejection_count: number;
  terminal_reason: SafeTerminalReason;
}

export interface RepresentativeRun {
  task_id: number;
  run_id: string;
  trace_ref: string | null;
  evaluator_ref: string | null;
  safe_trace_summary: SafeTraceSummary;
}

export interface FailureCluster {
  cluster_id: string;
  failure_signature: FailureSignature;
  support: number;
  representative_runs: RepresentativeRun[];
  candidate_editable_surfaces: string[];
}

export interface HeldInEvidence {
  schema_version: number;
  evidence_id: string;
  source: EvidenceSource;
  scope: EvidenceScope;
  failure_clusters: FailureCluster[];
}

export interface EvidenceManifest {
  schema_version: number;
  evidence_id: string;
  baseline_run_id: string;
  benchmark_id: string;
  harness_id: string;
  harness_version: string;
  tool_surface_digest: string;
  split: "held-in";
  held_out_included: false;
  held_in_task_ids: number[];
  final_benchmark_excluded: true;
}

/**
 * evidence 输出里绝不允许出现的键名（任意嵌套层级，大小写不敏感）。
 * 这是第二道防线：builder 只做白名单提取，本清单兜底防止字段名泄漏。
 */
export const EVIDENCE_FORBIDDEN_KEYS = [
  "goal",
  "goals",
  "gold",
  "gold_asin",
  "goal_options",
  "reward",
  "reward_detail",
  "reward_valid",
  "purchase",
  "purchase_asin",
  "instruction",
  "instruction_text",
  "instruction_simple",
  "task_instruction",
  "query",
  "normalized_query",
  "target",
  "args",
  "observation",
  "observation_state",
  "products",
  "product",
  "content",
  "user_persona",
  "api_key",
  "apikey",
  "authorization",
  "token",
  "secret",
] as const;

/** 运行时读取 evaluator record 时只允许出现的字段（其它一律不读）。 */
export const EVALUATOR_RECORD_ALLOWED_KEYS = [
  "schema_version",
  "run_id",
  "task_id",
  "environment_terminal",
  "reward_type",
  "reward_valid",
  "tool_steps",
  "guard_rejections",
  "max_steps_triggered",
  "failure_labels",
] as const;
