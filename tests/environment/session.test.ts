/**
 * ShoppingEnvironmentSession / withShoppingSession 的 mock 单元测试。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ShopSimulatorHttpClient } from "../../plugins/shopping/src/environment/client.ts";
import {
  ShoppingEnvironmentSession,
  ShoppingSessionStateError,
  withShoppingSession,
} from "../../plugins/shopping/src/environment/session.ts";

const SECRET = "SECRET-GOAL-gold-asin-xyz";

interface CapturedPayload {
  action: string;
  env_idx?: number;
  idx?: number;
  response?: string;
}

/** 脚本化完整生命周期：reset(envIdx) → N 次 interact → release。 */
function lifecycleFetch(opts: {
  envIdx?: number;
  interactDone?: boolean;
  releaseFails?: boolean;
  /** 第 N 次 interact（从 1 计）返回服务端 error。 */
  interactServerErrorOn?: number;
} = {}) {
  const envIdx = opts.envIdx ?? 3;
  const captured: CapturedPayload[] = [];
  let releaseCalls = 0;
  let interactCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as CapturedPayload;
    captured.push(payload);
    switch (payload.action) {
      case "reset":
        return new Response(JSON.stringify({
          result: {
            env_idx: envIdx,
            instruction: SECRET,
            goal_options: { 颜色: ["红"] },
            environment_version: "shopsimulator-environment-v2.1",
            message: "Task 0 started",
          },
        }), { status: 200 });
      case "interact": {
        interactCalls += 1;
        if (interactCalls === opts.interactServerErrorOn) {
          return new Response(JSON.stringify({
            result: { error: "mock server rejected interact" },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          result: {
            done: opts.interactDone ?? false,
            reward: 0,
            instruction: SECRET,
            goal: { asin: SECRET },
            env_idx: envIdx,
            over: opts.interactDone ?? false,
            observation_state: {},
          },
        }), { status: 200 });
      }
      case "release_one": {
        releaseCalls += 1;
        if (opts.releaseFails) {
          throw new TypeError("fetch failed: ECONNRESET");
        }
        return new Response(JSON.stringify({
          result: { message: `Environment ${envIdx} has been released` },
        }), { status: 200 });
      }
      default:
        throw new Error(`意外的 action: ${payload.action}`);
    }
  }) as typeof fetch;
  return { fetchImpl, captured, releaseCalls: () => releaseCalls };
}

function makeClient(fetchImpl: typeof fetch): ShopSimulatorHttpClient {
  return new ShopSimulatorHttpClient("http://127.0.0.1:5700", { fetchImpl });
}

test("生命周期：reset → interact → release，状态正确", async () => {
  const { fetchImpl, captured } = lifecycleFetch();
  const session = new ShoppingEnvironmentSession(makeClient(fetchImpl), 0);

  assert.equal(session.envIdx, null);
  assert.equal(session.isActive, false);

  const resetResult = await session.reset();
  assert.equal(resetResult.envIdx, 3);
  assert.equal(session.envIdx, 3);
  assert.equal(session.isActive, true);
  assert.equal(session.environmentVersion, "shopsimulator-environment-v2.1");

  const interactResult = await session.interact("Thought: t\nAction: search[枕头]");
  assert.equal(interactResult.done, false);
  assert.equal(session.done, false);

  await session.release();
  assert.equal(session.released, true);
  assert.equal(session.isActive, false);

  assert.deepEqual(
    captured.map((entry) => entry.action),
    ["reset", "interact", "release_one"],
  );
  // 返回值不泄漏敏感字段
  assert.ok(!JSON.stringify({ resetResult, interactResult }).includes(SECRET));
});

test("重复 reset 被拒绝", async () => {
  const { fetchImpl } = lifecycleFetch();
  const session = new ShoppingEnvironmentSession(makeClient(fetchImpl), 0);
  await session.reset();
  await assert.rejects(() => session.reset(), ShoppingSessionStateError);
});

test("reset 之前 interact 被拒绝", async () => {
  const { fetchImpl } = lifecycleFetch();
  const session = new ShoppingEnvironmentSession(makeClient(fetchImpl), 0);
  await assert.rejects(
    () => session.interact("search"),
    (err: unknown) => err instanceof ShoppingSessionStateError && err.message.includes("尚未 reset"),
  );
});

