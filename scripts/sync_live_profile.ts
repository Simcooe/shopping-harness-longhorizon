#!/usr/bin/env node
/**
 * live profile bundle 同步（冻结基础设施的一部分，非 harness 编辑面）。
 *
 * 根因：pnpm 的 file: 依赖是"安装时刻的源码树快照"（文件硬链接到
 * .pnpm 虚拟 store），本地 plugin 后续新增构建产物（如 lib/harness/、
 * lib/evidence/）不会自动出现在 profile 的 node_modules 副本里。旧的
 * run_live_task.sh 只在 node_modules 不存在时安装一次，导致 stale 副本
 * 被复用，DSH 加载 plugin 时 import ./harness/surface.js 失败。
 *
 * 本脚本在每次 live run 前计算本地 plugin 构建产物的确定性指纹：
 *   - plugins/shopping/package.json
 *   - plugins/shopping/pnpm-lock.yaml
 *   - plugins/shopping/cordis.patch.yml
 *   - harnesses/base/package.json（profile 依赖清单来源）
 *   - harnesses/base/cordis.patch.yml（profile patch）
 *   - plugins/shopping/lib/**（递归内容 hash）
 * 指纹变化时：只清理允许范围（profile 的 node_modules/ 与
 * .shopping-plugin-sync-* marker），重新 pnpm install，再写 marker；
 * 指纹未变时复用现有 node_modules，避免每次完整安装。
 *
 * 清理范围严格限定在 gitignored 的 .live/dsh-home/profiles/shopping-base/
 * 下；绝不触碰 dsh/、environment/ShopSimulator/、harnesses/、trajectories/
 * 或 evaluation/。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_MARKER_NAME = ".shopping-plugin-sync-hash";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 指纹覆盖的固定文件（相对 REPO_ROOT）。 */
const COVERED_FILES = [
  "plugins/shopping/package.json",
  "plugins/shopping/pnpm-lock.yaml",
  "plugins/shopping/cordis.patch.yml",
  "harnesses/base/package.json",
  "harnesses/base/cordis.patch.yml",
] as const;

/** 指纹覆盖的固定目录（递归 hash 其中所有文件）。 */
const COVERED_DIRS = ["plugins/shopping/lib"] as const;

/** 指纹覆盖的当前 harness 文件（harness.yml + 四个 editable surface）。 */
const HARNESS_FILES = [
  "harness.yml",
  "system-prompt.md",
  "tool-surface.yml",
  "runtime-policy.yml",
  "verification-policy.yml",
] as const;

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 递归列出目录下所有文件的相对路径（相对 dir，稳定排序）。 */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(relative(dir, full));
      }
    }
  };
  if (existsSync(dir)) {
    walk(dir);
  }
  return out;
}

/** 计算 sync 指纹（确定性：相同输入 → 相同输出）。 */
export function computeSyncFingerprint(repoRoot: string, harnessDir?: string): string {
  const parts: string[] = [];

  for (const rel of COVERED_FILES) {
    const full = join(repoRoot, rel);
    const digest = existsSync(full) ? sha256(readFileSync(full)) : "<missing>";
    parts.push(`${rel}\t${digest}`);
  }

  for (const rel of COVERED_DIRS) {
    const dir = join(repoRoot, rel);
    for (const fileRel of listFilesRecursive(dir)) {
      const full = join(dir, fileRel);
      const stat = statSync(full);
      if (!stat.isFile()) {
        continue;
      }
      parts.push(`${rel}/${fileRel}\t${sha256(readFileSync(full))}`);
    }
  }

  const harness = harnessDir ?? join(repoRoot, "harnesses", "base");
  const harnessRel = relative(repoRoot, harness) || ".";
  for (const file of HARNESS_FILES) {
    const full = join(harness, file);
    const digest = existsSync(full) ? sha256(readFileSync(full)) : "<missing>";
    parts.push(`${harnessRel}/${file}\t${digest}`);
  }

  return `sha256:${sha256(parts.join("\n"))}`;
}

export interface SyncMarker {
  schema_version: number;
  fingerprint: string;
}

