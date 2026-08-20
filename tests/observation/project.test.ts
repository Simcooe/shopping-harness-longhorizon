/**
 * observation 投影脱敏测试：隐藏字段永远不进入 actor 输出；
 * 模型可见内容（任务指令、页面观测）正确呈现。
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
  renderObservation,
  renderToolSummary,
} from "../../plugins/shopping/src/observation/index.ts";
import { parseActorObservation } from "../../plugins/shopping/src/environment/protocol.ts";

const SECRET = "SECRET-GOAL-gold-asin-xyz";
const TASK_TEXT = "请购买一个儿童乳胶枕头";

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

test("非对象输入投影为空对象", () => {
  assert.deepEqual(projectRawResult(null), {});
  assert.deepEqual(projectRawResult([1, 2]), {});
});

test("隐藏字段清单覆盖 goal/gold/reward/purchase 等红线", () => {
  for (const required of [
    "reward", "reward_detail", "goal", "goal_options", "purchase",
    "user_persona", "reason_key",
  ]) {
    assert.ok(
      (HIDDEN_RESULT_FIELDS as readonly string[]).includes(required),
      `HIDDEN_RESULT_FIELDS 缺少 ${required}`,
    );
  }
});

test("observation_state 白名单：未知键（含哨兵）一律丢弃", () => {
  const observation = parseActorObservation({
    page_type: "search_results",
    search_available: true,
    actions: ["B0X", "Next >"],
    products: [{ asin: "B0X", title: "枕头", price: 99, rank: 1, secret_field: SECRET }],
    attacker_field: SECRET,
    goal: SECRET,
  });
  assert.ok(observation !== null);
  assert.ok(!JSON.stringify(observation).includes(SECRET));
  assert.deepEqual(observation?.clickables, ["B0X", "Next >"]);
  const products = observation?.state["products"] as Array<Record<string, unknown>>;
  assert.equal(products[0]?.["asin"], "B0X");
  assert.ok(!("secret_field" in (products[0] ?? {})));
});

test("renderObservation：商品与按钮可见，隐藏字段不可见", () => {
  const observation = parseActorObservation({
    page_type: "search_results",
    search_available: true,
    actions: ["B0PILLOW01", "Next >"],
    query: "乳胶枕头",
    page: 1,
    total_pages: 2,
    total_results: 30,
    products: [{ asin: "B0PILLOW01", title: "儿童乳胶枕", brand: "某品牌", price: 99, rank: 1 }],
  });
  const text = renderObservation(observation);
  assert.ok(text.includes("B0PILLOW01"));
  assert.ok(text.includes("儿童乳胶枕"));
  assert.ok(text.includes("乳胶枕头"));
  assert.ok(text.includes("Next >"));
  assert.ok(!text.includes(SECRET));
});

test("renderToolSummary：只含动作与页面观测，绝不携带任务指令", () => {
  const observation = parseActorObservation({
    page_type: "product_detail",
    search_available: false,
    actions: ["Buy Now", "红色", "蓝色"],
    product: { asin: "B0X", title: "儿童乳胶枕", price: 99 },
    available_options: { 颜色: ["红色", "蓝色"] },
    selected_price: 99,
  });
  const summary = renderToolSummary({
    environmentAction: "click[B0X]",
    done: false,
    observation,
  });
  assert.ok(summary.includes("B0X"));
  assert.ok(summary.includes("红色 | 蓝色"));
  assert.ok(summary.includes("Buy Now"));
  // 任务指令由 bootstrap 注入 DSH 初始 prompt，工具结果绝不携带
  assert.ok(!summary.includes(TASK_TEXT));
  assert.ok(!summary.includes("【任务指令】"));

  const done = renderToolSummary({
    environmentAction: "search[x]",
    done: true,
    observation: null,
  });
  assert.ok(done.includes("已结束"));
});

test("adapter 结果投影只含状态字段", () => {
  const resetProjected = projectReset({
    envIdx: 1,
    environmentVersion: "v2.1",
    message: "Task 0 started",
    task: { instructionText: TASK_TEXT },
    observation: null,
  });
  assert.deepEqual(resetProjected, { envIdx: 1, environmentVersion: "v2.1" });

  const interactProjected = projectInteract({ envIdx: 1, done: true, over: true, observation: null });
  assert.deepEqual(interactProjected, { envIdx: 1, done: true, over: true });
  for (const value of [resetProjected, interactProjected]) {
    for (const forbidden of ["goal", "reward", "instruction", "task"]) {
      assert.ok(!(forbidden in value));
    }
  }
});

test("renderFinishSummary 简洁无敏感内容", () => {
  const finish = renderFinishSummary("no_suitable_product");
  assert.ok(finish.includes("未购买"));
  assert.ok(!finish.includes(SECRET));
});
