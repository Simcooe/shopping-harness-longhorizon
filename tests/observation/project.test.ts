/**
 * observation 投影脱敏测试：敏感字段永远不进入投影输出。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALLOWED_RAW_FIELDS,
  HIDDEN_RESULT_FIELDS,
  projectInteract,
  projectRawResult,
  projectReset,
  renderFinishSummary,
  renderInteractSummary,
} from "../../plugins/shopping/src/observation/index.ts";

const SECRET = "SECRET-GOAL-gold-asin-xyz";

/** 模拟服务端完整 result：白名单字段 + 全部隐藏字段 + 未知新字段。 */
function hostileRaw(): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    env_idx: 2,
    done: false,
    over: false,
    message: "Continue interaction",
    environment_version: "shopsimulator-environment-v2.1",
    future_unknown_field: SECRET,
  };
  for (const hidden of HIDDEN_RESULT_FIELDS) {
    raw[hidden] = SECRET;
  }
  return raw;
}

test("白名单投影：只保留 ALLOWED_RAW_FIELDS，隐藏与未知字段全部剔除", () => {
  const projected = projectRawResult(hostileRaw());
  assert.deepEqual(Object.keys(projected).sort(), [...ALLOWED_RAW_FIELDS].sort());
  assert.ok(!JSON.stringify(projected).includes(SECRET));
});

test("白名单字段类型不符也被丢弃", () => {
  const projected = projectRawResult({
    env_idx: "2",
    done: "false",
    message: 42,
    environment_version: null,
  });
  assert.deepEqual(projected, {});
});

test("非对象输入投影为空对象", () => {
  assert.deepEqual(projectRawResult(null), {});
  assert.deepEqual(projectRawResult([1, 2]), {});
  assert.deepEqual(projectRawResult("text"), {});
});

test("隐藏字段清单覆盖 goal/gold/reward/purchase 等红线", () => {
  for (const required of [
    "reward", "reward_detail", "goal", "goal_options", "purchase",
    "instruction", "instruction_simple", "user_persona", "reason_key",
  ]) {
    assert.ok(
      (HIDDEN_RESULT_FIELDS as readonly string[]).includes(required),
      `HIDDEN_RESULT_FIELDS 缺少 ${required}`,
    );
  }
});

test("adapter reset/interact 结果投影只含状态字段", () => {
  const resetProjected = projectReset({
    envIdx: 1,
    environmentVersion: "v2.1",
    message: "Task 0 started",
  });
  assert.deepEqual(resetProjected, { envIdx: 1, environmentVersion: "v2.1" });

  const interactProjected = projectInteract({ envIdx: 1, done: true, over: true });
  assert.deepEqual(interactProjected, { envIdx: 1, done: true, over: true });

  for (const value of [resetProjected, interactProjected]) {
    assert.ok(!JSON.stringify(value).includes(SECRET));
    for (const forbidden of ["goal", "reward", "instruction"]) {
      assert.ok(!(forbidden in value));
    }
  }
});

test("render 摘要不泄漏且超长 action 被截断", () => {
  const longAction = `search[${"x".repeat(300)}]`;
  const summary = renderInteractSummary(
    { envIdx: 1, done: false, over: false },
    longAction,
  );
  assert.ok(summary.includes("已执行环境动作"));
  assert.ok(summary.includes("进行中"));
  assert.ok(summary.length < 250);
  assert.ok(!summary.includes(SECRET));

  const doneSummary = renderInteractSummary(
    { envIdx: 1, done: true, over: true },
    "finish[no_suitable_product]",
  );
  assert.ok(doneSummary.includes("已结束"));
  assert.ok(doneSummary.includes("over"));

  const finish = renderFinishSummary("no_suitable_product");
  assert.ok(finish.includes("未购买"));
});
