/**
 * live run 的 bootstrap 会话（冻结层，rollout 审计的一部分）。
 *
 * 时序（instruction-before-first-decision，保留）：
 *   runner reset（唯一一次）→ 按 run 隔离的 bootstrap 文件
 *   → instruction_text 进 DSH 初始 prompt → plugin 接管同一 env_idx。
 *
 * 文件布局：
 *   .live/runs/<run_id>/bootstrap.json      正常 handoff
 *   .live/recovery/<run_id>-env-<env_idx>.json  release 失败时的恢复记录
 *
 * 写入保证（no-clobber，真原子）：
 *   - 目标目录内 openSync(tmp, "wx", 0600) 独占创建临时文件；
 *   - 写完整内容 + fsyncSync；
 *   - linkSync(tmp, target) 原子创建目标硬链接：目标已存在时 linkSync
 *     以 EEXIST 失败，绝不替换（POSIX rename 会覆盖，故不使用）；
 *   - 成功或失败都 unlink 临时文件，无残留。
 *
 * 错误分类（结构化 code，不匹配消息文本）：
 *   - BootstrapNotFoundError：仅对应底层 ENOENT；
 *   - BootstrapReadError：EACCES/EISDIR/其他读取失败；
 *   - BootstrapAlreadyExistsError：no-clobber 写入时目标已存在（EEXIST）。
 *
 * 红线：bootstrap/recovery 只保存 actor-safe 字段；goal 内部结构、
 * gold asin、reward/reward_detail、purchase、persona、API key、完整原始
 * observation 一律不得写入。
 */

import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ResetResult } from "../environment/protocol.ts";

export const BOOTSTRAP_SCHEMA_VERSION = 1;

/** instruction 注入 prompt 的最大长度（防御异常大文本）。 */
export const MAX_BOOTSTRAP_INSTRUCTION_CHARS = 4000;

/** run_id 允许字符：字母数字开头，后跟字母数字/点/下划线/短横线。 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface BootstrapSession {
  schema_version: number;
  run_id: string;
  task_id: number;
  env_idx: number;
  instruction_text: string;
}

/** 机器可读的错误 code（不依赖消息文本判断类别）。 */
export type BootstrapErrorCode =
  | "not_found"
  | "read_error"
  | "already_exists"
  | "invalid";

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;

  constructor(code: BootstrapErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 仅对应底层 ENOENT：cleanup 只有遇到它才能幂等退出 0。 */
export class BootstrapNotFoundError extends BootstrapError {
  constructor(path: string) {
    super("not_found", `bootstrap 文件不存在: ${path}`);
  }
}

/** 文件存在但读取失败（EACCES/EISDIR/IO 错误等）。 */
export class BootstrapReadError extends BootstrapError {
  constructor(path: string, errnoCode: string | undefined) {
    super("read_error", `bootstrap 文件读取失败: ${path} (${errnoCode ?? "unknown"})`);
  }
}

/** no-clobber 写入时目标已存在。 */
export class BootstrapAlreadyExistsError extends BootstrapError {
  constructor(path: string) {
    super("already_exists", `bootstrap 已存在，拒绝覆盖: ${path}`);
  }
}

/** 严格校验 run_id（拒绝路径穿越与非法字符）。 */
export function assertValidRunId(runId: string): void {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new BootstrapError("invalid", "run_id 不能为空");
  }
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    throw new BootstrapError("invalid", `run_id 含非法路径字符: ${runId}`);
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new BootstrapError("invalid", `run_id 格式非法: ${runId}`);
  }
}

/** 派生按 run 隔离的 bootstrap 路径：<liveDir>/runs/<run_id>/bootstrap.json。 */
export function resolveBootstrapPath(liveDir: string, runId: string): string {
  assertValidRunId(runId);
  return join(liveDir, "runs", runId, "bootstrap.json");
}

/** 派生按 run/env 隔离的 recovery 路径：<liveDir>/recovery/<run_id>-env-<env_idx>.json。 */
export function resolveRecoveryPath(liveDir: string, runId: string, envIdx: number): string {
  assertValidRunId(runId);
  return join(liveDir, "recovery", `${runId}-env-${envIdx}.json`);
}

/** 校验显式 --output 路径：必须绝对、无穿越段、以 .json 结尾。 */
export function assertValidOutputPath(outputPath: string): void {
  if (!isAbsolute(outputPath)) {
    throw new BootstrapError("invalid", "--output 必须是绝对路径");
  }
  const segments = outputPath.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new BootstrapError("invalid", "--output 含路径穿越段");
  }
  if (!outputPath.endsWith(".json")) {
    throw new BootstrapError("invalid", "--output 必须以 .json 结尾");
  }
}

/**
 * 从 reset 结果构建 bootstrap（白名单：只取 actor-safe 字段）。
 * run_id 始终校验（即使调用方使用显式 --output 也不绕过）。
 */
