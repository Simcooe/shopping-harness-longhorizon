#!/usr/bin/env node
/**
 * 生成 `.live` 下 shopping-base profile 的 effective cordis.patch.yml。
 *
 * 由 scripts/run_live_task.sh 调用。职责：
 *   1. 校验 `$SHOPPING_HARNESS_DIR` 可被 loadHarness() 合法加载（非法则退出非零）；
 *   2. 从当前 harness 的 system-prompt.md 生成 persona；
 *   3. 从 MODEL_NAME 生成 agent-default-model（actor 模型绑定）；
 *   4. 保留 harnesses/base/cordis.patch.yml 中冻结的默认工具禁用 row。
 *
 * effective patch 是 .live 运行产物（gitignore），不入库；用 yaml 库安全生成，
 * 不用 shell 字符串拼接。
 *
 * 用法：node scripts/generate_profile_patch.ts --profile-dir <abs path>
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadHarness } from "../plugins/shopping/src/harness/surface.ts";
import {
  buildEffectiveProfilePatch,
  renderProfilePatch,
} from "../plugins/shopping/src/selfharness/profile_patch.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  console.error(`[generate_profile_patch] ${message}`);
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  const profileIdx = argv.indexOf("--profile-dir");
  const profileDir = profileIdx >= 0 ? argv[profileIdx + 1] : undefined;
  if (profileDir === undefined || profileDir.length === 0) {
    fail("用法: generate_profile_patch.ts --profile-dir <abs path>");
  }

  const harnessDir = process.env["SHOPPING_HARNESS_DIR"] ?? join(REPO_ROOT, "harnesses", "base");

  // 1. 校验当前 harness 可合法加载（schema + 冻结边界）
  let harness;
  try {
    harness = loadHarness(harnessDir);
  } catch (cause) {
    fail(`harness 加载失败（${harnessDir}）: ${cause instanceof Error ? cause.message : String(cause)}`);
    return;
  }

  // 2. 冻结禁用规则 + persona + model selection
  const basePatchText = readFileSync(
    join(REPO_ROOT, "harnesses", "base", "cordis.patch.yml"),
    "utf-8",
  );
  const modelName = process.env["MODEL_NAME"] ?? "";
  const patch = buildEffectiveProfilePatch({ basePatchText, harness, modelName });

  // 3. 写 effective patch（.live 运行产物）
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "cordis.patch.yml"), renderProfilePatch(patch), "utf-8");
  console.error(
    `[generate_profile_patch] 生成 effective patch: harness=${harness.harnessId} `
    + `version=${harness.version} model=${modelName || "<none>"}`,
  );
}

main();
