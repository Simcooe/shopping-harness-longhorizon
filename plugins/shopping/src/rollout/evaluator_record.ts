/**
 * evaluator record（冻结层）——Phase 6 双轨迹之"结果证据"。
 *
 * 每次 run 写一份 JSON 到 evaluation/runs/<run_id>.json，与 actor trace
 * 通过 run_id 关联。仅供未来 failure evidence 构建，**硬性隔离**：
 *   - 不写入 DSH session；
 *   - 不作为同一任务中模型的 tool result 或 prompt；
 *   - 本阶段不据以修改 harness。
 * 结构隔离由装配保证：register/tools/observation 层在类型上拿不到
 * EvaluatorOutcome（只经 client 的 evaluatorSink 流入本模块）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluatorOutcome } from "../environment/protocol.ts";

export const EVALUATOR_SCHEMA_VERSION = 1;

/** 基础失败标签（与固定环境 Reward v3 的终止原因词汇对齐）。 */
export const FAILURE_LABELS = [
  "wrong_purchase",
  "repeat_loop",
  "max_steps",
  "early_abstain",
  "graceful_stop",
  "environment_error",
  "tool_error",
  "gold_purchase",
  "valid_alternative_purchase",
  "unknown",
] as const;

export type FailureLabel = (typeof FAILURE_LABELS)[number];

const KNOWN_ENV_LABELS: ReadonlySet<string> = new Set([
  "wrong_purchase",
  "repeat_loop",
  "max_steps",
  "early_abstain",
  "graceful_stop",
  "gold_purchase",
  "valid_alternative_purchase",
]);

export interface EvaluatorRecord {
  schema_version: number;
  run_id: string;
  task_id: number;
  harness_version: string;
  timestamp: string;
  /** 环境 terminal 状态。 */
  environment_terminal: {
    done: boolean;
    over: boolean;
    termination_reason: string | null;
  };
  /** public environment reward（只在 evaluator 侧）。 */
  reward: number | null;
  reward_type: string | null;
  reward_valid: boolean | null;
  purchase_asin: string | null;
  /** 运行统计。 */
  tool_steps: number;
  guard_rejections: number;
  max_steps_triggered: boolean;
  failure_labels: FailureLabel[];
  release_status: "released" | "release_failed" | "not_released";
}

/** 收集一次 run 的 evaluator 证据；由 runtime 在冻结装配中持有。 */
export class EvaluatorCollector {
  #steps = 0;
  #guardRejections = 0;
  #maxStepsTriggered = false;
  #outcome: EvaluatorOutcome | null = null;
  #localError: "tool_error" | "environment_error" | null = null;
  #over = false;

  noteToolStep(): void {
    this.#steps += 1;
  }

  noteGuardRejection(): void {
    this.#guardRejections += 1;
  }

  noteMaxSteps(): void {
    this.#maxStepsTriggered = true;
  }

  noteOver(): void {
    this.#over = true;
  }

  noteLocalError(kind: "tool_error" | "environment_error"): void {
    this.#localError = kind;
  }

  /** 只经 client evaluatorSink 到达；tools/register 层无此入口。 */
  noteEvaluatorOutcome(outcome: EvaluatorOutcome): void {
    this.#outcome = outcome;
  }

  get hasOutcome(): boolean {
    return this.#outcome !== null;
  }

  deriveFailureLabels(): FailureLabel[] {
    const labels: FailureLabel[] = [];
    const outcome = this.#outcome;
    const reason = outcome?.terminationReason ?? null;
    if (reason !== null && KNOWN_ENV_LABELS.has(reason)) {
      labels.push(reason as FailureLabel);
    }
    if (this.#maxStepsTriggered && !labels.includes("max_steps")) {
      labels.push("max_steps");
    }
    if (this.#localError !== null && !labels.includes(this.#localError)) {
      labels.push(this.#localError);
    }
    if (labels.length === 0) {
      labels.push("unknown");
    }
    return labels;
  }

  build(options: {
    runId: string;
    taskId: number;
    harnessVersion: string;
    releaseStatus: "released" | "release_failed" | "not_released";
    clock?: () => Date;
  }): EvaluatorRecord {
    const outcome = this.#outcome;
    const rewardDetail = outcome?.rewardDetail ?? null;
    const rewardType = rewardDetail !== null && typeof rewardDetail["type"] === "string"
      ? rewardDetail["type"] as string
      : (typeof rewardDetail?.["reward_type"] === "string"
        ? rewardDetail["reward_type"] as string
        : null);
    return {
      schema_version: EVALUATOR_SCHEMA_VERSION,
      run_id: options.runId,
      task_id: options.taskId,
      harness_version: options.harnessVersion,
      timestamp: (options.clock ?? (() => new Date()))().toISOString(),
      environment_terminal: {
        done: outcome?.done ?? false,
        over: this.#over,
        termination_reason: outcome?.terminationReason ?? null,
      },
      reward: outcome?.reward ?? null,
      reward_type: rewardType,
      reward_valid: outcome?.rewardValid ?? null,
      purchase_asin: outcome?.purchaseAsin ?? null,
      tool_steps: this.#steps,
      guard_rejections: this.#guardRejections,
      max_steps_triggered: this.#maxStepsTriggered,
      failure_labels: this.deriveFailureLabels(),
      release_status: options.releaseStatus,
    };
  }
}

/** 写 evaluator record 到 evaluation/runs/<run_id>.json。 */
export function writeEvaluatorRecord(
  dir: string,
  record: EvaluatorRecord,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.run_id}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return path;
}
