/**
 * shopping 运行时持有者（冻结层）：环境 client、当前会话、guard 状态、
 * actor trace 记录器与 evaluator 收集器。
 *
 * 双轨迹装配（Phase 6）：
 *   - actor trace：trajectories/actor/<run_id>.jsonl（模型可见证据）；
 *   - evaluator record：evaluation/runs/<run_id>.json（结果证据）。
 * evaluator 数据只经 client 的 evaluatorSink 流入 EvaluatorCollector，
 * tools/register/observation 层在类型上拿不到它。
 *
 * 约束：task_id 只能由外部 runner 注入；本层不提供"自选任务"能力。
 */

import { ShopSimulatorHttpClient } from "../environment/client.ts";
import type { ActorObservation } from "../environment/protocol.ts";
import { ShoppingEnvironmentSession } from "../environment/session.ts";
import { checkToolCall, GuardRejectionError, type GuardState } from "./guard.ts";
import type { ShoppingToolName } from "./actions.ts";
import { RolloutRecorder } from "../rollout/recorder.ts";
import { EvaluatorCollector, writeEvaluatorRecord } from "../rollout/evaluator_record.ts";
import { assertInjectedTaskId, loadDevelopmentTaskSource } from "../rollout/task_source.ts";
import type { BootstrapSession } from "../rollout/bootstrap.ts";

/** 步数预算错误：run 以 max_steps 终止。 */
export class MaxStepsError extends Error {
  constructor(maxSteps: number) {
    super(`已达到最大环境步数 ${maxSteps}`);
    this.name = "MaxStepsError";
  }
}

export interface ShoppingRuntimeOptions {
  /** 默认按 SHOPSIM_BASE_URL 构造（并接线 evaluatorSink）。 */
  client?: ShopSimulatorHttpClient;
  recorder?: RolloutRecorder;
  maxSteps?: number;
  env?: Record<string, string | undefined>;
  /** actor trace 根目录；默认 trajectories（实际写 <dir>/actor/）。 */
  trajectoriesDir?: string;
  /** evaluator record 目录；默认 evaluation/runs。 */
  evaluationDir?: string;
  harnessVersion?: string;
}

export class ShoppingRuntime {
  readonly client: ShopSimulatorHttpClient;
  readonly maxSteps: number;
  readonly evaluator: EvaluatorCollector;

  #recorder: RolloutRecorder | null;
  #env: Record<string, string | undefined>;
  #trajectoriesDir: string;
  #evaluationDir: string;
  #harnessVersion: string;
  #session: ShoppingEnvironmentSession | null = null;
  #steps = 0;
  #guardState: GuardState = { observation: null, terminal: false, inFlight: false };
  #taskId: number | null = null;
  #evaluatorWritten = false;

