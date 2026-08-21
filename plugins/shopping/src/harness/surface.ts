/**
 * Canonical harness 表示的加载与校验（冻结基础设施）。
 *
 * 职责边界：
 *   - 本模块是**冻结基础设施**：tool-surface resolver / schema validator；
 *   - 某个 harness 目录下的 YAML 内容才是未来 candidate 可修改对象；
 *   - primitive → 环境 action 的真实映射在代码中冻结（YAML 只能引用
 *     已声明的 primitive 与参数绑定，不能表达任意 shell/URL/JS/任意
 *     环境 action）。
 *
 * h0 的三个 primitive（覆盖 ShopSimulator 原生完整动作语言）：
 *   search → search[query]
 *   click  → click[target]
 *   finish → finish[no_suitable_product]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

/** 冻结 primitive 枚举：YAML 只能引用这三个值。 */
export const FROZEN_PRIMITIVES = ["search", "click", "finish"] as const;
export type Primitive = (typeof FROZEN_PRIMITIVES)[number];

/** 每个 primitive 的唯一参数名（冻结）。 */
export const PRIMITIVE_ARGS: Record<Primitive, string> = {
  search: "query",
  click: "target",
  finish: "reason",
};

export const HARNESS_SCHEMA_VERSION = 1;
export const TOOL_SURFACE_SCHEMA_VERSION = 1;

export class HarnessLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessLoadError";
  }
}

export interface ToolSurfaceParameter {
  name: string;
  type: "string";
  required: boolean;
  minLength?: number;
  maxLength?: number;
  enum?: readonly string[];
}

export interface ToolSurfaceEntry {
  name: string;
  primitive: Primitive;
  description: string;
  parameters: ToolSurfaceParameter[];
  /** 工具参数名 → primitive 参数名（必须一一对应 primitive 的唯一参数）。 */
  binding: Record<string, string>;
}

export interface ToolSurface {
  schema_version: number;
  tools: ToolSurfaceEntry[];
}

export interface RuntimePolicy {
  maxEnvironmentSteps: number;
  maxConsecutiveGuardRejections: number;
  onToolError: string;
  onMaxSteps: string;
  onEnvironmentDone: string;
}

export interface VerificationPolicy {
  completionRequiresEnvironmentDone: boolean;
  rewardOnlyInEvaluatorRecord: boolean;
  actorSeesReward: boolean;
  finishEqualsSuccess: boolean;
  evaluatorFeedbackIntoSameRollout: boolean;
}

