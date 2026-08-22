#!/usr/bin/env node
/**
 * candidate evaluator + gate v1（由 scripts/evaluate_candidate.sh 调用）。
 *
 * 流程：
 *   1. 解析 `--candidate-id <id>`（仅 id，路径由代码生成）；
 *   2. **提前校验 base held-in / held-out baseline**（零模型调用）：
 *      任何一条不满足 → 非零退出，绝不启动 candidate rollout；
 *   3. 校验 candidate harness（loadHarness）；
 *   4. 复用 baseline_orchestrator 跑 candidate held-in + held-out
 *      （SHOPPING_HARNESS_DIR=<candidate>，结果写 evaluation/candidates/<id>/）；
 *   5. 逐项 gate，写 gate.json。
 *
 * success 语义严格 evaluator-grounded（reward_valid=true 且 reward_type ∈
 * {gold_purchase, valid_alternative_purchase}）；held-out 仅 gate 读取，绝不
 * 提供给 proposer。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadBenchmarkManifest, type BenchmarkManifest } from "../plugins/shopping/src/harness/benchmark.ts";
import { loadHarness } from "../plugins/shopping/src/harness/surface.ts";
import { assertSafeCandidateId } from "../plugins/shopping/src/candidate/schema.ts";
import {
  countSuccess,
  evaluateGateV1,
  type EvalOutcome,
  type GateDecision,
} from "../plugins/shopping/src/selfharness/gate.ts";

const REPO_ROOT = process.env["SHOPPING_REPO_ROOT"]
  ?? join(dirname(fileURLToPath(import.meta.url)), "..");

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

function fail(message: string): never {
  console.error(`[candidate_evaluator] ${message}`);
  process.exit(1);
}

export interface CandidateEvalArgs {
  candidateId: string;
  baseHarnessDir: string;
  baselineHeldInId: string;
  baselineHeldOutId: string;
}

export function parseArgs(argv: string[]): CandidateEvalArgs {
  if (argv.includes("--candidate")) {
    throw new PreflightError(
      "已废弃 --candidate（路径）；请使用 --candidate-id <id>（仅 id，路径由代码生成）",
    );
  }
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const candidateId = get("--candidate-id");
  const baseHarness = get("--base-harness");
  const heldIn = get("--baseline-held-in");
  const heldOut = get("--baseline-held-out");
  if (candidateId === undefined || baseHarness === undefined || heldIn === undefined || heldOut === undefined) {
    throw new PreflightError(
      "用法: candidate_evaluator.ts --candidate-id <id> --base-harness <dir> --baseline-held-in <id> --baseline-held-out <id>",
    );
  }
  return {
    candidateId,
    baseHarnessDir: baseHarness,
    baselineHeldInId: heldIn,
    baselineHeldOutId: heldOut,
  };
}

/** candidate 路径只由代码生成；candidate_id 走 Proposal 安全校验（拒绝路径/../分隔符）。 */
export function resolveCandidateDir(repoRoot: string, candidateId: string): string {
  assertSafeCandidateId(candidateId);
  return join(repoRoot, "harnesses", "candidates", candidateId);
}

export type OutcomeValidation =
  | { ok: true; outcomes: EvalOutcome[] }
  | { ok: false; reason: string };

/**
 * 严格校验 outcome 完整性（baseline schema 完整才可用于 gate comparison）。
 * 缺失 evaluator-grounded reward_valid（null/undefined/字符串等）一律判不完整。
 */
