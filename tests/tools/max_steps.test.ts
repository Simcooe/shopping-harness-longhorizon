/**
 * 步数预算与 runner 注入懒会话的 mock 测试。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ShopSimulatorHttpClient } from "../../plugins/shopping/src/environment/client.ts";
import { MaxStepsError, ShoppingRuntime } from "../../plugins/shopping/src/tools/runtime.ts";
import {
  registerShoppingTools,
  type DshToolDefinition,
  type DshToolRegistryLike,
} from "../../plugins/shopping/src/tools/register.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const H0_DIR = join(REPO_ROOT, "harnesses", "base");
const TASK_SOURCE = join(REPO_ROOT, "configs", "tasks", "development.json");

function lifecycleFetch() {
  const captured: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captured.push(payload);
    switch (payload["action"]) {
      case "reset":
        return new Response(JSON.stringify({
          result: { env_idx: 5, environment_version: "shopsimulator-environment-v2.1", message: "Task 0 started" },
        }), { status: 200 });
      case "interact":
        return new Response(JSON.stringify({
          result: { done: false, reward: 0, env_idx: 5, over: false, observation_state: { page_type: 'search_results', search_available: true, actions: [] } },
        }), { status: 200 });
      case "release_one":
        return new Response(JSON.stringify({
          result: { message: "Environment 5 has been released" },
        }), { status: 200 });
      default:
        throw new Error("unexpected");
    }
  }) as typeof fetch;
  return { fetchImpl, captured };
}

class Collector implements DshToolRegistryLike {
  definitions: DshToolDefinition[] = [];
  register(definition: DshToolDefinition): () => void {
    this.definitions.push(definition);
    return () => undefined;
  }
  byName(name: string): DshToolDefinition {
    const found = this.definitions.find((entry) => entry.name === name);
    assert.ok(found);
    return found;
  }
}

const exec = { signal: new AbortController().signal };

test("懒会话：SHOPPING_TASK_ID 注入并校验，无需手动 openSession", async () => {
  const { fetchImpl, captured } = lifecycleFetch();
  const runtime = new ShoppingRuntime({
    client: new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl }),
    env: { SHOPPING_TASK_ID: "0", SHOPPING_TASK_SOURCE: TASK_SOURCE },
    maxSteps: 5,
    harnessDir: join(REPO_ROOT, "harnesses", "base"),
  });
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  const value = await registry.byName("shop_search").execute({ query: "枕头" }, exec) as { env_idx: number };
  assert.equal(value.env_idx, 5);
  assert.equal(captured[0]?.["action"], "reset");
  assert.equal(captured[0]?.["idx"], 0); // task_id 来自注入，不是模型决定
});

test("懒会话：非法注入（集合外 task_id）被拒绝", async () => {
  const { fetchImpl } = lifecycleFetch();
  const runtime = new ShoppingRuntime({
    client: new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl }),
    env: { SHOPPING_TASK_ID: "999999", SHOPPING_TASK_SOURCE: TASK_SOURCE },
    harnessDir: join(REPO_ROOT, "harnesses", "base"),
  });
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  await assert.rejects(
    () => registry.byName("shop_search").execute({ query: "x" }, exec),
    /不在声明的开发任务集合/,
  );
});

test("懒会话：缺少 SHOPPING_TASK_ID 时拒绝（不创建任务）", async () => {
  const { fetchImpl } = lifecycleFetch();
  const runtime = new ShoppingRuntime({
    client: new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl }),
    env: {},
    harnessDir: join(REPO_ROOT, "harnesses", "base"),
  });
  const registry = new Collector();
  registerShoppingTools(registry, runtime);

  await assert.rejects(
    () => registry.byName("shop_search").execute({ query: "x" }, exec),
    /SHOPPING_TASK_ID/,
  );
});

test("懒注入记录器：SHOPPING_RUN_ID 生效且轨迹脱敏", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-"));
  try {
    const { fetchImpl } = lifecycleFetch();
    const runtime = new ShoppingRuntime({
      client: new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl }),
      env: {
        SHOPPING_TASK_ID: "0",
        SHOPPING_TASK_SOURCE: TASK_SOURCE,
        SHOPPING_RUN_ID: "run-live-test",
      },
      trajectoriesDir: dir,
      maxSteps: 5,
      harnessDir: H0_DIR,
  });
    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    await registry.byName("shop_search").execute({ query: "枕头" }, exec);
    runtime.recorder?.close();

    const trajectory = readFileSync(join(dir, "actor", "run-live-test.jsonl"), "utf-8");
    assert.ok(trajectory.includes('"run_id":"run-live-test"'));
    assert.ok(trajectory.includes('"task_id":0'));
    for (const forbidden of ["goal", "gold", "reward_detail", "MODEL_API_KEY"]) {
      assert.ok(!trajectory.includes(forbidden));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("步数预算：超过 maxSteps 抛 MaxStepsError，release 且记录 max_steps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-"));
  try {
    const { fetchImpl, captured } = lifecycleFetch();
    const runtime = new ShoppingRuntime({
      client: new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl }),
      env: {
        SHOPPING_TASK_ID: "0",
        SHOPPING_TASK_SOURCE: TASK_SOURCE,
        SHOPPING_RUN_ID: "run-max-steps",
      },
      trajectoriesDir: dir,
      maxSteps: 2,
      harnessDir: H0_DIR,
  });
    const registry = new Collector();
    registerShoppingTools(registry, runtime);
    const tool = registry.byName("shop_search");

    await tool.execute({ query: "a" }, exec);
    await tool.execute({ query: "b" }, exec);
    await assert.rejects(
      () => tool.execute({ query: "c" }, exec),
      (err: unknown) => err instanceof MaxStepsError,
    );

    // release 被调用（finally 路径覆盖）
    assert.equal(captured[captured.length - 1]?.["action"], "release_one");
    runtime.recorder?.close();
    const trajectory = readFileSync(join(dir, "actor", "run-max-steps.jsonl"), "utf-8");
    assert.ok(trajectory.includes('"local_reason":"max_steps"'));
    assert.ok(trajectory.includes('"release_status":"released"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
