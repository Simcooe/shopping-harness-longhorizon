#!/usr/bin/env node
/**
 * live run bootstrap helper：在启动 DSH **之前** reset 一次 ShopSimulator，
 * 把 actor-safe 的 {run_id, task_id, env_idx, instruction_text} 写入按 run
 * 隔离的 bootstrap 文件（.live/runs/<run_id>/bootstrap.json，0600，no-clobber）。
 *
 * ownership / handoff 语义：
 *   - reset 成功后，本 helper 暂时拥有该 env_idx；
 *   - 只有 bootstrap 文件安全写入且 handoff 信息输出成功后，ownership
 *     才交给 runner；
 *   - handoff 完成前发生任何错误或收到 SIGINT/SIGTERM，helper 都必须
 *     release_one 当前 env_idx（只针对当前 env_idx，绝不 release_all）。
 *
 * release 结果决定日志（绝不无条件声称"已释放"）：
 *   - release 成功/already free → "新领取的 env_idx 已释放"；
 *   - release 失败 → 写 0600 no-clobber 恢复记录
 *     .live/recovery/<run_id>-env-<env_idx>.json（仅 actor-safe 字段），
 *     输出恢复记录路径与重试命令；
 *   - 恢复记录也写失败 → 明确输出"release 未成功且恢复记录写入失败"
 *     + env_idx + 人工 release_one 指引，退出非零。
 *
 * 用法（由 scripts/run_live_task.sh 调用）：
 *   node scripts/bootstrap_live_session.ts --task-id <id> --run-id <run_id> [--output <abs path>]
 *
 * stdout 只输出 {bootstrapPath, envIdx}（不含 instruction，避免扩散）。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ShopSimulatorHttpClient } from "../plugins/shopping/src/environment/index.ts";
import { loadDevelopmentTaskSource, assertInjectedTaskId } from "../plugins/shopping/src/rollout/task_source.ts";
import {
  assertValidOutputPath,
  assertValidRunId,
  buildBootstrap,
  resolveBootstrapPath,
  resolveRecoveryPath,
  writeBootstrap,
  writeRecoveryRecord,
  type BootstrapSession,
} from "../plugins/shopping/src/rollout/bootstrap.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_DIR = process.env["SHOPPING_LIVE_DIR"] ?? join(REPO_ROOT, ".live");

function fail(message: string): never {
  console.error(`[bootstrap_live_session] ${message}`);
  process.exit(1);
}

/** releaseOwned 的真实结果：released 为 false 时绝不声称已释放。 */
type ReleaseOwnedResult =
  | { released: true }
  | { released: false; recoveryPath: string | null; errorCode: string };

const argv = process.argv.slice(2);
const taskIdRaw = argv[argv.indexOf("--task-id") + 1];
const runId = argv[argv.indexOf("--run-id") + 1];
const outputIdx = argv.indexOf("--output");
const explicitOutput = outputIdx >= 0 ? argv[outputIdx + 1] : undefined;
if (taskIdRaw === undefined || runId === undefined) {
  fail("用法: bootstrap_live_session.ts --task-id <id> --run-id <run_id> [--output <abs path>]");
}
const taskId = Number(taskIdRaw);
if (!Number.isInteger(taskId)) {
  fail(`--task-id 不是整数: ${taskIdRaw}`);
}

// run_id 严格校验（即使使用显式 --output 也不绕过）
try {
  assertValidRunId(runId);
} catch (cause) {
  fail(cause instanceof Error ? cause.message : String(cause));
}

let bootstrapPath: string;
try {
  if (explicitOutput !== undefined) {
    assertValidOutputPath(explicitOutput);
    bootstrapPath = explicitOutput;
  } else {
    bootstrapPath = resolveBootstrapPath(LIVE_DIR, runId);
  }
} catch (cause) {
  fail(cause instanceof Error ? cause.message : String(cause));
}

