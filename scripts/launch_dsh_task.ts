#!/usr/bin/env node
/**
 * 以 argv 方式启动 headless DSH task（无 shell 解析，无注入面）。
 *
 * 任务 prompt 从 bootstrap 文件构造（buildInitialTaskPrompt），经
 * child_process.spawn 的参数数组传递给 dsh CLI：指令文本中的换行、
 * 引号、反引号、$() 等字符一律按字面值传递，绝不进入 shell 命令行。
 *
 * 中断处理：
 *   - SIGINT/SIGTERM 转发给 DSH child；
 *   - 等待 child 真正退出后 launcher 才退出（不留下孤儿 DSH 进程
 *     继续调用模型或环境）；
 *   - child 被信号终止时以 130（SIGINT）/143（SIGTERM）退出。
 *
 * 用法（由 scripts/run_live_task.sh 调用）：
 *   SHOPPING_BOOTSTRAP=/abs/path/bootstrap.json \
 *   node scripts/launch_dsh_task.ts --dsh-bin <path> --profile shopping-base
 * 缺少 SHOPPING_BOOTSTRAP 时明确失败，不回退到任何共享路径。
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBootstrap, buildInitialTaskPrompt } from "../plugins/shopping/src/rollout/bootstrap.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  console.error(`[launch_dsh_task] ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dshBin = argv[argv.indexOf("--dsh-bin") + 1];
const profileIdx = argv.indexOf("--profile");
const profile = profileIdx >= 0 ? argv[profileIdx + 1] : "shopping-base";
if (dshBin === undefined) {
  fail("缺少 --dsh-bin");
}

const bootstrapPath = process.env["SHOPPING_BOOTSTRAP"];
if (bootstrapPath === undefined || bootstrapPath.trim().length === 0) {
  fail("缺少 SHOPPING_BOOTSTRAP（指向 bootstrap.json 的绝对路径；不允许回退到共享路径）");
}
const bootstrap = loadBootstrap(bootstrapPath);
const prompt = buildInitialTaskPrompt(bootstrap);

// argv 数组传递：spawn 不经过 shell，prompt 作为单个参数原样送达
const child = spawn(dshBin, ["--profile", profile, prompt], {
  stdio: "inherit",
  env: process.env,
});

let childExited = false;

// 转发中断信号给 child；等 child 退出后 launcher 才退出
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (!childExited) {
      child.kill(signal);
    }
  });
}

child.on("error", (cause) => {
  fail(`无法启动 dsh: ${String(cause)}`);
});

child.on("exit", (code, signal) => {
  childExited = true;
  if (signal !== null) {
    // 被信号终止（如 Ctrl-C）：以惯例退出码退出，bash trap 负责 release
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
  process.exit(code ?? 1);
});