export interface HarnessDefinition {
  schemaVersion: number;
  harnessId: string;
  parentHarness: string | null;
  version: string;
  dir: string;
  systemPromptRef: string;
  systemPromptText: string;
  toolSurfaceRef: string;
  toolSurface: ToolSurface;
  /** tool-surface 的 canonical digest（记录进 actor trace）。 */
  toolSurfaceDigest: string;
  runtimePolicyRef: string;
  runtimePolicy: RuntimePolicy;
  verificationPolicyRef: string;
  verificationPolicy: VerificationPolicy;
  /** 可编辑面白名单（声明性；执行由 candidate 流程负责，本阶段不实现）。 */
  editableSurfaces: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 防御：YAML 解析结果中不得出现可执行内容（函数等）。 */
function assertNoExecutableContent(value: unknown, path = "$"): void {
  if (typeof value === "function") {
    throw new HarnessLoadError(`harness 配置含可执行内容: ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoExecutableContent(entry, `${path}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoExecutableContent(entry, `${path}.${key}`);
    }
  }
}

function readYamlFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new HarnessLoadError(`harness 文件不存在或不可读: ${path}`);
  }
  let parsed: unknown;
  try {
    // 显式禁用自定义 tag 解析：未知 tag（如 !!js/*）直接报错
    parsed = parseYaml(raw, { uniqueKeys: true });
  } catch (cause) {
    throw new HarnessLoadError(
      `harness YAML 解析失败: ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  assertNoExecutableContent(parsed);
  if (!isObject(parsed)) {
    throw new HarnessLoadError(`harness YAML 顶层必须是映射: ${path}`);
  }
  return parsed;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 校验 tool-surface.yml（唯一工具配置来源）。 */
export function parseToolSurface(data: Record<string, unknown>, refPath: string): ToolSurface {
  if (data["schema_version"] !== TOOL_SURFACE_SCHEMA_VERSION) {
    throw new HarnessLoadError(`${refPath}: tool-surface schema_version 必须为 1`);
  }
  const toolsRaw = data["tools"];
  if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) {
    throw new HarnessLoadError(`${refPath}: tools 必须是非空数组`);
  }
  const seen = new Set<string>();
  const tools: ToolSurfaceEntry[] = [];
  for (const [index, entryRaw] of toolsRaw.entries()) {
    const at = `${refPath}: tools[${index}]`;
    if (!isObject(entryRaw)) {
      throw new HarnessLoadError(`${at}: 必须是映射`);
    }
    const name = entryRaw["name"];
    if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
      throw new HarnessLoadError(`${at}: name 非法（小写字母开头的蛇形命名）`);
    }
    if (seen.has(name)) {
      throw new HarnessLoadError(`${at}: 工具名重复: ${name}`);
    }
    seen.add(name);

    const primitive = entryRaw["primitive"];
    if (typeof primitive !== "string"
      || !(FROZEN_PRIMITIVES as readonly string[]).includes(primitive)) {
      throw new HarnessLoadError(
        `${at}: 未知 primitive: ${String(primitive)}（仅允许 ${FROZEN_PRIMITIVES.join("/")}）`,
      );
    }
    const description = entryRaw["description"];
    if (typeof description !== "string" || description.length === 0) {
      throw new HarnessLoadError(`${at}: description 必须是非空字符串`);
    }

    // parameters：仅字符串参数，字段受限（不允许任意 schema 扩展）
    const paramsRaw = entryRaw["parameters"];
    if (!Array.isArray(paramsRaw)) {
      throw new HarnessLoadError(`${at}: parameters 必须是数组`);
    }
    const parameters: ToolSurfaceParameter[] = [];
    for (const [paramIndex, paramRaw] of paramsRaw.entries()) {
      const pat = `${at}.parameters[${paramIndex}]`;
      if (!isObject(paramRaw)) {
        throw new HarnessLoadError(`${pat}: 必须是映射`);
      }
      const paramName = paramRaw["name"];
      if (typeof paramName !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(paramName)) {
        throw new HarnessLoadError(`${pat}: name 非法`);
      }
      if (paramRaw["type"] !== "string") {
        throw new HarnessLoadError(`${pat}: type 必须是 "string"`);
      }
      const param: ToolSurfaceParameter = {
        name: paramName,
        type: "string",
        required: paramRaw["required"] === true,
      };
      if (paramRaw["min_length"] !== undefined) {
        if (typeof paramRaw["min_length"] !== "number") {
          throw new HarnessLoadError(`${pat}: min_length 必须是数字`);
        }
        param.minLength = paramRaw["min_length"];
      }
      if (paramRaw["max_length"] !== undefined) {
        if (typeof paramRaw["max_length"] !== "number") {
          throw new HarnessLoadError(`${pat}: max_length 必须是数字`);
        }
        param.maxLength = paramRaw["max_length"];
      }
      if (paramRaw["enum"] !== undefined) {
        if (!Array.isArray(paramRaw["enum"])
          || !paramRaw["enum"].every((entry) => typeof entry === "string")) {
          throw new HarnessLoadError(`${pat}: enum 必须是字符串数组`);
        }
        param.enum = paramRaw["enum"] as string[];
      }
      parameters.push(param);
    }

    // binding：工具参数 → primitive 参数；必须恰好绑定 primitive 的唯一参数
    const bindingRaw = entryRaw["binding"];
    if (!isObject(bindingRaw)) {
      throw new HarnessLoadError(`${at}: binding 必须是映射`);
    }
    const binding: Record<string, string> = {};
    for (const [key, value] of Object.entries(bindingRaw)) {
      if (typeof value !== "string") {
        throw new HarnessLoadError(`${at}: binding.${key} 必须是字符串`);
      }
      binding[key] = value;
    }
    const expectedPrimitiveArg = PRIMITIVE_ARGS[primitive as Primitive];
    const boundTargets = Object.values(binding);
    if (boundTargets.length !== 1 || boundTargets[0] !== expectedPrimitiveArg) {
      throw new HarnessLoadError(
        `${at}: binding 必须恰好映射到 primitive 参数 "${expectedPrimitiveArg}"`,
      );
    }
    const boundSources = Object.keys(binding);
    const requiredParams = parameters.filter((param) => param.required).map((param) => param.name);
    for (const requiredParam of requiredParams) {
      if (!boundSources.includes(requiredParam)) {
        throw new HarnessLoadError(`${at}: 必填参数 ${requiredParam} 未绑定`);
      }
    }

    tools.push({
      name,
      primitive: primitive as Primitive,
      description,
      parameters,
      binding,
    });
  }
  return { schema_version: TOOL_SURFACE_SCHEMA_VERSION, tools };
}

/** canonical digest：对解析后的 tool-surface 做确定性 sha256。 */
export function computeToolSurfaceDigest(surface: ToolSurface): string {
  const canonical = JSON.stringify(surface, Object.keys(surface).sort());
  return `sha256:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/** 校验 runtime-policy.yml（最小字段集）。 */
export function parseRuntimePolicy(data: Record<string, unknown>, refPath: string): RuntimePolicy {
  const steps = data["max_environment_steps"];
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1) {
    throw new HarnessLoadError(`${refPath}: max_environment_steps 必须是正整数`);
  }
  const rejections = data["max_consecutive_guard_rejections"];
  if (typeof rejections !== "number" || !Number.isInteger(rejections) || rejections < 1) {
    throw new HarnessLoadError(`${refPath}: max_consecutive_guard_rejections 必须是正整数`);
  }
  const enums: Array<[string, readonly string[]]> = [
    ["on_tool_error", ["terminate_run", "surface_error_to_model"]],
    ["on_max_steps", ["terminate_run"]],
    ["on_environment_done", ["terminate_run"]],
  ];
  const values: Record<string, string> = {};
  for (const [key, allowed] of enums) {
    const value = data[key];
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new HarnessLoadError(`${refPath}: ${key} 必须是 ${allowed.join("/")} 之一`);
    }
    values[key] = value;
  }
  return {
    maxEnvironmentSteps: steps,
    maxConsecutiveGuardRejections: rejections,
    onToolError: values["on_tool_error"] ?? "terminate_run",
    onMaxSteps: values["on_max_steps"] ?? "terminate_run",
    onEnvironmentDone: values["on_environment_done"] ?? "terminate_run",
  };
}

