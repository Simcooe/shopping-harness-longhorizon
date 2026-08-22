/**
 * held-in failure evidence bundle 离线测试。
 * 全程不调用模型、不启动真实 ShopSimulator、不读取真实 API key。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

import {
  buildFailureEvidence,
  buildHeldInEvidence,
} from "../../plugins/shopping/src/evidence/index.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

const SECRET = "SECRET-GOAL-gold-asin-xyz";

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

interface TraceEventInput {
  event: string;
  tool?: string;
  environment_action?: string;
  args?: Record<string, unknown>;
  local_reason?: string;
  [key: string]: unknown;
}

function writeActorTrace(dir: string, runId: string, taskId: number, events: TraceEventInput[]): string {
  const path = join(dir, "trajectories", "actor", `${runId}.jsonl`);
  mkdirSync(join(path, ".."), { recursive: true });
  const lines = events.map((event, index) => JSON.stringify({
    schema_version: 2,
    run_id: runId,
    task_id: taskId,
    harness_version: "shopping-base@0.0.0",
    timestamp: "2026-08-21T00:00:00.000Z",
    seq: index,
    ...event,
  }));
  writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
  return path;
}

function writeEvaluatorRecord(dir: string, runId: string, record: Record<string, unknown>): string {
  const path = join(dir, "evaluation", "runs", `${runId}.json`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return path;
}

interface BaselineOutcome {
  task_id: number;
  run_id: string | null;
  status: string;
  actor_trace_rel: string | null;
  evaluator_record_rel: string | null;
  [key: string]: unknown;
}

interface BaselineSpec {
  baselineRunId: string;
  benchmarkId?: string;
  harnessId?: string;
  harnessVersion?: string;
  toolSurfaceDigest?: string;
  heldInTaskIds?: number[];
  outcomes: BaselineOutcome[];
  withHeldOut?: boolean;
}

function writeBaseline(dir: string, spec: BaselineSpec): string {
  const baselineDir = join(dir, "evaluation", "baselines", spec.baselineRunId);
  const manifest = {
    baseline_run_id: spec.baselineRunId,
    benchmark_id: spec.benchmarkId ?? "shopping-development-v1",
    purpose: "harness_development_only",
    harness_id: spec.harnessId ?? "shopping-h0",
    harness_version: spec.harnessVersion ?? "0.1.0",
    tool_surface_digest: spec.toolSurfaceDigest ?? "sha256:deadbeef",
    task_source: "configs/tasks/development.json",
    held_in_task_ids: spec.heldInTaskIds ?? spec.outcomes.map((outcome) => outcome.task_id),
    held_out_task_ids: [8, 9, 10, 11],
    final_benchmark_excluded: true,
    max_environment_steps: 35,
    repeats: 1,
    splits_run: ["held-in"],
    task_run_map: spec.outcomes.map((outcome) => ({
      split: "held-in",
      task_id: outcome.task_id,
      run_id: outcome.run_id,
      status: outcome.status,
    })),
  };
  writeJson(join(baselineDir, "manifest.json"), manifest);
  writeJson(join(baselineDir, "held-in.json"), {
    baseline_run_id: spec.baselineRunId,
    benchmark_id: manifest["benchmark_id"],
    split: "held-in",
    usage_note: "held-in 轨迹后续允许用于 failure evidence",
    max_environment_steps: 35,
    outcomes: spec.outcomes,
  });
  if (spec.withHeldOut === true) {
    writeJson(join(baselineDir, "held-out.json"), {
      baseline_run_id: spec.baselineRunId,
      benchmark_id: manifest["benchmark_id"],
      split: "held-out",
      usage_note: "held-out 绝不提供给 proposer",
      outcomes: [{ task_id: 8, run_id: "run-heldout-secret", status: "environment_done", secret: SECRET }],
    });
  }
  return baselineDir;
}

function traceRunStart(harnessId = "shopping-h0"): TraceEventInput {
  return {
    event: "run_start",
    profile: "shopping-base",
    harness_id: harnessId,
    harness_manifest_version: "0.1.0",
    tool_surface: "sha256:deadbeef",
    system_prompt_ref: "system-prompt.md",
  };
}

function traceToolCall(tool: string, environmentAction: string, args?: Record<string, unknown>): TraceEventInput {
  return { event: "tool_call", tool, environment_action: environmentAction, args };
}

function traceTerminal(localReason: string): TraceEventInput {
  return { event: "terminal", done: localReason === "environment_done", local_reason: localReason, release_status: "released" };
}

// ---------------------------------------------------------------------------

test("正常 held-in baseline 输入生成 evidence，且 manifest 字段正确关联", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    // 一个明确失败（wrong_purchase）的 run，一个成功 run
    writeEvaluatorRecord(dir, "run-wrong", {
      schema_version: 1, run_id: "run-wrong", task_id: 0, harness_version: "v",
      environment_terminal: { done: true, over: true, termination_reason: "wrong_purchase" },
      reward: -0.5, reward_type: "wrong_purchase", reward_valid: true,
      purchase_asin: SECRET, failure_labels: ["wrong_purchase"],
      tool_steps: 4, guard_rejections: 1, max_steps_triggered: false, release_status: "released",
    });
    writeActorTrace(dir, "run-wrong", 0, [
      traceRunStart(),
      { event: "task_instruction", instruction_text: `购买${SECRET}` },
      traceToolCall("shop_search", `search[${SECRET}]`, { query: SECRET }),
      traceToolCall("shop_click", `click[${SECRET}]`, { target: SECRET }),
      traceToolCall("shop_finish", "finish[no_suitable_product]", { reason: "no_suitable_product" }),
      traceTerminal("environment_done"),
    ]);

    writeEvaluatorRecord(dir, "run-gold", {
      schema_version: 1, run_id: "run-gold", task_id: 1, harness_version: "v",
      environment_terminal: { done: true, over: true, termination_reason: "gold_purchase" },
      reward: 1.0, reward_type: "gold_purchase", reward_valid: true,
      purchase_asin: "B0GOLD", failure_labels: ["gold_purchase"],
      tool_steps: 3, guard_rejections: 0, max_steps_triggered: false, release_status: "released",
    });
    writeActorTrace(dir, "run-gold", 1, [
      traceRunStart(),
      traceToolCall("shop_search", "search[pillow]", { query: "pillow" }),
      traceToolCall("shop_finish", "finish[no_suitable_product]", { reason: "no_suitable_product" }),
      traceTerminal("environment_done"),
    ]);

    const baselineDir = writeBaseline(dir, {
      baselineRunId: "baseline-e1",
      heldInTaskIds: [0, 1],
      outcomes: [
        { task_id: 0, run_id: "run-wrong", status: "environment_done", actor_trace_rel: "trajectories/actor/run-wrong.jsonl", evaluator_record_rel: "evaluation/runs/run-wrong.json" },
        { task_id: 1, run_id: "run-gold", status: "environment_done", actor_trace_rel: "trajectories/actor/run-gold.jsonl", evaluator_record_rel: "evaluation/runs/run-gold.json" },
      ],
    });

    const { evidence, manifest } = buildHeldInEvidence(baselineDir, dir);

    assert.equal(evidence.schema_version, 1);
    assert.equal(evidence.evidence_id, "evidence-baseline-e1");
    assert.equal(evidence.source.baseline_run_id, "baseline-e1");
    assert.equal(evidence.source.benchmark_id, "shopping-development-v1");
    assert.equal(evidence.source.harness_id, "shopping-h0");
    assert.equal(evidence.source.harness_version, "0.1.0");
    assert.equal(evidence.source.tool_surface_digest, "sha256:deadbeef");
    assert.equal(evidence.source.split, "held-in");

    assert.equal(evidence.scope.task_count, 2);
    assert.equal(evidence.scope.eligible_failure_count, 1);
    assert.equal(evidence.scope.excluded_success_count, 1);
    assert.equal(evidence.scope.unknown_count, 0);
    assert.equal(evidence.scope.infra_failure_count, 0);
    assert.equal(evidence.scope.held_out_included, false);

    assert.equal(manifest.baseline_run_id, "baseline-e1");
    assert.equal(manifest.benchmark_id, "shopping-development-v1");
    assert.equal(manifest.harness_id, "shopping-h0");
    assert.equal(manifest.harness_version, "0.1.0");
    assert.equal(manifest.tool_surface_digest, "sha256:deadbeef");
    assert.deepEqual(manifest.held_in_task_ids, [0, 1]);
    assert.equal(manifest.final_benchmark_excluded, true);

    // 唯一失败 cluster 是 wrong_purchase
    assert.equal(evidence.failure_clusters.length, 1);
    const cluster = evidence.failure_clusters[0]!;
    assert.equal(cluster.failure_signature.evaluator_outcome, "wrong_purchase");
    assert.equal(cluster.failure_signature.execution_status, "evaluator_failure");
    assert.equal(cluster.support, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多个相同失败模式合并为同一 deterministic cluster，representative ≤3 且顺序稳定", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    const outcomes: BaselineOutcome[] = [];
    for (let i = 0; i < 5; i += 1) {
      const runId = `run-m-${i}`;
      const taskId = i;
      writeEvaluatorRecord(dir, runId, {
        schema_version: 1, run_id: runId, task_id: taskId, harness_version: "v",
        environment_terminal: { done: false, over: false, termination_reason: null },
        reward: null, reward_type: null, reward_valid: null, purchase_asin: null,
        failure_labels: ["max_steps"], tool_steps: 35, guard_rejections: 0,
        max_steps_triggered: true, release_status: "released",
      });
      writeActorTrace(dir, runId, taskId, [
        traceRunStart(),
        traceToolCall("shop_search", "search[x]", { query: "x" }),
        traceTerminal("max_steps"),
      ]);
      outcomes.push({
        task_id: taskId,
        run_id: runId,
        status: "terminated_without_done",
        actor_trace_rel: `trajectories/actor/${runId}.jsonl`,
        evaluator_record_rel: `evaluation/runs/${runId}.json`,
      });
    }
    const baselineDir = writeBaseline(dir, {
      baselineRunId: "baseline-e2",
      heldInTaskIds: [0, 1, 2, 3, 4],
      outcomes,
    });

    const { evidence } = buildHeldInEvidence(baselineDir, dir);
    assert.equal(evidence.scope.eligible_failure_count, 5);
    assert.equal(evidence.failure_clusters.length, 1);
    const cluster = evidence.failure_clusters[0]!;
    assert.equal(cluster.failure_signature.evaluator_outcome, "max_steps");
    assert.equal(cluster.failure_signature.execution_status, "terminated_without_done");
    assert.ok(cluster.failure_signature.agent_symptoms.includes("max_steps"));
    assert.equal(cluster.support, 5);
    assert.equal(cluster.representative_runs.length, 3);
    // 稳定排序：task_id 升序
    assert.deepEqual(
      cluster.representative_runs.map((run) => run.task_id),
      [0, 1, 2],
    );

    // 重复构建：cluster id 与内容稳定
    const { evidence: evidence2 } = buildHeldInEvidence(baselineDir, dir);
    assert.deepEqual(evidence2, evidence);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("held-out.json 缺失仍可构建；held-out.json 含 sentinel 也不被读取或泄漏", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    writeEvaluatorRecord(dir, "run-in", {
      schema_version: 1, run_id: "run-in", task_id: 0, harness_version: "v",
      environment_terminal: { done: true, over: true, termination_reason: "early_abstain" },
      reward: -0.35, reward_type: "early_abstain", reward_valid: true, purchase_asin: null,
      failure_labels: ["early_abstain"], tool_steps: 2, guard_rejections: 0,
      max_steps_triggered: false, release_status: "released",
    });
    writeActorTrace(dir, "run-in", 0, [
      traceRunStart(),
      traceToolCall("shop_finish", "finish[no_suitable_product]", { reason: "no_suitable_product" }),
      traceTerminal("environment_done"),
    ]);

    // 无 held-out.json
    const baselineDirNoHeldOut = writeBaseline(dir, {
      baselineRunId: "baseline-no-ho",
      heldInTaskIds: [0],
      outcomes: [{ task_id: 0, run_id: "run-in", status: "environment_done", actor_trace_rel: "trajectories/actor/run-in.jsonl", evaluator_record_rel: "evaluation/runs/run-in.json" }],
      withHeldOut: false,
    });
    const { evidence: evidenceNoHeldOut } = buildHeldInEvidence(baselineDirNoHeldOut, dir);
    assert.equal(evidenceNoHeldOut.scope.task_count, 1);
    assert.equal(evidenceNoHeldOut.scope.held_out_included, false);

    // 有 held-out.json（含 sentinel）
    const baselineDirWithHeldOut = writeBaseline(dir, {
      baselineRunId: "baseline-with-ho",
      heldInTaskIds: [0],
      outcomes: [{ task_id: 0, run_id: "run-in", status: "environment_done", actor_trace_rel: "trajectories/actor/run-in.jsonl", evaluator_record_rel: "evaluation/runs/run-in.json" }],
      withHeldOut: true,
    });
    const { evidence, manifest } = buildHeldInEvidence(baselineDirWithHeldOut, dir);
    const text = JSON.stringify(evidence) + JSON.stringify(manifest);
    assert.ok(!text.includes(SECRET), "held-out.json 的 sentinel 泄漏进了 evidence");
    assert.ok(!text.includes("run-heldout-secret"));
    assert.equal(evidence.scope.held_out_included, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("actor trace / evaluator record 的敏感字段绝不泄漏到 evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    const runId = "run-leak";
    writeEvaluatorRecord(dir, runId, {
      schema_version: 1, run_id: runId, task_id: 0, harness_version: "v",
      environment_terminal: { done: true, over: true, termination_reason: "wrong_purchase" },
      reward: 123.456, reward_type: "wrong_purchase", reward_valid: true,
      purchase_asin: "B0SECRETPURCHASE", gold_asin: "B0SECRETGOLD",
      failure_labels: ["wrong_purchase"], tool_steps: 5, guard_rejections: 1,
      max_steps_triggered: false, release_status: "released",
    });
    writeActorTrace(dir, runId, 0, [
      traceRunStart(),
      { event: "task_instruction", instruction_text: "SECRET_INSTRUCTION_请买枕头" },
      traceToolCall("shop_search", "search[SECRET_QUERY]", { query: "SECRET_QUERY" }),
      traceToolCall("shop_click", "click[SECRET_TARGET]", { target: "SECRET_TARGET" }),
      {
        event: "observation",
        page_type: "search_results",
        done: false,
        observation: { products: [{ asin: "SECRET_OBSERVATION_ASIN", title: "SECRET_OBSERVATION" }] },
      },
      traceTerminal("environment_done"),
    ]);
    const baselineDir = writeBaseline(dir, {
      baselineRunId: "baseline-leak",
      heldInTaskIds: [0],
      outcomes: [{ task_id: 0, run_id: runId, status: "environment_done", actor_trace_rel: `trajectories/actor/${runId}.jsonl`, evaluator_record_rel: `evaluation/runs/${runId}.json` }],
    });

    const { evidence, manifest } = buildHeldInEvidence(baselineDir, dir);
    const text = JSON.stringify(evidence) + JSON.stringify(manifest);
    for (const forbidden of [
      "123.456", "B0SECRETPURCHASE", "B0SECRETGOLD",
      "SECRET_INSTRUCTION", "SECRET_QUERY", "SECRET_TARGET", "SECRET_OBSERVATION",
    ]) {
      assert.ok(!text.includes(forbidden), `evidence 泄漏了 ${forbidden}`);
    }
    // 允许保留的类别名/工具名/计数仍存在
    assert.ok(text.includes("wrong_purchase"));
    assert.ok(text.includes("shop_search"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing evaluator record → infra_failure；environment done 但 evaluator 失败 → evaluator_failure（不算成功）", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    // missing evaluator record
    writeActorTrace(dir, "run-missing-eval", 0, [
      traceRunStart(),
      traceToolCall("shop_search", "search[x]", { query: "x" }),
      traceTerminal("session_over"),
    ]);

    // environment done=true 但 evaluator 明确失败（wrong_purchase）
    writeEvaluatorRecord(dir, "run-done-fail", {
      schema_version: 1, run_id: "run-done-fail", task_id: 1, harness_version: "v",
      environment_terminal: { done: true, over: true, termination_reason: "wrong_purchase" },
      reward: -0.4, reward_type: "wrong_purchase", reward_valid: true, purchase_asin: "B0X",
      failure_labels: ["wrong_purchase"], tool_steps: 4, guard_rejections: 0,
      max_steps_triggered: false, release_status: "released",
    });
    writeActorTrace(dir, "run-done-fail", 1, [
      traceRunStart(),
      traceToolCall("shop_search", "search[x]", { query: "x" }),
      traceTerminal("environment_done"),
    ]);

    const baselineDir = writeBaseline(dir, {
      baselineRunId: "baseline-e5",
      heldInTaskIds: [0, 1],
      outcomes: [
        { task_id: 0, run_id: "run-missing-eval", status: "missing_evaluator_record", actor_trace_rel: "trajectories/actor/run-missing-eval.jsonl", evaluator_record_rel: null },
        { task_id: 1, run_id: "run-done-fail", status: "environment_done", actor_trace_rel: "trajectories/actor/run-done-fail.jsonl", evaluator_record_rel: "evaluation/runs/run-done-fail.json" },
      ],
    });

    const { evidence } = buildHeldInEvidence(baselineDir, dir);

    assert.equal(evidence.scope.eligible_failure_count, 1);
    assert.equal(evidence.scope.excluded_success_count, 0);
    assert.equal(evidence.scope.infra_failure_count, 1);
    assert.equal(evidence.scope.unknown_count, 0);

    const infra = evidence.failure_clusters.find((c) => c.failure_signature.execution_status === "missing_evaluator_record");
    assert.ok(infra, "缺少 infra_failure cluster");
    assert.equal(infra.failure_signature.evaluator_outcome, "unknown");
    assert.equal(infra.support, 1);

    const failure = evidence.failure_clusters.find((c) => c.failure_signature.evaluator_outcome === "wrong_purchase");
    assert.ok(failure, "缺少 wrong_purchase cluster");
    assert.equal(failure.failure_signature.execution_status, "evaluator_failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("environment done 但无成功/失败证据 → unknown（不伪装 pass）；runner failure 不阻断其余 run", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    // done=true 但 reward_type=null, reward_valid=null, failure_labels=[unknown]
    writeEvaluatorRecord(dir, "run-unknown", {
      schema_version: 1, run_id: "run-unknown", task_id: 0, harness_version: "v",
      environment_terminal: { done: true, over: true, termination_reason: null },
      reward: null, reward_type: null, reward_valid: null, purchase_asin: null,
      failure_labels: ["unknown"], tool_steps: 1, guard_rejections: 0,
      max_steps_triggered: false, release_status: "released",
    });
    writeActorTrace(dir, "run-unknown", 0, [
      traceRunStart(),
      traceTerminal("environment_done"),
    ]);

    // runner failure（无 evaluator record）
    const baselineDir = writeBaseline(dir, {
      baselineRunId: "baseline-e6",
      heldInTaskIds: [0, 1],
      outcomes: [
        { task_id: 0, run_id: "run-unknown", status: "environment_done", actor_trace_rel: "trajectories/actor/run-unknown.jsonl", evaluator_record_rel: "evaluation/runs/run-unknown.json" },
        { task_id: 1, run_id: null, status: "runner_failure", actor_trace_rel: null, evaluator_record_rel: null },
      ],
    });

    const { evidence } = buildHeldInEvidence(baselineDir, dir);
    assert.equal(evidence.scope.task_count, 2);
    assert.equal(evidence.scope.unknown_count, 1);
    assert.equal(evidence.scope.infra_failure_count, 1);
    assert.equal(evidence.scope.excluded_success_count, 0);
    assert.equal(evidence.scope.eligible_failure_count, 0);

    const unknown = evidence.failure_clusters.find((c) => c.failure_signature.evaluator_outcome === "unknown"
      && c.failure_signature.execution_status === "evaluator_inconclusive");
    assert.ok(unknown, "缺少 unknown cluster");

    const runner = evidence.failure_clusters.find((c) => c.failure_signature.execution_status === "runner_failure");
    assert.ok(runner, "缺少 runner_failure cluster");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluator record JSON 损坏 → evaluator_record_corrupt（不伪造结果）", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    const runId = "run-corrupt";
    const evaluatorPath = join(dir, "evaluation", "runs", `${runId}.json`);
    mkdirSync(join(evaluatorPath, ".."), { recursive: true });
    writeFileSync(evaluatorPath, "{ not valid json ", "utf-8");
    const baselineDir = writeBaseline(dir, {
      baselineRunId: "baseline-corrupt",
      heldInTaskIds: [0],
      outcomes: [{ task_id: 0, run_id: runId, status: "environment_done", actor_trace_rel: null, evaluator_record_rel: `evaluation/runs/${runId}.json` }],
    });

    const { evidence } = buildHeldInEvidence(baselineDir, dir);
    assert.equal(evidence.scope.infra_failure_count, 1);
    const corrupt = evidence.failure_clusters.find((c) => c.failure_signature.execution_status === "evaluator_record_corrupt");
    assert.ok(corrupt);
    assert.equal(corrupt.failure_signature.evaluator_outcome, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("写盘：输出目录与文件正确创建", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    const baselineDir = writeBaseline(dir, {
      baselineRunId: "baseline-write",
      heldInTaskIds: [0],
      outcomes: [{ task_id: 0, run_id: null, status: "runner_failure", actor_trace_rel: null, evaluator_record_rel: null }],
    });
    const outDir = join(dir, "evaluation", "evidence", "baseline-write");
    const result = buildFailureEvidence({ baselineDir, repoRoot: dir, outDir });
    assert.ok(existsSync(join(outDir, "manifest.json")));
    assert.ok(existsSync(join(outDir, "held-in-evidence.json")));
    assert.equal(result.writtenFiles.length, 2);
    const evidence = JSON.parse(readFileSync(join(outDir, "held-in-evidence.json"), "utf-8")) as Record<string, unknown>;
    assert.equal(evidence["schema_version"], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 拒绝 --split held-out / --all；happy path 正常构建", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    const baselineRunId = "baseline-cli";
    writeBaseline(dir, {
      baselineRunId,
      heldInTaskIds: [0],
      outcomes: [{ task_id: 0, run_id: null, status: "runner_failure", actor_trace_rel: null, evaluator_record_rel: null }],
    });
    const baselineDir = join(dir, "evaluation", "baselines", baselineRunId);
    const outDir = join(dir, "out");
    const script = "scripts/build_failure_evidence.ts";

    for (const badArgs of [["--split", "held-out"], ["--split", "all"], ["--all"]]) {
      const result = spawnSync("node", [script, "--baseline-dir", baselineDir, ...badArgs], {
        cwd: REPO_ROOT, encoding: "utf-8",
      });
      assert.equal(result.status, 2, `应拒绝 ${badArgs.join(" ")}`);
      assert.match(result.stderr, /明确拒绝/);
    }

    // happy path：写盘成功（trace/evaluator 缺失 → infra_failure，仍可构建）
    const ok = spawnSync("node", [script, "--baseline-dir", baselineDir, "--out-dir", outDir], {
      cwd: REPO_ROOT, encoding: "utf-8",
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(join(outDir, "manifest.json")));
    assert.ok(existsSync(join(outDir, "held-in-evidence.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：baseline 目录名与 manifest baseline_run_id 不一致时报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    const baselineDir = writeBaseline(dir, {
      baselineRunId: "baseline-actual",
      heldInTaskIds: [0],
      outcomes: [{ task_id: 0, run_id: null, status: "runner_failure", actor_trace_rel: null, evaluator_record_rel: null }],
    });
    const renamed = join(dir, "evaluation", "baselines", "baseline-mismatch");
    renameSync(baselineDir, renamed);
    const result = spawnSync("node", ["scripts/build_failure_evidence.ts", "--baseline-dir", renamed], {
      cwd: REPO_ROOT, encoding: "utf-8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /不一致/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
