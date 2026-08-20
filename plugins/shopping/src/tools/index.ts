/**
 * tools 模块出口（冻结层）。
 */

export {
  ActionMappingError,
  NO_ARG_TOOL_NAMES,
  SHOPPING_TOOL_NAMES,
  isShoppingToolName,
  toEnvironmentAction,
  type FinishReason,
  type ShoppingToolName,
} from "./actions.ts";

export {
  BUY_NOW_TOOL,
  BACK_TO_SEARCH_TOOL,
  FINISH_WITHOUT_PURCHASE_TOOL,
  NEXT_PAGE_TOOL,
  OPEN_PRODUCT_TOOL,
  PREV_PAGE_TOOL,
  SEARCH_PRODUCTS_TOOL,
  SELECT_OPTION_TOOL,
  SHOPPING_TOOLS,
  VIEW_ATTRIBUTES_TOOL,
  VIEW_DESCRIPTION_TOOL,
  VIEW_FEATURES_TOOL,
  VIEW_REVIEWS_TOOL,
  validateToolArgs,
  type ShoppingToolDefinition,
  type ToolJsonSchema,
} from "./schemas.ts";

export {
  GuardRejectionError,
  checkToolCall,
  visibleOptionValues,
  visibleProductAsins,
  type GuardState,
} from "./guard.ts";

export { MaxStepsError, ShoppingRuntime, type ShoppingRuntimeOptions } from "./runtime.ts";

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
