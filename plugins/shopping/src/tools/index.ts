/**
 * tools 模块出口（冻结层）。
 */

export {
  GuardRejectionError,
  checkPrimitiveCall,
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
