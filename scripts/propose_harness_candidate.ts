#!/usr/bin/env node
/**
 * Self-Harness proposer：held-in evidence → 同一冻结模型 → 受限 candidate Harness。
 *
 * 用法：
 *   node scripts/propose_harness_candidate.ts \
 *     --evidence-dir evaluation/evidence/<baseline_run_id> \
 *     --base-harness harnesses/base \
 *     --count 3 \
 *     --live
 *
 * 安全红线：
 *   - 未传 --live 直接退出，不调用模型；
 *   - 只读 held-in-evidence.json + evidence manifest.json + base harness 的
 *     editable 文件与 manifest；绝不读 held-out / Final-200 / 原始 trace /
 *     原始 evaluator record；
 *   - proposer 输入不含 task instruction / query / target / goal / gold /
 *     purchase / reward 数值；
 *   - proposer 与 actor 使用完全相同的 MODEL_BASE_URL / MODEL_API_KEY /
 *     MODEL_NAME / temperature；
 *   - 输出是严格 proposal JSON，校验后才 materialize candidate。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { materializeCandidate } from "../plugins/shopping/src/candidate/materialize.ts";
import { parseProposal } from "../plugins/shopping/src/candidate/schema.ts";
import { loadHarness, type HarnessDefinition } from "../plugins/shopping/src/harness/surface.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES_DIR = join(REPO_ROOT, "harnesses", "candidates");
const BASELINE_EVAL_CONFIG = join(REPO_ROOT, "configs", "evaluation", "h0-baseline-v1.yml");
/** 只加载本项目需要的模型字段，避免把任意 .env 内容扩散到日志/内存。 */
const MODEL_ENV_KEYS = ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME"] as const;

function fail(message: string): never {
  console.error(`[propose_harness_candidate] ${message}`);
  process.exit(2);
}

/**
 * 解析简单 KEY=VALUE .env（不 shell out，不写任何文件）。
 * 支持空行、# 注释、单/双引号包裹的值；每行最多一个 `=`；非法行跳过。
 */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (key.length === 0) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    // 去引号（简单支持 '...' / "..."）
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** 已存在的进程环境变量优先于 .env；不打印任何密钥。 */
export function loadModelEnv(
  env: Record<string, string | undefined>,
  repoRoot: string,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  const envFile = env["SHOPPING_ENV_FILE"] ?? ".env";
  const envPath = envFile.startsWith("/") ? envFile : join(repoRoot, envFile);
  let fromFile: Record<string, string> = {};
  if (existsSync(envPath)) {
    fromFile = parseEnvFile(readFileSync(envPath, "utf-8"));
  }
  for (const key of MODEL_ENV_KEYS) {
    const processValue = env[key]?.trim();
    const fileValue = fromFile[key]?.trim();
    merged[key] = (processValue !== undefined && processValue.length > 0)
      ? processValue
      : (fileValue !== undefined && fileValue.length > 0 ? fileValue : undefined);
  }
  return merged;
}

