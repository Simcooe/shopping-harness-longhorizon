/**
 * ShopSimulator `/api/shop_agent` 协议类型与运行时校验（冻结层）。
 *
 * 双通道设计（Phase 6）：
 *   - actor 通道：模型可见内容（任务指令、页面观测、状态），进入工具结果
 *     与 actor trace；
 *   - evaluator 通道：reward / reward_detail / purchase / termination 等
 *     结果证据，只流向 evaluation/runs/ 的 evaluator record，**绝不**进入
 *     工具结果、prompt 或 DSH session。
 *
 * 隐藏字段（goal、goal_options、reward、reward_detail、purchase、gold、
 * user_persona 等）永远不进入 actor 通道；白名单 + 递归剔除双保险。
 */

/** 服务端 error 字符串保留上限：避免异常文本携带大段响应内容。 */
export const MAX_SERVER_ERROR_CHARS = 200;

/** actor 通道绝对禁止的键（递归剔除）。 */
export const ACTOR_FORBIDDEN_KEYS = [
  "reward",
  "reward_detail",
  "reward_valid",
  "goal",
  "goal_options",
  "purchase",
  "gold",
  "user_persona",
  "reason_key",
  "verbose_info",
  "instruction_simple",
  "termination_reason",
  "api_key",
  "authorization",
] as const;

/** actor 观测文本上限（模型可见页面内容的截断长度）。 */
export const MAX_ACTOR_TEXT_CHARS = 4000;

// ---------------------------------------------------------------------------
// 请求载荷
// ---------------------------------------------------------------------------

export interface ResetRequest {
  action: "reset";
  idx: number;
}

export interface InteractRequest {
  action: "interact";
  env_idx: number;
  response: string;
}

export interface ReleaseOneRequest {
  action: "release_one";
  env_idx: number;
}

export type ShopAgentRequest =
  | ResetRequest
  | InteractRequest
  | ReleaseOneRequest;

// ---------------------------------------------------------------------------
// Actor-safe 响应字段
// ---------------------------------------------------------------------------

/** 模型可见的任务指令（reset 时一次性可见）。 */
export interface TaskInstruction {
  instructionText: string;
}

/**
 * 模型可见的结构化页面观测（环境 observation_state 本身就是
 * answer-free 设计，这里再做一次防御性剔除与类型归一）。
 */
export interface ActorObservation {
  pageType: string;
  searchAvailable: boolean;
  /** 当前页面可点击项（含商品 asin、选项值、导航按钮）。 */
  clickables: string[];
  /** 脱敏后的完整 observation_state。 */
  state: Record<string, unknown>;
}

export interface ResetResult {
  envIdx: number;
  environmentVersion: string | null;
  message: string | null;
  /** 用户任务文本（模型可见）。 */
  task: TaskInstruction | null;
  observation: ActorObservation | null;
}

export interface InteractResult {
  envIdx: number;
  done: boolean;
  over: boolean;
  observation: ActorObservation | null;
}

export interface ReleaseResult {
  message: string;
}

// ---------------------------------------------------------------------------
// Evaluator-only 通道（绝不进入 actor 通道）
// ---------------------------------------------------------------------------

export interface EvaluatorOutcome {
  done: boolean;
  reward: number | null;
  rewardValid: boolean | null;
  terminationReason: string | null;
  /** reward 明细（evaluator 专用）。 */
  rewardDetail: Record<string, unknown> | null;
  /** 成交商品 asin（evaluator 专用）。 */
  purchaseAsin: string | null;
}

// ---------------------------------------------------------------------------
// 运行时校验
// ---------------------------------------------------------------------------

export type ParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** 递归剔除 actor 禁止键（白名单之外的第二道防线）。 */
export function stripActorForbidden(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripActorForbidden(entry, depth + 1));
  }
  if (isObject(value)) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if ((ACTOR_FORBIDDEN_KEYS as readonly string[]).includes(key.toLowerCase())) {
        continue;
      }
      cleaned[key] = stripActorForbidden(entry, depth + 1);
    }
    return cleaned;
  }
  return value;
}

/**
 * observation_state 的**白名单**键（与固定环境 observation.py 的公开
 * 字段一一对应）；任何未列出的键（包括未来服务端新增的未知字段）
 * 都不会进入 actor 通道。
 */
const OBSERVATION_STATE_KEYS = [
  "observation_version",
  "page_type",
  "search_available",
  "actions",
  "query",
  "normalized_query",
  "page",
  "total_pages",
  "total_results",
  "rank_start",
  "rank_end",
  "products",
  "product",
  "selected_options",
  "available_options",
  "selected_price",
  "subpage",
  "content",
] as const;

/** 商品摘要条目的白名单键。 */
const PRODUCT_SUMMARY_KEYS = [
  "asin",
  "title",
  "brand",
  "category",
  "price",
  "key_attributes",
  "rank",
] as const;

function whitelistKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in record) {
      cleaned[key] = record[key];
    }
  }
  return cleaned;
}

function sanitizeProductEntry(entry: unknown): unknown {
  if (!isObject(entry)) {
    return null;
  }
  return whitelistKeys(entry, PRODUCT_SUMMARY_KEYS);
}

/** 从 observation_state 构建 actor 观测；缺失或类型不符返回 null。 */
export function parseActorObservation(raw: unknown): ActorObservation | null {
  if (!isObject(raw)) {
    return null;
  }
  const state = whitelistKeys(raw, OBSERVATION_STATE_KEYS);
  // 商品列表与子页内容做二次净化
  if (Array.isArray(state["products"])) {
    state["products"] = (state["products"] as unknown[]).map(sanitizeProductEntry);
  }
  if (isObject(state["product"])) {
    state["product"] = sanitizeProductEntry(state["product"]);
  }
  if (typeof state["content"] === "string") {
    state["content"] = (state["content"] as string).slice(0, MAX_ACTOR_TEXT_CHARS);
  }
  const actions = state["actions"];
  return {
    pageType: typeof state["page_type"] === "string" ? state["page_type"] : "unknown",
    searchAvailable: state["search_available"] === true,
    clickables: Array.isArray(actions)
      ? actions.filter((entry): entry is string => typeof entry === "string")
      : [],
    state,
  };
}

/** 校验 HTTP body 顶层结构，返回其中的 result 对象。 */
export function parseEnvelope(body: unknown): ParseOutcome<Record<string, unknown>> {
  if (!isObject(body)) {
    return fail("HTTP body 不是 JSON 对象");
  }
  const result = body["result"];
  if (!isObject(result)) {
    return fail("HTTP body 缺少 result 对象");
  }
  return { ok: true, value: result };
}

/** 提取服务端 error 响应；无 error 返回 null。内容截断。 */
export function extractServerError(
  result: Record<string, unknown>,
): string | null {
  const error = result["error"];
  if (typeof error !== "string") {
    return null;
  }
  return error.slice(0, MAX_SERVER_ERROR_CHARS);
}

/** 校验 reset 的 result（actor 通道）。 */
export function parseResetResult(
  result: Record<string, unknown>,
): ParseOutcome<ResetResult> {
  if (!isInteger(result["env_idx"])) {
    return fail("reset 响应缺少有效的 env_idx（整数）");
  }
  const instruction = result["instruction"];
  const version = result["environment_version"];
  const message = result["message"];
  return {
    ok: true,
    value: {
      envIdx: result["env_idx"],
      environmentVersion: typeof version === "string" ? version : null,
      message: typeof message === "string" ? message : null,
      task: typeof instruction === "string" && instruction.length > 0
        ? { instructionText: instruction.slice(0, MAX_ACTOR_TEXT_CHARS) }
        : null,
      observation: parseActorObservation(result["observation_state"]),
    },
  };
}

/** 校验 interact 的 result（actor 通道）。 */
export function parseInteractResult(
  result: Record<string, unknown>,
): ParseOutcome<InteractResult> {
  if (!isInteger(result["env_idx"])) {
    return fail("interact 响应缺少有效的 env_idx（整数）");
  }
  if (typeof result["done"] !== "boolean") {
    return fail("interact 响应缺少布尔 done");
  }
  if (typeof result["over"] !== "boolean") {
    return fail("interact 响应缺少布尔 over");
  }
  return {
    ok: true,
    value: {
      envIdx: result["env_idx"],
      done: result["done"],
      over: result["over"],
      observation: parseActorObservation(result["observation_state"]),
    },
  };
}

/**
 * 提取 evaluator-only 结果证据（仅 done 时存在）。
 * 本函数的输出绝不允许进入 actor 通道。
 */
export function parseEvaluatorOutcome(
  result: Record<string, unknown>,
): EvaluatorOutcome | null {
  if (result["done"] !== true) {
    return null;
  }
  const reward = result["reward"];
  const rewardDetail = result["reward_detail"];
  const purchase = result["purchase"];
  return {
    done: true,
    reward: typeof reward === "number" ? reward : null,
    rewardValid: typeof result["reward_valid"] === "boolean"
      ? result["reward_valid"]
      : null,
    terminationReason: typeof result["termination_reason"] === "string"
      ? result["termination_reason"]
      : null,
    rewardDetail: isObject(rewardDetail)
      ? rewardDetail as Record<string, unknown>
      : null,
    purchaseAsin: isObject(purchase) && typeof purchase["asin"] === "string"
      ? purchase["asin"] as string
      : null,
  };
}

/** 校验 release_one 的 result。 */
export function parseReleaseResult(
  result: Record<string, unknown>,
): ParseOutcome<ReleaseResult> {
  if (typeof result["message"] !== "string") {
    return fail("release_one 响应缺少 message");
  }
  return { ok: true, value: { message: result["message"] } };
}
