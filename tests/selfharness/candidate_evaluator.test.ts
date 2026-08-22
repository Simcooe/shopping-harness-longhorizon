/**
 * candidate evaluator 提前校验 + `--candidate-id` 语义的离线测试。
 * 不调用真实模型；fake orchestrator 只写 sentinel 文件。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  parseArgs,
  preflightBaseBaselines,
  resolveCandidateDir,
} from "../../scripts/candidate_evaluator.ts";
import { materializeCandidate } from "../../plugins/shopping/src/candidate/index.ts";
import { loadHarness } from "../../plugins/shopping/src/harness/surface.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const REAL_BASE = join(REPO_ROOT, "harnesses", "base");

function outcome(taskId: number): Record<string, unknown> {
  return { task_id: taskId, status: "environment_done", reward_valid: true, reward_type: "gold_purchase" };
}

/** 搭建最小 temp repo：configs/evaluation/development-v1.yml + base harness。 */
function makeRepo(): { root: string; base: { harnessId: string; version: string; digest: string } } {
  const root = mkdtempSync(join(tmpdir(), "cand-eval-"));
  const baseHarness = loadHarness(REAL_BASE);
  // 复制 benchmark manifest
  mkdirSync(join(root, "configs", "evaluation"), { recursive: true });
  cpSync(
    join(REPO_ROOT, "configs", "evaluation", "development-v1.yml"),
    join(root, "configs", "evaluation", "development-v1.yml"),
  );
  return {
    root,
    base: {
      harnessId: baseHarness.harnessId,
      version: baseHarness.version,
      digest: baseHarness.toolSurfaceDigest,
    },
  };
}

