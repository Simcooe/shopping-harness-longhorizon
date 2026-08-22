/**
 * candidate materializer 与 proposal schema 的离线测试。
 * 不调用模型、不启动 ShopSimulator、不修改 harnesses/base（只读复制）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  materializeCandidate,
  parseProposal,
  ProposalError,
} from "../../plugins/shopping/src/candidate/index.ts";
import { loadHarness } from "../../plugins/shopping/src/harness/surface.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const BASE_HARNESS = join(REPO_ROOT, "harnesses", "base");

function makeProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    candidate_id: "cand-test-1",
    base_harness_id: "shopping-h0",
    base_harness_version: "0.1.0",
    evidence_id: "evidence-x",
    target_cluster_id: "cluster-x",
    hypothesis: "减少重复 primitive，缓解 max_steps。",
    edits: [{ path: "system-prompt.md", operation: "replace", content: "新的 system prompt 内容\n" }],
    expected_effect: "减少重复点击",
    regression_risks: ["可能降低探索性"],
    ...overrides,
  };
}

test("合法 proposal 能 materialize candidate：parent_harness/version/files 正确", () => {
  const dir = mkdtempSync(join(tmpdir(), "cand-"));
  try {
    const result = materializeCandidate({
      proposal: makeProposal(),
      baseHarnessDir: BASE_HARNESS,
      candidatesDir: dir,
      clock: () => new Date("2026-08-22T00:00:00.000Z"),
    });

    assert.equal(result.candidateId, "cand-test-1");
    assert.equal(result.harness.harnessId, "shopping-h0");
    assert.equal(result.harness.parentHarness, "shopping-h0");
    assert.match(result.harness.version, /0\.1\.0-candidate-cand-test-1/);

    // 5 个 harness 文件 + proposal/audit/patch 都在
    for (const file of [
      "harness.yml", "system-prompt.md", "tool-surface.yml",
      "runtime-policy.yml", "verification-policy.yml",
      "proposal.json", "audit.json", "patch.json",
    ]) {
      assert.ok(existsSync(join(result.candidateDir, file)), `缺少 ${file}`);
    }
    // system-prompt.md 是编辑后的新内容
    assert.equal(
      readFileSync(join(result.candidateDir, "system-prompt.md"), "utf-8"),
      "新的 system prompt 内容\n",
    );
    // candidate 可被 loadHarness 再加载
    assert.equal(loadHarness(result.candidateDir).harnessId, "shopping-h0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate_id 路径穿越被拒绝", () => {
  for (const bad of ["../evil", "a/b", "a\\b", "..", "-x", "X", ""]) {
    assert.throws(
      () => parseProposal(makeProposal({ candidate_id: bad })),
      ProposalError,
      `candidate_id 应被拒绝: ${bad}`,
    );
  }
});

test("proposal 修改冻结文件（harness.yml）或白名单之外的文件被拒绝", () => {
  assert.throws(
    () => parseProposal(makeProposal({
      edits: [{ path: "harness.yml", operation: "replace", content: "x" }],
    })),
    /editable_surfaces 白名单/,
  );
  assert.throws(
    () => parseProposal(makeProposal({
      edits: [{ path: "verification-policy.yml", operation: "append", content: "x" }],
    })),
    /operation 只能是 replace/,
  );
});

test("proposal 超过 2 个文件或内容超长被拒绝", () => {
  const three = makeProposal({
    edits: [
      { path: "system-prompt.md", operation: "replace", content: "a" },
      { path: "tool-surface.yml", operation: "replace", content: "b" },
      { path: "runtime-policy.yml", operation: "replace", content: "c" },
    ],
  });
  assert.throws(() => parseProposal(three), /最多 2 个文件/);

  const long = makeProposal({
    edits: [{ path: "system-prompt.md", operation: "replace", content: "x".repeat(9000) }],
  });
  assert.throws(() => parseProposal(long), /字符上限/);
});

test("candidate 不能放宽 verification-policy（materialize 失败并回滚）", () => {
  const dir = mkdtempSync(join(tmpdir(), "cand-"));
  try {
    const relaxed = makeProposal({
      candidate_id: "cand-relax",
      edits: [{
        path: "verification-policy.yml",
        operation: "replace",
        content: [
          "schema_version: 1",
          "completion_requires_environment_done: false",
          "reward_only_in_evaluator_record: true",
          "actor_sees_reward: false",
          "finish_equals_success: false",
          "evaluator_feedback_into_same_rollout: false",
        ].join("\n") + "\n",
      }],
    });
    assert.throws(
      () => materializeCandidate({ proposal: relaxed, baseHarnessDir: BASE_HARNESS, candidatesDir: dir }),
      /校验失败|冻结边界/,
    );
    // 回滚：不留下 candidate 目录
    assert.equal(existsSync(join(dir, "cand-relax")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate 不能更改 primitive mapping（materialize 失败）", () => {
  const dir = mkdtempSync(join(tmpdir(), "cand-"));
  try {
    const badPrimitive = makeProposal({
      candidate_id: "cand-badprim",
      edits: [{
        path: "tool-surface.yml",
        operation: "replace",
        content: [
          "schema_version: 1",
          "tools:",
          "  - name: shop_search",
          "    primitive: shell",
          "    description: x",
          "    parameters:",
          "      - name: query",
          "        type: string",
          "        required: true",
          "    binding:",
          "      query: query",
        ].join("\n") + "\n",
      }],
    });
    assert.throws(
      () => materializeCandidate({ proposal: badPrimitive, baseHarnessDir: BASE_HARNESS, candidatesDir: dir }),
      /校验失败|primitive/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