/** 读取 marker；缺失/损坏返回 null。 */
export function readSyncMarker(profileDir: string): SyncMarker | null {
  const path = join(profileDir, SYNC_MARKER_NAME);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed === "object" && parsed !== null
      && "schema_version" in parsed
      && "fingerprint" in parsed
      && typeof (parsed as { fingerprint?: unknown }).fingerprint === "string") {
      return {
        schema_version: Number((parsed as { schema_version?: unknown }).schema_version),
        fingerprint: (parsed as { fingerprint: string }).fingerprint,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeSyncMarker(profileDir: string, fingerprint: string): void {
  mkdirSync(profileDir, { recursive: true });
  const marker: SyncMarker = { schema_version: SYNC_SCHEMA_VERSION, fingerprint };
  writeFileSync(
    join(profileDir, SYNC_MARKER_NAME),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf-8",
  );
}

/** 是否 stale：marker 缺失或指纹不一致。 */
export function isSyncStale(profileDir: string, fingerprint: string): boolean {
  const marker = readSyncMarker(profileDir);
  return marker === null || marker.fingerprint !== fingerprint;
}

/**
 * 清理允许范围（仅 profile 的 node_modules/ 与 .shopping-plugin-sync-* marker）。
 * 绝不动 profile 之外的任何路径。
 */
export function clearProfileBundle(profileDir: string): void {
  const nodeModules = join(profileDir, "node_modules");
  if (existsSync(nodeModules)) {
    rmSync(nodeModules, { recursive: true, force: true });
  }
  if (existsSync(profileDir)) {
    for (const entry of readdirSync(profileDir)) {
      if (entry.startsWith(".shopping-plugin-sync-")) {
        rmSync(join(profileDir, entry), { recursive: true, force: true });
      }
    }
  }
}

/** 默认安装：profile 目录内 pnpm install。 */
export function defaultInstall(profileDir: string): void {
  const child = spawnSync("pnpm", ["install", "--silent"], {
    cwd: profileDir,
    stdio: "inherit",
    encoding: "utf-8",
  });
  if (child.status !== 0) {
    throw new Error(
      `pnpm install 失败（exit=${String(child.status)}）于 ${profileDir}`,
    );
  }
}

export interface SyncProfileOptions {
  repoRoot: string;
  profileDir: string;
  /** 当前 harness 目录（默认 harnesses/base）；其 5 个文件进入指纹。 */
  harnessDir?: string;
  /** 测试注入用；默认 defaultInstall。 */
  install?: (profileDir: string) => void;
}

export interface SyncProfileResult {
  fingerprint: string;
  stale: boolean;
  installed: boolean;
}

/** 顶层同步：算指纹 → 判 stale → 清理 → 安装 → 写 marker。 */
export function syncProfile(options: SyncProfileOptions): SyncProfileResult {
  const fingerprint = computeSyncFingerprint(options.repoRoot, options.harnessDir);
  if (!isSyncStale(options.profileDir, fingerprint)) {
    return { fingerprint, stale: false, installed: false };
  }
  clearProfileBundle(options.profileDir);
  const install = options.install ?? defaultInstall;
  install(options.profileDir);
  writeSyncMarker(options.profileDir, fingerprint);
  return { fingerprint, stale: true, installed: true };
}

function main(): void {
  const argv = process.argv.slice(2);
  const profileIdx = argv.indexOf("--profile-dir");
  const profileDir = profileIdx >= 0 ? argv[profileIdx + 1] : undefined;
  if (profileDir === undefined || profileDir.length === 0) {
    console.error("[sync_live_profile] 用法: sync_live_profile.ts --profile-dir <abs path>");
    process.exit(2);
  }

  try {
    const harnessDir = process.env["SHOPPING_HARNESS_DIR"] ?? join(REPO_ROOT, "harnesses", "base");
    const result = syncProfile({ repoRoot: REPO_ROOT, profileDir, harnessDir });
    console.error(
      `[sync_live_profile] fingerprint=${result.fingerprint} `
      + `stale=${String(result.stale)} installed=${String(result.installed)}`,
    );
  } catch (cause) {
    console.error(`[sync_live_profile] ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
