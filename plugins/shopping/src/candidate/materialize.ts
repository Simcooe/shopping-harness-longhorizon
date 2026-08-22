/**
 * candidate materializer（冻结基础设施）：把受限 proposal 落成
 * harnesses/candidates/<candidate_id>/ 的 candidate Harness。
 *
 * 硬性约束：
 *   - 只复制 base harness，设置 parent_harness/version，再应用 proposal 的
 *     replace 编辑（仅 editable_surfaces 白名单内的文件）；
 *   - 候选必须经 loadHarness() 校验（schema + 冻结边界），失败即回滚删除；
 *   - 不使用 shell / JS / git apply，纯文件复制 + 受限 JSON 编辑。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { loadHarness, type HarnessDefinition } from "../harness/surface.ts";
import {
  assertSafeCandidateId,
  parseProposal,
  type Proposal,
} from "./schema.ts";

export class MaterializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterializeError";
  }
}

export interface MaterializeOptions {
  proposal: unknown;
  baseHarnessDir: string;
  candidatesDir: string;
  clock?: () => Date;
}

export interface MaterializedCandidate {
  candidateId: string;
  candidateDir: string;
  harness: HarnessDefinition;
  proposal: Proposal;
}

function buildCandidateManifest(base: HarnessDefinition, candidateId: string): string {
  const manifest = {
    schema_version: base.schemaVersion,
    harness_id: base.harnessId,
    parent_harness: base.harnessId,
    version: `${base.version}-candidate-${candidateId}`,
    system_prompt: base.systemPromptRef,
    tool_surface: base.toolSurfaceRef,
    runtime_policy: base.runtimePolicyRef,
    verification_policy: base.verificationPolicyRef,
    editable_surfaces: [...base.editableSurfaces],
  };
  return `${stringifyYaml(manifest)}\n`;
}

function copyIfExists(src: string, dest: string): void {
  if (existsSync(src)) {
    copyFileSync(src, dest);
  }
}

/** 把合法 proposal 落成 candidate（纯文件操作，可离线测试）。 */
export function materializeCandidate(options: MaterializeOptions): MaterializedCandidate {
  const proposal = parseProposal(options.proposal);
  assertSafeCandidateId(proposal.candidate_id);
  const clock = options.clock ?? (() => new Date());

  const base = loadHarness(options.baseHarnessDir);
  if (proposal.base_harness_id !== base.harnessId) {
    throw new MaterializeError(
      `proposal.base_harness_id（${proposal.base_harness_id}）与 base harness（${base.harnessId}）不一致`,
    );
  }

  const candidateDir = join(options.candidatesDir, proposal.candidate_id);
  if (existsSync(candidateDir)) {
    throw new MaterializeError(`candidate 已存在（不覆盖）: ${candidateDir}`);
  }

  mkdirSync(candidateDir, { recursive: true });
  try {
    // 1. 复制 base 的四个 editable surface 文件
    copyIfExists(join(options.baseHarnessDir, base.systemPromptRef), join(candidateDir, base.systemPromptRef));
    copyIfExists(join(options.baseHarnessDir, base.toolSurfaceRef), join(candidateDir, base.toolSurfaceRef));
    copyIfExists(join(options.baseHarnessDir, base.runtimePolicyRef), join(candidateDir, base.runtimePolicyRef));
    copyIfExists(join(options.baseHarnessDir, base.verificationPolicyRef), join(candidateDir, base.verificationPolicyRef));

    // 2. harness.yml：parent_harness + version（framework 元数据，非 proposal 编辑）
    writeFileSync(
      join(candidateDir, "harness.yml"),
      buildCandidateManifest(base, proposal.candidate_id),
      "utf-8",
    );

    // 3. 应用 proposal 的 replace 编辑（仅 editable_surfaces 白名单文件）
    for (const edit of proposal.edits) {
      writeFileSync(join(candidateDir, edit.path), edit.content, "utf-8");
    }

    // 4. candidate 必须经 loadHarness 校验（schema + 冻结边界）
    let harness: HarnessDefinition;
    try {
      harness = loadHarness(candidateDir);
    } catch (cause) {
      throw new MaterializeError(
        `candidate 校验失败: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    // 5. 写 proposal.json / audit.json / patch.json
    const audit = {
      schema_version: 1,
      candidate_id: proposal.candidate_id,
      base_harness_id: base.harnessId,
      base_harness_version: base.version,
      candidate_harness_version: harness.version,
      evidence_id: proposal.evidence_id,
      target_cluster_id: proposal.target_cluster_id,
      edited_files: proposal.edits.map((edit) => edit.path),
      validation: { ok: true },
      created_at: clock().toISOString(),
    };
    const patch = {
      schema_version: 1,
      candidate_id: proposal.candidate_id,
      base_harness_id: base.harnessId,
      base_harness_version: base.version,
      edits: proposal.edits,
    };
    writeFileSync(join(candidateDir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`, "utf-8");
    writeFileSync(join(candidateDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf-8");
    writeFileSync(join(candidateDir, "patch.json"), `${JSON.stringify(patch, null, 2)}\n`, "utf-8");

    return { candidateId: proposal.candidate_id, candidateDir, harness, proposal };
  } catch (cause) {
    // 回滚：删除本次创建的 candidate 目录
    rmSync(candidateDir, { recursive: true, force: true });
    throw cause;
  }
}
