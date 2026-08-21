/**
 * development benchmark manifest 的加载与校验（冻结基础设施）。
 *
 * manifest 是本仓库自行定义的 development 集合（harness 开发专用）：
 *   - held-in 与 held-out 非空、无重复、严格不相交；
 *   - Final-200 Clean 绝不进入（final_benchmark_excluded 必须为 true）；
 *   - task IDs 的有效性由 scripts/validate_development_tasks.py 对环境
 *     实际验证，本模块只做结构校验。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const BENCHMARK_SCHEMA_VERSION = 1;

export class BenchmarkManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkManifestError";
  }
}

export interface BenchmarkManifest {
  schemaVersion: number;
  benchmarkId: string;
  purpose: string;
  harnessId: string;
  harnessVersion: string;
  taskSource: string;
  heldInTaskIds: readonly number[];
  heldOutTaskIds: readonly number[];
  finalBenchmarkExcluded: boolean;
  splitSelectionRationale: string;
  maxEnvironmentSteps: number;
  repeats: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIntList(value: unknown, label: string): number[] {
  if (!Array.isArray(value)
    || value.length === 0
    || !value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)) {
    throw new BenchmarkManifestError(`${label} 必须是非空的非负整数数组`);
  }
  const seen = new Set<number>();
  for (const entry of value as number[]) {
    if (seen.has(entry)) {
      throw new BenchmarkManifestError(`${label} 含重复 task_id: ${entry}`);
    }
    seen.add(entry);
  }
  return value as number[];
}

/** 校验并返回 manifest（held-in/held-out 不相交在此强制）。 */
export function parseBenchmarkManifest(data: unknown): BenchmarkManifest {
  if (!isObject(data)) {
    throw new BenchmarkManifestError("benchmark manifest 必须是映射");
  }
  if (data["schema_version"] !== BENCHMARK_SCHEMA_VERSION) {
    throw new BenchmarkManifestError("schema_version 必须为 1");
  }
  const strings: Array<[keyof BenchmarkManifest, string]> = [
    ["benchmarkId", "benchmark_id"],
    ["purpose", "purpose"],
    ["harnessId", "harness_id"],
    ["harnessVersion", "harness_version"],
    ["taskSource", "task_source"],
    ["splitSelectionRationale", "split_selection_rationale"],
  ];
  const result = {} as Record<string, unknown>;
  for (const [target, key] of strings) {
    const value = data[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new BenchmarkManifestError(`${key} 必须是非空字符串`);
    }
    result[target] = value;
  }
  if (result["purpose"] !== "harness_development_only") {
    throw new BenchmarkManifestError("purpose 必须是 harness_development_only");
  }

  const heldIn = requireIntList(data["held_in_task_ids"], "held_in_task_ids");
  const heldOut = requireIntList(data["held_out_task_ids"], "held_out_task_ids");
  const heldInSet = new Set(heldIn);
  for (const taskId of heldOut) {
    if (heldInSet.has(taskId)) {
      throw new BenchmarkManifestError(
        `held-in 与 held-out 相交于 task_id=${taskId}（必须严格不相交）`,
      );
    }
  }

  if (data["final_benchmark_excluded"] !== true) {
    throw new BenchmarkManifestError("final_benchmark_excluded 必须为 true");
  }

  const steps = data["max_environment_steps"];
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1) {
    throw new BenchmarkManifestError("max_environment_steps 必须是正整数");
  }

  let repeats = 1;
  const evaluation = data["evaluation"];
  if (evaluation !== undefined) {
    if (!isObject(evaluation)) {
      throw new BenchmarkManifestError("evaluation 必须是映射");
    }
    const repeatsRaw = evaluation["repeats"];
    if (repeatsRaw !== undefined) {
      if (typeof repeatsRaw !== "number" || !Number.isInteger(repeatsRaw) || repeatsRaw < 1) {
        throw new BenchmarkManifestError("evaluation.repeats 必须是正整数");
      }
      repeats = repeatsRaw;
    }
  }

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmarkId: result["benchmarkId"] as string,
    purpose: result["purpose"] as string,
    harnessId: result["harnessId"] as string,
    harnessVersion: result["harnessVersion"] as string,
    taskSource: result["taskSource"] as string,
    heldInTaskIds: heldIn,
    heldOutTaskIds: heldOut,
    finalBenchmarkExcluded: true,
    splitSelectionRationale: result["splitSelectionRationale"] as string,
    maxEnvironmentSteps: steps,
    repeats,
  };
}

/** 从文件加载 manifest。 */
export function loadBenchmarkManifest(path: string): BenchmarkManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new BenchmarkManifestError(`manifest 不存在或不可读: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new BenchmarkManifestError(
      `manifest YAML 解析失败: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return parseBenchmarkManifest(parsed);
}

/** 便捷：仓库内默认 manifest 路径。 */
export function defaultBenchmarkManifestPath(repoRoot: string): string {
  return join(repoRoot, "configs", "evaluation", "development-v1.yml");
}
