#!/usr/bin/env node
/**
 * shopping environment adapter 的 live smoke 入口。
 *
 * 用法（仓库根目录）：
 *   pnpm --dir plugins/shopping smoke-shopping-adapter --live
 *
 * 约束：
 *   - 必须显式传入 --live 才执行真实 HTTP 请求，否则只打印用法；
 *   - 任务 ID 来自 configs/tasks/development.json（development_smoke_only），
 *     不包含 Final-200 Clean；
 *   - 只从 SHOPSIM_BASE_URL 读取地址（默认 http://127.0.0.1:5700），
 *     不读取任何 API key；
 *   - 不自动启动 ShopSimulator；缺少服务时给出清晰提示；
 *   - 输出只有摘要：base URL、成功/失败、env_idx、done、release 状态，
 *     不打印完整 observation、goal、gold 或 Reward。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ShopSimNetworkError,
  ShopSimulatorAdapterError,
  ShopSimulatorHttpClient,
  withShoppingSession,
} from "../plugins/shopping/src/environment/index.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const TASK_CONFIG_PATH = join(REPO_ROOT, "configs", "tasks", "development.json");

const SMOKE_ACTION = "Thought: adapter smoke probe, search only.\nAction: search[枕头]";

function loadDevelopmentTaskId(): number {
  const config = JSON.parse(readFileSync(TASK_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  if (config["schema_version"] !== 1) {
    throw new Error("任务配置 schema_version 必须为 1");
  }
  if (config["purpose"] !== "development_smoke_only") {
    throw new Error("任务配置 purpose 必须为 development_smoke_only");
  }
  const taskIds = config["task_ids"];
  if (!Array.isArray(taskIds) || taskIds.length === 0
      || !taskIds.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)) {
    throw new Error("任务配置 task_ids 必须是非空的非负整数列表");
  }
  if (config["final_benchmark_excluded"] !== true) {
    throw new Error("任务配置必须声明 final_benchmark_excluded: true");
  }
  return taskIds[0] as number;
}

async function main(): Promise<number> {
  const live = process.argv.includes("--live");
  if (!live) {
    console.log([
      "shopping adapter smoke（未执行任何真实请求）",
      "用法: pnpm --dir plugins/shopping smoke-shopping-adapter --live",
      "前提: ShopSimulator 已在 SHOPSIM_BASE_URL（默认 http://127.0.0.1:5700）运行：",
      "      bash scripts/start_environment.sh",
    ].join("\n"));
    return 2;
  }

  let taskId: number;
  try {
    taskId = loadDevelopmentTaskId();
  } catch (cause) {
    console.error(`开发任务配置不可用: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }

  const client = ShopSimulatorHttpClient.fromEnv();
  const summary: Record<string, unknown> = {
    live: true,
    baseUrl: client.baseUrl,
    taskId,
    taskConfig: "configs/tasks/development.json (purpose=development_smoke_only)",
    success: false,
    envIdx: null,
    done: null,
    released: false,
    error: null,
  };

  try {
    const { session, value } = await withShoppingSession(
      client,
      taskId,
      async (activeSession) => {
        const step = await activeSession.interact(SMOKE_ACTION);
        return { done: step.done };
      },
    );
    summary["success"] = true;
    summary["envIdx"] = session.envIdx;
    summary["done"] = value.done;
    summary["released"] = session.released;
    summary["releaseError"] = session.releaseError?.message ?? null;
  } catch (cause) {
    if (cause instanceof ShopSimNetworkError) {
      summary["error"] = "network";
      console.error([
        `无法连接 ShopSimulator (${client.baseUrl})。`,
        "请先在另一个终端启动环境（本脚本不会自动启动它）：",
        "  bash scripts/setup_environment.sh   # 首次准备",
        "  bash scripts/start_environment.sh   # 启动服务",
      ].join("\n"));
    } else if (cause instanceof ShopSimulatorAdapterError) {
      summary["error"] = cause.code;
    } else {
      summary["error"] = "unexpected";
    }
    summary["errorMessage"] = cause instanceof Error ? cause.message : String(cause);
  }

  console.log(JSON.stringify(summary, null, 2));
  return summary["success"] === true ? 0 : 1;
}

process.exitCode = await main();
