/**
 * rollout 记录器脱敏与 JSONL 测试。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FORBIDDEN_RECORD_KEYS,
  RolloutRecorder,
  ROLLOUT_SCHEMA_VERSION,
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
    observation: SECRET,
    list: [{ gold: SECRET }, "fine"],
    long: "x".repeat(900),
  }) as Record<string, unknown>;

  const text = JSON.stringify(sanitized);
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes("goal"));
  assert.ok(!text.includes("reward_detail"));
  const args = sanitized["args"] as Record<string, unknown>;
  assert.equal(args["query"], "枕头");
  assert.deepEqual(args["nested"], { ok: 1 });
  assert.deepEqual(sanitized["list"], [{}, "fine"]);
  assert.ok(String(sanitized["long"]).length <= 402);
});

test("禁止键清单覆盖 goal/gold/reward/observation/凭据类", () => {
  for (const required of [
    "goal", "gold", "reward", "reward_detail", "goal_options", "purchase",
    "instruction", "observation", "api_key", "token", "secret",
  ]) {
    assert.ok(
      (FORBIDDEN_RECORD_KEYS as readonly string[]).includes(required),
      `FORBIDDEN_RECORD_KEYS 缺少 ${required}`,
    );
  }
});

test("JSONL 记录包含必需字段且逐行可解析", () => {
  const dir = mkdtempSync(join(tmpdir(), "rollout-"));
  try {
    const recorder = makeRecorder(dir);
    recorder.record({
      event: "tool_call",
      tool: "search_products",
      args: { query: "乳胶枕头" },
      environment_action: "search[乳胶枕头]",
    });
    recorder.record({
      event: "step",
      environment_action: "search[乳胶枕头]",
      observation_summary: { env_idx: 0, done: false, over: false },
      done: false,
    });
    recorder.record({
      event: "terminal",
      done: false,
      termination_reason: "finish_without_purchase",
      release_status: "released",
    });
    recorder.close();

    const lines = readFileSync(recorder.filePath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 3);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const [index, record] of parsed.entries()) {
      assert.equal(record["schema_version"], ROLLOUT_SCHEMA_VERSION);
      assert.equal(record["run_id"], "run-test-001");
      assert.equal(record["task_id"], 0);
      assert.equal(record["harness_version"], "shopping-base@0.0.0");
      assert.equal(record["timestamp"], "2026-08-20T00:00:00.000Z");
      assert.equal(record["seq"], index);
    }
    assert.equal(parsed[0]?.["event"], "tool_call");
    assert.equal(parsed[2]?.["release_status"], "released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("脱敏在真实写入路径生效：记录中不含哨兵", () => {
  const dir = mkdtempSync(join(tmpdir(), "rollout-"));
  try {
    const recorder = makeRecorder(dir);
    recorder.record({
      event: "tool_call",
      tool: "search_products",
      // 模拟被污染的参数与隐藏字段
      args: { query: "枕头", goal: SECRET, instruction: SECRET } as Record<string, unknown>,
      environment_action: "search[枕头]",
    });
    recorder.close();

    const text = readFileSync(recorder.filePath, "utf-8");
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes('"goal"'));
    assert.ok(text.includes('"query":"枕头"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("关闭后再记录抛错；重复 close 安全", () => {
  const dir = mkdtempSync(join(tmpdir(), "rollout-"));
  try {
    const recorder = makeRecorder(dir);
    recorder.close();
    recorder.close();
    assert.throws(
      () => recorder.record({
        event: "terminal",
        done: true,
        termination_reason: "x",
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