export function buildBootstrap(options: {
  runId: string;
  taskId: number;
  resetResult: ResetResult;
}): BootstrapSession {
  assertValidRunId(options.runId);
  const instruction = options.resetResult.task?.instructionText ?? "";
  if (instruction.length === 0) {
    throw new BootstrapError("invalid", "reset 未返回 actor-safe 任务指令，无法 bootstrap");
  }
  return {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    run_id: options.runId,
    task_id: options.taskId,
    env_idx: options.resetResult.envIdx,
    instruction_text: instruction.slice(0, MAX_BOOTSTRAP_INSTRUCTION_CHARS),
  };
}

/** 内部原子写入：tmp 独占 0600 创建 + fsync + linkSync no-clobber。 */
function atomicWriteNoClobber(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // linkSync 在目标已存在时以 EEXIST 失败：绝不覆盖已有 bootstrap
    linkSync(tmpPath, path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new BootstrapAlreadyExistsError(path);
    }
    throw cause;
  } finally {
    try {
      unlinkSync(tmpPath); // 成功或失败都不残留临时文件
    } catch {
      // 临时文件已被清理则忽略
    }
  }
}

/**
 * 原子、no-clobber、0600 写入 bootstrap 文件。
 * 目标已存在 → BootstrapAlreadyExistsError（不覆盖、不丢失旧 env_idx）。
 */
export function writeBootstrap(path: string, bootstrap: BootstrapSession): void {
  atomicWriteNoClobber(path, `${JSON.stringify(bootstrap, null, 2)}\n`);
}

/**
 * 写 release 失败的恢复记录（与 bootstrap 相同的 actor-safe 字段集）。
 * 同样 0600、no-clobber；已存在时返回既有路径（视为先前已记录）。
 */
export function writeRecoveryRecord(
  path: string,
  bootstrap: BootstrapSession,
): string {
  try {
    atomicWriteNoClobber(path, `${JSON.stringify(bootstrap, null, 2)}\n`);
  } catch (cause) {
    if (cause instanceof BootstrapAlreadyExistsError) {
      return path; // 已有恢复记录：不覆盖，直接指向它
    }
    throw cause;
  }
  return path;
}

/** 读取并校验 bootstrap 文件（结构化错误分类，不匹配消息文本）。 */
export function loadBootstrap(path: string): BootstrapSession {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BootstrapNotFoundError(path);
    }
    throw new BootstrapReadError(path, code);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new BootstrapError("invalid", "bootstrap 文件不是合法 JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new BootstrapError("invalid", "bootstrap 必须是 JSON 对象");
  }
  const record = data as Record<string, unknown>;
  if (record["schema_version"] !== BOOTSTRAP_SCHEMA_VERSION) {
    throw new BootstrapError("invalid", "bootstrap schema_version 必须为 1");
  }
  if (typeof record["run_id"] !== "string" || record["run_id"].length === 0) {
    throw new BootstrapError("invalid", "bootstrap 缺少 run_id");
  }
  // 文件内的 run_id 也必须通过严格校验（防构造文件绕过隔离）
  assertValidRunId(record["run_id"] as string);
  if (typeof record["task_id"] !== "number" || !Number.isInteger(record["task_id"])) {
    throw new BootstrapError("invalid", "bootstrap 缺少整数 task_id");
  }
  if (typeof record["env_idx"] !== "number" || !Number.isInteger(record["env_idx"])) {
    throw new BootstrapError("invalid", "bootstrap 缺少整数 env_idx");
  }
  if (typeof record["instruction_text"] !== "string"
    || record["instruction_text"].length === 0) {
    throw new BootstrapError("invalid", "bootstrap 缺少 instruction_text");
  }
  return {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    run_id: record["run_id"] as string,
    task_id: record["task_id"] as number,
    env_idx: record["env_idx"] as number,
    instruction_text: record["instruction_text"] as string,
  };
}

/**
 * 构造 DSH 初始任务 prompt：真实任务文本以清晰边界注入。
 * 纯字符串构造；传递必须走 argv（见 launch_dsh_task.ts），绝不拼接进
 * shell 命令行。
 */
export function buildInitialTaskPrompt(bootstrap: BootstrapSession): string {
  return [
    "你正在 ShopSimulator 中执行以下购物任务：",
    "",
    "<shopping_task>",
    bootstrap.instruction_text,
    "</shopping_task>",
    "",
    "请仅依据任务要求和当前可见环境信息行动。",
    "不得猜测隐藏的 goal、gold、reward 或购买结果。",
  ].join("\n");
}

/** cleanup 载荷：只释放当前 env_idx，禁止 release_all。 */
export function buildReleasePayload(bootstrap: BootstrapSession): {
  action: "release_one";
  env_idx: number;
} {
  return { action: "release_one", env_idx: bootstrap.env_idx };
}
