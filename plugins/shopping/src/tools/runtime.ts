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
import { RolloutRecorder } from "../rollout/recorder.ts";
import { assertInjectedTaskId, loadDevelopmentTaskSource } from "../rollout/task_source.ts";

/** 步数预算错误：run 以 max_steps 终止。 */
export class MaxStepsError extends Error {
  constructor(maxSteps: number) {
    super(`已达到最大环境步数 ${maxSteps}`);
    this.name = "MaxStepsError";
  }
}

export interface ShoppingRuntimeOptions {
  /** 默认 ShopSimulatorHttpClient.fromEnv()。 */
  client?: ShopSimulatorHttpClient;
  /** 可选轨迹记录器（由外部 runner 注入）。 */
  recorder?: RolloutRecorder;
  /** 最大环境步数；默认读 SHOPPING_MAX_STEPS，否则 5。 */
  maxSteps?: number;
  /** 测试可注入的环境变量视图。 */
  env?: Record<string, string | undefined>;
  /** 轨迹目录（懒注入记录器时使用）。 */
  trajectoriesDir?: string;
  /** harness 版本标记（轨迹 metadata）。 */
  harnessVersion?: string;
}

export class ShoppingRuntime {
  readonly client: ShopSimulatorHttpClient;
  readonly maxSteps: number;

  #recorder: RolloutRecorder | null;
  #env: Record<string, string | undefined>;
  #trajectoriesDir: string;
  #harnessVersion: string;
  #session: ShoppingEnvironmentSession | null = null;
  #steps = 0;

  constructor(options: ShoppingRuntimeOptions = {}) {
    this.client = options.client ?? ShopSimulatorHttpClient.fromEnv();
    this.#recorder = options.recorder ?? null;
    this.#env = options.env ?? process.env;
    this.#trajectoriesDir = options.trajectoriesDir ?? "trajectories";
    this.#harnessVersion = options.harnessVersion ?? "shopping-base@0.0.0";
    const fromEnv = Number(this.#env["SHOPPING_MAX_STEPS"]);
    this.maxSteps = options.maxSteps
      ?? (Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 5);
  }

  get recorder(): RolloutRecorder | null {
    return this.#recorder;
  }

  get session(): ShoppingEnvironmentSession | null {
    return this.#session;
  }

  get stepsUsed(): number {
    return this.#steps;
  }

  /** 步数预算：超额抛 MaxStepsError（run 以 max_steps 终止）。 */
  noteStep(): void {
    if (this.#steps >= this.maxSteps) {
      throw new MaxStepsError(this.maxSteps);
    }
    this.#steps += 1;
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

  /**
   * 懒会话：优先返回活动会话；否则从 runner 注入的 SHOPPING_TASK_ID
   * 打开会话（task_id 仍由外部注入，且必须属于声明的开发任务集）。
   * 同时按 SHOPPING_RUN_ID 懒注入轨迹记录器。
   */
  async ensureSession(): Promise<ShoppingEnvironmentSession> {
    if (this.#session !== null && !this.#session.released) {
      return this.#session;
    }
    const rawTaskId = this.#env["SHOPPING_TASK_ID"]?.trim();
    if (rawTaskId === undefined || rawTaskId.length === 0) {
      throw new Error(
        "没有活动 shopping 会话（task_id 必须由外部 runner 注入 SHOPPING_TASK_ID）",
      );
    }
    const taskId = Number(rawTaskId);
    if (!Number.isInteger(taskId)) {
      throw new Error(`SHOPPING_TASK_ID 不是整数: ${rawTaskId}`);
    }
    const sourcePath = this.#env["SHOPPING_TASK_SOURCE"]
      ?? "configs/tasks/development.json";
    const source = loadDevelopmentTaskSource(sourcePath);
    assertInjectedTaskId(source, taskId);

    if (this.#recorder === null) {
      const runId = this.#env["SHOPPING_RUN_ID"]?.trim();
      if (runId !== undefined && runId.length > 0) {
        this.#recorder = new RolloutRecorder({
          dir: this.#trajectoriesDir,
          runId,
          taskId,
          harnessVersion: this.#harnessVersion,
        });
      }
    }
    return this.openSession(taskId);
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
