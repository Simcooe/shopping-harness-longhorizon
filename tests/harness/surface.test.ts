/**
 * h0 canonical harness 表示的离线测试：
 * surface 加载/校验、primitive 冻结映射、未知 primitive 拒绝、
 * h0 内容断言（恰好三工具、system prompt 最小化、步数配置分离）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FROZEN_PRIMITIVES,
  HarnessLoadError,
  assertSafeActionArg,
  computeToolSurfaceDigest,
  loadHarness,
  primitiveToEnvironmentAction,
  validateSurfaceToolArgs,
} from "../../plugins/shopping/src/harness/surface.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const H0_DIR = join(REPO_ROOT, "harnesses", "base");

// ---- h0 加载与结构 -----------------------------------------------------------

test("h0 加载成功：harness_id/parent/version/四文件引用齐备", () => {
  const harness = loadHarness(H0_DIR);
  assert.equal(harness.schemaVersion, 1);
  assert.equal(harness.harnessId, "shopping-h0");
  assert.equal(harness.parentHarness, null);
  assert.equal(harness.version, "0.1.0");
  assert.equal(harness.systemPromptRef, "system-prompt.md");
  assert.equal(harness.toolSurfaceRef, "tool-surface.yml");
  assert.equal(harness.runtimePolicyRef, "runtime-policy.yml");
  assert.equal(harness.verificationPolicyRef, "verification-policy.yml");
  assert.ok(harness.systemPromptText.trim().length > 0);
  assert.ok(harness.toolSurfaceDigest.startsWith("sha256:"));
  assert.ok(harness.editableSurfaces.length >= 4);
});

test("h0 tool surface 恰好三个工具：shop_search/shop_click/shop_finish", () => {
  const harness = loadHarness(H0_DIR);
  assert.deepEqual(
    harness.toolSurface.tools.map((tool) => tool.name).sort(),
    ["shop_click", "shop_finish", "shop_search"],
  );
  assert.deepEqual(
    harness.toolSurface.tools.map((tool) => tool.primitive).sort(),
    ["click", "finish", "search"],
  );
  // h0 不含高层语义工具
  const text = JSON.stringify(harness.toolSurface);
  for (const legacy of ["open_product", "select_option", "buy_now", "next_page", "view_description"]) {
    assert.ok(!text.includes(legacy), `h0 不应包含 ${legacy}`);
  }
});

test("tool surface digest 稳定且随内容变化", () => {
  const harness = loadHarness(H0_DIR);
  assert.equal(computeToolSurfaceDigest(harness.toolSurface), harness.toolSurfaceDigest);
  const modified = {
    ...harness.toolSurface,
    tools: harness.toolSurface.tools.filter((tool) => tool.name !== "shop_finish"),
  };
  assert.notEqual(computeToolSurfaceDigest(modified), harness.toolSurfaceDigest);
});

// ---- 冻结 primitive 映射 ------------------------------------------------------

test("三个 primitive 固定映射到原生动作语言", () => {
  assert.equal(
    primitiveToEnvironmentAction("search", { query: "乳胶枕头" }, { query: "query" }),
    "search[乳胶枕头]",
  );
  assert.equal(
    primitiveToEnvironmentAction("click", { target: "B0PILLOW01" }, { target: "target" }),
    "click[B0PILLOW01]",
  );
  assert.equal(
    primitiveToEnvironmentAction("finish", { reason: "no_suitable_product" }, { reason: "reason" }),
    "finish[no_suitable_product]",
  );
});

test("primitive 参数文法防护：方括号/换行/首尾空白/超长被拒绝", () => {
  for (const bad of ["a]b", "a[b", "a\nb", " padded", "x".repeat(401)]) {
    assert.throws(
      () => primitiveToEnvironmentAction("search", { query: bad }, { query: "query" }),
      HarnessLoadError,
      `query=${bad.slice(0, 10)}`,
    );
    assert.throws(
      () => primitiveToEnvironmentAction("click", { target: bad }, { target: "target" }),
      HarnessLoadError,
    );
  }
  assert.throws(() => assertSafeActionArg("", "target"), HarnessLoadError);
});

test("finish primitive 只接受 no_suitable_product", () => {
  assert.throws(
    () => primitiveToEnvironmentAction("finish", { reason: "bored" }, { reason: "reason" }),
    HarnessLoadError,
  );
});

test("FROZEN_PRIMITIVES 枚举恰好三个且不可扩展", () => {
  assert.deepEqual([...FROZEN_PRIMITIVES], ["search", "click", "finish"]);
});

// ---- surface 参数校验 ---------------------------------------------------------

test("validateSurfaceToolArgs：严格拒绝额外参数与非法取值", () => {
  const harness = loadHarness(H0_DIR);
  const byName = new Map(harness.toolSurface.tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(validateSurfaceToolArgs(byName.get("shop_search")!, { query: "枕头" }), []);
  assert.ok(validateSurfaceToolArgs(byName.get("shop_search")!, { query: "枕头", extra: 1 })
    .some((problem) => problem.includes("额外参数")));
  assert.ok(validateSurfaceToolArgs(byName.get("shop_search")!, {})
    .some((problem) => problem.includes("query")));
  assert.ok(validateSurfaceToolArgs(byName.get("shop_search")!, { query: 123 })
    .some((problem) => problem.includes("字符串")));
  assert.ok(validateSurfaceToolArgs(byName.get("shop_search")!, { query: "x".repeat(201) })
    .some((problem) => problem.includes("超过")));
  assert.ok(validateSurfaceToolArgs(byName.get("shop_finish")!, { reason: "other" })
    .some((problem) => problem.includes("允许列表")));
  assert.deepEqual(
    validateSurfaceToolArgs(byName.get("shop_finish")!, { reason: "no_suitable_product" }),
    [],
  );
});

// ---- 非法 harness 内容拒绝（临时目录构造） -------------------------------------

function writeHarnessDir(dir: string, overrides: {
  toolSurface?: string;
  harness?: string;
}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "harness.yml"), overrides.harness ?? `schema_version: 1
harness_id: shopping-test
parent_harness: null
version: "0.0.1"
system_prompt: system-prompt.md
tool_surface: tool-surface.yml
runtime_policy: runtime-policy.yml
verification_policy: verification-policy.yml
editable_surfaces:
  - tool-surface.yml
`, "utf-8");
  writeFileSync(join(dir, "system-prompt.md"), "test prompt\n", "utf-8");
  writeFileSync(join(dir, "tool-surface.yml"), overrides.toolSurface ?? `schema_version: 1
tools:
  - name: shop_search
    primitive: search
    description: d
    parameters:
      - name: query
        type: string
        required: true
    binding:
      query: query
`, "utf-8");
  writeFileSync(join(dir, "runtime-policy.yml"), `schema_version: 1
max_environment_steps: 10
max_consecutive_guard_rejections: 2
on_tool_error: terminate_run
on_max_steps: terminate_run
on_environment_done: terminate_run
`, "utf-8");
  writeFileSync(join(dir, "verification-policy.yml"), `schema_version: 1
completion_requires_environment_done: true
reward_only_in_evaluator_record: true
actor_sees_reward: false
finish_equals_success: false
evaluator_feedback_into_same_rollout: false
`, "utf-8");
}

test("未知 primitive 被拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  try {
    writeHarnessDir(dir, {
      toolSurface: `schema_version: 1
tools:
  - name: shop_buy
    primitive: buy
    description: d
    parameters: []
    binding: {}
`,
    });
    assert.throws(() => loadHarness(dir), /未知 primitive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binding 未绑定 primitive 唯一参数被拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  try {
    writeHarnessDir(dir, {
      toolSurface: `schema_version: 1
tools:
  - name: shop_search
    primitive: search
    description: d
    parameters:
      - name: query
        type: string
        required: true
    binding:
      query: wrong_target
`,
    });
    assert.throws(() => loadHarness(dir), /binding/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("放宽 verification-policy 冻结边界的 harness 被拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  try {
    writeHarnessDir(dir, {});
    writeFileSync(join(dir, "verification-policy.yml"), `schema_version: 1
completion_requires_environment_done: true
reward_only_in_evaluator_record: false
actor_sees_reward: true
finish_equals_success: false
evaluator_feedback_into_same_rollout: false
`, "utf-8");
    assert.throws(() => loadHarness(dir), /冻结边界/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness.yml 引用的文件缺失时报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  try {
    writeHarnessDir(dir, {});
    rmSync(join(dir, "tool-surface.yml"));
    assert.throws(() => loadHarness(dir), HarnessLoadError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- h0 system prompt 与步数配置 ----------------------------------------------

test("h0 system prompt 最小化：无旧工具名、无复杂策略", () => {
  const harness = loadHarness(H0_DIR);
  const prompt = harness.systemPromptText;
  for (const legacy of [
    "search_products", "open_product", "select_option", "buy_now",
    "next_page", "prev_page", "back_to_search",
    "view_description", "view_features", "view_reviews", "view_attributes",
    "finish_without_purchase",
  ]) {
    assert.ok(!prompt.includes(legacy), `prompt 不应包含旧工具名 ${legacy}`);
  }
  for (const strategy of ["品牌", "预算优先", "防循环", "恢复策略", "最佳候选", "工作流"]) {
    assert.ok(!prompt.includes(strategy), `prompt 不应注入具体策略: ${strategy}`);
  }
  // 必含的最小规则
  for (const required of ["任务文本由初始 user prompt 提供", "shop_click", "一次只调用一个工具"]) {
    assert.ok(prompt.includes(required), `prompt 缺少: ${required}`);
  }
});

test("步数配置分离：smoke 配置 5 步，h0 runtime-policy 35 步", () => {
  const harness = loadHarness(H0_DIR);
  assert.equal(harness.runtimePolicy.maxEnvironmentSteps, 35);

  // live smoke 配置仍是 5 步（single-case smoke，不是正式 benchmark）
  const smokeConfig = readFileSync(
    join(REPO_ROOT, "configs", "live-task.example.yml"),
    "utf-8",
  );
  assert.match(smokeConfig, /max_environment_steps:\s*5/);
  assert.match(smokeConfig, /shop_search/);
});