/** 校验 verification-policy.yml（最小结束/评测边界）。 */
export function parseVerificationPolicy(
  data: Record<string, unknown>,
  refPath: string,
): VerificationPolicy {
  const booleans: Array<[keyof VerificationPolicy, string]> = [
    ["completionRequiresEnvironmentDone", "completion_requires_environment_done"],
    ["rewardOnlyInEvaluatorRecord", "reward_only_in_evaluator_record"],
    ["actorSeesReward", "actor_sees_reward"],
    ["finishEqualsSuccess", "finish_equals_success"],
    ["evaluatorFeedbackIntoSameRollout", "evaluator_feedback_into_same_rollout"],
  ];
  const result = {} as Record<keyof VerificationPolicy, boolean>;
  for (const [target, key] of booleans) {
    const value = data[key];
    if (typeof value !== "boolean") {
      throw new HarnessLoadError(`${refPath}: ${key} 必须是布尔值`);
    }
    result[target] = value;
  }
  // 冻结红线：h0（及任何 harness）不得放宽隔离
  if (!result.completionRequiresEnvironmentDone
    || !result.rewardOnlyInEvaluatorRecord
    || result.actorSeesReward
    || result.finishEqualsSuccess
    || result.evaluatorFeedbackIntoSameRollout) {
    throw new HarnessLoadError(
      `${refPath}: verification-policy 违反冻结边界（reward 隔离/environment done 语义不可放宽）`,
    );
  }
  return result as VerificationPolicy;
}

