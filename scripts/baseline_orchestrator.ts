#!/usr/bin/env node
/**
 * h0 baseline 批量 orchestrator（由 scripts/run_h0_baseline_eval.sh 在
 * 显式 --live 后调用；不读取/不打印 API key）。
 *
 * 时序（每个 task 独立、互不共享会话）：
 *   加载 benchmark manifest + h0 harness
 *   → 对 split 内每个 task：
 *       spawn scripts/run_live_task.sh --task-id <id> --live
 *       （复用现有 bootstrap/DSH runner；SHOPPING_LIVE_TASK_CONFIG 指向
 *        35 步正式配置）
 *       → 从子进程 stdout 解析 run_id
 *       → 独立 bootstrap / actor trace / evaluator record
 *       → 子进程自身负责 release_one（绝不 release_all）
 *       → 单 task 失败不阻断其余 task
 *   → 聚合写入 evaluation/baselines/<baseline_run_id>/
 *
 * 结果语义（绝不伪造 pass/fail）：
 *   runner_exit != 0                → runner_failure
 *   evaluator record 缺失            → missing_evaluator_record
 *   evaluator done == true          → environment_done
 *   evaluator 存在但 done == false  → terminated_without_done
 *   shop_finish 不等于成功；environment done / evaluator 证据才算数。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBenchmarkManifest, type BenchmarkManifest } from "../plugins/shopping/src/harness/benchmark.ts";
import { loadHarness } from "../plugins/shopping/src/harness/surface.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  console.error(`[baseline_orchestrator] ${message}`);
  process.exit(1);
}

interface TaskOutcome {
  task_id: number;
  split: string;
  run_id: string | null;
  runner_exit: number | null;
  actor_trace_rel: string | null;
  evaluator_record_rel: string | null;
  evaluator_present: boolean;
  environment_done: boolean | null;
  reward_type: string | null;
  status: "environment_done" | "terminated_without_done"
    | "missing_evaluator_record" | "runner_failure";
}

const argv = process.argv.slice(2);
const splitIdx = argv.indexOf("--split");
const splitArg = splitIdx >= 0 ? argv[splitIdx + 1] : undefined;
if (splitArg === undefined || !["held-in", "held-out", "all"].includes(splitArg)) {
  fail("用法: baseline_orchestrator.ts --split held-in|held-out|all");
}
const manifestIdx = argv.indexOf("--manifest");
const manifestPath = manifestIdx >= 0
  ? argv[manifestIdx + 1] as string
  : join(REPO_ROOT, "configs", "evaluation", "development-v1.yml");
const runIdIdx = argv.indexOf("--baseline-run-id");
const baselineRunIdOverride = runIdIdx >= 0 ? argv[runIdIdx + 1] : undefined;

let manifest: BenchmarkManifest;
try {
  manifest = loadBenchmarkManifest(manifestPath);
} catch (cause) {
  fail(`manifest 加载失败: ${cause instanceof Error ? cause.message : String(cause)}`);
}
if (manifest.finalBenchmarkExcluded !== true) {
  fail("manifest 必须声明 final_benchmark_excluded: true");
}

const evalConfigPath = process.env["SHOPPING_BASELINE_EVAL_CONFIG"]
  ?? join(REPO_ROOT, "configs", "evaluation", "h0-baseline-v1.yml");
if (!existsSync(evalConfigPath)) {
  fail(`评测配置不存在: ${evalConfigPath}`);
}

const harness = loadHarness(
  process.env["SHOPPING_HARNESS_DIR"] ?? join(REPO_ROOT, "harnesses", "base"),
);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const baselineRunId = baselineRunIdOverride ?? `baseline-${timestamp}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(baselineRunId)) {
  fail(`baseline_run_id 非法: ${baselineRunId}`);
}
const baselineDir = join(REPO_ROOT, "evaluation", "baselines", baselineRunId);
mkdirSync(baselineDir, { recursive: true });

function parseRunId(stdout: string): string | null {
  const match = stdout.match(/^\[run_live_task\] run_id=(\S+)/m);
  return match !== null && match[1] !== undefined ? match[1] : null;
}

function readEvaluatorRecord(runId: string): {
  present: boolean; done: boolean | null; rewardType: string | null;
} {
  const recordPath = join(REPO_ROOT, "evaluation", "runs", `${runId}.json`);
  if (!existsSync(recordPath)) {
    return { present: false, done: null, rewardType: null };
  }
  try {
    const record = JSON.parse(readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
    const terminal = record["environment_terminal"] as Record<string, unknown> | undefined;
    const rewardTypeRaw = record["reward_type"];
    return {
      present: true,
      done: typeof terminal?.["done"] === "boolean" ? terminal["done"] : null,
      rewardType: typeof rewardTypeRaw === "string" ? rewardTypeRaw : null,
    };
  } catch {
    return { present: false, done: null, rewardType: null };
  }
}

function runTask(taskId: number, split: string): TaskOutcome {
  const child = spawnSync(
    "bash",
    ["scripts/run_live_task.sh", "--task-id", String(taskId), "--live"],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        SHOPPING_LIVE_TASK_CONFIG: evalConfigPath,
      },
      timeout: 30 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const runnerExit = child.status;
  const runId = parseRunId(child.stdout ?? "");

  let outcome: TaskOutcome = {
    task_id: taskId,
    split,
    run_id: runId,
    runner_exit: runnerExit,
    actor_trace_rel: null,
    evaluator_record_rel: null,
    evaluator_present: false,
    environment_done: null,
    reward_type: null,
    status: "runner_failure",
  };

  if (runId !== null) {
    const tracePath = join(REPO_ROOT, "trajectories", "actor", `${runId}.jsonl`);
    if (existsSync(tracePath)) {
      outcome.actor_trace_rel = relative(REPO_ROOT, tracePath);
    }
    const evaluator = readEvaluatorRecord(runId);
    outcome.evaluator_present = evaluator.present;
    outcome.environment_done = evaluator.done;
    outcome.reward_type = evaluator.rewardType;
    if (evaluator.present) {
      outcome.evaluator_record_rel = relative(
        REPO_ROOT,
        join(REPO_ROOT, "evaluation", "runs", `${runId}.json`),
      );
    }
    if (runnerExit !== 0) {
      outcome.status = "runner_failure";
    } else if (!evaluator.present) {
      outcome.status = "missing_evaluator_record";
    } else if (evaluator.done === true) {
      outcome.status = "environment_done";
    } else {
      outcome.status = "terminated_without_done";
    }
  } else if (runnerExit === 0) {
    // runner 声称成功但没给出 run_id：按 infra 异常处理，不伪造结果
    outcome.status = "runner_failure";
  }
  return outcome;
}

const splitsToRun = splitArg === "all"
  ? ["held-in", "held-out"] as const
  : [splitArg] as unknown as ["held-in" | "held-out"];

const allOutcomes: TaskOutcome[] = [];
for (const split of splitsToRun) {
  const taskIds = split === "held-in"
    ? manifest.heldInTaskIds
    : manifest.heldOutTaskIds;
  console.error(
    `[baseline_orchestrator] split=${split} tasks=[${taskIds.join(", ")}] `
    + `max_steps=${manifest.maxEnvironmentSteps}`,
  );
  const splitOutcomes: TaskOutcome[] = [];
  for (const taskId of taskIds) {
    console.error(`[baseline_orchestrator] 运行 task ${taskId}（${split}）...`);
    const outcome = runTask(taskId, split);
    splitOutcomes.push(outcome);
    console.error(
      `[baseline_orchestrator] task ${taskId}: status=${outcome.status} `
      + `runner_exit=${String(outcome.runner_exit)} run_id=${outcome.run_id ?? "<none>"}`,
    );
  }
  // split 结果严格分开写文件
  const splitFile = join(baselineDir, `${split}.json`);
  writeFileSync(splitFile, `${JSON.stringify({
    baseline_run_id: baselineRunId,
    benchmark_id: manifest.benchmarkId,
    split,
    usage_note: split === "held-out"
      ? "held-out 结果仅供 candidate gate；后续绝不提供给 proposer"
      : "held-in 轨迹后续允许用于 failure evidence",
    max_environment_steps: manifest.maxEnvironmentSteps,
    outcomes: splitOutcomes,
  }, null, 2)}\n`, "utf-8");
  allOutcomes.push(...splitOutcomes);
}

// ---- 汇总（脱敏：只有计数与引用，无 goal/gold/observation/key） ------------
function countByStatus(outcomes: TaskOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {
    environment_done: 0,
    terminated_without_done: 0,
    missing_evaluator_record: 0,
    runner_failure: 0,
  };
  for (const outcome of outcomes) {
    counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  }
  return counts;
}

const rewardTypeCounts: Record<string, number> = {};
for (const outcome of allOutcomes) {
  if (outcome.reward_type !== null) {
    rewardTypeCounts[outcome.reward_type] = (rewardTypeCounts[outcome.reward_type] ?? 0) + 1;
  }
}

const summary = {
  baseline_run_id: baselineRunId,
  benchmark_id: manifest.benchmarkId,
  harness_id: manifest.harnessId,
  harness_version: manifest.harnessVersion,
  tool_surface_digest: harness.toolSurfaceDigest,
  splits: splitsToRun,
  max_environment_steps: manifest.maxEnvironmentSteps,
  evaluation_config: relative(REPO_ROOT, evalConfigPath),
  total_tasks: allOutcomes.length,
  status_counts: countByStatus(allOutcomes),
  completion_rate: allOutcomes.length > 0
    ? allOutcomes.filter((outcome) => outcome.status === "environment_done").length
      / allOutcomes.length
    : null,
  evaluator_present_count: allOutcomes.filter((outcome) => outcome.evaluator_present).length,
  runner_failure_count: allOutcomes.filter((outcome) => outcome.status === "runner_failure").length,
  evaluator_aggregate: { reward_type_counts: rewardTypeCounts },
  semantics: {
    pass_definition: "environment done 且存在 evaluator 证据（shop_finish 不算成功）",
    missing_evaluator_record: "DSH 在环境 terminal 前退出；不伪造 pass/fail",
    held_out_isolation: "held-out 结果单独文件；后续 proposer 不得读取",
  },
};
writeFileSync(join(baselineDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

const baselineManifest = {
  baseline_run_id: baselineRunId,
  benchmark_id: manifest.benchmarkId,
  purpose: manifest.purpose,
  harness_id: manifest.harnessId,
  harness_version: manifest.harnessVersion,
  tool_surface_digest: harness.toolSurfaceDigest,
  task_source: manifest.taskSource,
  held_in_task_ids: manifest.heldInTaskIds,
  held_out_task_ids: manifest.heldOutTaskIds,
  final_benchmark_excluded: manifest.finalBenchmarkExcluded,
  max_environment_steps: manifest.maxEnvironmentSteps,
  repeats: manifest.repeats,
  splits_run: splitsToRun,
  task_run_map: allOutcomes.map((outcome) => ({
    split: outcome.split,
    task_id: outcome.task_id,
    run_id: outcome.run_id,
    runner_exit: outcome.runner_exit,
    status: outcome.status,
    actor_trace_rel: outcome.actor_trace_rel,
    evaluator_record_rel: outcome.evaluator_record_rel,
  })),
};
writeFileSync(join(baselineDir, "manifest.json"), `${JSON.stringify(baselineManifest, null, 2)}\n`, "utf-8");

console.error(`[baseline_orchestrator] 结果目录: ${relative(REPO_ROOT, baselineDir)}`);
console.error(
  `[baseline_orchestrator] 汇总: ${JSON.stringify(summary.status_counts)} `
  + `completion_rate=${summary.completion_rate?.toFixed(3) ?? "n/a"}`,
);
process.exit(0);
