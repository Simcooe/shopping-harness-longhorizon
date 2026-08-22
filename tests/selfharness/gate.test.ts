/**
 * candidate gate v1 与 lineage 的离线测试（纯逻辑）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLineage,
  countSuccess,
  evaluateGateV1,
  isSuccess,
  type EvalOutcome,
  type GateInput,
} from "../../plugins/shopping/src/selfharness/index.ts";

function o(status: string, rewardValid: boolean | null, rewardType: string | null): EvalOutcome {
  return { task_id: 0, status, reward_valid: rewardValid, reward_type: rewardType };
}

function success(): EvalOutcome {
  return o("environment_done", true, "gold_purchase");
}

function baseInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    baseHeldIn: [success(), success(), o("environment_done", true, "max_steps")],
    baseHeldOut: [success(), o("environment_done", true, "wrong_purchase")],
    candidateHeldIn: [success(), success(), success()],
    candidateHeldOut: [success(), success()],
    editedFiles: ["system-prompt.md"],
    candidateValidated: true,
    ...overrides,
  };
}

test("success 语义：reward_valid=true 且 reward_type 为成功类别才算成功", () => {
  assert.equal(isSuccess(success()), true);
  assert.equal(isSuccess(o("environment_done", true, "valid_alternative_purchase")), true);
  // environment done 但 reward_valid 缺失 → 不算成功
  assert.equal(isSuccess(o("environment_done", null, "gold_purchase")), false);
  // environment done 但 reward_type 是失败类别 → 不算成功
  assert.equal(isSuccess(o("environment_done", true, "max_steps")), false);
  assert.equal(isSuccess(o("environment_done", true, "wrong_purchase")), false);
  assert.equal(countSuccess([success(), o("environment_done", null, "gold_purchase"), success()]), 2);
});

test("gate 接受：held-in improved + held-out non-degraded + 无 infra + validated", () => {
  const decision = evaluateGateV1(baseInput());
  assert.equal(decision.decision, "accepted");
  assert.ok(decision.rules.every((rule) => rule.pass));
});

test("gate 拒绝：held-in 未改善", () => {
  const decision = evaluateGateV1(baseInput({
    candidateHeldIn: [success(), success()], // 2 不严格大于 base 2
  }));
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.rules.find((r) => r.rule === "held_in_improved")?.pass, false);
});

test("gate 拒绝：held-out 退化", () => {
  const decision = evaluateGateV1(baseInput({
    candidateHeldOut: [o("environment_done", true, "wrong_purchase")], // 0 成功 < base 1
  }));
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.rules.find((r) => r.rule === "held_out_non_degraded")?.pass, false);
});

test("gate 拒绝：新增 runner_failure / missing_evaluator_record", () => {
  const decision = evaluateGateV1(baseInput({
    candidateHeldIn: [success(), success(), success(), o("runner_failure", null, null)],
  }));
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.rules.find((r) => r.rule === "no_new_infra_failure")?.pass, false);
});

test("gate 拒绝：缺 held-out baseline（绝不拿 held-in 代替）", () => {
  const decision = evaluateGateV1(baseInput({ baseHeldOut: null }));
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.rules.find((r) => r.rule === "held_out_baseline_present")?.pass, false);
});

test("gate 拒绝：candidate 未通过校验或修改白名单之外文件", () => {
  const decision = evaluateGateV1(baseInput({ candidateValidated: false }));
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.rules.find((r) => r.rule === "candidate_schema_frozen_boundary")?.pass, false);

  const decision2 = evaluateGateV1(baseInput({ editedFiles: ["harness.yml"] }));
  assert.equal(decision2.decision, "rejected");
  assert.equal(decision2.rules.find((r) => r.rule === "editable_surfaces_only")?.pass, false);
});

test("lineage 完整且无敏感字段", () => {
  const decision = evaluateGateV1(baseInput());
  const lineage = buildLineage({
    promotedHarnessId: "shopping-h0",
    promotedHarnessVersion: "0.1.0-candidate-cand-1",
    parentHarnessId: "shopping-h0",
    candidateId: "cand-1",
    sourceEvidenceId: "evidence-x",
    targetClusterId: "cluster-x",
    baseHarnessId: "shopping-h0",
    baseHarnessVersion: "0.1.0",
    metrics: {
      base_held_in_success: 2,
      base_held_out_success: 1,
      candidate_held_in_success: 3,
      candidate_held_out_success: 2,
    },
    gate: decision,
    modelIdentity: { model_name: "deepseek-v4", model_base_url: "https://api.example" },
    toolSurfaceDigest: "sha256:abc",
  });
  const text = JSON.stringify(lineage);
  assert.equal(lineage.candidate_id, "cand-1");
  assert.equal(lineage.gate.decision, "accepted");
  assert.equal(lineage.model_identity.model_name, "deepseek-v4");
  // 不得泄漏具体敏感值（字段名如 target_cluster_id 是合法元数据）
  for (const forbidden of [
    "SECRET_API_KEY", "B0GOLD", "B0PURCHASE", "SECRET_GOAL", "买枕头", "123.456",
  ]) {
    assert.ok(!text.includes(forbidden), `lineage 泄漏 ${forbidden}`);
  }
  // 不得含敏感字段名（reward/purchase/gold/goal/api_key）
  for (const key of ["reward", "purchase", "gold", "goal", "api_key"]) {
    assert.ok(!text.includes(key), `lineage 含敏感字段 ${key}`);
  }
});