/** 载入一个 harness 目录（harness.yml 为唯一入口）。 */
export function loadHarness(dir: string): HarnessDefinition {
  const manifestPath = join(dir, "harness.yml");
  const manifest = readYamlFile(manifestPath);

  if (manifest["schema_version"] !== HARNESS_SCHEMA_VERSION) {
    throw new HarnessLoadError("harness.yml: schema_version 必须为 1");
  }
  const harnessId = manifest["harness_id"];
  if (typeof harnessId !== "string" || harnessId.length === 0) {
    throw new HarnessLoadError("harness.yml: 缺少 harness_id");
  }
  const parentHarness = manifest["parent_harness"];
  if (parentHarness !== null && typeof parentHarness !== "string") {
    throw new HarnessLoadError("harness.yml: parent_harness 必须是 null 或字符串");
  }
  const version = manifest["version"];
  if (typeof version !== "string" || version.length === 0) {
    throw new HarnessLoadError("harness.yml: 缺少 version");
  }

  const refs: Array<["system_prompt" | "tool_surface" | "runtime_policy" | "verification_policy", string]> = [
    ["system_prompt", "system_prompt"],
    ["tool_surface", "tool_surface"],
    ["runtime_policy", "runtime_policy"],
    ["verification_policy", "verification_policy"],
  ];
  const resolved: Record<string, string> = {};
  for (const [key, yamlKey] of refs) {
    const ref = manifest[yamlKey];
    if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("/") || ref.includes("..")) {
      throw new HarnessLoadError(`harness.yml: ${yamlKey} 必须是目录内相对路径`);
    }
    resolved[key] = ref;
  }

  const editableSurfacesRaw = manifest["editable_surfaces"];
  if (!Array.isArray(editableSurfacesRaw)
    || !editableSurfacesRaw.every((entry) => typeof entry === "string")) {
    throw new HarnessLoadError("harness.yml: editable_surfaces 必须是字符串数组");
  }

  // system prompt
  const systemPromptPath = join(dir, resolved["system_prompt"]!);
  let systemPromptText: string;
  try {
    systemPromptText = readFileSync(systemPromptPath, "utf-8");
  } catch {
    throw new HarnessLoadError(`system prompt 不存在: ${systemPromptPath}`);
  }
  if (systemPromptText.trim().length === 0) {
    throw new HarnessLoadError(`system prompt 为空: ${systemPromptPath}`);
  }

  // tool surface / policies
  const toolSurfacePath = join(dir, resolved["tool_surface"]!);
  const toolSurface = parseToolSurface(readYamlFile(toolSurfacePath), resolved["tool_surface"]!);
  const runtimePolicyPath = join(dir, resolved["runtime_policy"]!);
  const runtimePolicy = parseRuntimePolicy(readYamlFile(runtimePolicyPath), resolved["runtime_policy"]!);
  const verificationPolicyPath = join(dir, resolved["verification_policy"]!);
  const verificationPolicy = parseVerificationPolicy(
    readYamlFile(verificationPolicyPath),
    resolved["verification_policy"]!,
  );

  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    harnessId,
    parentHarness: parentHarness as string | null,
    version,
    dir,
    systemPromptRef: resolved["system_prompt"]!,
    systemPromptText,
    toolSurfaceRef: resolved["tool_surface"]!,
    toolSurface,
    toolSurfaceDigest: computeToolSurfaceDigest(toolSurface),
    runtimePolicyRef: resolved["runtime_policy"]!,
    runtimePolicy,
    verificationPolicyRef: resolved["verification_policy"]!,
    verificationPolicy,
    editableSurfaces: editableSurfacesRaw as string[],
  };
}

