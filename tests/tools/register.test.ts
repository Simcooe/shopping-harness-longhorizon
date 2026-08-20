/**
 * register/runtime 与 adapter 的 mock 集成测试：
 * 工具 execute → action 映射 → adapter HTTP（mock）→ observation 投影 → 记录器。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ShopSimulatorHttpClient } from "../../plugins/shopping/src/environment/client.ts";
import { RolloutRecorder } from "../../plugins/shopping/src/rollout/index.ts";
import {
  buildShoppingToolDefinitions,
  registerShoppingTools,
  type DshToolDefinition,
  type DshToolRegistryLike,
} from "../../plugins/shopping/src/tools/register.ts";
import { ShoppingRuntime } from "../../plugins/shopping/src/tools/runtime.ts";

const SECRET = "SECRET-GOAL-gold-asin-xyz";

function lifecycleFetch(opts: { interactDone?: boolean; interactServerErrorOn?: number } = {}) {
  const captured: Array<Record<string, unknown>> = [];
  let interactCalls = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captured.push(payload);
    switch (payload["action"]) {
      case "reset":
        return new Response(JSON.stringify({
          result: { env_idx: 4, instruction: SECRET, environment_version: "shopsimulator-environment-v2.1", message: "Task 0 started" },
        }), { status: 200 });
      case "interact": {
        interactCalls += 1;
        if (interactCalls === opts.interactServerErrorOn) {
          return new Response(JSON.stringify({ result: { error: "mock interact rejected" } }), { status: 200 });
        }
        const done = opts.interactDone ?? false;
        return new Response(JSON.stringify({
          result: {
            done,
            reward: 0,
            instruction: SECRET,
            goal: { asin: SECRET },
            env_idx: 4,
            over: done,
            observation_state: {},
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

function makeRuntime(fetchImpl: typeof fetch, recorder?: RolloutRecorder): ShoppingRuntime {
  return new ShoppingRuntime({
    client: new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl }),
    ...(recorder !== undefined ? { recorder } : {}),
  });
}

const exec = { signal: new AbortController().signal };

test("registerShoppingTools 注册三个工具且 disposer 生效", () => {
  const { fetchImpl } = lifecycleFetch();
  const registry = new Collector();
  const dispose = registerShoppingTools(registry, makeRuntime(fetchImpl));
  assert.deepEqual(
    registry.definitions.map((definition) => definition.name).sort(),
    ["finish_without_purchase", "open_product", "search_products"],
  );
  dispose();
  assert.equal(registry.definitions.length, 0);
});

test("search_products execute：映射 → adapter → 投影摘要，轨迹落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "register-"));
  try {
    const { fetchImpl, captured } = lifecycleFetch();
    const recorder = new RolloutRecorder({
      dir,
      runId: "run-register-1",
      taskId: 0,
      harnessVersion: "shopping-base@0.0.0",
      clock: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const runtime = makeRuntime(fetchImpl, recorder);
    await runtime.openSession(0);
    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    const tool = registry.byName("search_products");
    const value = await tool.execute({ query: "乳胶枕头" }, exec) as { summary: string; done: boolean; env_idx: number };

    assert.equal(value.done, false);
    assert.equal(value.env_idx, 4);
    assert.ok(value.summary.includes("search[乳胶枕头]"));
    assert.ok(!value.summary.includes(SECRET));

    // 请求序列：reset → interact(search[...])
    assert.equal(captured[0]?.["action"], "reset");
    assert.equal(captured[1]?.["action"], "interact");
    assert.equal(captured[1]?.["response"], "search[乳胶枕头]");

    // 轨迹脱敏检查
    recorder.close();
    const trajectory = readFileSync(join(dir, "run-register-1.jsonl"), "utf-8");
    assert.ok(!trajectory.includes(SECRET));
    assert.ok(trajectory.includes('"tool":"search_products"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非法参数在映射前被拒绝，不触达环境", async () => {
  const { fetchImpl, captured } = lifecycleFetch();
  const runtime = makeRuntime(fetchImpl);
  await runtime.openSession(0);
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  const tool = registry.byName("search_products");
  await assert.rejects(
    () => tool.execute({ query: "坏]参数", extra: true }, exec),
    /参数无效/,
  );
  // 只有 reset，没有 interact
  assert.equal(captured.length, 1);
  await runtime.closeSession();
});

test("finish_without_purchase：done=true 时自动 release，后续调用被拒绝", async () => {
  const { fetchImpl, captured } = lifecycleFetch({ interactDone: true });
  const runtime = makeRuntime(fetchImpl);
  await runtime.openSession(0);
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  const tool = registry.byName("finish_without_purchase");
  const value = await tool.execute({ reason: "no_suitable_product" }, exec) as { done: boolean; summary: string };
  assert.equal(value.done, true);
  assert.ok(value.summary.includes("未购买"));

  // 最后一个请求是 release_one
  assert.equal(captured[captured.length - 1]?.["action"], "release_one");
  // 会话已释放：后续工具调用被拒绝
  await assert.rejects(
    () => registry.byName("search_products").execute({ query: "x" }, exec),
    /已释放|没有活动/,
  );
});

test("interact 服务端错误：异常路径仍 release 并记录 error_code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "register-"));
  try {
    const { fetchImpl, captured } = lifecycleFetch({ interactServerErrorOn: 1 });
    const recorder = new RolloutRecorder({
      dir,
      runId: "run-register-2",
      taskId: 0,
      harnessVersion: "shopping-base@0.0.0",
    });
    const runtime = makeRuntime(fetchImpl, recorder);
    await runtime.openSession(0);
    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    await assert.rejects(
      () => registry.byName("open_product").execute({ asin: "B0XYZ" }, exec),
      /环境错误/,
    );
    assert.equal(captured[captured.length - 1]?.["action"], "release_one");

    recorder.close();
    const trajectory = readFileSync(join(dir, "run-register-2.jsonl"), "utf-8");
    assert.ok(trajectory.includes('"event":"terminal"'));
    assert.ok(trajectory.includes('"error_code":"environment"'));
    assert.ok(trajectory.includes('"release_status":"released"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无活动会话时工具调用被拒绝（task_id 必须外部注入）", async () => {
  const { fetchImpl } = lifecycleFetch();
  const runtime = makeRuntime(fetchImpl);
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  await assert.rejects(
    () => registry.byName("search_products").execute({ query: "x" }, exec),
    /没有活动 shopping 会话/,
  );
});

test("已取消的调用被拒绝", async () => {
  const { fetchImpl } = lifecycleFetch();
  const runtime = makeRuntime(fetchImpl);
  await runtime.openSession(0);
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => registry.byName("search_products").execute({ query: "x" }, { signal: controller.signal }),
    /已取消/,
  );
  await runtime.closeSession();
});
