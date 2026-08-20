/**
 * ShopSimulator HTTP client（冻结层）。
 *
 * 只依赖 Node 原生 fetch；不读取任何 API key。地址来自显式构造参数或
 * 环境变量 SHOPSIM_BASE_URL（默认 http://127.0.0.1:5700）。
 *
 * 错误分类（消息中不包含响应体内容，避免泄漏 goal/observation 等数据）：
 *   - ShopSimNetworkError   网络层失败（连接拒绝、超时等）
 *   - ShopSimHttpError      HTTP 非成功状态码
 *   - ShopSimProtocolError  响应不是合法 JSON / 不符合协议
 *   - ShopSimEnvironmentError  服务端返回 result.error
 */

import {
  extractServerError,
  parseEnvelope,
  parseInteractResult,
  parseReleaseResult,
  parseResetResult,
  type InteractResult,
  type ReleaseResult,
  type ResetResult,
  type ShopAgentRequest,
} from "./protocol.ts";

export const DEFAULT_SHOPSIM_BASE_URL = "http://127.0.0.1:5700";
export const SHOP_AGENT_PATH = "/api/shop_agent";
const DEFAULT_TIMEOUT_MS = 120_000;

export class ShopSimulatorAdapterError extends Error {
  readonly code: "network" | "http" | "protocol" | "environment";

  constructor(code: ShopSimulatorAdapterError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 网络层失败：连接拒绝、DNS、超时等。 */
export class ShopSimNetworkError extends ShopSimulatorAdapterError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("network", message, options);
  }
}

/** HTTP 响应状态码非成功。 */
export class ShopSimHttpError extends ShopSimulatorAdapterError {
  readonly status: number;

  constructor(status: number, options?: { cause?: unknown }) {
    super("http", `ShopSimulator 返回 HTTP ${status}`, options);
    this.status = status;
  }
}

/** 响应体不是合法 JSON 或不符合协议结构。 */
export class ShopSimProtocolError extends ShopSimulatorAdapterError {
  constructor(reason: string) {
    super("protocol", `ShopSimulator 协议无效: ${reason}`);
  }
}

/** 服务端在 result.error 中返回错误。 */
export class ShopSimEnvironmentError extends ShopSimulatorAdapterError {
  constructor(serverMessage: string) {
    super("environment", `ShopSimulator 环境错误: ${serverMessage}`);
  }
}

export interface ShopSimulatorHttpClientOptions {
  /** 测试注入用；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时，毫秒。 */
  timeoutMs?: number;
}

export class ShopSimulatorHttpClient {
  readonly baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, options: ShopSimulatorHttpClientOptions = {}) {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]/.test(trimmed)) {
      throw new ShopSimProtocolError(`非法 baseUrl: 只接受 http(s):// 地址`);
    }
    this.baseUrl = trimmed;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 从环境变量构造；只读 SHOPSIM_BASE_URL，绝不读取任何 API key。 */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    options: ShopSimulatorHttpClientOptions = {},
  ): ShopSimulatorHttpClient {
    const configured = env["SHOPSIM_BASE_URL"]?.trim();
    return new ShopSimulatorHttpClient(
      configured && configured.length > 0 ? configured : DEFAULT_SHOPSIM_BASE_URL,
      options,
    );
  }

  /** reset：领取任务与租约 slot。 */
  async reset(taskId: number): Promise<ResetResult> {
    const result = await this.#post({ action: "reset", idx: taskId });
    const parsed = parseResetResult(result);
    if (!parsed.ok) {
      throw new ShopSimProtocolError(parsed.reason);
    }
    return parsed.value;
  }

  /** interact：在已领取的 slot 上执行一步动作。 */
  async interact(envIdx: number, action: string): Promise<InteractResult> {
    const result = await this.#post({
      action: "interact",
      env_idx: envIdx,
      response: action,
    });
    const parsed = parseInteractResult(result);
    if (!parsed.ok) {
      throw new ShopSimProtocolError(parsed.reason);
    }
    return parsed.value;
  }

  /** release_one：归还租约 slot。 */
  async releaseOne(envIdx: number): Promise<ReleaseResult> {
    const result = await this.#post({ action: "release_one", env_idx: envIdx });
    const parsed = parseReleaseResult(result);
    if (!parsed.ok) {
      throw new ShopSimProtocolError(parsed.reason);
    }
    return parsed.value;
  }

  async #post(request: ShopAgentRequest): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${SHOP_AGENT_PATH}`;
    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new ShopSimNetworkError(
        `无法连接 ShopSimulator (${url})`,
        { cause },
      );
    }

    if (!response.ok) {
      // 丢弃响应体：错误消息不携带任何响应内容
      await response.body?.cancel().catch(() => undefined);
      throw new ShopSimHttpError(response.status);
    }

    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch (cause) {
      throw new ShopSimProtocolError("响应不是合法 JSON");
    }

    const envelope = parseEnvelope(body);
    if (!envelope.ok) {
      throw new ShopSimProtocolError(envelope.reason);
    }
    const serverError = extractServerError(envelope.value);
    if (serverError !== null) {
      throw new ShopSimEnvironmentError(serverError);
    }
    return envelope.value;
  }
}
