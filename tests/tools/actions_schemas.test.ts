/**
 * 工具映射与 schema 的纯函数测试（冻结层合约）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ActionMappingError,
  SHOPPING_TOOL_NAMES,
  isShoppingToolName,
  toEnvironmentAction,
} from "../../plugins/shopping/src/tools/actions.ts";
import {
  FINISH_WITHOUT_PURCHASE_TOOL,
  OPEN_PRODUCT_TOOL,
  SEARCH_PRODUCTS_TOOL,
  SHOPPING_TOOLS,
  validateToolArgs,
} from "../../plugins/shopping/src/tools/schemas.ts";

// action mapping -------------------------------------------------------------

test("固定映射：search_products → search[query]", () => {
  assert.equal(
    toEnvironmentAction("search_products", { query: "乳胶枕头" }),
    "search[乳胶枕头]",
  );
});

test("固定映射：open_product → click[asin]", () => {
  assert.equal(
    toEnvironmentAction("open_product", { asin: "747848614498" }),
    "click[747848614498]",
  );
});

test("固定映射：finish_without_purchase → finish[no_suitable_product]", () => {
  assert.equal(
    toEnvironmentAction("finish_without_purchase", { reason: "no_suitable_product" }),
    "finish[no_suitable_product]",
  );
});

test("未知工具名被拒绝", () => {
  assert.throws(
    () => toEnvironmentAction("checkout_express", {}),
    ActionMappingError,
  );
});

test("finish 的非法 reason 被拒绝", () => {
  assert.throws(
    () => toEnvironmentAction("finish_without_purchase", { reason: "other" }),
    ActionMappingError,
  );
});

test("参数缺失或类型错误被拒绝", () => {
  assert.throws(() => toEnvironmentAction("search_products", {}), ActionMappingError);
  assert.throws(() => toEnvironmentAction("open_product", { asin: 123 }), ActionMappingError);
});

test("参数包含方括号/换行/首尾空白被拒绝（保护环境 action 文法）", () => {
  for (const bad of ["a]b", "a[b", "a\nb", " padded", "padded "]) {
    assert.throws(
      () => toEnvironmentAction("search_products", { query: bad }),
      ActionMappingError,
    );
  }
});

test("超长参数被拒绝", () => {
  assert.throws(
    () => toEnvironmentAction("search_products", { query: "x".repeat(401) }),
    ActionMappingError,
  );
});

// schemas ---------------------------------------------------------------------

test("恰好 12 个冻结工具，名称固定", () => {
  assert.deepEqual(
    SHOPPING_TOOLS.map((tool) => tool.name),
    [
      "search_products", "open_product", "select_option",
      "view_description", "view_features", "view_reviews", "view_attributes",
      "next_page", "prev_page", "back_to_search", "buy_now",
      "finish_without_purchase",
    ],
  );
  assert.deepEqual([...SHOPPING_TOOL_NAMES], SHOPPING_TOOLS.map((tool) => tool.name));
});

test("所有 schema 都是严格 object 且禁止额外参数", () => {
  for (const tool of SHOPPING_TOOLS) {
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    // 有参数的工具必须声明 required；无参数工具 required 为空
    if (Object.keys(tool.parameters.properties).length > 0) {
      assert.ok(tool.parameters.required.length > 0);
    }
    assert.ok(tool.description.length > 0);
  }
});

test("validateToolArgs 接受合法参数", () => {
  assert.deepEqual(validateToolArgs(SEARCH_PRODUCTS_TOOL, { query: "枕头" }), []);
  assert.deepEqual(validateToolArgs(OPEN_PRODUCT_TOOL, { asin: "B0XYZ" }), []);
  assert.deepEqual(
    validateToolArgs(FINISH_WITHOUT_PURCHASE_TOOL, { reason: "no_suitable_product" }),
    [],
  );
});

test("validateToolArgs 拒绝额外参数（严格 schema）", () => {
  const problems = validateToolArgs(SEARCH_PRODUCTS_TOOL, { query: "枕头", extra: 1 });
  assert.ok(problems.some((problem) => problem.includes("额外参数")));
});

test("validateToolArgs 拒绝缺少必填参数", () => {
  const problems = validateToolArgs(OPEN_PRODUCT_TOOL, {});
  assert.ok(problems.some((problem) => problem.includes("asin")));
});

test("validateToolArgs 拒绝非对象参数与枚举越界", () => {
  assert.deepEqual(validateToolArgs(SEARCH_PRODUCTS_TOOL, "query"), ["参数必须是 JSON 对象"]);
  const problems = validateToolArgs(FINISH_WITHOUT_PURCHASE_TOOL, { reason: "bored" });
  assert.ok(problems.some((problem) => problem.includes("允许列表")));
});

test("isShoppingToolName 判别", () => {
  assert.equal(isShoppingToolName("search_products"), true);
  assert.equal(isShoppingToolName("checkout_express"), false);
});

test("固定映射：其余 9 个无参数/选项工具", () => {
  assert.equal(toEnvironmentAction("select_option", { value: "红色" }), "click[红色]");
  assert.equal(toEnvironmentAction("view_description", {}), "click[Description]");
  assert.equal(toEnvironmentAction("view_features", {}), "click[Features]");
  assert.equal(toEnvironmentAction("view_reviews", {}), "click[Reviews]");
  assert.equal(toEnvironmentAction("view_attributes", {}), "click[Attributes]");
  assert.equal(toEnvironmentAction("next_page", {}), "click[Next >]");
  assert.equal(toEnvironmentAction("prev_page", {}), "click[< Prev]");
  assert.equal(toEnvironmentAction("back_to_search", {}), "click[Back to Search]");
  assert.equal(toEnvironmentAction("buy_now", {}), "click[Buy Now]");
});

test("无参数工具携带参数被拒绝", () => {
  assert.throws(() => toEnvironmentAction("buy_now", { asin: "X" }), ActionMappingError);
  assert.throws(() => toEnvironmentAction("next_page", { page: 2 }), ActionMappingError);
});

test("select_option 参数文法保护", () => {
  assert.throws(() => toEnvironmentAction("select_option", { value: "a]b" }), ActionMappingError);
  assert.throws(() => toEnvironmentAction("select_option", {}), ActionMappingError);
});
