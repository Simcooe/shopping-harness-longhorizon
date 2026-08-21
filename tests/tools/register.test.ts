/**
 * register/runtime 与 adapter 的 mock 集成测试（h0 三原语工具）。
 * 覆盖：工具注册、固定映射、click guard、双轨迹隔离与 release 保证。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ShopSimulatorHttpClient } from "../../plugins/shopping/src/environment/client.ts";
import { ShoppingRuntime } from "../../plugins/shopping/src/tools/runtime.ts";
import {
  registerShoppingTools,
  type DshToolDefinition,
  type DshToolRegistryLike,
} from "../../plugins/shopping/src/tools/register.ts";
import { GuardRejectionError } from "../../plugins/shopping/src/tools/guard.ts";
import { loadHarness } from "../../plugins/shopping/src/harness/surface.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const H0_DIR = join(REPO_ROOT, "harnesses", "base");

const SECRET = "SECRET-GOAL-gold-asin-xyz";
const TASK_TEXT = "请购买一个适合儿童的乳胶枕头";

function searchResultsState(asins: string[]) {
  return {
    observation_version: "shopping-observation-v2",
    page_type: "search_results",
    search_available: true,
    actions: [...asins, "Next >"],
    query: "枕头",
    page: 1,
    total_pages: 1,
    total_results: asins.length,
    products: asins.map((asin, index) => ({
      asin, title: `商品${index}`, price: 99, rank: index + 1,
    })),
  };
}

function lifecycleFetch(opts: {
  doneOnInteract?: number;
  interactServerErrorOn?: number;
  secondPageAsins?: string[];
} = {}) {
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
            observation_state: { page_type: "search_home", search_available: true, actions: [] },
          },
        }), { status: 200 });
      case "interact": {
        interactCalls += 1;
        if (interactCalls === opts.interactServerErrorOn) {
          return new Response(JSON.stringify({ result: { error: "mock interact rejected" } }), { status: 200 });
        }
        const done = opts.doneOnInteract !== undefined && interactCalls === opts.doneOnInteract;
        const asins = (opts.secondPageAsins !== undefined && interactCalls >= 2)
          ? opts.secondPageAsins
          : ["B0PILLOW01", "B0PILLOW02"];
        return new Response(JSON.stringify({
          result: {
            done,
            reward: done ? 1.0 : 0,
            reward_detail: done ? { type: "gold_purchase", gold_asin: SECRET } : {},
            instruction: SECRET,
            goal: { asin: SECRET },
            purchase: done ? { asin: SECRET, price: 99 } : {},
            termination_reason: done ? "gold_purchase" : undefined,
            reward_valid: true,
            env_idx: 4,
            over: done,
            observation_state: searchResultsState(asins),
          },
        }), { status: 200 });
      }
      case "release_one":
        return new Response(JSON.stringify({
          result: { message: `Environment ${String(payload["env_idx"])} has been released` },
        }), { status: 200 });
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

function makeRuntime(fetchImpl: typeof fetch, dir: string): ShoppingRuntime {
  return new ShoppingRuntime({
    client: new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl }),
    env: {},
    maxSteps: 5,
    harnessDir: H0_DIR,
    trajectoriesDir: dir,
    evaluationDir: dir,
  });
}

const exec = { signal: new AbortController().signal };

test("h0 恰好注册三个工具：shop_click/shop_finish/shop_search", () => {
  const dir = mkdtempSync(join(tmpdir(), "h0reg-"));
  try {
    const { fetchImpl } = lifecycleFetch();
    const registry = new Collector();
    const dispose = registerShoppingTools(registry, makeRuntime(fetchImpl, dir));
    assert.deepEqual(
      registry.definitions.map((definition) => definition.name).sort(),
      ["shop_click", "shop_finish", "shop_search"],
    );
    for (const definition of registry.definitions) {
      const params = definition.parameters as { additionalProperties?: unknown };
      assert.equal(params["additionalProperties"], false);
    }
    dispose();
    assert.equal(registry.definitions.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shop_search 固定映射 search[...]；工具结果无任务指令、无隐藏字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "h0reg-"));
  try {
    const { fetchImpl, captured } = lifecycleFetch();
    const runtime = makeRuntime(fetchImpl, dir);
    await runtime.openSession(0);
    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    const value = await registry.byName("shop_search").execute({ query: "乳胶枕头" }, exec) as {
      summary: string; done: boolean; env_idx: number;
    };
    assert.equal(value.done, false);
    assert.equal(value.env_idx, 4);
    assert.ok(value.summary.includes("search[乳胶枕头]"));
    assert.ok(value.summary.includes("B0PILLOW01"));
    assert.ok(!value.summary.includes("【任务指令】"));
    assert.ok(!value.summary.includes(TASK_TEXT));
    assert.ok(!value.summary.includes(SECRET));

    assert.equal(captured[0]?.["action"], "reset");
    assert.equal(captured[1]?.["response"], "search[乳胶枕头]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shop_click 可见 target → click[...]；不可见/历史/非法 target 被 guard 拒绝且不触网", async () => {
  const dir = mkdtempSync(join(tmpdir(), "h0reg-"));
  try {
    const { fetchImpl, captured } = lifecycleFetch({ secondPageAsins: ["B0NEW01"] });
    const runtime = makeRuntime(fetchImpl, dir);
    await runtime.openSession(0);
    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    await registry.byName("shop_search").execute({ query: "枕头" }, exec);
    // 可见 target 通过
    await registry.byName("shop_click").execute({ target: "B0PILLOW02" }, exec);
    // 不可见 target 拒绝
    await assert.rejects(
      () => registry.byName("shop_click").execute({ target: "B0HIDDEN99" }, exec),
      (err: unknown) => err instanceof GuardRejectionError && err.message.includes("可见"),
    );
    // 文法非法 target 拒绝（方括号/换行）
    for (const bad of ["a]b", "a\nb"]) {
      await assert.rejects(
        () => registry.byName("shop_click").execute({ target: bad }, exec),
        GuardRejectionError,
      );
    }
    // 翻到第二页后：历史页面 target 不再可见
    await registry.byName("shop_click").execute({ target: "Next >" }, exec);
    await assert.rejects(
      () => registry.byName("shop_click").execute({ target: "B0PILLOW01" }, exec),
      GuardRejectionError,
    );
    // 新页面 target 可用
    assert.ok(await registry.byName("shop_click").execute({ target: "B0NEW01" }, exec));

    // 被拒绝的调用不产生环境请求：interact 恰好 4 次
    const interacts = captured.filter((entry) => entry["action"] === "interact");
    assert.equal(interacts.length, 4);
    assert.equal(interacts[1]?.["response"], "click[B0PILLOW02]");
    assert.equal(interacts[3]?.["response"], "click[B0NEW01]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("参数严格校验：额外参数与错误 finish reason 被拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "h0reg-"));
  try {
    const { fetchImpl } = lifecycleFetch();
    const runtime = makeRuntime(fetchImpl, dir);
    await runtime.openSession(0);
    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    await assert.rejects(
      () => registry.byName("shop_search").execute({ query: "枕头", extra: 1 }, exec),
      /参数无效/,
    );
    await assert.rejects(
      () => registry.byName("shop_finish").execute({ reason: "bored" }, exec),
      /参数无效|允许列表/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shop_finish 固定映射 finish[no_suitable_product]；done 后 release、结果无 reward", async () => {
  const dir = mkdtempSync(join(tmpdir(), "h0reg-"));
  try {
    const { fetchImpl, captured } = lifecycleFetch({ doneOnInteract: 2 });
    const runtime = makeRuntime(fetchImpl, dir);
    await runtime.openSession(0);
    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    await registry.byName("shop_search").execute({ query: "枕头" }, exec);
    const value = await registry.byName("shop_finish").execute(
      { reason: "no_suitable_product" }, exec,
    ) as { done: boolean; summary: string };
    assert.equal(value.done, true);
    assert.ok(value.summary.includes("未购买"));
    assert.ok(!value.summary.includes(SECRET));
    assert.ok(!value.summary.includes("reward"));

    const interacts = captured.filter((entry) => entry["action"] === "interact");
    assert.equal(interacts[1]?.["response"], "finish[no_suitable_product]");
    assert.equal(captured[captured.length - 1]?.["action"], "release_one");

    // terminal 后拒绝任何调用
    await assert.rejects(
      () => registry.byName("shop_search").execute({ query: "x" }, exec),
      (err: unknown) => err instanceof GuardRejectionError && err.message.includes("已结束"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("工具异常路径仍 release；evaluator 通道与工具结果隔离", async () => {
  const dir = mkdtempSync(join(tmpdir(), "h0reg-"));
  try {
    const outcomes: unknown[] = [];
    const { fetchImpl, captured } = lifecycleFetch({ interactServerErrorOn: 1 });
    const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", {
      fetchImpl,
      evaluatorSink: (outcome) => outcomes.push(outcome),
    });
    const runtime = new ShoppingRuntime({
      client, env: {}, maxSteps: 5, harnessDir: H0_DIR,
      trajectoriesDir: dir, evaluationDir: dir,
    });
    await runtime.openSession(0);
    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    await assert.rejects(
      () => registry.byName("shop_search").execute({ query: "x" }, exec),
      /环境错误/,
    );
    assert.equal(captured[captured.length - 1]?.["action"], "release_one");
    // 未 done 场景：evaluator 无 outcome；工具层类型上也不存在 evaluator 入口
    assert.equal(runtime.evaluator.hasOutcome, false);
    assert.equal(outcomes.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness surface 是工具唯一来源：无 harness 时注册失败", () => {
  const runtime = new ShoppingRuntime({
    client: new ShopSimulatorHttpClient("http://127.0.0.1:5700"),
    env: {},
  });
  const registry = new Collector();
  assert.throws(() => registerShoppingTools(registry, runtime), /harness/);
});

test("h0 verification policy 冻结红线随 harness 加载", () => {
  const harness = loadHarness(H0_DIR);
  assert.equal(harness.verificationPolicy.completionRequiresEnvironmentDone, true);
  assert.equal(harness.verificationPolicy.rewardOnlyInEvaluatorRecord, true);
  assert.equal(harness.verificationPolicy.actorSeesReward, false);
  assert.equal(harness.verificationPolicy.finishEqualsSuccess, false);
  assert.equal(harness.verificationPolicy.evaluatorFeedbackIntoSameRollout, false);
});
