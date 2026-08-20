/**
 * ShopSimulator 环境会话生命周期（冻结层）：reset → interact* → release。
 *
 * 只维护最小状态（taskId / envIdx / done / released），保证租约在任何
 * 异常路径下都被归还。不负责工具 schema、action mapping、DSH 注册、
 * 策略或轨迹保存。
 */

import type { InteractResult, ResetResult } from "./protocol.ts";
import type { ShopSimulatorHttpClient } from "./client.ts";

/** 客户端侧的会话状态违规（未 reset、terminal 后 interact 等）。 */
export class ShoppingSessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShoppingSessionStateError";
  }
}

export class ShoppingEnvironmentSession {
  readonly taskId: number;

  #client: ShopSimulatorHttpClient;
  #envIdx: number | null = null;
  #done = false;
  #released = false;
  #releasePromise: Promise<void> | null = null;
  #environmentVersion: string | null = null;

  constructor(client: ShopSimulatorHttpClient, taskId: number) {
    this.#client = client;
    this.taskId = taskId;
  }

  get envIdx(): number | null {
    return this.#envIdx;
  }

  get done(): boolean {
    return this.#done;
  }

  get released(): boolean {
    return this.#released;
  }

  /** reset 成功后、terminal/release 之前。 */
  get isActive(): boolean {
    return this.#envIdx !== null && !this.#done && !this.#released;
  }

  get environmentVersion(): string | null {
    return this.#environmentVersion;
  }

  /** reset：领取任务与租约 slot。每个会话只允许一次。 */
  async reset(): Promise<ResetResult> {
    if (this.#released) {
      throw new ShoppingSessionStateError("会话已 release，不能再 reset");
    }
    if (this.#envIdx !== null) {
      throw new ShoppingSessionStateError("会话已经 reset，不能重复 reset");
    }
    const result = await this.#client.reset(this.taskId);
    this.#envIdx = result.envIdx;
    this.#environmentVersion = result.environmentVersion;
    return result;
  }

  /** interact：执行一步动作；terminal（done）或 release 后拒绝。 */
  async interact(action: string): Promise<InteractResult> {
    if (this.#released) {
      throw new ShoppingSessionStateError("会话已 release，不能再 interact");
    }
    if (this.#envIdx === null) {
      throw new ShoppingSessionStateError("会话尚未 reset，不能 interact");
    }
    if (this.#done) {
      throw new ShoppingSessionStateError("任务已 terminal，不能再 interact");
    }
    const result = await this.#client.interact(this.#envIdx, action);
    if (result.done) {
      this.#done = true;
    }
    return result;
  }

  /**
   * release：归还租约。可重复调用且并发安全；release 失败被吞掉并记录在
   * releaseError（finally 路径上不允许用释放失败掩盖原始错误）。
   */
  async release(): Promise<void> {
    if (this.#releasePromise !== null) {
      return this.#releasePromise;
    }
    this.#released = true;
    const envIdx = this.#envIdx;
    this.#releasePromise = (async () => {
      if (envIdx === null) {
        return;
      }
      try {
        await this.#client.releaseOne(envIdx);
      } catch (cause) {
        this.releaseError = cause instanceof Error ? cause : new Error(String(cause));
      }
    })();
    return this.#releasePromise;
  }

  /** release 阶段的错误（若有）。 */
  releaseError: Error | null = null;
}

/**
 * try/finally helper：reset → fn(session) → 无论 fn 是否抛出都 release。
 * fn 的异常原样向外传播；release 的失败记录在 session.releaseError。
 */
export async function withShoppingSession<R>(
  client: ShopSimulatorHttpClient,
  taskId: number,
  fn: (session: ShoppingEnvironmentSession) => Promise<R>,
): Promise<{ value: R; session: ShoppingEnvironmentSession }> {
  const session = new ShoppingEnvironmentSession(client, taskId);
  await session.reset();
  try {
    const value = await fn(session);
    return { value, session };
  } finally {
    await session.release();
  }
}
