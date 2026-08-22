/**
 * candidate proposal schema（Self-Harness 候选补丁的受限表示，冻结基础设施）。
 *
 * proposal 是 proposer 输出给 materializer 的严格 JSON。约束（不可放宽）：
 *   - 最多修改 2 个 editable file（editable_surfaces 白名单内）；
 *   - 只允许 replace 操作（content 为完整新文件内容）；
 *   - content 长度受限；
 *   - 不能修改 harness.yml 的 editable_surfaces 白名单；
 *   - candidate_id 安全、确定、不可路径穿越。
 * proposal 绝不包含 API key、goal、gold、reward 数值、完整 trace。
 */

export const PROPOSAL_SCHEMA_VERSION = 1;

/** 与 harnesses/base/harness.yml 的 editable_surfaces 一致的固定白名单。 */
export const EDITABLE_SURFACES = [
  "system-prompt.md",
  "tool-surface.yml",
  "runtime-policy.yml",
  "verification-policy.yml",
] as const;

export const MAX_PROPOSAL_EDITS = 2;
export const MAX_EDIT_CONTENT_CHARS = 8000;
export const MAX_HYPOTHESIS_CHARS = 4000;

/** candidate_id：小写字母/数字/连字符，长度 1..64，不以连字符开头。 */
export const CANDIDATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

export interface ProposalEdit {
  path: string;
  operation: "replace";
  content: string;
}

export interface Proposal {
  schema_version: number;
  candidate_id: string;
  base_harness_id: string;
  base_harness_version: string;
  evidence_id: string;
  target_cluster_id: string;
  hypothesis: string;
  edits: ProposalEdit[];
  expected_effect: string;
  regression_risks: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验 candidate_id 安全（无路径穿越、无分隔符、合法字符集）。 */
export function assertSafeCandidateId(candidateId: string): void {
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new ProposalError(
      `candidate_id 非法（须小写字母/数字/连字符，长度 1..64）: ${candidateId}`,
    );
  }
  if (candidateId.includes("..") || candidateId.includes("/") || candidateId.includes("\\")) {
    throw new ProposalError(`candidate_id 含路径分隔符: ${candidateId}`);
  }
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProposalError(`${key} 必须是非空字符串`);
  }
  return value;
}

function parseEdits(value: unknown): ProposalEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProposalError("edits 必须是非空数组");
  }
  if (value.length > MAX_PROPOSAL_EDITS) {
    throw new ProposalError(`edits 最多 ${MAX_PROPOSAL_EDITS} 个文件`);
  }
  const seen = new Set<string>();
  const edits: ProposalEdit[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isObject(entry)) {
      throw new ProposalError(`edits[${index}] 必须是对象`);
    }
    const path = requireString(entry, "path");
    if (!(EDITABLE_SURFACES as readonly string[]).includes(path)) {
      throw new ProposalError(
        `edits[${index}].path 不在 editable_surfaces 白名单: ${path}`,
      );
    }
    if (seen.has(path)) {
      throw new ProposalError(`edits 含重复文件: ${path}`);
    }
    seen.add(path);
    if (entry["operation"] !== "replace") {
      throw new ProposalError(`edits[${index}].operation 只能是 replace`);
    }
    const content = entry["content"];
    if (typeof content !== "string" || content.length === 0) {
      throw new ProposalError(`edits[${index}].content 必须是非空字符串`);
    }
    if (content.length > MAX_EDIT_CONTENT_CHARS) {
      throw new ProposalError(
        `edits[${index}].content 超过 ${MAX_EDIT_CONTENT_CHARS} 字符上限`,
      );
    }
    edits.push({ path, operation: "replace", content });
  }
  return edits;
}

/** 解析并严格校验 proposal JSON（纯函数，可离线测试）。 */
export function parseProposal(json: unknown): Proposal {
  if (!isObject(json)) {
    throw new ProposalError("proposal 必须是对象");
  }
  if (json["schema_version"] !== PROPOSAL_SCHEMA_VERSION) {
    throw new ProposalError("schema_version 必须为 1");
  }
  const candidateId = requireString(json, "candidate_id");
  assertSafeCandidateId(candidateId);

  const hypothesis = requireString(json, "hypothesis");
  if (hypothesis.length > MAX_HYPOTHESIS_CHARS) {
    throw new ProposalError(`hypothesis 超过 ${MAX_HYPOTHESIS_CHARS} 字符上限`);
  }
  const expectedEffect = requireString(json, "expected_effect");
  const risksRaw = json["regression_risks"];
  if (!Array.isArray(risksRaw) || !risksRaw.every((entry) => typeof entry === "string")) {
    throw new ProposalError("regression_risks 必须是字符串数组");
  }

  return {
    schema_version: PROPOSAL_SCHEMA_VERSION,
    candidate_id: candidateId,
    base_harness_id: requireString(json, "base_harness_id"),
    base_harness_version: requireString(json, "base_harness_version"),
    evidence_id: requireString(json, "evidence_id"),
    target_cluster_id: requireString(json, "target_cluster_id"),
    hypothesis,
    edits: parseEdits(json["edits"]),
    expected_effect: expectedEffect,
    regression_risks: risksRaw as string[],
  };
}
