/**
 * task_source 测试：task_id 只能外部注入且必须属于声明集合。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  TaskSourceError,
  assertInjectedTaskId,
  loadDevelopmentTaskSource,
} from "../../plugins/shopping/src/rollout/task_source.ts";

const REPO_CONFIG = new URL("../../configs/tasks/development.json", import.meta.url).pathname;

function withTempConfig(content: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "task-source-"));
  const path = join(dir, "tasks.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("加载仓库内的 development.json", () => {
  const source = loadDevelopmentTaskSource(REPO_CONFIG);
  assert.equal(source.purpose, "development_smoke_only");
  assert.equal(source.finalBenchmarkExcluded, true);
  assert.ok(source.taskIds.length > 0);
});

test("外部注入的合法 task_id 通过", () => {
  const source = loadDevelopmentTaskSource(REPO_CONFIG);
  const taskId = assertInjectedTaskId(source, source.taskIds[0]);
  assert.equal(taskId, source.taskIds[0]);
});

test("集合外的 task_id 被拒绝（模型不得决定 task_id）", () => {
  const source = loadDevelopmentTaskSource(REPO_CONFIG);
  assert.throws(
    () => assertInjectedTaskId(source, 999999),
    (err: unknown) => err instanceof TaskSourceError && err.message.includes("不在声明的开发任务集合"),
  );
});

test("非整数 task_id 被拒绝", () => {
  const source = loadDevelopmentTaskSource(REPO_CONFIG);
  assert.throws(() => assertInjectedTaskId(source, "0"), TaskSourceError);
  assert.throws(() => assertInjectedTaskId(source, 0.5), TaskSourceError);
  assert.throws(() => assertInjectedTaskId(source, undefined), TaskSourceError);
});

test("非法任务声明被拒绝", () => {
  withTempConfig({ schema_version: 2, purpose: "development_smoke_only", task_ids: [0], final_benchmark_excluded: true }, (path) => {
    assert.throws(() => loadDevelopmentTaskSource(path), /schema_version/);
  });
  withTempConfig({ schema_version: 1, purpose: "final_benchmark", task_ids: [0], final_benchmark_excluded: true }, (path) => {
    assert.throws(() => loadDevelopmentTaskSource(path), /development_smoke_only/);
  });
  withTempConfig({ schema_version: 1, purpose: "development_smoke_only", task_ids: [], final_benchmark_excluded: true }, (path) => {
    assert.throws(() => loadDevelopmentTaskSource(path), /task_ids/);
  });
  withTempConfig({ schema_version: 1, purpose: "development_smoke_only", task_ids: [0], final_benchmark_excluded: false }, (path) => {
    assert.throws(() => loadDevelopmentTaskSource(path), /final_benchmark_excluded/);
  });
  withTempConfig("not json", (path) => {
    assert.throws(() => loadDevelopmentTaskSource(path), /不是合法 JSON/);
  });
  assert.throws(() => loadDevelopmentTaskSource("/nonexistent/path.json"), /无法读取/);
});
