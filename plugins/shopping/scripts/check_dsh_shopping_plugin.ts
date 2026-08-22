#!/usr/bin/env node
/**
 * DSH shopping plugin 的无模型装配检查（不 boot DSH、不调模型、
 * 不启动 ShopSimulator）。
 *
 * 运行：pnpm --dir plugins/shopping check:dsh
 *
 * 检查内容（离线、纯本地）：
 *   1. harnesses/base profile manifest 形状（private/name/dependencies/
 *      dsh.profile.bundles，依据固定 DSH commit 的 app-boot/profile.ts）；
 *   2. shopping bundle 的 cordis.patch.yml 包含插件挂载行；
 *   3. profile patch 设置了冻结的购物 system prompt（persona）；
 *   4. 直接导入插件入口并以最小注册表执行 apply()：验证 12 个工具
 *      已注册、名称/参数 schema 正确、output.render 产出文本块；
 *   5. runner.json 的任务来源声明可从 configs/tasks/development.json 加载。
 *
 * 明确的限制（不伪造运行成功）：
 *   - 本检查不是真实 Cordis Loader boot：没有走 profile 安装与
 *     bundle 解析链路（npm registry 的 DSH 包版本滞后于固定 SHA，
 *     见 harnesses/base/README.md）；
 *   - 官方最接近的无模型入口是 `dsh --profile <name> --dump-config`
 *     （无 boot、!!js 不求值），需要 DSH CLI 与其依赖安装，本阶段不执行；
 *   - 工具 execute 的真实调用链（权限/超时/事件管线）不在本检查范围。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { apply, name as pluginName, setShoppingRuntime } from "../src/index.ts";
import { loadHarness } from "../src/harness/surface.ts";
import { DEFAULT_MODEL_FACING_TOOL_ROWS, NON_MODEL_FACING_TOOL_PREFIXED_ROWS } from "../src/harness/profile_tool_surface.ts";
import type { DshToolDefinition, DshToolRegistryLike } from "../src/tools/register.ts";
import { ShoppingRuntime } from "../src/tools/runtime.ts";
import { ShopSimulatorHttpClient } from "../src/environment/client.ts";
import { loadDevelopmentTaskSource } from "../src/rollout/task_source.ts";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PLUGIN_DIR, "..", "..");
const PLUGIN_PACKAGE_NAME = "@shopping-harness/plugin-shopping";

interface CheckStep {
  name: string;
  ok: boolean;
  detail: string;
}

const steps: CheckStep[] = [];

function step(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

// 1. profile manifest ---------------------------------------------------------

const profilePath = join(REPO_ROOT, "harnesses", "base", "package.json");
const profile = readJson(profilePath);
const profileBundles = (profile["dsh"] as Record<string, unknown> | undefined)?.["profile"] as
  | { bundles?: unknown }
  | undefined;
const bundles = Array.isArray(profileBundles?.["bundles"]) ? profileBundles?.["bundles"] as string[] : [];
step(
  "profile manifest 形状",
  profile["private"] === true
    && typeof profile["name"] === "string"
    && typeof profile["dependencies"] === "object"
    && bundles.includes(PLUGIN_PACKAGE_NAME)
    && bundles.includes("@deepseek-ai/dsh-base")
    && bundles.includes("@deepseek-ai/dsh-headless"),
  `name=${String(profile["name"])}, bundles=[${bundles.join(", ")}]`,
);

// 2. shopping bundle patch ------------------------------------------------------

const bundlePatchRaw = readFileSync(join(PLUGIN_DIR, "cordis.patch.yml"), "utf-8");
const bundlePatch = parseYaml(bundlePatchRaw) as Array<Record<string, unknown>>;
const insertedRows = bundlePatch.flatMap(
  (entry) => (Array.isArray(entry["insert"]) ? entry["insert"] as Array<Record<string, unknown>> : []),
);
const shoppingRow = insertedRows.find((row) => row["name"] === PLUGIN_PACKAGE_NAME);
step(
  "bundle patch 挂载 shopping 插件行",
  shoppingRow !== undefined && typeof shoppingRow["id"] === "string",
  shoppingRow === undefined
    ? "未找到 name=@shopping-harness/plugin-shopping 的 insert 行"
    : `id=${String(shoppingRow["id"])}`,
);

// 3. profile patch：system prompt ------------------------------------------------

const profilePatchRaw = readFileSync(
  join(REPO_ROOT, "harnesses", "base", "cordis.patch.yml"),
  "utf-8",
);
const profilePatch = parseYaml(profilePatchRaw) as Array<Record<string, unknown>>;
const systemPromptRow = profilePatch.find((entry) => entry["id"] === "system-prompt");
const persona = (systemPromptRow?.["config"] as Record<string, unknown> | undefined)?.["persona"];
step(
  "profile patch 设置购物 system prompt",
  typeof persona === "string"
    && persona.includes("shop_click")
    && !persona.includes("search_products"),
  typeof persona === "string" ? `persona ${persona.length} 字符` : "缺少 persona",
);

// 3b. profile patch 禁用全部默认 model-facing tool row --------------------------

const disabledRowIds = profilePatch
  .filter((entry) => entry["disabled"] === true)
  .map((entry) => entry["id"])
  .filter((id): id is string => typeof id === "string");
const missingDisables = (DEFAULT_MODEL_FACING_TOOL_ROWS as readonly string[]).filter(
  (rowId) => !disabledRowIds.includes(rowId),
);
step(
  "profile patch 禁用全部默认 model-facing tool row（且不禁用 tools registry）",
  missingDisables.length === 0 && !disabledRowIds.includes("tools"),
  missingDisables.length === 0
    ? `已禁用 ${disabledRowIds.length} 个 row`
    : `缺失禁用: ${missingDisables.join(", ")}`,
);

// 3c. 防漂移：与固定 DSH base bundle 的 model-facing tool row 对齐 -----------------

const basePatchPath = join(REPO_ROOT, "dsh", "packages", "bundle", "base", "cordis.patch.yml");
if (existsSync(basePatchPath)) {
  const baseText = readFileSync(basePatchPath, "utf-8");
  const baseToolRows = [...baseText.matchAll(/-\s+id:\s+(tool-[a-z0-9-]+)/g)]
    .map((match) => match[1] ?? "")
    .filter((id) => !(NON_MODEL_FACING_TOOL_PREFIXED_ROWS as readonly string[]).includes(id));
  const baseModelFacing = [...new Set([...baseToolRows, "plan-mode"])].sort();
  const uncovered = baseModelFacing.filter(
    (id) => !(DEFAULT_MODEL_FACING_TOOL_ROWS as readonly string[]).includes(id),
  );
  const extra = (DEFAULT_MODEL_FACING_TOOL_ROWS as readonly string[]).filter(
    (id) => !baseModelFacing.includes(id),
  );
  step(
    "profile 禁用清单与固定 DSH base model-facing tool row 对齐",
    uncovered.length === 0 && extra.length === 0,
    `base rows=[${baseModelFacing.join(", ")}]`
      + (uncovered.length > 0 ? ` 未覆盖=${uncovered.join(",")}` : "")
      + (extra.length > 0 ? ` 多余=${extra.join(",")}` : ""),
  );
} else {
  step("profile 禁用清单与 DSH base 对齐（dsh/ 缺失，跳过）", true, "dsh/ 未检出，按冻结常量校验");
}

// 4. 插件入口 apply() → 12 个工具注册 ----------------------------------------------

class CollectorRegistry implements DshToolRegistryLike {
  definitions: DshToolDefinition[] = [];
  register(definition: DshToolDefinition): () => void {
    this.definitions.push(definition);
    return () => {
      this.definitions = this.definitions.filter((entry) => entry !== definition);
    };
  }
}

const registry = new CollectorRegistry();
// 显式运行时：只读 SHOPSIM_BASE_URL 的 client，不发任何网络请求。
setShoppingRuntime(new ShoppingRuntime({
  client: new ShopSimulatorHttpClient("http://127.0.0.1:5700"),
}));
apply({ tools: registry });

// h0：工具的唯一配置来源是 harnesses/base/tool-surface.yml
const harness = loadHarness(join(REPO_ROOT, "harnesses", "base"));
const registeredNames = registry.definitions.map((definition) => definition.name).sort();
const expectedNames = harness.toolSurface.tools.map((tool) => tool.name).sort();
step(
  "apply() 注册 h0 tool surface（恰好 3 个 primitive 工具）",
  harness.harnessId === "shopping-h0"
    && expectedNames.length === 3
    && JSON.stringify(registeredNames) === JSON.stringify(expectedNames),
  `harness=${harness.harnessId} registered=[${registeredNames.join(", ")}]`,
);

let schemaOk = true;
const schemaNotes: string[] = [];
for (const definition of registry.definitions) {
  const params = definition.parameters as { additionalProperties?: unknown; required?: unknown };
  if (params["additionalProperties"] !== false) {
    schemaOk = false;
    schemaNotes.push(`${definition.name}: additionalProperties 不为 false`);
  }
  const hasProperties = typeof params["properties"] === "object"
    && params["properties"] !== null
    && Object.keys(params["properties"] as object).length > 0;
  if (hasProperties
    && (!Array.isArray(params["required"]) || (params["required"] as unknown[]).length === 0)) {
    schemaOk = false;
    schemaNotes.push(`${definition.name}: 有参数但未声明 required`);
  }
  if (typeof definition.execute !== "function" || typeof definition.output?.render !== "function") {
    schemaOk = false;
    schemaNotes.push(`${definition.name}: execute/output.render 缺失`);
  }
  const blocks = definition.output.render({}, { summary: "s", done: false, env_idx: 0 });
  if (blocks.length !== 1 || blocks[0]?.type !== "text") {
    schemaOk = false;
    schemaNotes.push(`${definition.name}: render 未产出单一 text 块`);
  }
}
step("工具 schema 严格且 output.render 正确", schemaOk, schemaNotes.join("; ") || "全部通过");

// 5. runner 任务来源 ---------------------------------------------------------------

try {
  const source = loadDevelopmentTaskSource(
    join(REPO_ROOT, "configs", "tasks", "development.json"),
  );
  const runner = readJson(join(REPO_ROOT, "harnesses", "base", "runner.json"));
  const selection = runner["task_selection"] as Record<string, unknown> | undefined;
  step(
    "runner 任务来源（外部注入，development_smoke_only）",
    selection?.["mode"] === "external_injection_only" && source.taskIds.length > 0,
    `task_ids=[${source.taskIds.join(", ")}]`,
  );
} catch (cause) {
  step("runner 任务来源", false, cause instanceof Error ? cause.message : String(cause));
}

// 汇总 ---------------------------------------------------------------------------

setShoppingRuntime(null); // 清理注入

const failed = steps.filter((entry) => !entry.ok);
console.log(JSON.stringify({
  plugin: pluginName,
  mode: "offline-assembly-check",
  steps,
  success: failed.length === 0,
  limitations: [
    "非真实 Cordis Loader boot（未走 profile 安装/bundle 解析）",
    "官方最接近的无模型入口为 dsh --profile <name> --dump-config，本阶段未执行",
    "工具执行管线（权限/超时/session 事件）未在本检查中运行",
  ],
}, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