export interface EvidenceInput {
  manifest: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

/** 只读 held-in evidence + manifest（绝不读 held-out / trace / evaluator record）。 */
export function readEvidenceInput(evidenceDir: string): EvidenceInput {
  const manifest = JSON.parse(
    readFileSync(join(evidenceDir, "manifest.json"), "utf-8"),
  ) as Record<string, unknown>;
  const evidence = JSON.parse(
    readFileSync(join(evidenceDir, "held-in-evidence.json"), "utf-8"),
  ) as Record<string, unknown>;
  return { manifest, evidence };
}

export interface BaseHarnessInput {
  harness: HarnessDefinition;
  files: Record<string, string>;
}

/** 读 base harness 的 editable 文件内容（供 proposer 参考当前实现）。 */
export function readBaseHarnessInput(baseHarnessDir: string): BaseHarnessInput {
  const harness = loadHarness(baseHarnessDir);
  const files: Record<string, string> = {
    "harness.yml": readFileSync(join(baseHarnessDir, "harness.yml"), "utf-8"),
    [harness.systemPromptRef]: readFileSync(join(baseHarnessDir, harness.systemPromptRef), "utf-8"),
    [harness.toolSurfaceRef]: readFileSync(join(baseHarnessDir, harness.toolSurfaceRef), "utf-8"),
    [harness.runtimePolicyRef]: readFileSync(join(baseHarnessDir, harness.runtimePolicyRef), "utf-8"),
    [harness.verificationPolicyRef]: readFileSync(join(baseHarnessDir, harness.verificationPolicyRef), "utf-8"),
  };
  return { harness, files };
}

export interface BuildPromptOptions {
  evidence: EvidenceInput;
  base: BaseHarnessInput;
  cluster: Record<string, unknown>;
}

/** 构建 proposer prompt（纯函数，可离线测试；只含 held-in evidence + base 文件）。 */
export function buildProposalPrompt(options: BuildPromptOptions): string {
  const evidence = options.evidence.evidence;
  const scope = evidence["scope"] ?? {};
  const source = evidence["source"] ?? {};
  const cluster = options.cluster;

  const editableSurfaces = Array.isArray(cluster["candidate_editable_surfaces"])
    ? (cluster["candidate_editable_surfaces"] as string[])
    : [];

  const parts: string[] = [];
  parts.push("You are a harness engineer proposing a MINIMAL, verifiable edit to a shopping agent's harness.");
  parts.push("");
  parts.push("CONTEXT");
  parts.push(`- harness_id: ${String(source["harness_id"] ?? "shopping-h0")}`);
  parts.push(`- harness_version: ${String(source["harness_version"] ?? "")}`);
  parts.push(`- benchmark_id: ${String(source["benchmark_id"] ?? "")}`);
  parts.push(`- evidence_id: ${String(evidence["evidence_id"] ?? "")}`);
  parts.push(`- scope: ${JSON.stringify(scope)}`);
  parts.push("");
  parts.push("FAILURE CLUSTER TO ADDRESS (one cluster only):");
  parts.push(JSON.stringify(cluster, null, 2));
  parts.push("");
  parts.push("CURRENT HARNESS FILES (editable surfaces only):");
  for (const file of editableSurfaces) {
    const content = options.base.files[file];
    parts.push(`--- ${file} ---`);
    parts.push(content ?? "(missing)");
  }
  parts.push("");
  parts.push("RULES:");
  parts.push("- Target ONLY the cluster above; do not hardcode any specific held-in task, product, or query.");
  parts.push("- Minimal change. Explain the hypothesis. Do not add environment capabilities.");
  parts.push("- Only edit these editable surfaces (at most 2 files, replace whole file):");
  parts.push(`  ${editableSurfaces.join(", ")}`);
  parts.push("- Do NOT edit harness.yml, the editable_surfaces whitelist, primitive mapping, reward, evaluator, or any frozen layer.");
  parts.push("- Output STRICT JSON only (no markdown, no commentary), matching this schema:");
  parts.push(JSON.stringify({
    schema_version: 1,
    candidate_id: "proposal-<short-id>",
    base_harness_id: String(source["harness_id"] ?? "shopping-h0"),
    base_harness_version: String(source["harness_version"] ?? ""),
    evidence_id: String(evidence["evidence_id"] ?? ""),
    target_cluster_id: String(cluster["cluster_id"] ?? ""),
    hypothesis: "<why this change helps>",
    edits: [{ path: "system-prompt.md", operation: "replace", content: "<full new file content>" }],
    expected_effect: "<what should change>",
    regression_risks: ["<risk>"],
  }, null, 2));
  parts.push("");

  return parts.join("\n");
}

/** 从模型输出中提取 JSON 对象（宽容提取，随后 parseProposal 严格校验）。 */
export function extractProposalJson(text: string): unknown {
  const trimmed = text.trim();
  // 去掉 ```json ... ``` 或 ``` ... ``` 围栏
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch !== null ? fenceMatch[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("模型输出不含可解析的 JSON 对象");
  }
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

/** 从合并后的模型环境读取配置；缺字段时抛错（只报字段名、不打印值）。 */
export function readModelConfig(modelEnv: Record<string, string | undefined>): ModelConfig {
  const missing = MODEL_ENV_KEYS.filter((key) => {
    const value = modelEnv[key]?.trim();
    return value === undefined || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`缺少模型配置字段: ${missing.join(", ")}（请填写 SHOPPING_ENV_FILE / .env；值不打印）`);
  }
  const baseUrl = String(modelEnv["MODEL_BASE_URL"] ?? "").trim().replace(/\/+$/, "");
  const temperature = readBaselineTemperature();
  return {
    baseUrl,
    apiKey: String(modelEnv["MODEL_API_KEY"] ?? "").trim(),
    model: String(modelEnv["MODEL_NAME"] ?? "").trim(),
    temperature,
  };
}

/** 读 h0 baseline 配置的 temperature（与 actor 同一来源；用正则避免脚本级 yaml 依赖）。 */
export function readBaselineTemperature(): number {
  try {
    const text = readFileSync(BASELINE_EVAL_CONFIG, "utf-8");
    const match = text.match(/^temperature:\s*([0-9.]+)\s*$/m);
    return match !== null ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/** 与 actor 相同的模型调用（OpenAI-compatible /chat/completions）。 */
export async function callModel(config: ModelConfig, prompt: string): Promise<string> {
  const url = `${config.baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      messages: [
        { role: "system", content: "You output strict JSON only." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`模型请求失败 HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("模型响应缺少 choices");
  }
  const message = (choices[0] as Record<string, unknown>)?.["message"];
  const content = (message as Record<string, unknown> | undefined)?.["content"];
  if (typeof content !== "string") {
    throw new Error("模型响应缺少 message.content");
  }
  return content;
}

function main(): void {
  const argv = process.argv.slice(2);
  const live = argv.includes("--live");
  if (!live) {
    fail("未传 --live：proposer 不调用模型，直接退出。");
  }
  const evidenceIdx = argv.indexOf("--evidence-dir");
  const evidenceDir = evidenceIdx >= 0 ? argv[evidenceIdx + 1] : undefined;
  const baseIdx = argv.indexOf("--base-harness");
  const baseHarnessArg = baseIdx >= 0 ? argv[baseIdx + 1] : undefined;
  const countIdx = argv.indexOf("--count");
  const count = countIdx >= 0 ? Number(argv[countIdx + 1]) : 1;
  if (evidenceDir === undefined || baseHarnessArg === undefined) {
    fail("用法: propose_harness_candidate.ts --evidence-dir <dir> --base-harness <dir> [--count N] --live");
  }
  if (!Number.isInteger(count) || count < 1) {
    fail("--count 必须是正整数");
  }

  const baseHarnessDir = baseHarnessArg.startsWith("/")
    ? baseHarnessArg
    : join(REPO_ROOT, baseHarnessArg);
  const resolvedEvidenceDir = evidenceDir.startsWith("/")
    ? evidenceDir
    : join(REPO_ROOT, evidenceDir);

  // 在读取 evidence / 调用模型前，先加载 .env（进程环境优先），缺 .env/字段即退出。
  const envFile = process.env["SHOPPING_ENV_FILE"] ?? ".env";
  const envPath = envFile.startsWith("/") ? envFile : join(REPO_ROOT, envFile);
  if (!existsSync(envPath)) {
    fail(`缺少 ${envPath}：请先 cp .env.example .env 并填写 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME。`);
  }
  const modelEnv = loadModelEnv(process.env, REPO_ROOT);

  const evidence = readEvidenceInput(resolvedEvidenceDir);
  const base = readBaseHarnessInput(baseHarnessDir);
  let config: ModelConfig;
  try {
    config = readModelConfig(modelEnv);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
    return;
  }

  const clustersRaw = (evidence.evidence["failure_clusters"] ?? []);
  if (!Array.isArray(clustersRaw)) {
    fail("evidence 缺少 failure_clusters 数组");
  }
  const clusters = (clustersRaw as Array<Record<string, unknown>>)
    .slice()
    .sort((a, b) => (Number(b["support"] ?? 0) - Number(a["support"] ?? 0)))
    .slice(0, count);

  void main0(clusters, evidence, base, config).catch((cause) => {
    fail(cause instanceof Error ? cause.message : String(cause));
  });
}

async function main0(
  clusters: Array<Record<string, unknown>>,
  evidence: EvidenceInput,
  base: BaseHarnessInput,
  config: ModelConfig,
): Promise<void> {
  for (const cluster of clusters) {
    const prompt = buildProposalPrompt({ evidence, base, cluster });
    console.error(`[propose_harness_candidate] 针对 cluster=${String(cluster["cluster_id"] ?? "?")} 提出 candidate...`);
    const raw = await callModel(config, prompt);
    const json = extractProposalJson(raw);
    const proposal = parseProposal(json);
    const materialized = materializeCandidate({
      proposal,
      baseHarnessDir: base.harness.dir,
      candidatesDir: CANDIDATES_DIR,
    });
    console.error(
      `[propose_harness_candidate] materialized candidate=${materialized.candidateId} `
      + `harness=${materialized.harness.harnessId}@${materialized.harness.version}`,
    );
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
