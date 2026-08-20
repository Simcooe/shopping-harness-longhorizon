/**
 * 最小 JSONL rollout 记录器（冻结层，轨迹审计）。
 *
 * 每条记录是一行 JSON，包含：schema_version、run_id、task_id、
 * harness_version、timestamp、工具调用名/参数、环境 action、
 * actor-visible observation 摘要、done、结束原因、release 状态。
 *
 * 红线：**不记录**模型 key、完整 observation、goal、gold、reward 或
 * 任何隐藏环境字段。记录器内置脱敏：
 *   1. 任何对象在写入前按 FORBIDDEN_RECORD_KEYS 剔除禁止键（递归）；
 *   2. 字符串值截断到 MAX_RECORDED_STRING_CHARS；
 *   3. observation 只接受结构化摘要（done/over/envIdx），不接受原文。
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export const ROLLOUT_SCHEMA_VERSION = 1;

/** 禁止进入轨迹的键（任意嵌套层级）。 */
export const FORBIDDEN_RECORD_KEYS = [
  "goal",
  "goals",
  "gold",
  "gold_asin",
  "reward",
  "reward_detail",
  "goal_options",
  "purchase",
  "instruction",
  "instruction_simple",
  "instruction_text",
  "user_persona",
  "reason_key",
  "verbose_info",
  "observation",
  "api_key",
  "apikey",
  "token",
  "secret",
] as const;

const MAX_RECORDED_STRING_CHARS = 400;
const MAX_RECORDED_DEPTH = 6;

/** 脱敏：剔除禁止键、截断字符串、限制嵌套深度。纯函数。 */
export function sanitizeForRecord(value: unknown, depth = 0): unknown {
  if (depth > MAX_RECORDED_DEPTH) {
    return "<truncated-depth>";
  }
  if (typeof value === "string") {
    return value.length > MAX_RECORDED_STRING_CHARS
      ? `${value.slice(0, MAX_RECORDED_STRING_CHARS)}…`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForRecord(entry, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if ((FORBIDDEN_RECORD_KEYS as readonly string[]).includes(key.toLowerCase())) {
        continue;
      }
      cleaned[key] = sanitizeForRecord(entry, depth + 1);
    }
    return cleaned;
  }
  return String(value);
}

export interface RolloutRecordBase {
  schema_version: number;
  run_id: string;
  task_id: number;
  harness_version: string;
  timestamp: string;
  seq: number;
}

export interface ToolCallRecord {
  event: "tool_call";
  tool: string;
  args: Record<string, unknown>;
  environment_action: string;
}

export interface StepRecord {
  event: "step";
  environment_action: string;
  observation_summary: { env_idx: number; done: boolean; over: boolean };
  done: boolean;
}

export interface TerminalRecord {
  event: "terminal";
  done: boolean;
  termination_reason: string;
  release_status: "released" | "release_failed" | "not_released";
  error_code?: string;
}

export type RolloutEvent = ToolCallRecord | StepRecord | TerminalRecord;
export type RolloutRecord = RolloutRecordBase & RolloutEvent;

export interface RolloutRecorderOptions {
  /** 轨迹目录（仓库内 trajectories/）。不存在则创建。 */
  dir: string;
  runId: string;
  taskId: number;
  harnessVersion: string;
  /** 测试可注入时钟。 */
  clock?: () => Date;
}

export class RolloutRecorder {
  readonly filePath: string;
  readonly runId: string;

  #taskId: number;
  #harnessVersion: string;
  #clock: () => Date;
  #seq = 0;
  #fd: number | null = null;
  #closed = false;

  constructor(options: RolloutRecorderOptions) {
    this.runId = options.runId;
    this.#taskId = options.taskId;
    this.#harnessVersion = options.harnessVersion;
    this.#clock = options.clock ?? (() => new Date());
    mkdirSync(options.dir, { recursive: true });
    this.filePath = join(options.dir, `${options.runId}.jsonl`);
    this.#fd = openSync(this.filePath, "a");
  }

  /** 追加一条记录（内部完成脱敏）。文件已关闭时抛错。 */
  record(event: RolloutEvent): RolloutRecord {
    if (this.#closed || this.#fd === null) {
      throw new Error("RolloutRecorder 已关闭");
    }
    const record: RolloutRecord = {
      schema_version: ROLLOUT_SCHEMA_VERSION,
      run_id: this.runId,
      task_id: this.#taskId,
      harness_version: this.#harnessVersion,
      timestamp: this.#clock().toISOString(),
      seq: this.#seq++,
      ...event,
    };
    const sanitized = sanitizeForRecord(record) as RolloutRecord;
    writeSync(this.#fd, `${JSON.stringify(sanitized)}\n`);
    return sanitized;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
    this.#closed = true;
  }
}

/** 生成确定性 run id（clock 可注入，避免依赖随机数）。 */
export function makeRunId(clock: () => Date = () => new Date()): string {
  const stamp = clock().toISOString().replace(/[:.]/g, "-");
  return `run-${stamp}`;
}