/** 写一个 baseline 目录（held-in.json 或 held-out.json + manifest.json）。 */
function writeBaseline(
  repoRoot: string,
  id: string,
  split: "held-in" | "held-out",
  taskIds: number[],
  base: { harnessId: string; version: string; digest: string },
  overrides: {
    split?: string;
    harnessId?: string;
    digest?: string;
    outcomes?: Record<string, unknown>[];
  } = {},
): string {
  const dir = join(repoRoot, "evaluation", "baselines", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${split}.json`),
    `${JSON.stringify({
      baseline_run_id: id,
      benchmark_id: "shopping-development-v1",
      split: overrides.split ?? split,
      outcomes: overrides.outcomes ?? taskIds.map(outcome),
    }, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify({
      baseline_run_id: id,
      benchmark_id: "shopping-development-v1",
      harness_id: overrides.harnessId ?? base.harnessId,
      harness_version: base.version,
      tool_surface_digest: overrides.digest ?? base.digest,
      held_in_task_ids: [0, 1, 2, 3, 4, 5, 6, 7],
      held_out_task_ids: [8, 9, 10, 11],
    }, null, 2)}\n`,
    "utf-8",
  );
  return dir;
}

function makeCandidate(repoRoot: string, candidateId: string): string {
  return materializeCandidate({
    proposal: {
      schema_version: 1,
      candidate_id: candidateId,
      base_harness_id: "shopping-h0",
      base_harness_version: "0.1.0",
      evidence_id: "evidence-x",
      target_cluster_id: "cluster-x",
      hypothesis: "测试 candidate",
      edits: [{ path: "system-prompt.md", operation: "replace", content: "测试 prompt\n" }],
      expected_effect: "无",
      regression_risks: [],
    },
    baseHarnessDir: REAL_BASE,
    candidatesDir: join(repoRoot, "harnesses", "candidates"),
    clock: () => new Date("2026-08-22T00:00:00.000Z"),
  }).candidateDir;
}

// ---------------------------------------------------------------------------

test("parseArgs：--candidate-id 解析为纯 id；--candidate 被拒绝", () => {
  const args = parseArgs([
    "--candidate-id", "cand-x",
    "--base-harness", "harnesses/base",
    "--baseline-held-in", "b1",
    "--baseline-held-out", "b2",
  ]);
  assert.equal(args.candidateId, "cand-x");
  assert.equal(args.baselineHeldInId, "b1");
  assert.equal(args.baselineHeldOutId, "b2");

  assert.throws(
    () => parseArgs([
      "--candidate", "harnesses/candidates/cand-x",
      "--base-harness", "harnesses/base",
      "--baseline-held-in", "b1",
      "--baseline-held-out", "b2",
    ]),
    /--candidate-id/,
  );
});

test("resolveCandidateDir：路径由代码生成，路径穿越被拒绝", () => {
  assert.equal(resolveCandidateDir("/repo", "cand-x"), "/repo/harnesses/candidates/cand-x");
  for (const bad of ["../evil", "a/b", "a\\b", "..", "-x", ""]) {
    assert.throws(() => resolveCandidateDir("/repo", bad), Error, `应拒绝: ${bad}`);
  }
});

test("preflight：缺 base held-out baseline 目录 → 抛错", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base);
    assert.throws(
      () => preflightBaseBaselines({
        repoRoot: repo.root, baseHarnessDir: REAL_BASE,
        baselineHeldInId: "b-in", baselineHeldOutId: "b-out",
      }),
      /held-out.*缺失|目录缺失/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("preflight：held-out baseline ID 存在但文件缺失 → 抛错", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base);
    // b-out 目录存在，但没有 held-out.json
    mkdirSync(join(repo.root, "evaluation", "baselines", "b-out"), { recursive: true });
    assert.throws(
      () => preflightBaseBaselines({
        repoRoot: repo.root, baseHarnessDir: REAL_BASE,
        baselineHeldInId: "b-in", baselineHeldOutId: "b-out",
      }),
      /held-out\.json/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("preflight：held-out.json split 错误 → 抛错", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base);
    writeBaseline(repo.root, "b-out", "held-out", [8, 9, 10, 11], repo.base, { split: "held-in" });
    assert.throws(
      () => preflightBaseBaselines({
        repoRoot: repo.root, baseHarnessDir: REAL_BASE,
        baselineHeldInId: "b-in", baselineHeldOutId: "b-out",
      }),
      /split 应为 held-out/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("preflight：baseline harness_id 与 base harness 不一致 → 抛错", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base);
    writeBaseline(repo.root, "b-out", "held-out", [8, 9, 10, 11], repo.base, { harnessId: "other-harness" });
    assert.throws(
      () => preflightBaseBaselines({
        repoRoot: repo.root, baseHarnessDir: REAL_BASE,
        baselineHeldInId: "b-in", baselineHeldOutId: "b-out",
      }),
      /harness_id.*不一致/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("preflight：合法 base held-in + held-out baseline → 通过", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base);
    writeBaseline(repo.root, "b-out", "held-out", [8, 9, 10, 11], repo.base);
    const result = preflightBaseBaselines({
      repoRoot: repo.root, baseHarnessDir: REAL_BASE,
      baselineHeldInId: "b-in", baselineHeldOutId: "b-out",
    });
    assert.equal(result.baseHeldIn.length, 8);
    assert.equal(result.baseHeldOut.length, 4);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("preflight：base held-in outcome 缺 reward_valid → 抛错", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base, {
      outcomes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ task_id: i, status: "environment_done", reward_type: "gold_purchase" })),
    });
    writeBaseline(repo.root, "b-out", "held-out", [8, 9, 10, 11], repo.base);
    assert.throws(
      () => preflightBaseBaselines({
        repoRoot: repo.root, baseHarnessDir: REAL_BASE,
        baselineHeldInId: "b-in", baselineHeldOutId: "b-out",
      }),
      /reward_valid/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("preflight：base held-out outcome 缺 reward_valid → 抛错", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base);
    writeBaseline(repo.root, "b-out", "held-out", [8, 9, 10, 11], repo.base, {
      outcomes: [8, 9, 10, 11].map((i) => ({ task_id: i, status: "environment_done", reward_type: "gold_purchase" })),
    });
    assert.throws(
      () => preflightBaseBaselines({
        repoRoot: repo.root, baseHarnessDir: REAL_BASE,
        baselineHeldInId: "b-in", baselineHeldOutId: "b-out",
      }),
      /reward_valid/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("preflight：reward_valid 为 null/字符串/undefined 全部拒绝", () => {
  for (const bad of [null, "true", undefined]) {
    const repo = makeRepo();
    try {
      const outcomes = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        task_id: i, status: "environment_done", reward_type: "gold_purchase", reward_valid: bad,
      }));
      writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base, { outcomes });
      writeBaseline(repo.root, "b-out", "held-out", [8, 9, 10, 11], repo.base);
      assert.throws(
        () => preflightBaseBaselines({
          repoRoot: repo.root, baseHarnessDir: REAL_BASE,
          baselineHeldInId: "b-in", baselineHeldOutId: "b-out",
        }),
        /reward_valid/,
        `reward_valid=${String(bad)} 应被拒绝`,
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }
});

test("preflight：reward_valid 为 true/false 的完整 baseline 通过", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base, {
      outcomes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        task_id: i, status: "environment_done",
        reward_type: i < 3 ? "gold_purchase" : "max_steps",
        reward_valid: i < 3,
      })),
    });
    writeBaseline(repo.root, "b-out", "held-out", [8, 9, 10, 11], repo.base, {
      outcomes: [8, 9, 10, 11].map((i) => ({
        task_id: i, status: "environment_done",
        reward_type: i < 9 ? "gold_purchase" : "wrong_purchase",
        reward_valid: i < 9,
      })),
    });
    const result = preflightBaseBaselines({
      repoRoot: repo.root, baseHarnessDir: REAL_BASE,
      baselineHeldInId: "b-in", baselineHeldOutId: "b-out",
    });
    assert.equal(result.baseHeldIn.length, 8);
    assert.equal(result.baseHeldOut.length, 4);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

function makeFakeOrchestrator(dir: string, sentinel: string): string {
  const path = join(dir, "fake-orchestrator.js");
  writeFileSync(path, `const fs = require("fs");
const path = require("path");
fs.writeFileSync(process.env.FAKE_SENTINEL, "called", "utf-8");
const outDir = process.env.SHOPPING_EVAL_OUT_DIR;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "held-in.json"), JSON.stringify({ split: "held-in", outcomes: [] }));
fs.writeFileSync(path.join(outDir, "held-out.json"), JSON.stringify({ split: "held-out", outcomes: [] }));
`, "utf-8");
  return path;
}

function spawnEvaluator(opts: {
  repoRoot: string;
  candidateId: string;
  baselineHeldInId: string;
  baselineHeldOutId?: string;
  fakeOrchestrator: string;
  sentinel: string;
}): { status: number | null; stderr: string } {
  const args = [
    "scripts/candidate_evaluator.ts",
    "--candidate-id", opts.candidateId,
    "--base-harness", REAL_BASE,
    "--baseline-held-in", opts.baselineHeldInId,
  ];
  if (opts.baselineHeldOutId !== undefined) {
    args.push("--baseline-held-out", opts.baselineHeldOutId);
  }
  const result = spawnSync("node", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      SHOPPING_REPO_ROOT: opts.repoRoot,
      SHOPPING_EVAL_ORCHESTRATOR_CMD: `node ${opts.fakeOrchestrator}`,
      FAKE_SENTINEL: opts.sentinel,
    },
  });
  return { status: result.status, stderr: result.stderr };
}

test("spawn：缺 --baseline-held-out → 非零退出，fake orchestrator 未被调用，不创建评测目录", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base);
    makeCandidate(repo.root, "cand-ok");
    const sentinel = join(repo.root, "sentinel.txt");
    const fake = makeFakeOrchestrator(repo.root, sentinel);

    const result = spawnEvaluator({
      repoRoot: repo.root,
      candidateId: "cand-ok",
      baselineHeldInId: "b-in",
      // 不传 --baseline-held-out
      fakeOrchestrator: fake,
      sentinel,
    });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(sentinel), "fake orchestrator 不应被调用");
    assert.ok(!existsSync(join(repo.root, "evaluation", "candidates", "cand-ok")), "不应创建 candidate 评测目录");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("spawn：held-out baseline 文件缺失 → 零模型调用退出", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base);
    mkdirSync(join(repo.root, "evaluation", "baselines", "b-out"), { recursive: true });
    makeCandidate(repo.root, "cand-ok");
    const sentinel = join(repo.root, "sentinel.txt");
    const fake = makeFakeOrchestrator(repo.root, sentinel);

    const result = spawnEvaluator({
      repoRoot: repo.root,
      candidateId: "cand-ok",
      baselineHeldInId: "b-in",
      baselineHeldOutId: "b-out",
      fakeOrchestrator: fake,
      sentinel,
    });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(sentinel), "fake orchestrator 不应被调用");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("spawn：合法 base held-in + held-out → 进入 rollout，fake orchestrator 被调用", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base);
    writeBaseline(repo.root, "b-out", "held-out", [8, 9, 10, 11], repo.base);
    makeCandidate(repo.root, "cand-ok");
    const sentinel = join(repo.root, "sentinel.txt");
    const fake = makeFakeOrchestrator(repo.root, sentinel);

    const result = spawnEvaluator({
      repoRoot: repo.root,
      candidateId: "cand-ok",
      baselineHeldInId: "b-in",
      baselineHeldOutId: "b-out",
      fakeOrchestrator: fake,
      sentinel,
    });
    // 会进入 rollout（sentinel 被写）；之后 gate 可能 reject（candidate 结果为空），退出码可为非零
    assert.ok(existsSync(sentinel), "fake orchestrator 应被调用");
    void result;
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

function makeIncompleteOrchestrator(dir: string, sentinel: string): string {
  const path = join(dir, "fake-orchestrator-incomplete.js");
  writeFileSync(path, `const fs = require("fs");
const path = require("path");
fs.writeFileSync(process.env.FAKE_SENTINEL, "called", "utf-8");
const outDir = process.env.SHOPPING_EVAL_OUT_DIR;
fs.mkdirSync(outDir, { recursive: true });
const heldIn = Array.from({ length: 8 }, (_, i) => ({ task_id: i, status: "environment_done", reward_type: "gold_purchase" }));
const heldOut = Array.from({ length: 4 }, (_, i) => ({ task_id: 8 + i, status: "environment_done", reward_type: "gold_purchase" }));
fs.writeFileSync(path.join(outDir, "held-in.json"), JSON.stringify({ split: "held-in", outcomes: heldIn }));
fs.writeFileSync(path.join(outDir, "held-out.json"), JSON.stringify({ split: "held-out", outcomes: heldOut }));
`, "utf-8");
  return path;
}

test("spawn：candidate rollout 输出缺 reward_valid → gate rejected + schema_complete=false", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo.root, "b-in", "held-in", [0, 1, 2, 3, 4, 5, 6, 7], repo.base);
    writeBaseline(repo.root, "b-out", "held-out", [8, 9, 10, 11], repo.base);
    makeCandidate(repo.root, "cand-ok");
    const sentinel = join(repo.root, "sentinel.txt");
    const fake = makeIncompleteOrchestrator(repo.root, sentinel);

    const result = spawnEvaluator({
      repoRoot: repo.root,
      candidateId: "cand-ok",
      baselineHeldInId: "b-in",
      baselineHeldOutId: "b-out",
      fakeOrchestrator: fake,
      sentinel,
    });
    assert.ok(existsSync(sentinel), "fake orchestrator 应被调用");
    assert.notEqual(result.status, 0, "candidate outcome 不完整应 reject（非零退出）");
    const gatePath = join(repo.root, "evaluation", "candidates", "cand-ok", "gate.json");
    assert.ok(existsSync(gatePath), "应写 gate.json");
    const gate = JSON.parse(readFileSync(gatePath, "utf-8")) as Record<string, unknown>;
    assert.equal(gate["decision"], "rejected");
    assert.equal(gate["candidate_outcome_schema_complete"], false);
    assert.equal(gate["candidate_held_in_success"], null);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("bash help 只出现 --candidate-id", () => {
  const script = readFileSync(join(REPO_ROOT, "scripts", "evaluate_candidate.sh"), "utf-8");
  assert.ok(script.includes("--candidate-id"));
  assert.ok(!/--candidate\b(?!-id)/.test(script), "help 不应出现旧 --candidate");
});
