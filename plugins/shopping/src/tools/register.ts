/**
 * 三个购物工具在 DSH 工具注册表中的注册（冻结层）。
 *
 * 依据固定 DSH commit（见 DEPENDENCIES.md）中的真实 API：
 *   - dsh/packages/core/tools/src/index.ts：
 *       ToolRuntime.register(definition: ToolDefinition): () => void
 *       ToolDefinition extends ToolSchema {
 *         output: { schema: JsonSchemaNode; render(args, value): ContentBlock[] },
 *         execute(args: unknown, exec: ToolRunContext): Promise<unknown>
 *       }
 *   - dsh/packages/llm/llm/src/types.ts：
 *       ToolSchema { name; description; parameters: Record<string, unknown> }
 *       TextBlock { type: 'text'; text: string }
 *   - 注册表接受"原始 JSON Schema + 自行负责输入校验"的 ToolDefinition
 *     （同一文件注释），因此无需依赖 defineTool/ValueSchemaSpec DSL。
 *
 * 为什么本地声明结构类型而不 import @deepseek-ai/dsh-tools：
 *   npm registry 上该包版本（0.0.1-rc.1）落后于本仓库固定的 commit
 *   （0.1.0-rc.7），直接安装会引入 API 漂移。结构类型逐字段对照固定
 *   源码核实；若未来依赖对齐，可无缝换回官方 import。
 *
 * 本层不创建任务、不决定 task_id；handler 从 ShoppingRuntime 的当前
 * 会话获取 env_idx（task_id 由外部 runner 注入）。
 */

import { toEnvironmentAction } from "./actions.ts";
import { SHOPPING_TOOLS, validateToolArgs, type ShoppingToolDefinition } from "./schemas.ts";
import type { ShoppingRuntime } from "./runtime.ts";
import {
  projectInteract,
  renderFinishSummary,
  renderInteractSummary,
} from "../observation/project.ts";

// ---- 与固定 DSH 源码一致的结构类型 -----------------------------------------

/** 对应 TextBlock（dsh-llm types.ts）。 */
export interface DshTextBlock {
  type: "text";
  text: string;
}

export type DshContentBlock = DshTextBlock;
export type DshJsonValue = unknown;

/** 对应 ToolOutputDefinition（dsh-tools index.ts）。 */
export interface DshToolOutputDefinition {
  schema: Record<string, unknown>;
  render(args: unknown, value: DshJsonValue): DshContentBlock[];
}

/** 对应 ToolRunContext 的最小可运行子集（dsh-tools index.ts）。 */
export interface DshToolRunContextLike {
  signal: AbortSignal;
}

/** 对应 ToolDefinition（dsh-tools index.ts）+ ToolSchema（dsh-llm types.ts）。 */
export interface DshToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: DshToolOutputDefinition;
  execute(args: unknown, exec: DshToolRunContextLike): Promise<unknown>;
}

/** 对应 ToolRuntime.register 的注册面（dsh-tools index.ts）。 */
export interface DshToolRegistryLike {
  register(definition: DshToolDefinition): () => void;
}

/** 工具输出的 canonical 值（同时由 output.schema 声明）。 */
export interface ShoppingToolOutput {
  summary: string;
  done: boolean;
  env_idx: number;
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    done: { type: "boolean" },
    env_idx: { type: "integer" },
  },
  required: ["summary", "done", "env_idx"],
  additionalProperties: false,
};

function renderOutput(_args: unknown, value: DshJsonValue): DshContentBlock[] {
  const output = value as ShoppingToolOutput;
  return [{ type: "text", text: output.summary }];
}

/** 构建一个冻结工具定义。 */
function buildDefinition(
  tool: ShoppingToolDefinition,
  runtime: ShoppingRuntime,
): DshToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: { ...tool.parameters } as Record<string, unknown>,
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    async execute(args: unknown, exec: DshToolRunContextLike): Promise<unknown> {
      if (exec.signal.aborted) {
        throw new Error("工具调用已取消");
      }
      const problems = validateToolArgs(tool, args);
      if (problems.length > 0) {
        throw new Error(`参数无效: ${problems.join("; ")}`);
      }
      const environmentAction = toEnvironmentAction(
        tool.name,
        args as Record<string, unknown>,
      );

      const session = runtime.requireSession();
      const recorder = runtime.recorder;
      recorder?.record({
        event: "tool_call",
        tool: tool.name,
        args: args as Record<string, unknown>,
        environment_action: environmentAction,
      });

      try {
        const result = await session.interact(environmentAction);
        const projected = projectInteract(result);
        const summary = tool.name === "finish_without_purchase"
          ? renderFinishSummary((args as { reason: string }).reason)
          : renderInteractSummary(projected, environmentAction);

        recorder?.record({
          event: "step",
          environment_action: environmentAction,
          observation_summary: {
            env_idx: projected.envIdx,
            done: projected.done,
            over: projected.over,
          },
          done: projected.done,
        });

        if (projected.done || projected.over) {
          await session.release();
          recorder?.record({
            event: "terminal",
            done: projected.done,
            termination_reason: projected.done ? "environment_done" : "session_over",
            release_status: session.releaseError === null ? "released" : "release_failed",
          });
        }

        const output: ShoppingToolOutput = {
          summary,
          done: projected.done,
          env_idx: projected.envIdx,
        };
        return output;
      } catch (cause) {
        // 异常路径也保证归还租约
        await session.release();
        recorder?.record({
          event: "terminal",
          done: false,
          termination_reason: "tool_error",
          release_status: session.releaseError === null ? "released" : "release_failed",
          error_code: "code" in (cause as { code?: string })
            ? String((cause as { code?: string }).code)
            : "unknown",
        });
        throw cause;
      }
    },
  };
}

/** 构建三个冻结工具定义（schemas 与映射均来自冻结模块）。 */
export function buildShoppingToolDefinitions(
  runtime: ShoppingRuntime,
): DshToolDefinition[] {
  return SHOPPING_TOOLS.map((tool) => buildDefinition(tool, runtime));
}

/** 把三个工具注册进给定的注册表，返回 disposer。 */
export function registerShoppingTools(
  registry: DshToolRegistryLike,
  runtime: ShoppingRuntime,
): () => void {
  const disposers = buildShoppingToolDefinitions(runtime).map(
    (definition) => registry.register(definition),
  );
  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