/**
 * 冻结 primitive → 环境 action 映射（唯一合法通道）。
 * YAML 无法表达映射本身，只能引用 primitive。
 */
export function primitiveToEnvironmentAction(
  primitive: Primitive,
  args: Record<string, unknown>,
  binding: Record<string, string>,
): string {
  const primitiveArgName = PRIMITIVE_ARGS[primitive];
  const sourceParam = Object.entries(binding).find(
    ([, target]) => target === primitiveArgName,
  )?.[0];
  const value = sourceParam !== undefined ? args[sourceParam] : undefined;

  switch (primitive) {
    case "search": {
      if (typeof value !== "string") {
        throw new HarnessLoadError("search primitive 需要字符串参数");
      }
      assertSafeActionArg(value, "query");
      return `search[${value}]`;
    }
    case "click": {
      if (typeof value !== "string") {
        throw new HarnessLoadError("click primitive 需要字符串参数");
      }
      assertSafeActionArg(value, "target");
      return `click[${value}]`;
    }
    case "finish": {
      if (value !== "no_suitable_product") {
        throw new HarnessLoadError("finish primitive 的 reason 只能是 no_suitable_product");
      }
      return "finish[no_suitable_product]";
    }
    default:
      throw new HarnessLoadError(`未知 primitive: ${String(primitive)}`);
  }
}

/**
 * action 参数文法安全校验（冻结）：环境用 name[arg] 文法解析动作，
 * 方括号/换行/首尾空白/超长都会改变解析结果，一律拒绝。
 */
export function assertSafeActionArg(arg: string, label: string): void {
  if (typeof arg !== "string" || arg.length === 0) {
    throw new HarnessLoadError(`${label} 必须是非空字符串`);
  }
  if (arg.trim() !== arg) {
    throw new HarnessLoadError(`${label} 不允许首尾空白`);
  }
  if (/[[\]\r\n]/.test(arg)) {
    throw new HarnessLoadError(`${label} 不允许包含方括号或换行`);
  }
  const MAX_ARG_CHARS = 400;
  if (arg.length > MAX_ARG_CHARS) {
    throw new HarnessLoadError(`${label} 超过 ${MAX_ARG_CHARS} 字符上限`);
  }
}

/** 按 tool-surface 参数定义校验模型入参（严格：禁止额外键）。 */
export function validateSurfaceToolArgs(
  entry: ToolSurfaceEntry,
  args: unknown,
): string[] {
  if (!isObject(args)) {
    return ["参数必须是 JSON 对象"];
  }
  const problems: string[] = [];
  const declared = new Map(entry.parameters.map((param) => [param.name, param]));
  for (const key of Object.keys(args)) {
    if (!declared.has(key)) {
      problems.push(`禁止的额外参数: ${key}`);
    }
  }
  for (const param of entry.parameters) {
    const value = args[param.name];
    if (value === undefined) {
      if (param.required) {
        problems.push(`缺少必填参数: ${param.name}`);
      }
      continue;
    }
    if (typeof value !== "string") {
      problems.push(`参数 ${param.name} 必须是字符串`);
      continue;
    }
    if (param.minLength !== undefined && value.length < param.minLength) {
      problems.push(`参数 ${param.name} 长度不足 ${param.minLength}`);
    }
    if (param.maxLength !== undefined && value.length > param.maxLength) {
      problems.push(`参数 ${param.name} 超过 ${param.maxLength} 字符`);
    }
    if (param.enum !== undefined && !param.enum.includes(value)) {
      problems.push(`参数 ${param.name} 取值不在允许列表: ${param.enum.join(", ")}`);
    }
  }
  return problems;
}
