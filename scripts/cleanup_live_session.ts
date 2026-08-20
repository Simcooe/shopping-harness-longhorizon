#!/usr/bin/env node
/**
 * live run cleanup：只释放 bootstrap 的当前 env_idx（release_one），
 * 绝不使用 release_all（不得影响其他并发任务）。
 *
 * 错误分类（结构化 code，不匹配消息文本）：
 *   - BootstrapNotFoundError（仅 ENOENT）→ 幂等成功，退出码 0；
 *   - BootstrapReadError（EACCES/EISDIR/IO 等，文件存在但不可读）
 *     → 非零退出（2），保留原路径，不声称已清理，不发送 release_one；
 *   - bootstrap 内容非法 → 非零退出（2），明确报错；
 *   - 缺少 SHOPPING_BOOTSTRAP → 非零退出（2），不猜路径。
 *
 * release 语义：
 *   - release_one 成功或 "already free" → 删除 bootstrap 文件；
 *     若 .live/runs/<run_id>/ 因此变空，删除该空目录（只删本 run 的目录）；
 *   - release 失败 / ShopSimulator 不可达 → 保留 bootstrap 文件，
 *     打印可执行的重试命令（不含敏感信息），退出码 1；可再次运行重试。
 *
 * 用法（由 scripts/run_live_task.sh 的 EXIT trap 调用，或手动重试）：
 *   SHOPPING_BOOTSTRAP=/absolute/path/to/bootstrap.json \
 *   SHOPSIM_BASE_URL=http://127.0.0.1:5700 \
 *   node scripts/cleanup_live_session.ts
 */

import { readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { ShopSimulatorHttpClient } from "../plugins/shopping/src/environment/index.ts";
import {
  BootstrapNotFoundError,
  buildReleasePayload,
  loadBootstrap,
} from "../plugins/shopping/src/rollout/bootstrap.ts";

const bootstrapPath = process.env["SHOPPING_BOOTSTRAP"];
if (bootstrapPath === undefined || bootstrapPath.trim().length === 0) {
  console.error("[cleanup_live_session] 缺少 SHOPPING_BOOTSTRAP（指向 bootstrap.json 的绝对路径）");
  process.exit(2);
}

let bootstrap;
try {
  bootstrap = loadBootstrap(bootstrapPath);
} catch (cause) {
  if (cause instanceof BootstrapNotFoundError) {
    // 仅真正 ENOENT 才能幂等成功
    console.error("[cleanup_live_session] bootstrap 文件不存在，视为已清理。");
    process.exit(0);
  }
  // 读取失败/非法内容：非零退出，保留原路径，不声称已清理
  console.error(`[cleanup_live_session] bootstrap 不可用: ${cause instanceof Error ? cause.message : String(cause)}`);
  console.error(`[cleanup_live_session] 原路径保留: ${bootstrapPath}；未发送 release_one。`);
  process.exit(2);
}

const baseUrl = (process.env["SHOPSIM_BASE_URL"] ?? "http://127.0.0.1:5700").trim();
const client = new ShopSimulatorHttpClient(baseUrl);
const payload = buildReleasePayload(bootstrap);

try {
  // release_one 幂等：重复调用返回 "already free"，同样视为成功
  const result = await client.releaseOne(payload.env_idx);
  console.error(
    `[cleanup_live_session] released env_idx=${payload.env_idx}（${result.message}）`,
  );
} catch (cause) {
  // 保留 bootstrap 文件：不得静默声称已释放；给出可执行的重试命令
  console.error(
    `[cleanup_live_session] release 失败（env_idx=${payload.env_idx}），bootstrap 保留于 ${bootstrapPath}`,
  );
  console.error(
    `[cleanup_live_session] 重试: SHOPPING_BOOTSTRAP=${bootstrapPath} `
    + `SHOPSIM_BASE_URL=${baseUrl} node scripts/cleanup_live_session.ts`,
  );
  console.error(`[cleanup_live_session] 原因: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}

// 释放成功：删除 bootstrap 文件；若本 run 目录因此变空则删除空目录
try {
  unlinkSync(bootstrapPath);
} catch {
  // 并发下可能已被删除：无碍
}
try {
  const runDir = dirname(bootstrapPath);
  if (readdirSync(runDir).length === 0) {
    rmdirSync(runDir); // 只删本 run 的空目录；非空或其他 run 不受影响
  }
} catch {
  // 目录清理失败不影响释放成功的事实
}