// task_id 必须属于声明的开发任务集
const source = loadDevelopmentTaskSource(
  join(REPO_ROOT, "configs", "tasks", "development.json"),
);
assertInjectedTaskId(source, taskId);

const baseUrl = (process.env["SHOPSIM_BASE_URL"] ?? "http://127.0.0.1:5700").trim();
const client = new ShopSimulatorHttpClient(baseUrl);

// ---- ownership 阶段：reset 成功后，helper 暂时拥有 env_idx ----------------
let ownedEnvIdx: number | null = null;
let handedOff = false;
let pendingBootstrap: BootstrapSession | null = null;

/** 尝试释放当前拥有的 env_idx；返回真实结果（绝不吞错后假装成功）。 */
async function releaseOwned(): Promise<ReleaseOwnedResult> {
  if (ownedEnvIdx === null || handedOff) {
    return { released: true };
  }
  const envIdx = ownedEnvIdx;
  try {
    await client.releaseOne(envIdx);
    return { released: true };
  } catch (cause) {
    const errorCode = "code" in (cause as { code?: string })
      ? String((cause as { code?: string }).code)
      : "unknown";
    // 写恢复记录（0600、no-clobber、仅 actor-safe 字段）
    let recoveryPath: string | null = null;
    try {
      const record = pendingBootstrap ?? {
        schema_version: 1,
        run_id: runId,
        task_id: taskId,
        env_idx: envIdx,
        instruction_text: "",
      };
      recoveryPath = writeRecoveryRecord(
        resolveRecoveryPath(LIVE_DIR, runId, envIdx),
        record,
      );
    } catch {
      recoveryPath = null;
    }
    return { released: false, recoveryPath, errorCode };
  }
}

/** 按 release 真实结果输出并退出（handoff 前失败路径）。 */
async function failWithRelease(context: string): Promise<never> {
  const result = await releaseOwned();
  if (result.released) {
    fail(`${context}；新领取的 env_idx=${ownedEnvIdx} 已释放。`);
  }
  if (result.recoveryPath !== null) {
    console.error(`[bootstrap_live_session] ${context}；env_idx=${ownedEnvIdx} 尚未确认释放；恢复记录位于 ${result.recoveryPath}`);
    console.error(
      `[bootstrap_live_session] 恢复重试: SHOPPING_BOOTSTRAP=${result.recoveryPath} `
      + `SHOPSIM_BASE_URL=${baseUrl} node scripts/cleanup_live_session.ts`,
    );
    process.exit(1);
  }
  console.error(`[bootstrap_live_session] ${context}；release 未成功且 recovery record 写入失败。`);
  console.error(`[bootstrap_live_session] 未释放的 env_idx=${ownedEnvIdx}（run_id=${runId}）。`);
  console.error(
    "[bootstrap_live_session] 人工释放指引：向 ShopSimulator 的 /api/shop_agent 发送 "
    + `{"action":"release_one","env_idx":${ownedEnvIdx}}（只针对该 env_idx，勿用 release_all）。`,
  );
  process.exit(1);
}

// reset 后、handoff 前收到中断：尽力释放当前 env_idx（按真实结果输出）
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void failWithRelease(`收到 ${signal}，handoff 未完成`).catch(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}

let resetResult;
try {
  // 整个 run 唯一一次 reset（发生在这里，早于 DSH 启动与第一次模型请求）
  resetResult = await client.reset(taskId);
} catch (cause) {
  fail(`reset 失败: ${cause instanceof Error ? cause.message : String(cause)}`);
}
ownedEnvIdx = resetResult.envIdx;

try {
  const bootstrap = buildBootstrap({ runId, taskId, resetResult });
  pendingBootstrap = bootstrap;
  writeBootstrap(bootstrapPath, bootstrap); // 目标已存在 → BootstrapAlreadyExistsError
  console.log(JSON.stringify({ bootstrapPath, envIdx: bootstrap.env_idx }));
  handedOff = true; // ownership 交给 runner
} catch (cause) {
  await failWithRelease(
    `bootstrap 写入失败: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}
