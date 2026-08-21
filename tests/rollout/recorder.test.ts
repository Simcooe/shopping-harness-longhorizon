/**
 * actor trace 记录器脱敏与 JSONL 测试（Phase 6 schema v2）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ACTOR_TRACE_SCHEMA_VERSION,
  FORBIDDEN_RECORD_KEYS,
  RolloutRecorder,
  makeRunId,
  sanitizeForRecord,
} from "../../plugins/shopping/src/rollout/index.ts";

const SECRET = "SECRET-GOAL-gold-asin-xyz";

function makeRecorder(dir: string) {
  const fixedDate = new Date("2026-08-20T00:00:00.000Z");
  return new RolloutRecorder({
    dir,
    runId: "run-test-001",
    taskId: 0,
    harnessVersion: "shopping-base@0.0.0",
    clock: () => fixedDate,
  });
}

test("sanitizeForRecord 递归剔除禁止键并截断长字符串", () => {
  const sanitized = sanitizeForRecord({
    tool: "search_products",
    args: { query: "枕头", goal: SECRET, nested: { reward_detail: SECRET, ok: 1 } },
    termination_reason: SECRET,
    authorization: SECRET,
    list: [{ gold: SECRET }, "fine"],
    long: "x".repeat(2500),
  }) as Record<string, unknown>;

  const text = JSON.stringify(sanitized);
  assert.ok(!text.includes(SECRET));
  const args = sanitized["args"] as Record<string, unknown>;
  assert.equal(args["query"], "枕头");
  assert.deepEqual(args["nested"], { ok: 1 });
  assert.deepEqual(sanitized["list"], [{}, "fine"]);
  assert.ok(String(sanitized["long"]).length <= 2002);
});

test("禁止键清单覆盖 goal/gold/reward/purchase/凭据/termination", () => {
  for (const required of [
    "goal", "gold", "reward", "reward_detail", "reward_valid", "goal_options",
    "purchase", "termination_reason", "api_key", "authorization", "secret", "token",
  ]) {
    assert.ok(
      (FORBIDDEN_RECORD_KEYS as readonly string[]).includes(required),
      `FORBIDDEN_RECORD_KEYS 缺少 ${required}`,
    );
  }
});

test("actor trace：六类事件逐行可解析，字段完整", () => {
  const dir = mkdtempSync(join(tmpdir(), "actor-"));
  try {
    const recorder = makeRecorder(dir);
    recorder.record({
      event: "run_start",
      profile: "shopping-base",
      harness_id: "shopping-h0",
      harness_manifest_version: "0.1.0",
      tool_surface: "sha256:deadbeef",
      system_prompt_ref: "system-prompt.md",
    });
    recorder.record({ event: "task_instruction", instruction_text: "买一个枕头" });
    recorder.record({
      event: "tool_call",
      tool: "search_products",
      args: { query: "乳胶枕头" },
      environment_action: "search[乳胶枕头]",
    });
    recorder.record({
      event: "guard_rejection",
      tool: "open_product",
      guard_reason: "asin_not_visible",
      correction: "该 asin 不在当前页面可见的商品列表中。",
    });
    recorder.record({
      event: "observation",
      page_type: "search_results",
      done: false,
      observation: { page_type: "search_results", products: [{ asin: "B0X" }] },
    });
    recorder.record({
      event: "terminal",
      done: false,
      local_reason: "environment_done",
      release_status: "released",
    });
    recorder.close();

    const lines = readFileSync(recorder.filePath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 6);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const [index, record] of parsed.entries()) {
      assert.equal(record["schema_version"], ACTOR_TRACE_SCHEMA_VERSION);
      assert.equal(record["run_id"], "run-test-001");
      assert.equal(record["task_id"], 0);
      assert.equal(record["harness_version"], "shopping-base@0.0.0");
      assert.equal(record["timestamp"], "2026-08-20T00:00:00.000Z");
      assert.equal(record["seq"], index);
    }
    assert.deepEqual(
      parsed.map((record) => record["event"]),
      ["run_start", "task_instruction", "tool_call", "guard_rejection", "observation", "terminal"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("actor trace 保留模型可见内容、剔除 evaluator/隐藏内容", () => {
  const dir = mkdtempSync(join(tmpdir(), "actor-"));
  try {
    const recorder = makeRecorder(dir);
    // 模拟被污染的事件载荷：隐藏字段必须被剔除
    recorder.record({
      event: "observation",
      page_type: "search_results",
      done: false,
      observation: {
        products: [{ asin: "B0X", title: "枕头" }],
        goal: SECRET,
        reward: 1.0,
        gold_asin: SECRET,
      } as unknown as Record<string, unknown>,
    });
    recorder.record({
      event: "task_instruction",
      instruction_text: "请购买一个儿童乳胶枕头",
    });
    recorder.close();

    const text = readFileSync(recorder.filePath, "utf-8");
    // 模型可见内容保留
    assert.ok(text.includes("B0X"));
    assert.ok(text.includes("请购买一个儿童乳胶枕头"));
    // 隐藏内容剔除
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes('"reward"'));
    assert.ok(!text.includes('"goal"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("关闭后再记录抛错；重复 close 安全", () => {
  const dir = mkdtempSync(join(tmpdir(), "actor-"));
  try {
    const recorder = makeRecorder(dir);
    recorder.close();
    recorder.close();
    assert.throws(
      () => recorder.record({
        event: "terminal",
        done: true,
        local_reason: "environment_done",
        release_status: "released",
      }),
      /已关闭/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeRunId 由时钟决定、无随机", () => {
  const id = makeRunId(() => new Date("2026-08-20T01:02:03.456Z"));
  assert.equal(id, "run-2026-08-20T01-02-03-456Z");
});
