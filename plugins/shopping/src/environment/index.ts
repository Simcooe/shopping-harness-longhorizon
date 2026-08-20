/**
 * environment adapter 公共出口（冻结层）。
 * 未来只有 tools 层可以把模型工具调用映射为 search[...]/click[...]/finish[...]
 * 并通过本层发送；本层自身不做任何 action mapping。
 */

export {
  DEFAULT_SHOPSIM_BASE_URL,
  SHOP_AGENT_PATH,
  ShopSimulatorAdapterError,
  ShopSimulatorHttpClient,
  ShopSimNetworkError,
  ShopSimHttpError,
  ShopSimProtocolError,
  ShopSimEnvironmentError,
  type ShopSimulatorHttpClientOptions,
} from "./client.ts";

export {
  parseEnvelope,
  extractServerError,
  parseResetResult,
  parseInteractResult,
  parseReleaseResult,
  MAX_SERVER_ERROR_CHARS,
  type InteractRequest,
  type InteractResult,
  type ParseOutcome,
  type ReleaseOneRequest,
  type ReleaseResult,
  type ResetRequest,
  type ResetResult,
  type ShopAgentRequest,
} from "./protocol.ts";

export {
  ShoppingEnvironmentSession,
  ShoppingSessionStateError,
  withShoppingSession,
} from "./session.ts";
