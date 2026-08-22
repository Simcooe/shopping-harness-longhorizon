/**
 * held-in failure evidence builder（冻结基础设施，确定性、脱敏、可审计）。
 *
 * 职责：把一个已完成 baseline 结果目录中的 held-in 运行记录，转换为
 * evidence bundle，作为未来同一冻结模型 proposer 的**唯一失败输入**。
 *
 * 硬性约束：
 *   - 只读 baseline manifest.json / held-in.json / 其引用的 actor trace 与
 *     evaluator record；绝不读 held-out.json；
 *   - 只做白名单提取：evidence 中绝无 goal/gold/reward 数值/purchase/
 *     原始 instruction/observation/query/target/工具参数/模型文本；
 *   - 分类只以 evaluator 证据为准（reward_type / reward_valid / failure
 *     label）；environment done / shop_finish 绝不等于成功；证据不足 → unknown；
 *   - 聚类完全确定性（无 LLM、无随机），相同输入重复构建输出稳定。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AGENT_SYMPTOMS,
  CANDIDATE_EDITABLE_SURFACES,
  EVIDENCE_FORBIDDEN_KEYS,
  EVIDENCE_RUN_ID_PATTERN,
  EVIDENCE_SCHEMA_VERSION,
  EXECUTION_STATUSES,
  FAILURE_REWARD_TYPES,
  H0_TOOL_NAMES,
  SAFE_TERMINAL_REASONS,
  SUCCESS_REWARD_TYPES,
  type AgentSymptom,
  type EvidenceManifest,
  type EvidenceSource,
  type FailureCluster,
  type FailureSignature,
  type HeldInEvidence,
  type H0ToolName,
  type RepresentativeRun,
  type SafeTerminalReason,
  type SafeTraceSummary,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// 错误与工具
// ---------------------------------------------------------------------------

export class EvidenceBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceBuildError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new EvidenceBuildError(`文件不存在或不可读: ${path}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) {
      throw new Error("顶层不是 JSON 对象");
    }
    return parsed;
  } catch (cause) {
    throw new EvidenceBuildError(
      `JSON 解析失败: ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function requireString(data: Record<string, unknown>, key: string, refPath: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new EvidenceBuildError(`${refPath}: ${key} 必须是非空字符串`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// baseline 输入读取
// ---------------------------------------------------------------------------

interface BaselineManifest {
  baselineRunId: string;
  benchmarkId: string;
  harnessId: string;
  harnessVersion: string;
  toolSurfaceDigest: string;
  heldInTaskIds: number[];
  finalBenchmarkExcluded: boolean;
}

function parseBaselineManifest(data: Record<string, unknown>, refPath: string): BaselineManifest {
  const baselineRunId = requireString(data, "baseline_run_id", refPath);
  if (!EVIDENCE_RUN_ID_PATTERN.test(baselineRunId)) {
    throw new EvidenceBuildError(`${refPath}: baseline_run_id 非法: ${baselineRunId}`);
  }
  const heldInRaw = data["held_in_task_ids"];
  if (!Array.isArray(heldInRaw)
    || !heldInRaw.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)) {
    throw new EvidenceBuildError(`${refPath}: held_in_task_ids 必须是非负整数数组`);
  }
  if (data["final_benchmark_excluded"] !== true) {
    throw new EvidenceBuildError(`${refPath}: final_benchmark_excluded 必须为 true`);
  }
  return {
    baselineRunId,
    benchmarkId: requireString(data, "benchmark_id", refPath),
    harnessId: requireString(data, "harness_id", refPath),
    harnessVersion: requireString(data, "harness_version", refPath),
    toolSurfaceDigest: requireString(data, "tool_surface_digest", refPath),
    heldInTaskIds: heldInRaw as number[],
    finalBenchmarkExcluded: true,
  };
}

interface HeldInOutcome {
  taskId: number;
  runId: string | null;
  status: string;
  actorTraceRel: string | null;
  evaluatorRecordRel: string | null;
}

function parseHeldInOutcomes(data: Record<string, unknown>, refPath: string): HeldInOutcome[] {
  if (data["split"] !== "held-in") {
    throw new EvidenceBuildError(`${refPath}: split 必须为 held-in`);
  }
  const outcomesRaw = data["outcomes"];
  if (!Array.isArray(outcomesRaw)) {
    throw new EvidenceBuildError(`${refPath}: outcomes 必须是数组`);
  }
  const outcomes: HeldInOutcome[] = [];
  for (const [index, entry] of outcomesRaw.entries()) {
    if (!isObject(entry)) {
      throw new EvidenceBuildError(`${refPath}: outcomes[${index}] 必须是对象`);
    }
    const taskId = entry["task_id"];
    if (typeof taskId !== "number" || !Number.isInteger(taskId) || taskId < 0) {
      throw new EvidenceBuildError(`${refPath}: outcomes[${index}].task_id 非法`);
    }
    const runIdRaw = entry["run_id"];
    if (runIdRaw !== null && runIdRaw !== undefined && typeof runIdRaw !== "string") {
      throw new EvidenceBuildError(`${refPath}: outcomes[${index}].run_id 非法`);
    }
    const runId = typeof runIdRaw === "string" && runIdRaw.length > 0 ? runIdRaw : null;
    outcomes.push({
      taskId,
      runId,
      status: typeof entry["status"] === "string" ? entry["status"] : "unknown",
      actorTraceRel: typeof entry["actor_trace_rel"] === "string" && entry["actor_trace_rel"].length > 0
        ? entry["actor_trace_rel"]
        : null,
      evaluatorRecordRel: typeof entry["evaluator_record_rel"] === "string"
        && entry["evaluator_record_rel"].length > 0
        ? entry["evaluator_record_rel"]
        : null,
    });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// evaluator record 与 actor trace 的安全读取
// ---------------------------------------------------------------------------

interface EvaluatorEvidence {
  done: boolean | null;
  rewardValid: boolean | null;
  rewardType: string | null;
  failureLabels: string[];
  maxStepsTriggered: boolean;
  guardRejections: number;
}

type EvaluatorRead =
  | { kind: "present"; evidence: EvaluatorEvidence }
  | { kind: "missing" }
  | { kind: "corrupt" };

function readEvaluator(path: string): EvaluatorRead {
  if (!existsSync(path)) {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { kind: "corrupt" };
  }
  if (!isObject(parsed)) {
    return { kind: "corrupt" };
  }
  const terminal = parsed["environment_terminal"];
  const done = isObject(terminal) && typeof terminal["done"] === "boolean"
    ? terminal["done"]
    : null;
  const rewardValid = typeof parsed["reward_valid"] === "boolean"
    ? parsed["reward_valid"]
    : null;
  const rewardType = typeof parsed["reward_type"] === "string"
    ? parsed["reward_type"]
    : null;
  const failureLabelsRaw = parsed["failure_labels"];
  const failureLabels = Array.isArray(failureLabelsRaw)
    ? failureLabelsRaw.filter((entry): entry is string => typeof entry === "string")
    : [];
  const maxStepsTriggered = parsed["max_steps_triggered"] === true;
  const guardRejections = typeof parsed["guard_rejections"] === "number"
    && Number.isInteger(parsed["guard_rejections"]) && parsed["guard_rejections"] >= 0
    ? parsed["guard_rejections"]
    : 0;
  return {
    kind: "present",
    evidence: {
      done,
      rewardValid,
      rewardType,
      failureLabels,
      maxStepsTriggered,
      guardRejections,
    },
  };
}

interface TraceEvent {
  event: string;
  tool: string | null;
  environmentAction: string | null;
  localReason: string | null;
}

type ActorTraceRead =
  | { kind: "present"; events: TraceEvent[] }
  | { kind: "missing" }
  | { kind: "corrupt" };

function readActorTrace(path: string): ActorTraceRead {
  if (!existsSync(path)) {
    return { kind: "missing" };
  }
  let lines: string[];
  try {
    lines = readFileSync(path, "utf-8").split("\n");
  } catch {
    return { kind: "corrupt" };
  }
  const events: TraceEvent[] = [];
  let sawCorrupt = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      sawCorrupt = true;
      continue;
    }
    if (!isObject(parsed)) {
      sawCorrupt = true;
      continue;
    }
    const event = typeof parsed["event"] === "string" ? parsed["event"] : null;
    const tool = typeof parsed["tool"] === "string" ? parsed["tool"] : null;
    const environmentAction = typeof parsed["environment_action"] === "string"
      ? parsed["environment_action"]
      : null;
    const localReason = typeof parsed["local_reason"] === "string"
      ? parsed["local_reason"]
      : null;
    if (event !== null) {
      events.push({ event, tool, environmentAction, localReason });
    }
  }
  if (events.length === 0) {
    return { kind: "corrupt" };
  }
  void sawCorrupt;
  return { kind: "present", events };
}

// ---------------------------------------------------------------------------
// trace 安全摘要与症状
// ---------------------------------------------------------------------------

function emptyToolCounts(): Record<H0ToolName, number> {
  return {
    shop_search: 0,
    shop_click: 0,
    shop_finish: 0,
  };
}

function toSafeTerminalReason(raw: string | null): SafeTerminalReason {
  if (raw !== null && (SAFE_TERMINAL_REASONS as readonly string[]).includes(raw)) {
    return raw as SafeTerminalReason;
  }
  return "no_terminal_event";
}

const REPEATED_PRIMITIVE_THRESHOLD = 3;
const EARLY_FINISH_MAX_TOOL_CALLS = 3;

function summarizeTrace(trace: ActorTraceRead): SafeTraceSummary {
  if (trace.kind === "missing") {
    return {
      tool_counts: emptyToolCounts(),
      guard_rejection_count: 0,
      terminal_reason: "trace_missing",
    };
  }
  if (trace.kind === "corrupt") {
    return {
      tool_counts: emptyToolCounts(),
      guard_rejection_count: 0,
      terminal_reason: "trace_corrupt",
    };
  }

  const counts = emptyToolCounts();
  let guardRejections = 0;
  let terminalReason: string | null = null;
  for (const event of trace.events) {
    if (event.event === "tool_call" && event.tool !== null) {
      if ((H0_TOOL_NAMES as readonly string[]).includes(event.tool)) {
        counts[event.tool as H0ToolName] += 1;
      }
    } else if (event.event === "guard_rejection") {
      guardRejections += 1;
    } else if (event.event === "terminal") {
      terminalReason = event.localReason;
    }
  }
  return {
    tool_counts: counts,
    guard_rejection_count: guardRejections,
    terminal_reason: toSafeTerminalReason(terminalReason),
  };
}

function deriveSymptoms(
  evaluator: EvaluatorEvidence | null,
  trace: ActorTraceRead,
): AgentSymptom[] {
  const symptoms = new Set<AgentSymptom>();

  if (evaluator !== null && evaluator.maxStepsTriggered) {
    symptoms.add("max_steps");
  }
  if (evaluator !== null && evaluator.guardRejections > 0) {
    symptoms.add("guard_rejection");
  }
  const hasToolErrorLabel = evaluator !== null
    && evaluator.failureLabels.some((label) => label === "tool_error" || label === "environment_error");
  if (hasToolErrorLabel) {
    symptoms.add("tool_error");
  }

  if (trace.kind === "present") {
    const actionCounts = new Map<string, number>();
    let toolCalls = 0;
    let sawFinish = false;
    for (const event of trace.events) {
      if (event.event === "tool_call") {
        toolCalls += 1;
        if (event.environmentAction !== null) {
          actionCounts.set(
            event.environmentAction,
            (actionCounts.get(event.environmentAction) ?? 0) + 1,
          );
        }
        if (event.tool === "shop_finish") {
          sawFinish = true;
        }
      } else if (event.event === "guard_rejection") {
        symptoms.add("guard_rejection");
      } else if (event.event === "terminal") {
        if (event.localReason === "max_steps") {
          symptoms.add("max_steps");
        }
        if (event.localReason === "tool_error") {
          symptoms.add("tool_error");
        }
      }
    }
    for (const count of actionCounts.values()) {
      if (count >= REPEATED_PRIMITIVE_THRESHOLD) {
        symptoms.add("repeated_primitive");
        break;
      }
    }
    if (sawFinish && toolCalls <= EARLY_FINISH_MAX_TOOL_CALLS) {
      symptoms.add("early_finish");
    }
  }

  return [...symptoms].sort();
}

// ---------------------------------------------------------------------------
// 分类：success / failure / unknown / infra_failure
// ---------------------------------------------------------------------------

type RunCategory = "failure" | "success" | "unknown" | "infra_failure";

interface AssessedRun {
  taskId: number;
  runId: string;
  traceRef: string | null;
  evaluatorRef: string | null;
  category: RunCategory;
  executionStatus: string;
  evaluatorOutcome: string;
  agentSymptoms: AgentSymptom[];
  safeTraceSummary: SafeTraceSummary;
}

const FAILURE_SET: ReadonlySet<string> = new Set<string>(FAILURE_REWARD_TYPES);
const SUCCESS_SET: ReadonlySet<string> = new Set<string>(SUCCESS_REWARD_TYPES);

function primaryFailureLabel(rewardType: string | null, failureLabels: string[]): string {
  if (rewardType !== null && FAILURE_SET.has(rewardType)) {
    return rewardType;
  }
  for (const label of failureLabels) {
    if (FAILURE_SET.has(label)) {
      return label;
    }
  }
  return "unknown";
}

function classify(
  outcome: HeldInOutcome,
  evaluator: EvaluatorRead,
  trace: ActorTraceRead,
): AssessedRun {
  const safeTraceSummary = summarizeTrace(trace);

  const base = {
    taskId: outcome.taskId,
    runId: outcome.runId ?? "",
    traceRef: outcome.actorTraceRel,
    evaluatorRef: outcome.evaluatorRecordRel,
    safeTraceSummary,
  };

  if (outcome.status === "runner_failure") {
    return {
      ...base,
      category: "infra_failure",
      executionStatus: "runner_failure",
      evaluatorOutcome: "unknown",
      agentSymptoms: [],
    };
  }

  if (evaluator.kind === "missing") {
    return {
      ...base,
      category: "infra_failure",
      executionStatus: "missing_evaluator_record",
      evaluatorOutcome: "unknown",
      agentSymptoms: [],
    };
  }
  if (evaluator.kind === "corrupt") {
    return {
      ...base,
      category: "infra_failure",
      executionStatus: "evaluator_record_corrupt",
      evaluatorOutcome: "unknown",
      agentSymptoms: [],
    };
  }

  const evidence = evaluator.evidence;
  const symptoms = deriveSymptoms(evidence, trace);

  // 成功：evaluator 明确判定 reward 有效且 reward_type 为成功类别。
  if (evidence.rewardValid === true && evidence.rewardType !== null
    && SUCCESS_SET.has(evidence.rewardType)) {
    return {
      ...base,
      category: "success",
      executionStatus: "evaluator_failure",
      evaluatorOutcome: "unknown",
      agentSymptoms: symptoms,
    };
  }

  const hasFailureSignal = evidence.rewardValid === false
    || (evidence.rewardType !== null && FAILURE_SET.has(evidence.rewardType))
    || evidence.failureLabels.some((label) => FAILURE_SET.has(label));

  if (hasFailureSignal) {
    const evaluatorOutcome = primaryFailureLabel(evidence.rewardType, evidence.failureLabels);
    return {
      ...base,
      category: "failure",
      executionStatus: evidence.done === true ? "evaluator_failure" : "terminated_without_done",
      evaluatorOutcome,
      agentSymptoms: symptoms,
    };
  }

  return {
    ...base,
    category: "unknown",
    executionStatus: "evaluator_inconclusive",
    evaluatorOutcome: "unknown",
    agentSymptoms: symptoms,
  };
}

// ---------------------------------------------------------------------------
// 确定性聚类
// ---------------------------------------------------------------------------

function signatureKey(signature: FailureSignature): string {
  return JSON.stringify({
    evaluator_outcome: signature.evaluator_outcome,
    execution_status: signature.execution_status,
    agent_symptoms: [...signature.agent_symptoms].sort(),
  });
}

function computeClusterId(signature: FailureSignature): string {
  return `cluster-${createHash("sha256").update(signatureKey(signature)).digest("hex").slice(0, 16)}`;
}

function sortRuns(runs: AssessedRun[]): AssessedRun[] {
  return [...runs].sort((a, b) => {
    if (a.taskId !== b.taskId) {
      return a.taskId - b.taskId;
    }
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  });
}

function toRepresentative(run: AssessedRun): RepresentativeRun {
  return {
    task_id: run.taskId,
    run_id: run.runId,
    trace_ref: run.traceRef,
    evaluator_ref: run.evaluatorRef,
    safe_trace_summary: run.safeTraceSummary,
  };
}

const MAX_REPRESENTATIVES = 3;

function buildCluster(
  signature: FailureSignature,
  runs: AssessedRun[],
): FailureCluster {
  const sorted = sortRuns(runs);
  return {
    cluster_id: computeClusterId(signature),
    failure_signature: {
      evaluator_outcome: signature.evaluator_outcome,
      execution_status: signature.execution_status,
      agent_symptoms: [...signature.agent_symptoms].sort(),
    },
    support: sorted.length,
    representative_runs: sorted.slice(0, MAX_REPRESENTATIVES).map(toRepresentative),
    candidate_editable_surfaces: [...CANDIDATE_EDITABLE_SURFACES],
  };
}

function groupFailures(runs: AssessedRun[]): FailureCluster[] {
  const groups = new Map<string, AssessedRun[]>();
  for (const run of runs) {
    if (run.category !== "failure") {
      continue;
    }
    const signature: FailureSignature = {
      evaluator_outcome: run.evaluatorOutcome,
      execution_status: run.executionStatus,
      agent_symptoms: [...run.agentSymptoms].sort(),
    };
    const key = signatureKey(signature);
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [run]);
    } else {
      bucket.push(run);
    }
  }
  const clusters: FailureCluster[] = [];
  for (const [, bucket] of groups) {
    const first = bucket[0]!;
    clusters.push(buildCluster({
      evaluator_outcome: first.evaluatorOutcome,
      execution_status: first.executionStatus,
      agent_symptoms: [...first.agentSymptoms].sort(),
    }, bucket));
  }
  clusters.sort((a, b) => {
    const sa = a.failure_signature;
    const sb = b.failure_signature;
    if (sa.evaluator_outcome !== sb.evaluator_outcome) {
      return sa.evaluator_outcome < sb.evaluator_outcome ? -1 : 1;
    }
    if (sa.execution_status !== sb.execution_status) {
      return sa.execution_status < sb.execution_status ? -1 : 1;
    }
    return sa.agent_symptoms.join(",") < sb.agent_symptoms.join(",") ? -1 : 1;
  });
  return clusters;
}

function buildUnknownCluster(runs: AssessedRun[]): FailureCluster | null {
  const bucket = runs.filter((run) => run.category === "unknown");
  if (bucket.length === 0) {
    return null;
  }
  return buildCluster({
    evaluator_outcome: "unknown",
    execution_status: "evaluator_inconclusive",
    agent_symptoms: [],
  }, bucket);
}

function buildInfraClusters(runs: AssessedRun[]): FailureCluster[] {
  const clusters: FailureCluster[] = [];
  for (const status of EXECUTION_STATUSES) {
    if (status !== "runner_failure" && status !== "missing_evaluator_record"
      && status !== "evaluator_record_corrupt") {
      continue;
    }
    const bucket = runs.filter((run) => run.category === "infra_failure"
      && run.executionStatus === status);
    if (bucket.length === 0) {
      continue;
    }
    clusters.push(buildCluster({
      evaluator_outcome: "unknown",
      execution_status: status,
      agent_symptoms: [],
    }, bucket));
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// 输出校验（第二道防线：禁止字段名泄漏）
// ---------------------------------------------------------------------------

function assertNoForbiddenKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if ((EVIDENCE_FORBIDDEN_KEYS as readonly string[]).includes(key.toLowerCase())) {
        throw new EvidenceBuildError(`evidence 输出含禁止字段名: ${path}.${key}`);
      }
      assertNoForbiddenKeys(entry, `${path}.${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 主构建
// ---------------------------------------------------------------------------

export interface BuildFailureEvidenceOptions {
  /** baseline 结果目录（含 manifest.json 与 held-in.json）。 */
  baselineDir: string;
  /** 仓库根（解析 held-in.json 里的相对 trace/evaluator 引用）。 */
  repoRoot: string;
  /** 输出目录（默认 evaluation/evidence/<baseline_run_id>）。 */
  outDir: string;
}

