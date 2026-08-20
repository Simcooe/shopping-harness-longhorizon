/**
 * ShopSimulatorHttpClient 的 mock HTTP 单元测试（不依赖真实服务）。
 *
 * 运行：node --test tests/environment/   （仓库根目录）
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SHOPSIM_BASE_URL,
  SHOP_AGENT_PATH,
  ShopSimEnvironmentError,
  ShopSimHttpError,
  ShopSimNetworkError,
  ShopSimProtocolError,
  ShopSimulatorHttpClient,
} from "../../plugins/shopping/src/environment/client.ts";

/** 敏感哨兵：服务端"偷偷"返回 goal/observation 类字段，绝不应泄漏。 */
const SECRET = "SECRET-GOAL-gold-asin-xyz";
/** 任务指令是 actor 可见内容，用独立哨兵。 */
const TASK_TEXT = "TASK-INSTRUCTION-visible";

interface CapturedRequest {
  url: string;
  method: string;
  payload: unknown;
}

/** 脚本化 mock fetch：按顺序返回 responses；记录收到的请求。 */
function mockFetch(responses: Array<() => Response | Promise<Response> | never>) {
  const captured: CapturedRequest[] = [];
  let call = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const payload = init?.body !== undefined
      ? JSON.parse(String(init.body))
      : undefined;
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      payload,
    });
    const next = responses[call++];
    if (next === undefined) {
      throw new TypeError("mock fetch: 没有更多脚本化响应");
    }
    return await next();
  }) as typeof fetch;
  return { fetchImpl, captured };
}

function jsonResponse(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ result }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 模拟真实服务端：reset 响应里夹带 goal/observation 敏感字段。 */
function realisticResetResult(envIdx = 2): Record<string, unknown> {
  return {
    env_idx: envIdx,
    idx: 0,
    message: "Task 0 started",
    instruction: TASK_TEXT,
    instruction_simple: SECRET,
    goal_options: { 颜色: ["红", "蓝"] },
    environment_version: "shopsimulator-environment-v2.1",
    observation_state: { page_type: 0, secrets: SECRET },
  };
}

function realisticInteractResult(envIdx = 2, done = false): Record<string, unknown> {
  return {
    done,
    reward: 0,
    instruction: `${SECRET} 完整页面观测文本…`,
    message: "Continue interaction",
    env_idx: envIdx,
    idx: "slot-0-0",
    reward_detail: { gold_asin: SECRET },
    purchase: {},
    goal: { asin: SECRET },
    over: done,
    observation_state: { page_type: 1 },
  };
}

// a. 默认 / 自定义 base URL -------------------------------------------------

test("fromEnv: 未设置 SHOPSIM_BASE_URL 时使用默认地址", () => {
  const client = ShopSimulatorHttpClient.fromEnv({});
  assert.equal(client.baseUrl, DEFAULT_SHOPSIM_BASE_URL);
  assert.equal(client.baseUrl, "http://127.0.0.1:5700");
});

test("fromEnv: 使用自定义 SHOPSIM_BASE_URL 并规范化尾部斜杠", () => {
  const client = ShopSimulatorHttpClient.fromEnv({
    SHOPSIM_BASE_URL: "http://127.0.0.1:7777/",
  });
  assert.equal(client.baseUrl, "http://127.0.0.1:7777");
});

test("fromEnv: 空白 SHOPSIM_BASE_URL 回退默认地址", () => {
  const client = ShopSimulatorHttpClient.fromEnv({ SHOPSIM_BASE_URL: "   " });
  assert.equal(client.baseUrl, DEFAULT_SHOPSIM_BASE_URL);
});

test("构造函数拒绝非法 baseUrl", () => {
  assert.throws(() => new ShopSimulatorHttpClient("ftp://x"), ShopSimProtocolError);
  assert.throws(() => new ShopSimulatorHttpClient(""), ShopSimProtocolError);
});

// b. reset 成功 --------------------------------------------------------------

test("reset 成功：返回 actor-safe 字段，请求体正确", async () => {
  const { fetchImpl, captured } = mockFetch([() => jsonResponse(realisticResetResult(2))]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  const result = await client.reset(0);

  assert.equal(result.envIdx, 2);
  assert.equal(result.environmentVersion, "shopsimulator-environment-v2.1");
  assert.equal(result.message, "Task 0 started");
  // 任务指令进入 actor 通道；goal_options 等隐藏字段被丢弃
  assert.equal(result.task?.instructionText, TASK_TEXT);
  // observation_state 存在 → 白名单投影；其中夹带的 secrets 键被丢弃
  assert.ok(result.observation !== null);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes("goal_options"));
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.url, `http://127.0.0.1:5700${SHOP_AGENT_PATH}`);
  assert.equal(captured[0]?.method, "POST");
  assert.deepEqual(captured[0]?.payload, { action: "reset", idx: 0 });
});

// c. interact 成功 -----------------------------------------------------------

