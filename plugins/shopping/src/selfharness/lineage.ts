/**
 * promotion lineage（纯逻辑，可离线测试，冻结基础设施）。
 *
 * lineage.json 记录一次 promotion 的完整可审计上下文，绝不包含 API key、
 * goal、gold、reward 数值、purchase、instruction、query、target、trace 原文。
 */

import type { GateDecision, GateRuleResult } from "./gate.ts";

export interface LineageMetrics {
  base_held_in_success: number;
  base_held_out_success: number | null;
  candidate_held_in_success: number;
  candidate_held_out_success: number | null;
}

export interface LineageModelIdentity {
  model_name: string;
  model_base_url: string;
}

export interface LineageRecord {
  schema_version: number;
  promoted_harness_id: string;
  promoted_harness_version: string;
  parent_harness_id: string;
  candidate_id: string;
  source_evidence_id: string;
  target_cluster_id: string;
  base_harness_id: string;
  base_harness_version: string;
  metrics: LineageMetrics;
  gate: {
    decision: "accepted" | "rejected";
    rules: GateRuleResult[];
  };
  model_identity: LineageModelIdentity;
  tool_surface_digest: string;
}

export interface BuildLineageInput {
  promotedHarnessId: string;
  promotedHarnessVersion: string;
  parentHarnessId: string;
  candidateId: string;
  sourceEvidenceId: string;
  targetClusterId: string;
  baseHarnessId: string;
  baseHarnessVersion: string;
  metrics: LineageMetrics;
  gate: GateDecision;
  modelIdentity: LineageModelIdentity;
  toolSurfaceDigest: string;
}

/** 构建 lineage.json 记录（纯函数）。 */
export function buildLineage(input: BuildLineageInput): LineageRecord {
  return {
    schema_version: 1,
    promoted_harness_id: input.promotedHarnessId,
    promoted_harness_version: input.promotedHarnessVersion,
    parent_harness_id: input.parentHarnessId,
    candidate_id: input.candidateId,
    source_evidence_id: input.sourceEvidenceId,
    target_cluster_id: input.targetClusterId,
    base_harness_id: input.baseHarnessId,
    base_harness_version: input.baseHarnessVersion,
    metrics: input.metrics,
    gate: input.gate,
    model_identity: input.modelIdentity,
    tool_surface_digest: input.toolSurfaceDigest,
  };
}