  constructor(options: ShoppingRuntimeOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#trajectoriesDir = options.trajectoriesDir ?? "trajectories";
    this.#evaluationDir = options.evaluationDir ?? "evaluation/runs";
    this.#harnessVersion = options.harnessVersion ?? "shopping-base@0.0.0";
    this.evaluator = new EvaluatorCollector();
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      // 默认 client：evaluator 结果证据只流向本 runtime 的收集器
      this.client = ShopSimulatorHttpClient.fromEnv(this.#env, {
        evaluatorSink: (outcome) => this.evaluator.noteEvaluatorOutcome(outcome),
      });
    }
    this.#recorder = options.recorder ?? null;
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

  get taskId(): number | null {
    return this.#taskId;
  }

  get harnessVersion(): string {
    return this.#harnessVersion;
  }

  get evaluationDir(): string {
    return this.#evaluationDir;
  }

  /** 步数预算：超额抛 MaxStepsError（run 以 max_steps 终止）。 */
  noteStep(): void {
    if (this.#steps >= this.maxSteps) {
      throw new MaxStepsError(this.maxSteps);
    }
    this.#steps += 1;
  }

  // ---- guard 集成 -----------------------------------------------------------

  /** guard 校验：拒绝时抛 GuardRejectionError（不调用环境、不耗步数）。 */
  guardCheck(toolName: ShoppingToolName, args: Record<string, unknown>): void {
    try {
      checkToolCall(toolName, args, this.#guardState);
    } catch (cause) {
      if (cause instanceof GuardRejectionError) {
        this.evaluator.noteGuardRejection();
        this.#recorder?.record({
          event: "guard_rejection",
          tool: toolName,
          guard_reason: cause.guardReason,
          correction: cause.message,
        });
      }
      throw cause;
    }
  }

  beginCall(): void {
    this.#guardState.inFlight = true;
  }

  endCall(): void {
    this.#guardState.inFlight = false;
  }

  /** 用最新 actor 观测更新 guard 状态。 */
  observe(observation: ActorObservation | null): void {
    if (observation !== null) {
      this.#guardState.observation = observation;
    }
  }

  markTerminal(): void {
    this.#guardState.terminal = true;
  }

  // ---- 会话 ----------------------------------------------------------------

  /**
   * 注入外部选择的 task_id 并领取会话（reset）。
   * 同一时刻只允许一个活动会话。
   * 注意：live 路径不使用本方法（bootstrap 接管，全程只 reset 一次）。
   */
  async openSession(taskId: number): Promise<ShoppingEnvironmentSession> {
    if (this.#session !== null && !this.#session.released) {
      throw new Error("已存在活动 shopping 会话；先 release 再开新会话");
    }
    const session = new ShoppingEnvironmentSession(this.client, taskId);
    const reset = await session.reset();
    this.#session = session;
    this.#taskId = taskId;
    void reset;
    return session;
  }

  /**
   * bootstrap 接管：外部 runner 已 reset 并写入 bootstrap 文件；
   * plugin 在 DSH boot（第一次模型请求前）接管同一 env_idx，
   * 并如实记录 actor trace：run_start → task_instruction
   * （指令此刻已进入 DSH 初始任务 prompt）。绝不二次 reset。
   */
  adoptBootstrap(bootstrap: BootstrapSession): ShoppingEnvironmentSession {
    if (this.#session !== null && !this.#session.released) {
      throw new Error("已存在活动 shopping 会话，不能重复 bootstrap");
    }
    this.#session = ShoppingEnvironmentSession.adopted(
      this.client,
      bootstrap.task_id,
      bootstrap.env_idx,
    );
    this.#taskId = bootstrap.task_id;

    if (this.#recorder === null) {
      this.#recorder = new RolloutRecorder({
        dir: `${this.#trajectoriesDir}/actor`,
        runId: bootstrap.run_id,
        taskId: bootstrap.task_id,
        harnessVersion: this.#harnessVersion,
      });
    }
    this.#recorder.record({
      event: "run_start",
      profile: "shopping-base",
      tools: [],
      system_prompt_ref: "harnesses/base/system-prompt.md",
    });
    this.#recorder.record({
      event: "task_instruction",
      instruction_text: bootstrap.instruction_text,
    });
    return this.#session;
  }

  /**
   * 懒会话：优先返回活动会话；bootstrap 模式下只接管不 reset；
   * 非 bootstrap（开发/smoke）模式才允许懒 reset。
   */
  async ensureSession(): Promise<ShoppingEnvironmentSession> {
    if (this.#session !== null && !this.#session.released) {
      return this.#session;
    }
    if (this.#env["SHOPPING_BOOTSTRAP"] !== undefined) {
      throw new Error(
        "SHOPPING_BOOTSTRAP 模式：会话必须在 boot 阶段接管，插件不得自行 reset",
      );
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
          dir: `${this.#trajectoriesDir}/actor`,
          runId,
          taskId,
          harnessVersion: this.#harnessVersion,
        });
        this.#recorder.record({
          event: "run_start",
          profile: "shopping-base",
          tools: [],
          system_prompt_ref: "harnesses/base/system-prompt.md",
        });
      }
    }
    return this.openSession(taskId);
  }

  /** 写 evaluator record（幂等：只写一次）。 */
  finalizeEvaluator(releaseStatus: "released" | "release_failed" | "not_released"): void {
    if (this.#evaluatorWritten || this.#taskId === null) {
      return;
    }
    const runId = this.#env["SHOPPING_RUN_ID"]?.trim();
    if (runId === undefined || runId.length === 0) {
      return;
    }
    this.#evaluatorWritten = true;
    writeEvaluatorRecord(
      this.#evaluationDir,
      this.evaluator.build({
        runId,
        taskId: this.#taskId,
        harnessVersion: this.#harnessVersion,
        releaseStatus,
      }),
    );
  }

  /** 归还并解绑当前会话（幂等）。 */
  async closeSession(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    this.markTerminal();
    if (session !== null) {
      await session.release();
      this.finalizeEvaluator(
        session.releaseError === null ? "released" : "release_failed",
      );
    }
    this.#recorder?.close();
  }
}
