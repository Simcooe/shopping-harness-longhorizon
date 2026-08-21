/**
 * live runner 准备逻辑的离线测试：不发任何模型请求。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { join } from "node:path";

import {
  LiveConfigError,
  assertMetadataHasNoSecrets,
  buildRunMetadata,
  missingModelEnvKeys,
  validateLiveTaskConfig,
} from "../../plugins/shopping/src/rollout/index.ts";
import { loadHarness } from "../../plugins/shopping/src/harness/surface.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const REPO_ROOT_FOR_HARNESS = new URL("../..", import.meta.url).pathname;
const TOOLS = loadHarness(join(REPO_ROOT_FOR_HARNESS, "harnesses", "base"))
  .toolSurface.tools.map((tool) => tool.name);

function validConfigObject(): Record<string, unknown> {
  return {
    schema_version: 1,
    purpose: "development_single_live_task",
    task_source: "configs/tasks/development.json",
    max_environment_steps: 5,
    temperature: 0,
    allowed_tools: TOOLS,
    output_dir: "trajectories/",
    final_benchmark_excluded: true,
  };
}

// 模型环境变量校验 -------------------------------------------------------------

test("missingModelEnvKeys：缺失时全部列出，齐备时为空", () => {
  assert.deepEqual(missingModelEnvKeys({}), [
    "MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME",
  ]);
  assert.deepEqual(missingModelEnvKeys({
    MODEL_BASE_URL: "x", MODEL_API_KEY: "y", MODEL_NAME: "z",
  }), []);
  assert.deepEqual(missingModelEnvKeys({
    MODEL_BASE_URL: "x", MODEL_API_KEY: "  ", MODEL_NAME: "z",
  }), ["MODEL_API_KEY"]);
});

// live-task 配置校验 -----------------------------------------------------------

test("validateLiveTaskConfig 接受合规模板", () => {
  const config = validateLiveTaskConfig(validConfigObject(), TOOLS);
  assert.equal(config.maxEnvironmentSteps, 5);
  assert.equal(config.temperature, 0);
  assert.deepEqual([...config.allowedTools], TOOLS);
});

test("validateLiveTaskConfig 拒绝违规项", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["purpose", { ...validConfigObject(), purpose: "benchmark" }],
    ["task_source", { ...validConfigObject(), task_source: "other.json" }],
    ["max_environment_steps", { ...validConfigObject(), max_environment_steps: 0 }],
    ["temperature", { ...validConfigObject(), temperature: -1 }],
    ["allowed_tools", { ...validConfigObject(), allowed_tools: ["checkout_express"] }],
    ["output_dir", { ...validConfigObject(), output_dir: "/tmp/" }],
    ["final_benchmark_excluded", { ...validConfigObject(), final_benchmark_excluded: false }],
  ];
  for (const [label, bad] of cases) {
    assert.throws(() => validateLiveTaskConfig(bad, TOOLS), LiveConfigError, label);
  }
});

test("仓库提交的 live-task.example.yml 通过校验（经 prepare 脚本）", () => {
  const result = spawnSync("node", [
    "plugins/shopping/scripts/prepare_live_run.ts",
    "--task-id", "0",
  ], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      MODEL_BASE_URL: "https://example.invalid",
      MODEL_API_KEY: "sk-test-SENTINEL-xyz",
      MODEL_NAME: "test-model",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(metadata["task_id"], 0);
  assert.equal(metadata["model_name"], "test-model");
  assert.equal(metadata["max_environment_steps"], 5);
  assert.equal(metadata["final_benchmark_excluded"], true);
  // run metadata 不含密钥值，也不含密钥键名
  assert.ok(!result.stdout.includes("sk-test-SENTINEL-xyz"));
  assert.ok(!result.stdout.includes("MODEL_API_KEY"));
  assert.ok(!result.stdout.includes("DEEPSEEK_API_KEY"));
});

test("prepare：非 development task_id 被拒绝", () => {
  const result = spawnSync("node", [
    "plugins/shopping/scripts/prepare_live_run.ts",
    "--task-id", "999999",
  ], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      MODEL_BASE_URL: "https://example.invalid",
      MODEL_API_KEY: "sk-test",
      MODEL_NAME: "m",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不在声明的开发任务集合/);
});

test("prepare：缺模型字段时拒绝且不触发任何请求", () => {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env["MODEL_API_KEY"];
  delete env["MODEL_BASE_URL"];
  delete env["MODEL_NAME"];
  const result = spawnSync("node", [
    "plugins/shopping/scripts/prepare_live_run.ts",
    "--task-id", "0",
  ], { cwd: REPO_ROOT, encoding: "utf-8", env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MODEL_API_KEY/);
});

// run_live_task.sh 无 --live ----------------------------------------------------

test("run_live_task.sh 未传 --live：打印用法并以 2 退出，不调用模型", () => {
  const result = spawnSync("bash", ["scripts/run_live_task.sh"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--live/);
  assert.match(result.stdout, /不会调用模型/);
});

// metadata 脱敏防线 --------------------------------------------------------------

test("assertMetadataHasNoSecrets 拦截密钥泄漏", () => {
  const env = { MODEL_API_KEY: "sk-super-secret" };
  const config = validateLiveTaskConfig(validConfigObject(), TOOLS);
  const metadata = buildRunMetadata({
    runId: "run-x", taskId: 0, harnessVersion: "v",
    modelName: "m", modelBaseUrl: "https://example.invalid", config,
  });
  assertMetadataHasNoSecrets(metadata, env); // 干净 metadata 通过

  assert.throws(
    () => assertMetadataHasNoSecrets({ ...metadata, leaked: "sk-super-secret" }, env),
    /MODEL_API_KEY/,
  );
  assert.throws(
    () => assertMetadataHasNoSecrets({ ...metadata, MODEL_API_KEY: "whatever" }, {}),
    /敏感键名/,
  );
});
