/**
 * live profile bundle 同步的离线测试。
 * 不调用真实模型、不启动真实 ShopSimulator、不访问网络（install 用注入的 fake）。
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  clearProfileBundle,
  computeSyncFingerprint,
  isSyncStale,
  readSyncMarker,
  syncProfile,
  SYNC_MARKER_NAME,
  writeSyncMarker,
} from "../../scripts/sync_live_profile.ts";

function write(repoRoot: string, rel: string, content: string): void {
  const path = join(repoRoot, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** 搭建一个最小 repoRoot，含指纹覆盖的文件与一个 lib/ 文件。 */
function makeRepo(libFiles: Record<string, string> = { "index.js": "export const x = 1;\n" }): string {
  const root = mkdtempSync(join(tmpdir(), "sync-repo-"));
  write(root, "plugins/shopping/package.json", '{"name":"p","dependencies":{"yaml":"^2.9.0"}}\n');
  write(root, "plugins/shopping/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(root, "plugins/shopping/cordis.patch.yml", "- insert: []\n");
  write(root, "harnesses/base/package.json", '{"name":"profile"}\n');
  write(root, "harnesses/base/cordis.patch.yml", "- id: system-prompt\n");
  for (const [rel, content] of Object.entries(libFiles)) {
    write(root, `plugins/shopping/lib/${rel}`, content);
  }
  return root;
}

test("fingerprint 确定性：相同输入 → 相同输出", () => {
  const root = makeRepo();
  try {
    const a = computeSyncFingerprint(root);
    const b = computeSyncFingerprint(root);
    assert.equal(a, b);
    assert.match(a, /^sha256:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fingerprint 敏感：新增 lib 文件或内容变化都会改变指纹", () => {
  const root = makeRepo();
  try {
    const base = computeSyncFingerprint(root);
    // 新增 lib/harness/surface.js（模拟 h0 新增构建产物）
    write(root, "plugins/shopping/lib/harness/surface.js", "export const load = () => {};\n");
    const afterAdd = computeSyncFingerprint(root);
    assert.notEqual(afterAdd, base);

    // 修改已有 lib 文件内容
    write(root, "plugins/shopping/lib/index.js", "export const x = 2;\n");
    const afterEdit = computeSyncFingerprint(root);
    assert.notEqual(afterEdit, afterAdd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isSyncStale：marker 缺失或指纹不一致为 stale，一致为 fresh", () => {
  const root = makeRepo();
  const profileDir = mkdtempSync(join(tmpdir(), "sync-profile-"));
  try {
    const fp = computeSyncFingerprint(root);
    assert.equal(isSyncStale(profileDir, fp), true);
    writeSyncMarker(profileDir, fp);
    assert.equal(isSyncStale(profileDir, fp), false);
    assert.equal(isSyncStale(profileDir, "sha256:deadbeef"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("syncProfile：stale 时安装并把 lib/harness 同步进 profile 副本；fresh 时复用不重装", () => {
  const root = makeRepo({ "harness/surface.js": "export const load = () => {};\n" });
  const profileDir = mkdtempSync(join(tmpdir(), "sync-profile-"));
  let installCount = 0;
  const fakeInstall = (dir: string): void => {
    installCount += 1;
    // 模拟 pnpm file: 依赖快照：把 plugin lib 复制进 profile 的 node_modules 副本
    cpSync(join(root, "plugins", "shopping", "lib"), join(dir, "node_modules", "@shopping-harness", "plugin-shopping", "lib"), { recursive: true });
  };
  try {
    const first = syncProfile({ repoRoot: root, profileDir, install: fakeInstall });
    assert.equal(first.stale, true);
    assert.equal(first.installed, true);
    assert.equal(installCount, 1);
    assert.ok(
      existsSync(join(profileDir, "node_modules", "@shopping-harness", "plugin-shopping", "lib", "harness", "surface.js")),
      "profile 副本应包含 lib/harness/surface.js",
    );
    assert.ok(readSyncMarker(profileDir) !== null);

    // 再次同步：指纹未变 → fresh，不重装
    const second = syncProfile({ repoRoot: root, profileDir, install: fakeInstall });
    assert.equal(second.stale, false);
    assert.equal(second.installed, false);
    assert.equal(installCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("clearProfileBundle 只清理 node_modules 与 marker，不动其它文件", () => {
  const profileDir = mkdtempSync(join(tmpdir(), "sync-profile-"));
  try {
    mkdirSync(join(profileDir, "node_modules", "sub"), { recursive: true });
    writeFileSync(join(profileDir, "node_modules", "sub", "x.js"), "x", "utf-8");
    writeFileSync(join(profileDir, SYNC_MARKER_NAME), '{"schema_version":1,"fingerprint":"sha256:abc"}\n', "utf-8");
    writeFileSync(join(profileDir, ".shopping-plugin-sync-old"), "old", "utf-8");
    writeFileSync(join(profileDir, "cordis.patch.yml"), "keep", "utf-8");
    writeFileSync(join(profileDir, "keep.txt"), "keep", "utf-8");

    clearProfileBundle(profileDir);

    assert.equal(existsSync(join(profileDir, "node_modules")), false);
    assert.equal(existsSync(join(profileDir, SYNC_MARKER_NAME)), false);
    assert.equal(existsSync(join(profileDir, ".shopping-plugin-sync-old")), false);
    assert.equal(readFileSync(join(profileDir, "cordis.patch.yml"), "utf-8"), "keep");
    assert.equal(readFileSync(join(profileDir, "keep.txt"), "utf-8"), "keep");
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("fingerprint 覆盖 harness 文件：system-prompt.md 变化改变指纹", () => {
  const root = makeRepo();
  try {
    const harnessDir = join(root, "harnesses", "base");
    write(root, "harnesses/base/system-prompt.md", "prompt v1\n");
    const before = computeSyncFingerprint(root, harnessDir);
    write(root, "harnesses/base/system-prompt.md", "prompt v2\n");
    const after = computeSyncFingerprint(root, harnessDir);
    assert.notEqual(before, after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
