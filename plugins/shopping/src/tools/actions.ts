/**
 * 购物工具 → ShopSimulator 环境 action 的固定映射（冻结层）。
 *
 * 唯一职责：三个 model-facing 工具到环境 action 字符串的一一映射。
 *   search_products        → search[<query>]
 *   open_product           → click[<asin>]
 *   finish_without_purchase → finish[no_suitable_product]
 *
 * 本文件为冻结层：未来 Self-Harness 不得修改。
 */

export const SHOPPING_TOOL_NAMES = [
  "search_products",
  "open_product",
  "finish_without_purchase",
] as const;

export type ShoppingToolName = (typeof SHOPPING_TOOL_NAMES)[number];

export interface SearchProductsArgs {
  query: string;
}

export interface OpenProductArgs {
  asin: string;
}

export type FinishReason = "no_suitable_product";

export interface FinishWithoutPurchaseArgs {
  reason: FinishReason;
}

export type ShoppingToolArgs =
  | SearchProductsArgs
  | OpenProductArgs
  | FinishWithoutPurchaseArgs;

/** 映射层错误：非法工具名或参数内容会破坏环境 action 文法。 */
export class ActionMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionMappingError";
  }
}

/**
 * action 参数内容校验：环境用 `name[arg]` 文法解析动作，
 * 参数里出现方括号、换行或首尾空白都会改变解析结果，一律拒绝。
 */
function assertSafeActionArg(arg: string, label: string): void {
  if (typeof arg !== "string" || arg.length === 0) {
    throw new ActionMappingError(`${label} 必须是非空字符串`);
  }
  if (arg.trim() !== arg) {
    throw new ActionMappingError(`${label} 不允许首尾空白`);
  }
  if (/[[\]\r\n]/.test(arg)) {
    throw new ActionMappingError(`${label} 不允许包含方括号或换行`);
  }
  const MAX_ARG_CHARS = 400;
  if (arg.length > MAX_ARG_CHARS) {
    throw new ActionMappingError(`${label} 超过 ${MAX_ARG_CHARS} 字符上限`);
  }
}

export function isShoppingToolName(name: string): name is ShoppingToolName {
  return (SHOPPING_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 固定映射（纯函数）。未知工具名或非法参数抛出 ActionMappingError。
 * 未来 Self-Harness 不得修改本映射。
 */
export function toEnvironmentAction(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "search_products": {
      const query = args["query"];
      if (typeof query !== "string") {
        throw new ActionMappingError("search_products 需要字符串参数 query");
      }
      assertSafeActionArg(query, "query");
      return `search[${query}]`;
    }
    case "open_product": {
      const asin = args["asin"];
      if (typeof asin !== "string") {
        throw new ActionMappingError("open_product 需要字符串参数 asin");
      }
      assertSafeActionArg(asin, "asin");
      return `click[${asin}]`;
    }
    case "finish_without_purchase": {
      const reason = args["reason"];
      if (reason !== "no_suitable_product") {
        throw new ActionMappingError(
          "finish_without_purchase 的 reason 只能是 no_suitable_product",
        );
      }
      return "finish[no_suitable_product]";
    }
    default:
      throw new ActionMappingError(`未知购物工具: ${toolName}`);
  }
}
