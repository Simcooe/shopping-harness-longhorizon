/**
 * development benchmark manifest 的离线测试。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BenchmarkManifestError,
  loadBenchmarkManifest,
  parseBenchmarkManifest,
} from "../../plugins/shopping/src/harness/benchmark.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

function validManifest(): Record<string, unknown> {
  return {
    schema_version: 1,
    benchmark_id: "shopping-development-test",
    purpose: "harness_development_only",
    harness_id: "shopping-h0",
    harness_version: "0.1.0",
    task_source: "configs/tasks/development.json",
    held_in_task_ids: [0, 1],
    held_out_task_ids: [2],
    final_benchmark_excluded: true,
    split_selection_rationale: "test",
    max_environment_steps: 35,
    evaluation: { repeats: 1 },
  };
}

test("仓库 development-v1.yml 合法：12 tasks、8/4 split、不相交、35 步", () => {
  const manifest = loadBenchmarkManifest(
    `${REPO_ROOT}/configs/evaluation/development-v1.yml`,
  );
  assert.equal(manifest.benchmarkId, "shopping-development-v1");
  assert.equal(manifest.purpose, "harness_development_only");
  assert.equal(manifest.harnessId, "shopping-h0");
  assert.equal(manifest.harnessVersion, "0.1.0");
  assert.equal(manifest.finalBenchmarkExcluded, true);
  assert.equal(manifest.maxEnvironmentSteps, 35);
  assert.equal(manifest.repeats, 1);
  assert.equal(manifest.heldInTaskIds.length, 8);
  assert.equal(manifest.heldOutTaskIds.length, 4);
  // 非空、无重复、严格不相交
  const heldIn = new Set(manifest.heldInTaskIds);
  assert.equal(heldIn.size, manifest.heldInTaskIds.length);
  assert.equal(new Set(manifest.heldOutTaskIds).size, manifest.heldOutTaskIds.length);
  for (const taskId of manifest.heldOutTaskIds) {
    assert.ok(!heldIn.has(taskId), `task ${taskId} 不应同时属于两个 split`);
  }
  assert.ok(manifest.splitSelectionRationale.length > 0);
});

test("合成 manifest 校验通过", () => {
  const manifest = parseBenchmarkManifest(validManifest());
  assert.deepEqual([...manifest.heldInTaskIds], [0, 1]);
  assert.deepEqual([...manifest.heldOutTaskIds], [2]);
});

test("split 为空/重复/相交均被拒绝", () => {
  const emptyHeldIn = { ...validManifest(), held_in_task_ids: [] };
  assert.throws(() => parseBenchmarkManifest(emptyHeldIn), BenchmarkManifestError);

  const duplicated = { ...validManifest(), held_in_task_ids: [0, 0] };
  assert.throws(() => parseBenchmarkManifest(duplicated), /重复/);

  const overlapping = { ...validManifest(), held_out_task_ids: [1, 3] };
  assert.throws(() => parseBenchmarkManifest(overlapping), /相交/);
});

test("final_benchmark_excluded 必须为 true", () => {
  const bad = { ...validManifest(), final_benchmark_excluded: false };
  assert.throws(() => parseBenchmarkManifest(bad), /final_benchmark_excluded/);
});

test("purpose 与步数约束", () => {
  assert.throws(
    () => parseBenchmarkManifest({ ...validManifest(), purpose: "final_benchmark" }),
    /purpose/,
  );
  assert.throws(
    () => parseBenchmarkManifest({ ...validManifest(), max_environment_steps: 0 }),
    /max_environment_steps/,
  );
});

test("缺失文件与非 YAML 拒绝", () => {
  assert.throws(() => loadBenchmarkManifest("/nonexistent/manifest.yml"), BenchmarkManifestError);
});
