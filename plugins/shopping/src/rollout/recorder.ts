/**
 * actor trace 记录器（冻结层，轨迹审计）——Phase 6 双轨迹之"模型可见证据"。
 *
 * actor trace 与模型实际可见内容一致（未来 Self-Harness 从它挖掘失败模式）：
 * 任务指令、工具调用与参数、环境 action、actor-visible 观测、guard
 * 拒绝、terminal 与 release 状态。
 *
 * 红线：**不记录** evaluator outcome、reward、gold、goal、隐藏环境字段、
 * 完整未投影原始 response、API key/Authorization。写入前递归剔除
 * FORBIDDEN_RECORD_KEYS；观测只接受已投影/已脱敏的结构。
 *
 * 文件布局：`<dir>/<run_id>.jsonl`（runtime 传入 trajectories/actor）。
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export const ACTOR_TRACE_SCHEMA_VERSION = 2;

/** 禁止进入轨迹的键（任意嵌套层级）。 */
export const FORBIDDEN_RECORD_KEYS = [
  "goal",
  "goals",
  "gold",
  "gold_asin",
  "reward",
  "reward_detail",
  "reward_valid",
  "goal_options",
  "purchase",
  "purchase_asin",
  "instruction_simple",
  "user_persona",
  "reason_key",
  "verbose_info",
  "termination_reason",
  "api_key",
  "apikey",
  "authorization",
  "token",
  "secret",
] as const;

const MAX_RECORDED_STRING_CHARS = 2000;
const MAX_RECORDED_DEPTH = 8;

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

export interface ActorRecordBase {
  schema_version: number;
  run_id: string;
  task_id: number;
  harness_version: string;
  timestamp: string;
  seq: number;
}

export interface RunStartRecord {
  event: "run_start";
  profile: string;
  tools: readonly string[];
  system_prompt_ref: string;
}

export interface TaskInstructionRecord {
  event: "task_instruction";
  /** 模型实际可见的用户任务文本（注入首个工具结果时记录）。 */
  instruction_text: string;
}

export interface ToolCallRecord {
  event: "tool_call";
  tool: string;
  args: Record<string, unknown>;
  environment_action: string;
}

export interface GuardRejectionRecord {
  event: "guard_rejection";
  tool: string;
  guard_reason: string;
  /** 返回给模型的安全纠正信息（本身必须无敏感内容）。 */
  correction: string;
}

export interface ObservationRecord {
  event: "observation";
  page_type: string;
  done: boolean;
  /** 已脱敏的 actor-visible 观测状态。 */
  observation: Record<string, unknown>;
}

export interface TerminalRecord {
  event: "terminal";
  done: boolean;
  /** 本地可见的结束原因（environment_done/max_steps/tool_error/guard 等）。 */
  local_reason: string;
  release_status: "released" | "release_failed" | "not_released";
  error_code?: string;
}

export type ActorEvent =
  | RunStartRecord
  | TaskInstructionRecord
  | ToolCallRecord
  | GuardRejectionRecord
  | ObservationRecord
  | TerminalRecord;

export type ActorRecord = ActorRecordBase & ActorEvent;

export interface RolloutRecorderOptions {
  /** actor trace 目录（trajectories/actor）。不存在则创建。 */
  dir: string;
  runId: string;
  taskId: number;
  harnessVersion: string;
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

  /** 追加一条 actor 记录（内部完成脱敏）。文件已关闭时抛错。 */
  record(event: ActorEvent): ActorRecord {
    if (this.#closed || this.#fd === null) {
      throw new Error("RolloutRecorder 已关闭");
    }
    const record: ActorRecord = {
      schema_version: ACTOR_TRACE_SCHEMA_VERSION,
      run_id: this.runId,
      task_id: this.#taskId,
      harness_version: this.#harnessVersion,
      timestamp: this.#clock().toISOString(),
      seq: this.#seq++,
      ...event,
    };
    const sanitized = sanitizeForRecord(record) as ActorRecord;
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
