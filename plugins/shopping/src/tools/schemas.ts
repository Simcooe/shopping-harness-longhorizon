/**
 * 三个 model-facing 购物工具的冻结 schema（冻结层）。
 *
 * 以严格 JSON Schema 为唯一事实来源：additionalProperties: false，
 * 所有参数必填，禁止额外参数。register.ts 负责把它转换成 DSH 工具
 * 注册所需的形态，不在此处引入 DSH 依赖。
 *
 * 描述文本只说明工具语义与安全约束，不包含任何任务 goal 或策略。
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
    pattern?: string;
  }>;
  required: readonly string[];
  additionalProperties: false;
}

export interface ShoppingToolDefinition {
  name: ShoppingToolName;
  description: string;
  parameters: ToolJsonSchema;
}

export const SEARCH_PRODUCTS_TOOL: ShoppingToolDefinition = {
  name: "search_products",
  description:
    "在商品库中按关键词搜索商品，返回结果页。参数 query 为搜索关键词。",
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
    "打开搜索结果中的某个商品详情页。参数 asin 为目标商品 ID（结果页可见的商品标识）。",
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
