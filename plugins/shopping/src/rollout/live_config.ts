/**
 * live runner 的离线准备与校验逻辑（冻结层，rollout 审计的一部分）。
 *
 * 原则：所有校验都可离线测试；真实模型调用只在 run_live_task.sh 收到
 * --live 且全部前置检查通过后才发生。API key 只存在于未提交的 .env，
 * 任何 run metadata 都不得包含密钥。
 */

export const REQUIRED_MODEL_ENV_KEYS = [
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_NAME",
] as const;

export interface LiveTaskConfig {
  schemaVersion: number;
  purpose: string;
  taskSource: string;
  maxEnvironmentSteps: number;
  temperature: number;
  allowedTools: readonly string[];
  outputDir: string;
  finalBenchmarkExcluded: boolean;
}

export class LiveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveConfigError";
  }
}

/** 校验模型相关环境变量齐备；返回缺失项列表（不输出值）。 */
export function missingModelEnvKeys(
  env: Record<string, string | undefined>,
): string[] {
  return REQUIRED_MODEL_ENV_KEYS.filter((key) => {
    const value = env[key]?.trim();
    return value === undefined || value.length === 0;
  });
}

/** 校验 run metadata 绝不携带密钥（写入轨迹前的最后防线）。 */
export function assertMetadataHasNoSecrets(
  metadata: Record<string, unknown>,
  env: Record<string, string | undefined>,
): void {
  const serialized = JSON.stringify(metadata);
  const apiKey = env["MODEL_API_KEY"];
  if (apiKey !== undefined && apiKey.length > 0 && serialized.includes(apiKey)) {
    throw new LiveConfigError("run metadata 泄露了 MODEL_API_KEY");
  }
  for (const forbidden of ["MODEL_API_KEY", "DEEPSEEK_API_KEY"]) {
    if (serialized.includes(forbidden)) {
      throw new LiveConfigError(`run metadata 包含敏感键名 ${forbidden}`);
    }
  }
}

/** 校验 live-task 配置（YAML 解析后的对象）。 */
export function validateLiveTaskConfig(
  data: unknown,
  allowedToolNames: readonly string[],
): LiveTaskConfig {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new LiveConfigError("live-task 配置必须是对象");
  }
  const record = data as Record<string, unknown>;
  if (record["schema_version"] !== 1) {
    throw new LiveConfigError("live-task 配置 schema_version 必须为 1");
  }
  if (record["purpose"] !== "development_single_live_task") {
    throw new LiveConfigError(
      "live-task 配置 purpose 必须为 development_single_live_task",
    );
  }
  if (record["task_source"] !== "configs/tasks/development.json") {
    throw new LiveConfigError("task_source 必须是 configs/tasks/development.json");
  }
  const maxSteps = record["max_environment_steps"];
  if (typeof maxSteps !== "number" || !Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new LiveConfigError("max_environment_steps 必须是正整数");
  }
  const temperature = record["temperature"];
  if (typeof temperature !== "number" || temperature < 0) {
    throw new LiveConfigError("temperature 必须是非负数");
  }
  const tools = record["allowed_tools"];
  if (
    !Array.isArray(tools)
    || tools.length === 0
    || !tools.every(
      (tool) => typeof tool === "string" && allowedToolNames.includes(tool),
    )
  ) {
    throw new LiveConfigError(
      `allowed_tools 必须是已实现工具的非空子集: [${allowedToolNames.join(", ")}]`,
    );
  }
  if (record["output_dir"] !== "trajectories/") {
    throw new LiveConfigError("output_dir 必须是 trajectories/");
  }
  if (record["final_benchmark_excluded"] !== true) {
    throw new LiveConfigError("必须声明 final_benchmark_excluded: true");
  }
  return {
    schemaVersion: 1,
    purpose: "development_single_live_task",
    taskSource: "configs/tasks/development.json",
    maxEnvironmentSteps: maxSteps,
    temperature,
    allowedTools: tools as string[],
    outputDir: "trajectories/",
    finalBenchmarkExcluded: true,
  };
}

export interface RunMetadata {
  schema_version: number;
  run_id: string;
  task_id: number;
  harness_version: string;
  profile: string;
  model_name: string;
  model_base_url: string;
  temperature: number;
  max_environment_steps: number;
  allowed_tools: readonly string[];
  final_benchmark_excluded: boolean;
}

/** 构建脱敏 run metadata（model_name/base_url 非敏感；密钥绝不进入）。 */
export function buildRunMetadata(options: {
  runId: string;
  taskId: number;
  harnessVersion: string;
  modelName: string;
  modelBaseUrl: string;
  config: LiveTaskConfig;
}): RunMetadata {
  return {
    schema_version: 1,
    run_id: options.runId,
    task_id: options.taskId,
    harness_version: options.harnessVersion,
    profile: "shopping-base",
    model_name: options.modelName,
    model_base_url: options.modelBaseUrl,
    temperature: options.config.temperature,
    max_environment_steps: options.config.maxEnvironmentSteps,
    allowed_tools: options.config.allowedTools,
    final_benchmark_excluded: true,
  };
}
