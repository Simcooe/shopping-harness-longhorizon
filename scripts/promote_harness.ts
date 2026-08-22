#!/usr/bin/env node
/**
 * promotion + lineage（只在 gate.json 明确 accepted 后运行）。
 *
 * 用法：node scripts/promote_harness.ts --candidate-id <candidate_id>
 *
 * 输出 harnesses/promoted/<candidate_id>/（5 个 harness 文件 + proposal/audit/
 * gate/lineage）。绝不覆盖 base harness，绝不覆盖已有 promoted。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadHarness } from "../plugins/shopping/src/harness/surface.ts";
import { buildLineage, type GateDecision } from "../plugins/shopping/src/selfharness/index.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  console.error(`[promote_harness] ${message}`);
  process.exit(1);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function main(): void {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--candidate-id");
  const candidateId = idx >= 0 ? argv[idx + 1] : undefined;
  if (candidateId === undefined || candidateId.length === 0) {
    fail("用法: promote_harness.ts --candidate-id <candidate_id>");
  }

  const candidateDir = join(REPO_ROOT, "harnesses", "candidates", candidateId);
  const gatePath = join(REPO_ROOT, "evaluation", "candidates", candidateId, "gate.json");
  if (!existsSync(gatePath)) {
    fail(`candidate 尚无 gate 结果（未评测）: ${gatePath}`);
  }
  const gate = readJson(gatePath) as unknown as GateDecision & {
    tool_surface_digest?: string;
    model_identity?: { model_name?: string; model_base_url?: string };
  };
  if (gate.decision !== "accepted") {
    fail(`candidate 未被 gate 接受（decision=${gate.decision}），拒绝 promote`);
  }

  const harness = loadHarness(candidateDir);
  const proposal = readJson(join(candidateDir, "proposal.json"));
  const audit = readJson(join(candidateDir, "audit.json"));

  const promotedDir = join(REPO_ROOT, "harnesses", "promoted", candidateId);
  if (existsSync(promotedDir)) {
    fail(`promoted 已存在（不覆盖）: ${promotedDir}`);
  }
  mkdirSync(promotedDir, { recursive: true });

  // 复制 5 个 harness 文件 + proposal/audit/gate
  for (const file of [
    "harness.yml",
    harness.systemPromptRef,
    harness.toolSurfaceRef,
    harness.runtimePolicyRef,
    harness.verificationPolicyRef,
  ]) {
    copyFileSync(join(candidateDir, file), join(promotedDir, file));
  }
  copyFileSync(join(candidateDir, "proposal.json"), join(promotedDir, "proposal.json"));
  copyFileSync(join(candidateDir, "audit.json"), join(promotedDir, "audit.json"));
  copyFileSync(gatePath, join(promotedDir, "gate.json"));

  const lineage = buildLineage({
    promotedHarnessId: harness.harnessId,
    promotedHarnessVersion: harness.version,
    parentHarnessId: harness.parentHarness ?? String(proposal["base_harness_id"] ?? ""),
    candidateId,
    sourceEvidenceId: String(proposal["evidence_id"] ?? ""),
    targetClusterId: String(proposal["target_cluster_id"] ?? ""),
    baseHarnessId: String(proposal["base_harness_id"] ?? ""),
    baseHarnessVersion: String(proposal["base_harness_version"] ?? ""),
    metrics: {
      base_held_in_success: gate.base_held_in_success,
      base_held_out_success: gate.base_held_out_success,
      candidate_held_in_success: gate.candidate_held_in_success,
      candidate_held_out_success: gate.candidate_held_out_success,
    },
    gate: { decision: gate.decision, rules: gate.rules },
    modelIdentity: {
      model_name: gate.model_identity?.model_name ?? "",
      model_base_url: gate.model_identity?.model_base_url ?? "",
    },
    toolSurfaceDigest: gate.tool_surface_digest ?? harness.toolSurfaceDigest,
  });

  writeFileSync(join(promotedDir, "lineage.json"), `${JSON.stringify(lineage, null, 2)}\n`, "utf-8");
  console.error(
    `[promote_harness] promoted=${candidateId} harness=${harness.harnessId}@${harness.version}`,
  );
  void audit;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
