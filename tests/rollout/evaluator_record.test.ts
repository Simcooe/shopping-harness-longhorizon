/**
 * evaluator record 测试：结果证据收集、失败标签、与 actor 通道的隔离。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EVALUATOR_SCHEMA_VERSION,
  EvaluatorCollector,
  writeEvaluatorRecord,
} from "../../plugins/shopping/src/rollout/index.ts";
import { renderObservation, renderToolSummary } from "../../plugins/shopping/src/observation/index.ts";
import { parseActorObservation } from "../../plugins/shopping/src/environment/protocol.ts";

const SECRET_ASIN = "B0GOLD-SECRET-ASIN";

function doneOutcome() {
  return {
    done: true,
    reward: 1.0,
    rewardValid: true,
    terminationReason: "gold_purchase",
    rewardDetail: { type: "gold_purchase", gold_asin: SECRET_ASIN },
    purchaseAsin: SECRET_ASIN,
  };
}

test("evaluator 收集与构建：reward/终止/统计齐全", () => {
  const collector = new EvaluatorCollector();
  collector.noteToolStep();
  collector.noteToolStep();
  collector.noteGuardRejection();
  collector.noteEvaluatorOutcome(doneOutcome());

  const record = collector.build({
    runId: "run-eval-1",
    taskId: 0,
    harnessVersion: "shopping-base@0.0.0",
    releaseStatus: "released",
    clock: () => new Date("2026-08-20T00:00:00.000Z"),
  });

  assert.equal(record.schema_version, EVALUATOR_SCHEMA_VERSION);
  assert.equal(record.run_id, "run-eval-1");
  assert.equal(record.task_id, 0);
  assert.equal(record.reward, 1.0);
  assert.equal(record.reward_type, "gold_purchase");
  assert.equal(record.reward_valid, true);
  assert.equal(record.purchase_asin, SECRET_ASIN);
  assert.equal(record.environment_terminal.done, true);
  assert.equal(record.environment_terminal.termination_reason, "gold_purchase");
  assert.equal(record.tool_steps, 2);
  assert.equal(record.guard_rejections, 1);
  assert.equal(record.max_steps_triggered, false);
  assert.deepEqual(record.failure_labels, ["gold_purchase"]);
  assert.equal(record.release_status, "released");
});

test("失败标签：max_steps / tool_error / early_abstain / unknown", () => {
  const maxSteps = new EvaluatorCollector();
  maxSteps.noteMaxSteps();
  assert.deepEqual(maxSteps.build({
    runId: "a", taskId: 0, harnessVersion: "v", releaseStatus: "released",
  }).failure_labels, ["max_steps"]);

  const toolError = new EvaluatorCollector();
  toolError.noteLocalError("tool_error");
  assert.ok(toolError.build({
    runId: "b", taskId: 0, harnessVersion: "v", releaseStatus: "released",
  }).failure_labels.includes("tool_error"));

  const abstain = new EvaluatorCollector();
  abstain.noteEvaluatorOutcome({
    done: true, reward: -0.35, rewardValid: true,
    terminationReason: "early_abstain", rewardDetail: null, purchaseAsin: null,
  });
  assert.ok(abstain.build({
    runId: "c", taskId: 0, harnessVersion: "v", releaseStatus: "released",
  }).failure_labels.includes("early_abstain"));

  const empty = new EvaluatorCollector();
  assert.deepEqual(empty.build({
    runId: "d", taskId: 0, harnessVersion: "v", releaseStatus: "not_released",
  }).failure_labels, ["unknown"]);
});

test("写入 evaluation/runs/<run_id>.json 且 run_id 关联", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-"));
  try {
    const collector = new EvaluatorCollector();
    collector.noteEvaluatorOutcome(doneOutcome());
    const record = collector.build({
      runId: "run-link-42", taskId: 0, harnessVersion: "v", releaseStatus: "released",
    });
    const path = writeEvaluatorRecord(dir, record);
    assert.equal(path, join(dir, "run-link-42.json"));
    const written = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    assert.equal(written["run_id"], "run-link-42");
    assert.equal(written["reward"], 1.0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("隔离：evaluator 证据不可能被 observation 投影或工具摘要引用", () => {
  // observation 投影的输入类型里不存在 reward/gold 字段；
  // 即便构造"被污染"的观测，白名单也会剔除秘密
  const observation = parseActorObservation({
    page_type: "search_results",
    search_available: true,
    actions: [],
    products: [{ asin: "B0X", title: "枕头" }],
    gold_asin: SECRET_ASIN,
    reward_detail: doneOutcome().rewardDetail,
  });
  const text = renderObservation(observation);
  assert.ok(!text.includes(SECRET_ASIN));

  const summary = renderToolSummary({
    environmentAction: "click[Buy Now]",
    done: true,
    taskInstruction: null,
    observation,
  });
  assert.ok(!summary.includes(SECRET_ASIN));
  assert.ok(!summary.includes("gold_purchase"));

  // evaluator 侧则完整保留证据（两个通道各司其职）
  const collector = new EvaluatorCollector();
  collector.noteEvaluatorOutcome(doneOutcome());
  const record = collector.build({
    runId: "x", taskId: 0, harnessVersion: "v", releaseStatus: "released",
  });
  assert.equal(record.purchase_asin, SECRET_ASIN);
});
