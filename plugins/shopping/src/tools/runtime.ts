/**
 * shopping 运行时持有者（冻结层）：环境 client、当前会话与记录器。
 *
 * 约束：
 *   - task_id 只能由外部 runner 注入（见 rollout/task_source.ts），
 *     本层不提供任何"自选任务"能力；
 *   - 不创建新环境任务，只领取注入的 task_id；
 *   - terminal 或异常时负责归还租约（release 幂等）。
 */

import { ShopSimulatorHttpClient } from "../environment/client.ts";
import { ShoppingEnvironmentSession } from "../environment/session.ts";
import type { RolloutRecorder } from "../rollout/recorder.ts";

export interface ShoppingRuntimeOptions {
  /** 默认 ShopSimulatorHttpClient.fromEnv()。 */
  client?: ShopSimulatorHttpClient;
  /** 可选轨迹记录器（由外部 runner 注入）。 */
  recorder?: RolloutRecorder;
}

export class ShoppingRuntime {
  readonly client: ShopSimulatorHttpClient;
  readonly recorder: RolloutRecorder | null;

  #session: ShoppingEnvironmentSession | null = null;

  constructor(options: ShoppingRuntimeOptions = {}) {
    this.client = options.client ?? ShopSimulatorHttpClient.fromEnv();
    this.recorder = options.recorder ?? null;
  }

  get session(): ShoppingEnvironmentSession | null {
    return this.#session;
  }

  /**
   * 注入外部选择的 task_id 并领取会话（reset）。
   * 同一时刻只允许一个活动会话。
   */
  async openSession(taskId: number): Promise<ShoppingEnvironmentSession> {
    if (this.#session !== null && !this.#session.released) {
      throw new Error("已存在活动 shopping 会话；先 release 再开新会话");
    }
    const session = new ShoppingEnvironmentSession(this.client, taskId);
    await session.reset();
    this.#session = session;
    return session;
  }

  /** 工具 handler 使用：必须已有活动会话。 */
  requireSession(): ShoppingEnvironmentSession {
    if (this.#session === null) {
      throw new Error("没有活动 shopping 会话（task_id 必须由外部 runner 注入）");
    }
    if (this.#session.released) {
      throw new Error("shopping 会话已释放");
    }
    return this.#session;
  }

  /** 归还并解绑当前会话（幂等）。 */
  async closeSession(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    if (session !== null) {
      await session.release();
    }
  }
}
