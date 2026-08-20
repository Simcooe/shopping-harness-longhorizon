#!/usr/bin/env node
/**
 * live run 离线准备校验：配置、任务注入、模型环境变量、脱敏 metadata。
 * 由 scripts/run_live_task.sh 调用；任何校验失败都以非零退出，
 * 且不会触发任何模型请求。
 *
 * 用法: node scripts/prepare_live_run.ts --task-id <id> [--config <path>]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { SHOPPING_TOOL_NAMES } from "../src/tools/actions.ts";
import {
  assertInjectedTaskId,
  loadDevelopmentTaskSource,
} from "../src/rollout/task_source.ts";
import {
  assertMetadataHasNoSecrets,
  buildRunMetadata,
  missingModelEnvKeys,
  validateLiveTaskConfig,
} from "../src/rollout/live_config.ts";
import { makeRunId } from "../src/rollout/recorder.ts";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PLUGIN_DIR, "..", "..");

function fail(message: string): never {
  console.error(`[prepare_live_run] ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const taskIdRaw = argv[argv.indexOf("--task-id") + 1];
const configIdx = argv.indexOf("--config");
const configPath = configIdx >= 0
  ? argv[configIdx + 1] as string
  : join(REPO_ROOT, "configs", "live-task.example.yml");

if (taskIdRaw === undefined || taskIdRaw === "") {
  fail("缺少 --task-id");
}
const taskId = Number(taskIdRaw);
if (!Number.isInteger(taskId)) {
  fail(`--task-id 不是整数: ${taskIdRaw}`);
}

// 1. live-task 配置校验
let configText: string;
try {
  configText = readFileSync(configPath, "utf-8");
} catch {
  fail(`无法读取 live-task 配置: ${configPath}`);
}
const config = validateLiveTaskConfig(parseYaml(configText), SHOPPING_TOOL_NAMES);

// 2. task_id 必须属于声明的开发任务集（模型不得决定 task_id）
const source = loadDevelopmentTaskSource(join(REPO_ROOT, config.taskSource));
assertInjectedTaskId(source, taskId);

// 3. 模型环境变量齐备（只检查存在性，不打印值）
const missing = missingModelEnvKeys(process.env);
if (missing.length > 0) {
  fail(`缺少模型配置（请在未提交的 .env 中填写）: ${missing.join(", ")}`);
}

// 4. 脱敏 run metadata
const metadata = buildRunMetadata({
  runId: makeRunId(),
  taskId,
  harnessVersion: "shopping-base@0.0.0",
  modelName: String(process.env["MODEL_NAME"] ?? "").trim(),
  modelBaseUrl: String(process.env["MODEL_BASE_URL"] ?? "").trim(),
  config,
});
assertMetadataHasNoSecrets(metadata, process.env);

console.log(JSON.stringify(metadata, null, 2));
