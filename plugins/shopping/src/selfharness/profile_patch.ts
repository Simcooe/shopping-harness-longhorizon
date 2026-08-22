/**
 * effective profile patch 生成（Self-Harness 执行一致性，冻结基础设施）。
 *
 * 修复关键不一致：canonical harness 的 `system-prompt.md` 必须成为 DSH 运行时
 * 实际使用的 persona，而不是 profile cordis.patch.yml 里的静态文本。同时把
 * DSH actor 的 model selection 绑定到 `MODEL_NAME`，使 actor 与 proposer 使用
 * 完全相同的模型身份。
 *
 * effective patch = 冻结的默认工具禁用 row + 当前 harness 的 persona +
 *   agent-default-model（MODEL_NAME）。
 * 生成使用 `yaml` 库（parse/stringify），绝不 shell 字符串拼接 YAML。
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { HarnessDefinition } from "../harness/surface.ts";

export const MODEL_PROVIDER = "deepseek-official";

export interface BuildEffectiveProfilePatchOptions {
  /** harnesses/base/cordis.patch.yml 的内容（冻结禁用规则的来源）。 */
  basePatchText: string;
  /** 当前 harness（已 loadHarness 校验；persona 取自其 systemPromptText）。 */
  harness: HarnessDefinition;
  /** 模型名（来自 .env 的 MODEL_NAME；为空则省略 agent-default-model 行）。 */
  modelName: string;
}

/** 构建 effective patch 的条目数组（纯函数，可离线测试）。 */
export function buildEffectiveProfilePatch(
  options: BuildEffectiveProfilePatchOptions,
): Array<Record<string, unknown>> {
  const basePatch = parseYaml(options.basePatchText) as unknown;
  if (!Array.isArray(basePatch)) {
    throw new Error("base cordis.patch.yml 必须是顶层数组");
  }
  const disabledRows = basePatch.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null && row["disabled"] === true,
  );

  const patch: Array<Record<string, unknown>> = [
    { id: "system-prompt", config: { persona: options.harness.systemPromptText } },
  ];

  const model = options.modelName.trim();
  if (model.length > 0) {
    patch.push({
      id: "agent-default-model",
      config: { provider: MODEL_PROVIDER, model },
    });
  }

  patch.push(...disabledRows);
  return patch;
}

/** 渲染 effective patch 为 YAML 文本。 */
export function renderProfilePatch(patch: Array<Record<string, unknown>>): string {
  return stringifyYaml(patch);
}

/** 解析 effective patch YAML 回对象（用于离线校验/测试 round-trip）。 */
export function parseProfilePatchText(text: string): unknown {
  return parseYaml(text);
}
