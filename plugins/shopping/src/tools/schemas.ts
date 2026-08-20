/**
 * 12 个 model-facing 购物工具的冻结 schema（冻结层）。
 *
 * 严格 JSON Schema 为唯一事实来源：additionalProperties: false，
 * 禁止额外参数。register.ts 负责转换为 DSH 注册形态。
 * 描述文本只说明工具语义与安全约束，不含任务 goal 或策略。
 */

import type { ShoppingToolName } from "./actions.ts";

export interface ToolJsonSchema {
  type: "object";
  properties: Record<string, {
    type: "string";
    description: string;
    minLength?: number;
    maxLength?: number;
    enum?: readonly string[];
  }>;
  required: readonly string[];
  additionalProperties: false;
}

export interface ShoppingToolDefinition {
  name: ShoppingToolName;
  description: string;
  parameters: ToolJsonSchema;
}

function noArgSchema(): ShoppingToolDefinition["parameters"] {
  return { type: "object", properties: {}, required: [], additionalProperties: false };
}

export const SEARCH_PRODUCTS_TOOL: ShoppingToolDefinition = {
  name: "search_products",
  description: "在商品库中按关键词搜索商品，返回结果页。参数 query 为搜索关键词。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词（不允许包含方括号或换行）。",
        minLength: 1,
        maxLength: 400,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const OPEN_PRODUCT_TOOL: ShoppingToolDefinition = {
  name: "open_product",
  description:
    "打开当前结果页中可见的某个商品详情页。参数 asin 必须是当前页面可见的商品标识。",
  parameters: {
    type: "object",
    properties: {
      asin: {
        type: "string",
        description: "商品 ID（asin），必须来自当前可见的搜索结果。",
        minLength: 1,
        maxLength: 400,
      },
    },
    required: ["asin"],
    additionalProperties: false,
  },
};

export const SELECT_OPTION_TOOL: ShoppingToolDefinition = {
  name: "select_option",
  description:
    "在商品详情页选择一个规格选项（如颜色、尺码）。参数 value 必须是当前页面可见的选项值。",
  parameters: {
    type: "object",
    properties: {
      value: {
        type: "string",
        description: "选项值，必须来自当前页面可见选项。",
        minLength: 1,
        maxLength: 400,
      },
    },
    required: ["value"],
    additionalProperties: false,
  },
};

export const VIEW_DESCRIPTION_TOOL: ShoppingToolDefinition = {
  name: "view_description",
  description: "在商品详情页查看 Description 子页。要求当前页面存在 Description 按钮。",
  parameters: noArgSchema(),
};

export const VIEW_FEATURES_TOOL: ShoppingToolDefinition = {
  name: "view_features",
  description: "在商品详情页查看 Features 子页。要求当前页面存在 Features 按钮。",
  parameters: noArgSchema(),
};

export const VIEW_REVIEWS_TOOL: ShoppingToolDefinition = {
  name: "view_reviews",
  description: "在商品详情页查看 Reviews 子页。要求当前页面存在 Reviews 按钮。",
  parameters: noArgSchema(),
};

export const VIEW_ATTRIBUTES_TOOL: ShoppingToolDefinition = {
  name: "view_attributes",
  description: "在商品详情页查看 Attributes 子页。要求当前页面存在 Attributes 按钮。",
  parameters: noArgSchema(),
};

export const NEXT_PAGE_TOOL: ShoppingToolDefinition = {
  name: "next_page",
  description: "在结果页翻到下一页。要求当前页面存在 Next 按钮。",
  parameters: noArgSchema(),
};

export const PREV_PAGE_TOOL: ShoppingToolDefinition = {
  name: "prev_page",
  description: "在结果页翻到上一页。要求当前页面存在 Prev 按钮。",
  parameters: noArgSchema(),
};

export const BACK_TO_SEARCH_TOOL: ShoppingToolDefinition = {
  name: "back_to_search",
  description: "返回搜索首页（不清除已探索进度）。要求当前页面存在 Back to Search 按钮。",
  parameters: noArgSchema(),
};

export const BUY_NOW_TOOL: ShoppingToolDefinition = {
  name: "buy_now",
  description:
    "购买当前商品。购买前必须已选择全部必需规格；要求当前页面存在 Buy Now 按钮。",
  parameters: noArgSchema(),
};

export const FINISH_WITHOUT_PURCHASE_TOOL: ShoppingToolDefinition = {
  name: "finish_without_purchase",
  description:
    "在未找到合适商品时结束本次购物（不购买）。reason 只能是 no_suitable_product。",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "结束原因。",
        enum: ["no_suitable_product"],
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

export const SHOPPING_TOOLS: readonly ShoppingToolDefinition[] = [
  SEARCH_PRODUCTS_TOOL,
  OPEN_PRODUCT_TOOL,
  SELECT_OPTION_TOOL,
  VIEW_DESCRIPTION_TOOL,
  VIEW_FEATURES_TOOL,
  VIEW_REVIEWS_TOOL,
  VIEW_ATTRIBUTES_TOOL,
  NEXT_PAGE_TOOL,
  PREV_PAGE_TOOL,
  BACK_TO_SEARCH_TOOL,
  BUY_NOW_TOOL,
  FINISH_WITHOUT_PURCHASE_TOOL,
];

/** 校验一段 JSON 值是否符合某工具的参数 schema（严格：禁止额外键）。 */
export function validateToolArgs(
  tool: ShoppingToolDefinition,
  args: unknown,
): string[] {
  const problems: string[] = [];
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return ["参数必须是 JSON 对象"];
  }
  const record = args as Record<string, unknown>;
  const declared = new Set(Object.keys(tool.parameters.properties));
  for (const key of Object.keys(record)) {
    if (!declared.has(key)) {
      problems.push(`禁止的额外参数: ${key}`);
    }
  }
  for (const requiredKey of tool.parameters.required) {
    if (!(requiredKey in record)) {
      problems.push(`缺少必填参数: ${requiredKey}`);
    }
  }
  for (const [key, spec] of Object.entries(tool.parameters.properties)) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      problems.push(`参数 ${key} 必须是字符串`);
      continue;
    }
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      problems.push(`参数 ${key} 长度不足 ${spec.minLength}`);
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      problems.push(`参数 ${key} 超过 ${spec.maxLength} 字符`);
    }
    if (spec.enum !== undefined && !spec.enum.includes(value)) {
      problems.push(`参数 ${key} 取值不在允许列表: ${spec.enum.join(", ")}`);
    }
  }
  return problems;
}
