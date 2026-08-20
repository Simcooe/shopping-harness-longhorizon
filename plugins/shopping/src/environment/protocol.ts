/**
 * ShopSimulator `/api/shop_agent` 协议类型与运行时校验（冻结层）。
 *
 * 只暴露 plugin actor 所需的最小公共字段；goal、gold、Reward 明细、
 * 完整 observation 与商品数据一律不进入本层类型，也不进入校验输出。
 */

/** 服务端 error 字符串保留上限：避免异常文本携带大段响应内容。 */
export const MAX_SERVER_ERROR_CHARS = 200;

// ---------------------------------------------------------------------------
// 请求载荷（发往 POST {baseUrl}/api/shop_agent 的 JSON body）
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
// Actor-safe 响应字段（服务端其余字段一律丢弃）
// ---------------------------------------------------------------------------

export interface ResetResult {
  /** 租约 slot，后续 interact/release 必须携带。 */
  envIdx: number;
  /** 环境版本标记，可空。 */
  environmentVersion: string | null;
  /** 服务端消息，可空。 */
  message: string | null;
}

export interface InteractResult {
  envIdx: number;
  /** 环境判定本任务结束（购买完成或终止策略触发）。 */
  done: boolean;
  /** 会话历史超限或 done。 */
  over: boolean;
}

export interface ReleaseResult {
  message: string;
}

// ---------------------------------------------------------------------------
// 运行时校验：不抛异常，返回判别式结果，由 client 层决定错误类型
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

/** 提取服务端 error 响应；无 error 返回 null。内容截断，避免大文本扩散。 */
export function extractServerError(
  result: Record<string, unknown>,
): string | null {
  const error = result["error"];
  if (typeof error !== "string") {
    return null;
  }
  return error.slice(0, MAX_SERVER_ERROR_CHARS);
}

/** 校验 reset 的 result；只保留 actor-safe 字段。 */
export function parseResetResult(
  result: Record<string, unknown>,
): ParseOutcome<ResetResult> {
  if (!isInteger(result["env_idx"])) {
    return fail("reset 响应缺少有效的 env_idx（整数）");
  }
  const envIdx = result["env_idx"];
  const version = result["environment_version"];
  const message = result["message"];
  return {
    ok: true,
    value: {
      envIdx,
      environmentVersion: typeof version === "string" ? version : null,
      message: typeof message === "string" ? message : null,
    },
  };
}

/** 校验 interact 的 result；只保留 actor-safe 字段。 */
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
    },
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
