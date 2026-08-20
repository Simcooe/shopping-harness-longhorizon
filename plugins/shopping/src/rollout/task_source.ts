/**
 * 任务来源（冻结层，rollout 审计的一部分）：task_id 只能由外部 runner
 * 从 configs/tasks/development.json 声明的集合中选择并注入；
 * 模型不得决定 task_id。
 */

import { readFileSync } from "node:fs";

export interface DevelopmentTaskSource {
  schemaVersion: number;
  purpose: string;
  taskIds: readonly number[];
  finalBenchmarkExcluded: boolean;
}

export class TaskSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSourceError";
  }
}

/** 加载并校验开发任务声明文件（纯 I/O 边界校验）。 */
export function loadDevelopmentTaskSource(path: string): DevelopmentTaskSource {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (cause) {
    throw new TaskSourceError(`无法读取任务声明: ${path}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new TaskSourceError("任务声明不是合法 JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TaskSourceError("任务声明必须是 JSON 对象");
  }
  const record = data as Record<string, unknown>;
  if (record["schema_version"] !== 1) {
    throw new TaskSourceError("任务声明 schema_version 必须为 1");
  }
  if (record["purpose"] !== "development_smoke_only") {
    throw new TaskSourceError("runner 只接受 development_smoke_only 任务集");
  }
  const taskIds = record["task_ids"];
  if (
    !Array.isArray(taskIds)
    || taskIds.length === 0
    || !taskIds.every(
      (entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0,
    )
  ) {
    throw new TaskSourceError("task_ids 必须是非空的非负整数列表");
  }
  if (record["final_benchmark_excluded"] !== true) {
    throw new TaskSourceError("任务声明必须显式 final_benchmark_excluded: true");
  }
  return {
    schemaVersion: 1,
    purpose: "development_smoke_only",
    taskIds: taskIds as number[],
    finalBenchmarkExcluded: true,
  };
}

/** 校验外部注入的 task_id 属于声明集合。 */
export function assertInjectedTaskId(
  source: DevelopmentTaskSource,
  taskId: unknown,
): number {
  if (typeof taskId !== "number" || !Number.isInteger(taskId)) {
    throw new TaskSourceError("注入的 task_id 必须是整数");
  }
  if (!source.taskIds.includes(taskId)) {
    throw new TaskSourceError(
      `task_id ${taskId} 不在声明的开发任务集合中（模型不得决定 task_id）`,
    );
  }
  return taskId;
}
