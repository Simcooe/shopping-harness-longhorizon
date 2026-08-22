/**
 * shopping-base profile 的 model-facing tool surface 隔离（无模型离线测试）。
 * 不调用真实模型、不修改 dsh/ 源码。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { loadHarness } from "../../plugins/shopping/src/harness/surface.ts";
import {
  DEFAULT_MODEL_FACING_TOOL_ROWS,
  FORBIDDEN_MODEL_TOOL_NAMES,
  NON_MODEL_FACING_TOOL_PREFIXED_ROWS,
} from "../../plugins/shopping/src/harness/profile_tool_surface.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const PROFILE_PATCH = join(REPO_ROOT, "harnesses", "base", "cordis.patch.yml");
const DSH_BASE_PATCH = join(REPO_ROOT, "dsh", "packages", "bundle", "base", "cordis.patch.yml");

test("h0 模型可见工具面恰好三个 shopping tools，且无任何默认 DSH 工具名", () => {
  const harness = loadHarness(join(REPO_ROOT, "harnesses", "base"));
  const names = harness.toolSurface.tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, ["shop_click", "shop_finish", "shop_search"]);
  for (const forbidden of FORBIDDEN_MODEL_TOOL_NAMES) {
    assert.ok(!names.includes(forbidden), `h0 工具面泄漏了 ${forbidden}`);
  }
});

test("profile patch 明确禁用全部默认 model-facing tool row，且不禁用 tools registry", () => {
  const text = readFileSync(PROFILE_PATCH, "utf-8");

  const missing = (DEFAULT_MODEL_FACING_TOOL_ROWS as readonly string[]).filter((rowId) => {
    const re = new RegExp(`- id: ${rowId}\\s+disabled:\\s*true`);
    return !re.test(text);
  });
  assert.deepEqual(missing, [], `以下 model-facing tool row 未禁用: ${missing.join(", ")}`);

  // DSH tools registry 本身必须保留（不加入禁用清单）
  assert.ok(!/-\s*id:\s*tools\s+disabled:\s*true/.test(text), "tools registry 不应被禁用");

  // system-prompt persona 仍保留
  assert.match(text, /- id: system-prompt/);
  assert.match(text, /persona:/);
});

test("profile 禁用清单与固定 DSH base 的 model-facing tool row 对齐（防漂移）", (t) => {
  if (!existsSync(DSH_BASE_PATCH)) {
    t.skip("dsh/ 未检出，跳过与固定 DSH base 的对齐校验");
    return;
  }
  const baseText = readFileSync(DSH_BASE_PATCH, "utf-8");
  const toolRows = [...baseText.matchAll(/-\s+id:\s+(tool-[a-z0-9-]+)/g)]
    .map((match) => match[1] ?? "")
    .filter((id) => !(NON_MODEL_FACING_TOOL_PREFIXED_ROWS as readonly string[]).includes(id));
  const baseModelFacing = [...new Set([...toolRows, "plan-mode"])].sort();

  assert.deepEqual(
    baseModelFacing,
    [...DEFAULT_MODEL_FACING_TOOL_ROWS].sort(),
    "DSH base 的 model-facing tool row 与 shopping 禁用清单不一致",
  );
});