// h. terminal（done）后 interact 被拒绝 ---------------------------------------

test("done 之后 interact 被拒绝", async () => {
  const { fetchImpl } = lifecycleFetch({ interactDone: true });
  const session = new ShoppingEnvironmentSession(makeClient(fetchImpl), 0);
  await session.reset();

  const result = await session.interact("Action: click[购买]");
  assert.equal(result.done, true);
  assert.equal(session.done, true);

  await assert.rejects(
    () => session.interact("search"),
    (err: unknown) => err instanceof ShoppingSessionStateError && err.message.includes("terminal"),
  );
});

test("release 之后 reset / interact 都被拒绝", async () => {
  const { fetchImpl } = lifecycleFetch();
  const session = new ShoppingEnvironmentSession(makeClient(fetchImpl), 0);
  await session.reset();
  await session.release();

  await assert.rejects(() => session.reset(), ShoppingSessionStateError);
  await assert.rejects(() => session.interact("search"), ShoppingSessionStateError);
});

test("release 可重复调用且只发一次 HTTP 请求", async () => {
  const { fetchImpl, releaseCalls } = lifecycleFetch();
  const session = new ShoppingEnvironmentSession(makeClient(fetchImpl), 0);
  await session.reset();

  await session.release();
  await session.release();
  await Promise.all([session.release(), session.release()]);

  assert.equal(releaseCalls(), 1);
  assert.equal(session.releaseError, null);
});

test("未成功 reset 的会话 release 是安全 no-op", async () => {
  const { fetchImpl, captured, releaseCalls } = lifecycleFetch();
  const session = new ShoppingEnvironmentSession(makeClient(fetchImpl), 0);
  await session.release();
  assert.equal(releaseCalls(), 0);
  assert.equal(captured.length, 0);
});

test("release 网络失败被记录而不抛出", async () => {
  const { fetchImpl } = lifecycleFetch({ releaseFails: true });
  const session = new ShoppingEnvironmentSession(makeClient(fetchImpl), 0);
  await session.reset();

  await session.release(); // 不应抛出
  assert.equal(session.released, true);
  assert.ok(session.releaseError instanceof Error);
});

// withSession helper ----------------------------------------------------------

test("withShoppingSession 正常路径自动 release", async () => {
  const { fetchImpl, captured } = lifecycleFetch();
  const { value, session } = await withShoppingSession(
    makeClient(fetchImpl),
    0,
    async (activeSession) => {
      const step = await activeSession.interact("Thought: t\nAction: search[枕头]");
      return step.done;
    },
  );

  assert.equal(value, false);
  assert.equal(session.released, true);
  assert.deepEqual(
    captured.map((entry) => entry.action),
    ["reset", "interact", "release_one"],
  );
});

// i. fn 抛异常时 finally 仍然 release ------------------------------------------

test("withShoppingSession 在 fn 抛异常时仍 release，且异常原样传播", async () => {
  const { fetchImpl, captured } = lifecycleFetch();
  const boom = new Error("fn exploded");

  await assert.rejects(
    () => withShoppingSession(makeClient(fetchImpl), 0, async () => {
      throw boom;
    }),
    (err: unknown) => err === boom,
  );

  const actions = captured.map((entry) => entry.action);
  assert.equal(actions[0], "reset");
  assert.equal(actions[actions.length - 1], "release_one");
});

test("withShoppingSession 在 interact 失败时仍 release", async () => {
  const { fetchImpl, captured } = lifecycleFetch({ interactServerErrorOn: 2 });
  const client = makeClient(fetchImpl);

  await assert.rejects(
    () => withShoppingSession(client, 0, async (session) => {
      await session.interact("search"); // 第一次成功
      await session.interact("search"); // 第二次：服务端 error → 抛出
    }),
  );

  assert.equal(captured[captured.length - 1]?.action, "release_one");
});

test("withShoppingSession 的返回值与会话不泄漏敏感内容", async () => {
  const { fetchImpl } = lifecycleFetch();
  const { value, session } = await withShoppingSession(
    makeClient(fetchImpl),
    0,
    async (activeSession) => await activeSession.interact("search"),
  );
  assert.ok(!JSON.stringify({ value, envIdx: session.envIdx }).includes(SECRET));
});