export interface BuildFailureEvidenceResult {
  evidence: HeldInEvidence;
  manifest: EvidenceManifest;
  outDir: string;
  writtenFiles: string[];
}

/** 纯构建：读输入 → 分类 → 聚类 → 返回 evidence 对象（不写盘）。 */
export function buildHeldInEvidence(
  baselineDir: string,
  repoRoot: string,
): { evidence: HeldInEvidence; manifest: EvidenceManifest } {
  const baselineManifest = parseBaselineManifest(
    readJsonFile(join(baselineDir, "manifest.json")),
    "manifest.json",
  );
  const heldInData = readJsonFile(join(baselineDir, "held-in.json"));
  const outcomes = parseHeldInOutcomes(heldInData, "held-in.json");

  const assessed: AssessedRun[] = [];
  for (const outcome of outcomes) {
    const evaluator = outcome.evaluatorRecordRel !== null
      ? readEvaluator(join(repoRoot, outcome.evaluatorRecordRel))
      : { kind: "missing" as const };
    const trace = outcome.actorTraceRel !== null
      ? readActorTrace(join(repoRoot, outcome.actorTraceRel))
      : { kind: "missing" as const };
    assessed.push(classify(outcome, evaluator, trace));
  }

  const failureClusters = groupFailures(assessed);
  const unknownCluster = buildUnknownCluster(assessed);
  const infraClusters = buildInfraClusters(assessed);

  const clusters: FailureCluster[] = [
    ...failureClusters,
    ...(unknownCluster !== null ? [unknownCluster] : []),
    ...infraClusters,
  ];

  const eligibleFailureCount = assessed.filter((run) => run.category === "failure").length;
  const excludedSuccessCount = assessed.filter((run) => run.category === "success").length;
  const unknownCount = assessed.filter((run) => run.category === "unknown").length;
  const infraFailureCount = assessed.filter((run) => run.category === "infra_failure").length;

  const source: EvidenceSource = {
    baseline_run_id: baselineManifest.baselineRunId,
    benchmark_id: baselineManifest.benchmarkId,
    split: "held-in",
    harness_id: baselineManifest.harnessId,
    harness_version: baselineManifest.harnessVersion,
    tool_surface_digest: baselineManifest.toolSurfaceDigest,
  };

  const evidence: HeldInEvidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_id: `evidence-${baselineManifest.baselineRunId}`,
    source,
    scope: {
      task_count: assessed.length,
      eligible_failure_count: eligibleFailureCount,
      excluded_success_count: excludedSuccessCount,
      unknown_count: unknownCount,
      infra_failure_count: infraFailureCount,
      held_out_included: false,
    },
    failure_clusters: clusters,
  };

  const manifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_id: `evidence-${baselineManifest.baselineRunId}`,
    baseline_run_id: baselineManifest.baselineRunId,
    benchmark_id: baselineManifest.benchmarkId,
    harness_id: baselineManifest.harnessId,
    harness_version: baselineManifest.harnessVersion,
    tool_surface_digest: baselineManifest.toolSurfaceDigest,
    split: "held-in",
    held_out_included: false,
    held_in_task_ids: [...baselineManifest.heldInTaskIds].sort((a, b) => a - b),
    final_benchmark_excluded: true,
  };

  assertNoForbiddenKeys(evidence);
  assertNoForbiddenKeys(manifest);

  return { evidence, manifest };
}

/** 写盘：manifest.json + held-in-evidence.json。 */
export function writeEvidenceBundle(
  outDir: string,
  bundle: { evidence: HeldInEvidence; manifest: EvidenceManifest },
): string[] {
  mkdirSync(outDir, { recursive: true });
  const evidencePath = join(outDir, "held-in-evidence.json");
  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(evidencePath, `${JSON.stringify(bundle.evidence, null, 2)}\n`, "utf-8");
  writeFileSync(manifestPath, `${JSON.stringify(bundle.manifest, null, 2)}\n`, "utf-8");
  return [evidencePath, manifestPath];
}

/** 顶层：构建并写盘（CLI 与测试复用）。 */
export function buildFailureEvidence(options: BuildFailureEvidenceOptions): BuildFailureEvidenceResult {
  const bundle = buildHeldInEvidence(options.baselineDir, options.repoRoot);
  const writtenFiles = writeEvidenceBundle(options.outDir, bundle);
  return {
    evidence: bundle.evidence,
    manifest: bundle.manifest,
    outDir: options.outDir,
    writtenFiles,
  };
}

export { EVIDENCE_SCHEMA_VERSION, SUCCESS_REWARD_TYPES, FAILURE_REWARD_TYPES, AGENT_SYMPTOMS };