export function parseOutcomesStrict(
  splitJson: Record<string, unknown>,
  label: string,
  expectedTaskIds: readonly number[],
): OutcomeValidation {
  const outcomesRaw = splitJson["outcomes"];
  if (!Array.isArray(outcomesRaw) || outcomesRaw.length === 0) {
    return { ok: false, reason: `${label} outcomes 必须是非空数组` };
  }
  const seen = new Set<number>();
  const outcomes: EvalOutcome[] = [];
  for (const [index, entry] of outcomesRaw.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `${label} outcome[${index}] 必须是对象` };
    }
    const record = entry as Record<string, unknown>;

    const taskId = record["task_id"];
    if (typeof taskId !== "number" || !Number.isInteger(taskId)) {
      return { ok: false, reason: `${label} outcome[${index}].task_id 必须是整数` };
    }
    const status = record["status"];
    if (typeof status !== "string" || status.length === 0) {
      return { ok: false, reason: `${label} outcome[${index}].status 必须是非空字符串` };
    }
    const rewardType = record["reward_type"];
    if (rewardType !== null && rewardType !== undefined && typeof rewardType !== "string") {
      return { ok: false, reason: `${label} outcome[${index}].reward_type 必须是 string 或 null` };
    }
    const rewardValid = record["reward_valid"];
    if (typeof rewardValid !== "boolean") {
      return {
        ok: false,
        reason: `${label} outcome[${index}].reward_valid 必须是 boolean（baseline schema 不完整，缺 evaluator-grounded reward_valid）`,
      };
    }
    if (seen.has(taskId)) {
      return { ok: false, reason: `${label} outcome 含重复 task_id: ${taskId}` };
    }
    seen.add(taskId);
    outcomes.push({
      task_id: taskId,
      status,
      reward_valid: rewardValid,
      reward_type: rewardType === undefined ? null : rewardType,
    });
  }
  if (!sameTaskSet([...seen], expectedTaskIds)) {
    return {
      ok: false,
      reason: `${label} outcome task 集合（${[...seen].sort((a, b) => a - b).join(",")}）与 development-v1 manifest 不一致`,
    };
  }
  return { ok: true, outcomes };
}

function readBaselineJson(path: string, label: string, helpCommand: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new PreflightError(`${label} 缺失: ${path}。请先运行: ${helpCommand}`);
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("顶层不是 JSON 对象");
    }
    return data as Record<string, unknown>;
  } catch (cause) {
    throw new PreflightError(
      `${label} 无法解析: ${path}（${cause instanceof Error ? cause.message : String(cause)}）。请重新运行: ${helpCommand}`,
    );
  }
}

