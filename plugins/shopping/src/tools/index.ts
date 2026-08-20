/**
 * tools 模块出口（冻结层）。
 */

export {
  ActionMappingError,
  SHOPPING_TOOL_NAMES,
  isShoppingToolName,
  toEnvironmentAction,
  type FinishReason,
  type FinishWithoutPurchaseArgs,
  type OpenProductArgs,
  type SearchProductsArgs,
  type ShoppingToolArgs,
  type ShoppingToolName,
} from "./actions.ts";

export {
  FINISH_WITHOUT_PURCHASE_TOOL,
  OPEN_PRODUCT_TOOL,
  SEARCH_PRODUCTS_TOOL,
  SHOPPING_TOOLS,
  validateToolArgs,
  type ShoppingToolDefinition,
  type ToolJsonSchema,
} from "./schemas.ts";

export { ShoppingRuntime, type ShoppingRuntimeOptions } from "./runtime.ts";

export {
  buildShoppingToolDefinitions,
  registerShoppingTools,
  type DshContentBlock,
  type DshJsonValue,
  type DshToolDefinition,
  type DshToolOutputDefinition,
  type DshToolRegistryLike,
  type DshToolRunContextLike,
  type DshTextBlock,
  type ShoppingToolOutput,
} from "./register.ts";