test("interact 成功：只返回 done/over/envIdx", async () => {
  const { fetchImpl, captured } = mockFetch([() => jsonResponse(realisticInteractResult(2))]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  const result = await client.interact(2, "Thought: t\nAction: search[枕头]");

  assert.equal(result.envIdx, 2);
  assert.equal(result.done, false);
  assert.equal(result.over, false);
  assert.ok(result.observation !== undefined);
  assert.deepEqual(captured[0]?.payload, {
    action: "interact",
    env_idx: 2,
    response: "Thought: t\nAction: search[枕头]",
  });
});

// d. release 成功与重复 release ----------------------------------------------

test("releaseOne 成功与重复 release（already free）", async () => {
  const { fetchImpl } = mockFetch([
    () => jsonResponse({ message: "Environment 2 has been released" }),
    () => jsonResponse({ message: "Environment 2 is already free" }),
  ]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  const first = await client.releaseOne(2);
  const second = await client.releaseOne(2);

  assert.match(first.message, /released/);
  assert.match(second.message, /already free/);
});

// e. 服务端 error 响应 ---------------------------------------------------------

test("服务端 result.error 映射为 ShopSimEnvironmentError", async () => {
  const { fetchImpl } = mockFetch([() => jsonResponse({ error: "reset action requires idx parameter" })]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  await assert.rejects(
    () => client.reset(0),
    (err: unknown) =>
      err instanceof ShopSimEnvironmentError &&
      err.code === "environment" &&
      err.message.includes("reset action requires idx parameter"),
  );
});

test("服务端超长 error 被截断，不携带大文本", async () => {
  const huge = "x".repeat(5000) + SECRET;
  const { fetchImpl } = mockFetch([() => jsonResponse({ error: huge })]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  await assert.rejects(
    () => client.reset(0),
    (err: unknown) =>
      err instanceof Error &&
      err.message.length < 500 &&
      !err.message.includes(SECRET),
  );
});

// f. malformed body -----------------------------------------------------------

test("非法 JSON 响应映射为 ShopSimProtocolError", async () => {
  const { fetchImpl } = mockFetch([() => new Response("not-json", { status: 200 })]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  await assert.rejects(
    () => client.reset(0),
    (err: unknown) => err instanceof ShopSimProtocolError && err.code === "protocol",
  );
});

test("缺少 result 对象映射为 ShopSimProtocolError", async () => {
  const { fetchImpl } = mockFetch([() => new Response(JSON.stringify({ other: 1 }), { status: 200 })]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  await assert.rejects(() => client.reset(0), ShopSimProtocolError);
});

test("env_idx 类型错误（字符串）被拒绝", async () => {
  const bad = realisticResetResult();
  bad["env_idx"] = "2";
  const { fetchImpl } = mockFetch([() => jsonResponse(bad)]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  await assert.rejects(
    () => client.reset(0),
    (err: unknown) => err instanceof ShopSimProtocolError && err.message.includes("env_idx"),
  );
});

test("interact 缺少布尔 done 被拒绝", async () => {
  const bad = realisticInteractResult();
  delete bad["done"];
  const { fetchImpl } = mockFetch([() => jsonResponse(bad)]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  await assert.rejects(() => client.interact(2, "search"), ShopSimProtocolError);
});

test("release 缺少 message 被拒绝", async () => {
  const { fetchImpl } = mockFetch([() => jsonResponse({})]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  await assert.rejects(() => client.releaseOne(2), ShopSimProtocolError);
});

// g. 网络失败 / HTTP 非成功 ----------------------------------------------------

test("网络失败映射为 ShopSimNetworkError", async () => {
  const { fetchImpl } = mockFetch([
    () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    },
  ]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  await assert.rejects(
    () => client.reset(0),
    (err: unknown) =>
      err instanceof ShopSimNetworkError &&
      err.code === "network" &&
      err.cause instanceof TypeError,
  );
});

test("HTTP 500 映射为 ShopSimHttpError（不读取响应体）", async () => {
  const { fetchImpl } = mockFetch([
    () => new Response(`${SECRET} internal stacktrace`, { status: 500 }),
  ]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  await assert.rejects(
    () => client.reset(0),
    (err: unknown) =>
      err instanceof ShopSimHttpError &&
      err.status === 500 &&
      !err.message.includes(SECRET),
  );
});

// j. 泄漏防护：结果与错误对象序列化后不含敏感哨兵 --------------------------------

test("所有返回值与错误对象不泄漏 goal/gold/observation 内容", async () => {
  const { fetchImpl } = mockFetch([
    () => jsonResponse(realisticResetResult()),
    () => jsonResponse(realisticInteractResult()),
    () => jsonResponse({ message: "released" }),
  ]);
  const client = new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });

  const resetResult = await client.reset(0);
  const interactResult = await client.interact(2, "search");
  const releaseResult = await client.releaseOne(2);

  for (const value of [resetResult, interactResult, releaseResult]) {
    assert.ok(!JSON.stringify(value).includes(SECRET));
  }
  // 字段白名单：返回值里不允许出现 goal/observation 类键
  for (const value of [resetResult, interactResult]) {
    for (const forbidden of ["goal", "goal_options", "reward_detail", "observation_state", "reward"]) {
      assert.ok(!(forbidden in value), `返回值不应包含 ${forbidden}`);
    }
  }
  // interact 返回值不含页面原文键（只经投影的 observation 结构）
  assert.ok(!("instruction" in interactResult));
});
