/**
 * proposer 的离线测试：prompt 只含 held-in、JSON 提取、无 --live 不调模型。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildProposalPrompt,
  extractProposalJson,
  loadModelEnv,
  parseEnvFile,
  readEvidenceInput,
  readBaseHarnessInput,
  readModelConfig,
  type EvidenceInput,
} from "../../scripts/propose_harness_candidate.ts";
import { materializeCandidate } from "../../plugins/shopping/src/candidate/index.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

test("extractProposalJson 从 markdown 围栏与裸 JSON 中提取", () => {
  const obj = { schema_version: 1, candidate_id: "cand-x" };
  assert.deepEqual(extractProposalJson(`\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``), obj);
  assert.deepEqual(extractProposalJson(JSON.stringify(obj)), obj);
  assert.deepEqual(extractProposalJson(`前缀 ${JSON.stringify(obj)} 后缀`), obj);
});

test("readEvidenceInput 只读 held-in evidence，不读 held-out", () => {
  const dir = mkdtempSync(join(tmpdir(), "prop-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ baseline_run_id: "b1", benchmark_id: "x" }));
    writeFileSync(join(dir, "held-in-evidence.json"), JSON.stringify({
      evidence_id: "evidence-b1",
      failure_clusters: [{ cluster_id: "c1", support: 3 }],
    }));
    // held-out.json 含 sentinel，但 readEvidenceInput 绝不读它
    writeFileSync(join(dir, "held-out.json"), JSON.stringify({ secret: "HELD_OUT_SENTINEL" }));

    const input = readEvidenceInput(dir);
    const text = JSON.stringify(input);
    assert.ok(!text.includes("HELD_OUT_SENTINEL"), "held-out sentinel 泄漏进 proposer 输入");
    assert.ok(text.includes("c1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildProposalPrompt 含 held-in cluster 与 base 文件，不含 held-out 内容", () => {
  const evidence: EvidenceInput = {
    manifest: { baseline_run_id: "b1", benchmark_id: "shopping-development-v1" },
    evidence: {
      evidence_id: "evidence-b1",
      scope: { eligible_failure_count: 5 },
      source: { harness_id: "shopping-h0", harness_version: "0.1.0", benchmark_id: "shopping-development-v1" },
      failure_clusters: [],
    },
  };
  const base = readBaseHarnessInput(join(REPO_ROOT, "harnesses", "base"));
  const cluster = {
    cluster_id: "cluster-abc",
    failure_signature: { evaluator_outcome: "max_steps", execution_status: "evaluator_failure", agent_symptoms: ["repeated_primitive"] },
    support: 3,
    candidate_editable_surfaces: ["system-prompt.md", "tool-surface.yml", "runtime-policy.yml", "verification-policy.yml"],
  };
  const prompt = buildProposalPrompt({ evidence, base, cluster });
  assert.ok(prompt.includes("cluster-abc"));
  assert.ok(prompt.includes("max_steps"));
  assert.ok(prompt.includes("system-prompt.md"));
  assert.ok(!prompt.includes("HELD_OUT_SENTINEL"));
  // 不应包含具体敏感值（"不猜测 goal/gold/reward" 是 base prompt 的合法指令文本，不是泄漏）
  for (const forbidden of ["SECRET_GOAL", "B0GOLD_ASIN", "B0PURCHASE_ASIN", "123.456", "请购买某个具体商品"]) {
    assert.ok(!prompt.includes(forbidden), `proposer prompt 泄漏 ${forbidden}`);
  }
});

test("proposer 未传 --live 直接退出、不调用模型", () => {
  const result = spawnSync(
    "node",
    ["scripts/propose_harness_candidate.ts", "--evidence-dir", "evaluation/evidence/x", "--base-harness", "harnesses/base"],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未传 --live/);
});

test("parseEnvFile：支持注释/空行/引号；非法行跳过", () => {
  const parsed = parseEnvFile(
    "# 注释\n"
    + "\n"
    + "MODEL_NAME=deepseek-v4\n"
    + "MODEL_BASE_URL=\"https://api.example.com\"\n"
    + "MODEL_API_KEY='sk-quoted'\n"
    + "NO_EQUALS_LINE\n"
    + "=empty-key\n",
  );
  assert.equal(parsed["MODEL_NAME"], "deepseek-v4");
  assert.equal(parsed["MODEL_BASE_URL"], "https://api.example.com");
  assert.equal(parsed["MODEL_API_KEY"], "sk-quoted");
  assert.equal(parsed["NO_EQUALS_LINE"], undefined);
  assert.equal(parsed[""], undefined);
});

test("loadModelEnv：进程环境变量优先于 .env；只加载模型字段", () => {
  const dir = mkdtempSync(join(tmpdir(), "prop-env-"));
  try {
    writeFileSync(join(dir, ".env"), "MODEL_BASE_URL=file-url\nMODEL_API_KEY=file-key\nMODEL_NAME=file-model\nEXTRA_VAR=should-not-leak\n");
    // 进程环境里的 MODEL_NAME 优先
    const merged = loadModelEnv({ SHOPPING_ENV_FILE: join(dir, ".env"), MODEL_NAME: "proc-model" }, dir);
    assert.equal(merged["MODEL_NAME"], "proc-model");
    assert.equal(merged["MODEL_BASE_URL"], "file-url");
    assert.equal(merged["MODEL_API_KEY"], "file-key");
    assert.equal(merged["EXTRA_VAR"], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readModelConfig：缺字段报字段名不报值；完整字段可用", () => {
  // 缺 MODEL_NAME
  assert.throws(
    () => readModelConfig({ MODEL_BASE_URL: "https://x", MODEL_API_KEY: "k", MODEL_NAME: "" }),
    /MODEL_NAME/,
  );
  // 错误信息不含密钥值
  let message = "";
  try {
    readModelConfig({ MODEL_BASE_URL: "https://x", MODEL_API_KEY: "SECRET_KEY_VALUE", MODEL_NAME: "" });
  } catch (cause) {
    message = cause instanceof Error ? cause.message : String(cause);
  }
  assert.ok(!message.includes("SECRET_KEY_VALUE"), "错误信息不应泄漏密钥值");

  const config = readModelConfig({
    MODEL_BASE_URL: "https://api.example.com/",
    MODEL_API_KEY: "sk-test",
    MODEL_NAME: "deepseek-v4",
  });
  assert.equal(config.baseUrl, "https://api.example.com");
  assert.equal(config.model, "deepseek-v4");
  assert.equal(config.apiKey, "sk-test");
});

test("candidate/proposal 输出不含 API key", () => {
  const dir = mkdtempSync(join(tmpdir(), "prop-cand-"));
  try {
    const result = materializeCandidate({
      proposal: {
        schema_version: 1,
        candidate_id: "cand-nokey",
        base_harness_id: "shopping-h0",
        base_harness_version: "0.1.0",
        evidence_id: "evidence-x",
        target_cluster_id: "cluster-x",
        hypothesis: "测试",
        edits: [{ path: "system-prompt.md", operation: "replace", content: "prompt\n" }],
        expected_effect: "无",
        regression_risks: [],
      },
      baseHarnessDir: join(REPO_ROOT, "harnesses", "base"),
      candidatesDir: dir,
      clock: () => new Date("2026-08-22T00:00:00.000Z"),
    });
    for (const file of ["proposal.json", "audit.json", "patch.json", "harness.yml", "system-prompt.md"]) {
      const text = readFileSync(join(result.candidateDir, file), "utf-8");
      assert.ok(!text.includes("SECRET_KEY_VALUE"), `${file} 泄漏 API key`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
