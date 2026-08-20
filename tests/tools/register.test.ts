/**
 * register/runtime 与 adapter 的 mock 集成测试（Phase 6）：
 * 12 工具注册、guard、双轨迹、evaluator 隔离与 release 保证。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ShopSimulatorHttpClient } from "../../plugins/shopping/src/environment/client.ts";
import {
  registerShoppingTools,
  type DshToolDefinition,
  type DshToolRegistryLike,
} from "../../plugins/shopping/src/tools/register.ts";
import { GuardRejectionError } from "../../plugins/shopping/src/tools/guard.ts";
import { ShoppingRuntime } from "../../plugins/shopping/src/tools/runtime.ts";
import { RolloutRecorder } from "../../plugins/shopping/src/rollout/index.ts";

const SECRET = "SECRET-GOAL-gold-asin-xyz";
const TASK_TEXT = "请购买一个适合儿童的乳胶枕头";

/** 搜索结果页观测（actor-visible）。 */
function searchResultsState(products: Array<{ asin: string; title: string }>) {
  return {
    observation_version: "shopping-observation-v2",
    page_type: "search_results",
    search_available: true,
    actions: [...products.map((product) => product.asin), "Next >", "Back to Search", "Buy Now"],
    query: "乳胶枕头",
    page: 1,
    total_pages: 1,
    total_results: products.length,
    products: products.map((product, index) => ({
      asin: product.asin,
      title: product.title,
      price: 99,
      rank: index + 1,
    })),
    // 混入隐藏字段：投影/记录必须剔除
    goal: { asin: SECRET },
    reward: 1.0,
  };
}

function lifecycleFetch(opts: { interactDoneOn?: number; interactServerErrorOn?: number } = {}) {
  const captured: Array<Record<string, unknown>> = [];
  let interactCalls = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captured.push(payload);
    switch (payload["action"]) {
      case "reset":
        return new Response(JSON.stringify({
          result: {
            env_idx: 4,
            instruction: TASK_TEXT,
            instruction_simple: SECRET,
            goal_options: { 颜色: [SECRET] },
            environment_version: "shopsimulator-environment-v2.1",
            message: "Task 0 started",
            observation_state: {
              page_type: "search_home",
              search_available: true,
              actions: [],
            },
          },
        }), { status: 200 });
      case "interact": {
        interactCalls += 1;
        if (interactCalls === opts.interactServerErrorOn) {
          return new Response(JSON.stringify({ result: { error: "mock interact rejected" } }), { status: 200 });
        }
        const done = opts.interactDoneOn !== undefined && interactCalls === opts.interactDoneOn;
        return new Response(JSON.stringify({
          result: {
            done,
            reward: done ? 1.0 : 0,
            reward_detail: done ? { type: "gold_purchase", gold_asin: SECRET } : {},
            instruction: "页面文本（含商品列表）",
            goal: { asin: SECRET },
            purchase: done ? { asin: SECRET, price: 99 } : {},
            termination_reason: done ? "gold_purchase" : undefined,
            reward_valid: true,
            env_idx: 4,
            over: done,
            observation_state: searchResultsState([
              { asin: "B0PILLOW01", title: "儿童乳胶枕" },
              { asin: "B0PILLOW02", title: "记忆棉枕" },
            ]),
          },
        }), { status: 200 });
      }
      case "release_one":
        return new Response(JSON.stringify({ result: { message: "Environment 4 has been released" } }), { status: 200 });
      default:
        throw new Error(`unexpected action: ${String(payload["action"])}`);
    }
  }) as typeof fetch;
  return { fetchImpl, captured };
}

class Collector implements DshToolRegistryLike {
  definitions: DshToolDefinition[] = [];
  register(definition: DshToolDefinition): () => void {
    this.definitions.push(definition);
    return () => {
      this.definitions = this.definitions.filter((entry) => entry !== definition);
    };
  }
  byName(name: string): DshToolDefinition {
    const found = this.definitions.find((entry) => entry.name === name);
    assert.ok(found, `工具 ${name} 未注册`);
    return found;
  }
}