function sameTaskSet(actual: number[], expected: readonly number[]): boolean {
  const a = [...actual].sort((x, y) => x - y);
  const b = [...expected].sort((x, y) => x - y);
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

export interface PreflightResult {
  baseHeldIn: EvalOutcome[];
  baseHeldOut: EvalOutcome[];
}

/**
 * 提前校验 base held-in / held-out baseline（在任何 candidate rollout 之前）。
 * 任一失败抛 PreflightError，绝不调用 baseline_orchestrator / 模型。
 */
export function preflightBaseBaselines(opts: {
  repoRoot: string;
  baseHarnessDir: string;
  baselineHeldInId: string;
  baselineHeldOutId: string;
}): PreflightResult {
  const baseHarnessDir = opts.baseHarnessDir.startsWith("/")
    ? opts.baseHarnessDir
    : join(opts.repoRoot, opts.baseHarnessDir);
  const base = loadHarness(baseHarnessDir);
  const benchmark = loadBenchmarkManifest(
    join(opts.repoRoot, "configs", "evaluation", "development-v1.yml"),
  );

  const HELD_IN_CMD = "bash scripts/run_h0_baseline_eval.sh --split held-in --live";
  const HELD_OUT_CMD = "bash scripts/run_h0_baseline_eval.sh --split held-out --live";

  const validateSplit = (
    baselineId: string,
    splitFile: "held-in.json" | "held-out.json",
    expectedSplit: "held-in" | "held-out",
    expectedTaskIds: readonly number[],
    helpCommand: string,
  ): EvalOutcome[] => {
    const baselineDir = join(opts.repoRoot, "evaluation", "baselines", baselineId);
    if (!existsSync(baselineDir)) {
      throw new PreflightError(`base ${expectedSplit} baseline 目录缺失: ${baselineDir}。请先运行: ${helpCommand}`);
    }
    const splitJson = readBaselineJson(join(baselineDir, splitFile), `base ${expectedSplit}`, helpCommand);
    if (splitJson["split"] !== expectedSplit) {
      throw new PreflightError(
        `${splitFile} 的 split 应为 ${expectedSplit}，实际为 ${String(splitJson["split"])}。请重新运行: ${helpCommand}`,
      );
    }
    if (splitJson["benchmark_id"] !== benchmark.benchmarkId) {
      throw new PreflightError(
        `base ${expectedSplit} baseline 的 benchmark_id（${String(splitJson["benchmark_id"])}）与 ${benchmark.benchmarkId} 不一致`,
      );
    }
    const manifest = readBaselineJson(join(baselineDir, "manifest.json"), `base ${expectedSplit} manifest`, helpCommand);
    if (manifest["harness_id"] !== base.harnessId) {
      throw new PreflightError(
        `base ${expectedSplit} baseline 的 harness_id（${String(manifest["harness_id"])}）与当前 base harness（${base.harnessId}）不一致`,
      );
    }
    if (manifest["harness_version"] !== base.version) {
      throw new PreflightError(
        `base ${expectedSplit} baseline 的 harness_version（${String(manifest["harness_version"])}）与当前 base harness（${base.version}）不一致`,
      );
    }
    if (manifest["tool_surface_digest"] !== base.toolSurfaceDigest) {
      throw new PreflightError(
        `base ${expectedSplit} baseline 的 tool_surface_digest（${String(manifest["tool_surface_digest"])}）与当前 base harness（${base.toolSurfaceDigest}）不一致`,
      );
    }
    const validation = parseOutcomesStrict(splitJson, `base ${expectedSplit}`, expectedTaskIds);
    if (!validation.ok) {
      throw new PreflightError(`${validation.reason}。请重新运行: ${helpCommand}`);
    }
    return validation.outcomes;
  };

  const baseHeldIn = validateSplit(
    opts.baselineHeldInId,
    "held-in.json",
    "held-in",
    benchmark.heldInTaskIds,
    HELD_IN_CMD,
  );
  const baseHeldOut = validateSplit(
    opts.baselineHeldOutId,
    "held-out.json",
    "held-out",
    benchmark.heldOutTaskIds,
    HELD_OUT_CMD,
  );

  return { baseHeldIn, baseHeldOut };
}

export interface RolloutOptions {
  repoRoot: string;
  candidateDir: string;
  candidateOutDir: string;
  manifestPath: string;
}

/** 跑 candidate held-in + held-out（默认复用 baseline_orchestrator；测试可注入 fake）。 */
export function runCandidateRollout(opts: RolloutOptions): void {
  const override = process.env["SHOPPING_EVAL_ORCHESTRATOR_CMD"];
  let result;
  if (override !== undefined && override.length > 0) {
    result = spawnSync(override, {
      cwd: opts.repoRoot,
      shell: true,
      stdio: "inherit",
      env: {
        ...process.env,
        SHOPPING_HARNESS_DIR: opts.candidateDir,
        SHOPPING_EVAL_OUT_DIR: opts.candidateOutDir,
      },
    });
  } else {
    result = spawnSync(
      "node",
      [
        "scripts/baseline_orchestrator.ts",
        "--split", "all",
        "--manifest", opts.manifestPath,
        "--out-dir", opts.candidateOutDir,
      ],
      {
        cwd: opts.repoRoot,
        stdio: "inherit",
        env: { ...process.env, SHOPPING_HARNESS_DIR: opts.candidateDir },
      },
    );
  }
  if (result.status !== 0) {
    throw new Error(`candidate 评测失败（exit=${String(result.status)}）`);
  }
}

interface CandidateOutcomesResult {
  ok: boolean;
  heldIn: EvalOutcome[];
  heldOut: EvalOutcome[];
  reason: string;
}

/** 读 candidate rollout 产物并严格校验完整性（缺 reward_valid → 不完整）。 */
export function readCandidateOutcomes(outDir: string, benchmark: BenchmarkManifest): CandidateOutcomesResult {
  const heldInPath = join(outDir, "held-in.json");
  const heldOutPath = join(outDir, "held-out.json");
  if (!existsSync(heldInPath) || !existsSync(heldOutPath)) {
    return { ok: false, heldIn: [], heldOut: [], reason: "candidate 评测产物缺失（held-in.json / held-out.json）" };
  }
  let heldInJson: unknown;
  let heldOutJson: unknown;
  try {
    heldInJson = JSON.parse(readFileSync(heldInPath, "utf-8"));
    heldOutJson = JSON.parse(readFileSync(heldOutPath, "utf-8"));
  } catch (cause) {
    return { ok: false, heldIn: [], heldOut: [], reason: `candidate 评测产物无法解析（${cause instanceof Error ? cause.message : String(cause)}）` };
  }
  const heldInVal = parseOutcomesStrict(heldInJson as Record<string, unknown>, "candidate held-in", benchmark.heldInTaskIds);
  if (!heldInVal.ok) {
    return { ok: false, heldIn: [], heldOut: [], reason: heldInVal.reason };
  }
  const heldOutVal = parseOutcomesStrict(heldOutJson as Record<string, unknown>, "candidate held-out", benchmark.heldOutTaskIds);
  if (!heldOutVal.ok) {
    return { ok: false, heldIn: [], heldOut: [], reason: heldOutVal.reason };
  }
  return { ok: true, heldIn: heldInVal.outcomes, heldOut: heldOutVal.outcomes, reason: "" };
}

function main(): void {
  let args: CandidateEvalArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
    return;
  }

  let candidateDir: string;
  try {
    candidateDir = resolveCandidateDir(REPO_ROOT, args.candidateId);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
    return;
  }

  if (!existsSync(join(candidateDir, "harness.yml"))) {
    fail(`candidate 不存在: ${candidateDir}`);
  }

  // 1. 提前校验 base baselines（任何失败 → 零模型调用退出，绝不创建 candidate 评测目录）
  let preflight: PreflightResult;
  try {
    preflight = preflightBaseBaselines({
      repoRoot: REPO_ROOT,
      baseHarnessDir: args.baseHarnessDir,
      baselineHeldInId: args.baselineHeldInId,
      baselineHeldOutId: args.baselineHeldOutId,
    });
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
    return;
  }

  // 2. candidate 校验（schema + 冻结边界）
  let candidateValidated = true;
  let toolSurfaceDigest = "";
  try {
    const harness = loadHarness(candidateDir);
    toolSurfaceDigest = harness.toolSurfaceDigest;
  } catch (cause) {
    candidateValidated = false;
    console.error(`[candidate_evaluator] candidate 校验失败: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  // edited_files（来自 patch.json）
  let editedFiles: string[] = [];
  try {
    const patch = JSON.parse(readFileSync(join(candidateDir, "patch.json"), "utf-8")) as Record<string, unknown>;
    const edits = patch["edits"];
    if (Array.isArray(edits)) {
      editedFiles = (edits as Array<Record<string, unknown>>).map((edit) => String(edit["path"] ?? ""));
    }
  } catch {
    editedFiles = [];
  }

  // 3. candidate rollout（此时 base baselines 已确认存在且一致）
  const candidateOutDir = join(REPO_ROOT, "evaluation", "candidates", args.candidateId);
  const manifestPath = join(REPO_ROOT, "configs", "evaluation", "development-v1.yml");
  try {
    runCandidateRollout({ repoRoot: REPO_ROOT, candidateDir, candidateOutDir, manifestPath });
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
    return;
  }

  // 4. 读并严格校验 candidate outcome（缺 reward_valid → rejected，不当 0 成功）
  const benchmark = loadBenchmarkManifest(manifestPath);
  const candidateOutcomes = readCandidateOutcomes(candidateOutDir, benchmark);
  const modelIdentity = {
    model_name: String(process.env["MODEL_NAME"] ?? "").trim(),
    model_base_url: String(process.env["MODEL_BASE_URL"] ?? "").trim(),
  };

  if (!candidateOutcomes.ok) {
    writeFileSync(
      join(candidateOutDir, "gate.json"),
      `${JSON.stringify({
        decision: "rejected",
        candidate_outcome_schema_complete: false,
        reason: candidateOutcomes.reason,
        base_held_in_success: countSuccess(preflight.baseHeldIn),
        base_held_out_success: countSuccess(preflight.baseHeldOut),
        candidate_held_in_success: null,
        candidate_held_out_success: null,
        rules: [],
        tool_surface_digest: toolSurfaceDigest,
        model_identity: modelIdentity,
      }, null, 2)}\n`,
      "utf-8",
    );
    console.error(`[candidate_evaluator] gate decision=rejected（candidate outcome 不完整）candidate=${args.candidateId}`);
    process.exit(1);
  }

  // 5. gate
  const decision: GateDecision = evaluateGateV1({
    baseHeldIn: preflight.baseHeldIn,
    baseHeldOut: preflight.baseHeldOut,
    candidateHeldIn: candidateOutcomes.heldIn,
    candidateHeldOut: candidateOutcomes.heldOut,
    editedFiles,
    candidateValidated,
  });

  writeFileSync(
    join(candidateOutDir, "gate.json"),
    `${JSON.stringify({
      ...decision,
      candidate_outcome_schema_complete: true,
      tool_surface_digest: toolSurfaceDigest,
      model_identity: modelIdentity,
    }, null, 2)}\n`,
    "utf-8",
  );
  console.error(`[candidate_evaluator] gate decision=${decision.decision} candidate=${args.candidateId}`);
  if (decision.decision === "rejected") {
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
