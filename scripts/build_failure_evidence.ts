#!/usr/bin/env node
/**
 * held-in failure evidence bundle 构建 CLI。
 *
 * 用法：
 *   node scripts/build_failure_evidence.ts --baseline-dir evaluation/baselines/<baseline_run_id>
 *   （可选 --out-dir <dir>，默认 evaluation/evidence/<baseline_run_id>）
 *
 * 只读取 baseline 目录下的 manifest.json / held-in.json 及其引用的 actor
 * trace / evaluator record。绝不读取 held-out.json。明确拒绝 --split held-out /
 * --all 及等价参数。不读取、不打印 API key，不调用模型。
 */

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EvidenceBuildError,
  buildFailureEvidence,
} from "../plugins/shopping/src/evidence/index.ts";
import { EVIDENCE_RUN_ID_PATTERN } from "../plugins/shopping/src/evidence/schema.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  console.error(`[build_failure_evidence] ${message}`);
  process.exit(2);
}

interface ParsedArgs {
  baselineDir: string | null;
  outDir: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { baselineDir: null, outDir: null };
  const takeValue = (arg: string, inline: string | undefined, next: string | undefined): string | undefined => {
    if (inline !== undefined && inline.length > 0) {
      return inline;
    }
    if (next !== undefined && next.length > 0 && !next.startsWith("-")) {
      return next;
    }
    fail(`参数 ${arg} 缺少值`);
    return undefined;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--all" || arg === "--held-out") {
      fail(`明确拒绝 ${arg}：evidence 只使用 held-in，绝不读取 held-out 或 all`);
    }
    if (arg === "--split" || arg.startsWith("--split=")) {
      const value = arg.startsWith("--split=")
        ? arg.slice("--split=".length)
        : (argv[i + 1] ?? "");
      if (value !== "held-in") {
        fail(`明确拒绝 --split ${value || "<empty>"}：evidence 只使用 held-in`);
      }
      if (!arg.startsWith("--split=")) {
        i += 1;
      }
      continue;
    }
    if (arg === "--baseline-dir" || arg.startsWith("--baseline-dir=")) {
      const value = takeValue(
        "--baseline-dir",
        arg.startsWith("--baseline-dir=") ? arg.slice("--baseline-dir=".length) : undefined,
        argv[i + 1],
      );
      result.baselineDir = value ?? null;
      if (!arg.startsWith("--baseline-dir=")) {
        i += 1;
      }
      continue;
    }
    if (arg === "--out-dir" || arg.startsWith("--out-dir=")) {
      const value = takeValue(
        "--out-dir",
        arg.startsWith("--out-dir=") ? arg.slice("--out-dir=".length) : undefined,
        argv[i + 1],
      );
      result.outDir = value ?? null;
      if (!arg.startsWith("--out-dir=")) {
        i += 1;
      }
      continue;
    }
    fail(`未知参数: ${arg}`);
  }
  return result;
}

function resolveFromRepo(cwdPath: string): string {
  return isAbsolute(cwdPath) ? cwdPath : resolve(REPO_ROOT, cwdPath);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.baselineDir === null) {
    fail("用法: build_failure_evidence.ts --baseline-dir <baseline dir> [--out-dir <dir>]");
  }

  const baselineDir = resolveFromRepo(args.baselineDir);

  // 读取 baseline manifest 的 baseline_run_id，校验与目录名对应，并推导默认输出目录
  let baselineRunId: string;
  try {
    const manifest = JSON.parse(
      readFileSync(join(baselineDir, "manifest.json"), "utf-8"),
    ) as Record<string, unknown>;
    baselineRunId = typeof manifest["baseline_run_id"] === "string"
      ? manifest["baseline_run_id"]
      : "";
  } catch (cause) {
    fail(`无法读取 baseline manifest.json: ${cause instanceof Error ? cause.message : String(cause)}`);
    return;
  }

  if (!EVIDENCE_RUN_ID_PATTERN.test(baselineRunId)) {
    fail(`manifest.json 的 baseline_run_id 非法: ${baselineRunId}`);
  }
  if (basename(baselineDir) !== baselineRunId) {
    fail(
      `baseline 目录名（${basename(baselineDir)}）与 manifest.json 的 `
      + `baseline_run_id（${baselineRunId}）不一致`,
    );
  }

  const outDir = args.outDir !== null
    ? resolveFromRepo(args.outDir)
    : join(REPO_ROOT, "evaluation", "evidence", baselineRunId);

  let result;
  try {
    result = buildFailureEvidence({ baselineDir, repoRoot: REPO_ROOT, outDir });
  } catch (cause) {
    fail(cause instanceof EvidenceBuildError || cause instanceof Error
      ? cause.message
      : String(cause));
    return;
  }

  const scope = result.evidence.scope;
  console.error(
    `[build_failure_evidence] evidence 目录: ${outDir}`,
  );
  console.error(
    `[build_failure_evidence] scope: task=${scope.task_count} `
    + `eligible_failure=${scope.eligible_failure_count} `
    + `excluded_success=${scope.excluded_success_count} `
    + `unknown=${scope.unknown_count} infra_failure=${scope.infra_failure_count} `
    + `clusters=${result.evidence.failure_clusters.length}`,
  );
}

main();