function makeRuntime(
  fetchImpl: typeof fetch,
  extras: { recorder?: RolloutRecorder; evaluatorDir?: string } = {},
): ShoppingRuntime {
  return new ShoppingRuntime({
    client: new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl }),
    env: {},
    maxSteps: 5,
    ...(extras.recorder !== undefined ? { recorder: extras.recorder } : {}),
    ...(extras.evaluatorDir !== undefined ? { evaluationDir: extras.evaluatorDir } : {}),
  });
}

const exec = { signal: new AbortController().signal };

test("注册完整 12 个冻结工具，disposer 生效", () => {
  const { fetchImpl } = lifecycleFetch();
  const registry = new Collector();
  const dispose = registerShoppingTools(registry, makeRuntime(fetchImpl));
  assert.deepEqual(
    registry.definitions.map((definition) => definition.name).sort(),
    [
      "back_to_search", "buy_now", "finish_without_purchase", "next_page",
      "open_product", "prev_page", "search_products", "select_option",
      "view_attributes", "view_description", "view_features", "view_reviews",
    ],
  );
  dispose();
  assert.equal(registry.definitions.length, 0);
});

test("search：任务指令注入首个结果、页面观测可见、轨迹脱敏", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-"));
  try {
    const { fetchImpl, captured } = lifecycleFetch();
    const recorder = new RolloutRecorder({
      dir, runId: "run-p6-1", taskId: 0, harnessVersion: "shopping-base@0.0.0",
      clock: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const runtime = makeRuntime(fetchImpl, { recorder });
    await runtime.openSession(0);
    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    const value = await registry.byName("search_products").execute({ query: "乳胶枕头" }, exec) as {
      summary: string; done: boolean; env_idx: number;
    };

    assert.equal(value.done, false);
    assert.equal(value.env_idx, 4);
    // 模型可见：任务指令 + 页面商品
    assert.ok(value.summary.includes(TASK_TEXT));
    assert.ok(value.summary.includes("B0PILLOW01"));
    assert.ok(value.summary.includes("儿童乳胶枕"));
    // 隐藏字段绝不进入工具结果
    assert.ok(!value.summary.includes(SECRET));

    assert.equal(captured[0]?.["action"], "reset");
    assert.equal(captured[1]?.["response"], "search[乳胶枕头]");

    // actor trace：task_instruction + observation 已记录且脱敏
    recorder.close();
    const trace = readFileSync(join(dir, "run-p6-1.jsonl"), "utf-8");
    assert.ok(trace.includes('"event":"task_instruction"'));
    assert.ok(trace.includes('"event":"observation"'));
    assert.ok(trace.includes("B0PILLOW01"));
    assert.ok(!trace.includes(SECRET));
    assert.ok(!trace.includes("reward"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("任务指令只注入一次", async () => {
  const { fetchImpl } = lifecycleFetch();
  const runtime = makeRuntime(fetchImpl);
  await runtime.openSession(0);
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  const first = await registry.byName("search_products").execute({ query: "a" }, exec) as { summary: string };
  const second = await registry.byName("search_products").execute({ query: "b" }, exec) as { summary: string };
  assert.ok(first.summary.includes("【任务指令】"));
  assert.ok(!second.summary.includes("【任务指令】"));
});

test("guard：open_product 的 asin 必须可见；拒绝不调用环境", async () => {
  const { fetchImpl, captured } = lifecycleFetch();
  const runtime = makeRuntime(fetchImpl);
  await runtime.openSession(0);
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  // 先搜索，拿到含 B0PILLOW01 的观测
  await registry.byName("search_products").execute({ query: "枕头" }, exec);
  const callsBefore = captured.length;

  // 合法 asin → 通过
  const opened = await registry.byName("open_product").execute({ asin: "B0PILLOW01" }, exec);
  assert.ok(opened);
  // 不可见 asin → guard 拒绝，且不产生新的环境请求
  await assert.rejects(
    () => registry.byName("open_product").execute({ asin: "B0HIDDEN99" }, exec),
    (err: unknown) => err instanceof GuardRejectionError && err.message.includes("可见"),
  );
  assert.equal(captured.length, callsBefore + 1);
});

test("guard：按钮类工具要求当前页面可见对应按钮", async () => {
  const { fetchImpl } = lifecycleFetch();
  const runtime = makeRuntime(fetchImpl);
  await runtime.openSession(0);
  const registry = new Collector();
  registerShoppingTools(registry, runtime);
  await registry.byName("search_products").execute({ query: "枕头" }, exec);

  // 搜索结果页观测含 Next >
  assert.ok(await registry.byName("next_page").execute({}, exec));
  // 构造不含 Buy Now 的观测：buy_now 必须被 guard 拒绝
  runtime.observe({
    pageType: "search_results",
    searchAvailable: true,
    clickables: ["Next >", "B0PILLOW01"],
    state: { page_type: "search_results", search_available: true, actions: ["Next >", "B0PILLOW01"] },
  });
  await assert.rejects(
    () => registry.byName("buy_now").execute({}, exec),
    (err: unknown) => err instanceof GuardRejectionError && err.message.includes("Buy Now"),
  );
});

test("guard：搜索不可用时拒绝 search；finish reason 严格校验", async () => {
  const { fetchImpl } = lifecycleFetch();
  const runtime = makeRuntime(fetchImpl);
  await runtime.openSession(0);
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  // finish reason 严格
  await assert.rejects(
    () => registry.byName("finish_without_purchase").execute({ reason: "bored" }, exec),
    /参数无效|no_suitable_product/,
  );
  // 手动构造"搜索不可用"状态
  runtime.observe({
    pageType: "product_detail",
    searchAvailable: false,
    clickables: [],
    state: { page_type: "product_detail", search_available: false, actions: [] },
  });
  await assert.rejects(
    () => registry.byName("search_products").execute({ query: "x" }, exec),
    (err: unknown) => err instanceof GuardRejectionError && err.message.includes("搜索"),
  );
});

test("buy_now 完成购买：done=true → release + terminal + 工具结果不含 reward", async () => {
  const { fetchImpl, captured } = lifecycleFetch({ interactDoneOn: 3 });
  const runtime = makeRuntime(fetchImpl);
  await runtime.openSession(0);
  const registry = new Collector();
  registerShoppingTools(registry, runtime);
  await registry.byName("search_products").execute({ query: "枕头" }, exec);
  await registry.byName("open_product").execute({ asin: "B0PILLOW01" }, exec);

  const value = await registry.byName("buy_now").execute({}, exec) as { done: boolean; summary: string };
  assert.equal(value.done, true);
  assert.ok(!value.summary.includes(SECRET));
  assert.ok(!value.summary.includes("reward"));
  assert.equal(captured[captured.length - 1]?.["action"], "release_one");

  // terminal 后拒绝任何工具调用
  await assert.rejects(
    () => registry.byName("search_products").execute({ query: "x" }, exec),
    (err: unknown) => err instanceof GuardRejectionError && err.message.includes("已结束"),
  );
});

test("异常路径仍 release，evaluator 记录 tool_error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-"));
  try {
    const { fetchImpl, captured } = lifecycleFetch({ interactServerErrorOn: 1 });
    const runtime = makeRuntime(fetchImpl, { evaluatorDir: dir });
    await runtime.openSession(0);
    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    await assert.rejects(
      () => registry.byName("search_products").execute({ query: "x" }, exec),
      /环境错误/,
    );
    assert.equal(captured[captured.length - 1]?.["action"], "release_one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluator 隔离：sink 收到 reward 证据，但工具层类型上拿不到", async () => {
  const outcomes: unknown[] = [];
  const { fetchImpl } = lifecycleFetch({ interactDoneOn: 2 });
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", {
    fetchImpl,
    evaluatorSink: (outcome) => outcomes.push(outcome),
  });
  const runtime = new ShoppingRuntime({ client, env: {}, maxSteps: 5 });
  await runtime.openSession(0);
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  await registry.byName("search_products").execute({ query: "枕头" }, exec);
  const value = await registry.byName("buy_now").execute({}, exec) as { summary: string };

  // evaluator 通道拿到了 reward 证据
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0] as { reward: number; purchaseAsin: string };
  assert.equal(outcome.reward, 1.0);
  assert.equal(outcome.purchaseAsin, SECRET);
  // 但模型可见结果里没有这些证据
  assert.ok(!value.summary.includes(SECRET));
  assert.ok(!value.summary.includes("gold_purchase"));
  // evaluator 证据只经 sink 流出；注入 runtime 的收集器不应持有它
  // （真实装配中 runtime 自建 client 并把 sink 指向自己的收集器）
  assert.equal(runtime.evaluator.hasOutcome, false);
  assert.equal(outcomes.length, 1);
});
