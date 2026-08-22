/**
 * effective profile patch 生成的离线测试（persona / model 绑定 / 禁用行保留）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildEffectiveProfilePatch,
  parseProfilePatchText,
  renderProfilePatch,
} from "../../plugins/shopping/src/selfharness/index.ts";
import { loadHarness } from "../../plugins/shopping/src/harness/surface.ts";
import { DEFAULT_MODEL_FACING_TOOL_ROWS } from "../../plugins/shopping/src/harness/profile_tool_surface.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const BASE_HARNESS = join(REPO_ROOT, "harnesses", "base");
const BASE_PATCH = join(REPO_ROOT, "harnesses", "base", "cordis.patch.yml");

function build(modelName: string) {
  const harness = loadHarness(BASE_HARNESS);
  const basePatchText = readFileSync(BASE_PATCH, "utf-8");
  const patch = buildEffectiveProfilePatch({ basePatchText, harness, modelName });
  const rendered = renderProfilePatch(patch);
  const parsed = parseProfilePatchText(rendered) as Array<Record<string, unknown>>;
  return { harness, patch, rendered, parsed };
}

test("h0 effective persona 与 h0 system-prompt.md 完全一致（round-trip）", () => {
  const { harness, parsed } = build("deepseek-v4");
  const personaRow = parsed.find((row) => row["id"] === "system-prompt");
  const persona = (personaRow?.["config"] as Record<string, unknown> | undefined)?.["persona"];
  assert.equal(
    persona,
    harness.systemPromptText,
    "effective persona 应与 system-prompt.md 内容一致",
  );
});

test("agent-default-model 绑定 MODEL_NAME", () => {
  const { parsed } = build("deepseek-v4-pro");
  const modelRow = parsed.find((row) => row["id"] === "agent-default-model");
  assert.equal((modelRow?.["config"] as Record<string, unknown>)?.["model"], "deepseek-v4-pro");
});

test("冻结的默认工具禁用行被完整保留", () => {
  const { parsed } = build("m");
  const disabledIds = parsed.filter((row) => row["disabled"] === true).map((row) => row["id"]);
  for (const rowId of DEFAULT_MODEL_FACING_TOOL_ROWS) {
    assert.ok(disabledIds.includes(rowId), `缺失禁用行: ${rowId}`);
  }
  assert.ok(!disabledIds.includes("tools"), "tools registry 不应被禁用");
});

test("candidate 修改 system-prompt.md 后 effective persona 变化", () => {
  const harness = loadHarness(BASE_HARNESS);
  const basePatchText = readFileSync(BASE_PATCH, "utf-8");
  const editedHarness = { ...harness, systemPromptText: "修改后的 persona\n" };
  const patch = buildEffectiveProfilePatch({ basePatchText, harness: editedHarness, modelName: "m" });
  const parsed = parseProfilePatchText(renderProfilePatch(patch)) as Array<Record<string, unknown>>;
  const persona = (parsed.find((row) => row["id"] === "system-prompt")?.["config"] as Record<string, unknown>)?.["persona"];
  assert.equal(persona, "修改后的 persona\n");
  assert.notEqual(persona, harness.systemPromptText);
});
