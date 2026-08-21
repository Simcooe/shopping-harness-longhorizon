/**
 * 购物工具在 DSH 工具注册表中的注册（冻结层，surface 驱动）。
 *
 * 工具的唯一配置来源是当前 harness 的 tool-surface.yml（经冻结的
 * surface loader 校验）；本文件不再硬编码任何工具名。
 *
 * 依据固定 DSH commit 的真实 API：ToolRuntime.register(ToolDefinition)，
 * ToolDefinition = {name, description, parameters(JSON Schema),
 * output:{schema, render}, execute(args, exec)}。
 *
 * 双通道纪律：execute 只接触 actor 通道；evaluator 结果证据经 client
 * evaluatorSink 直达记录器，本文件拿不到、也不传递它。
 */

import type { ToolSurfaceEntry } from "../harness/surface.ts";
import { primitiveToEnvironmentAction, validateSurfaceToolArgs } from "../harness/surface.ts";
import type { ShoppingRuntime } from "./runtime.ts";
import {
  projectInteract,
  renderFinishSummary,
  renderToolSummary,
} from "../observation/project.ts";

// ---- 与固定 DSH 源码一致的结构类型 -----------------------------------------

export interface DshTextBlock {
  type: "text";
  text: string;
}

export type DshContentBlock = DshTextBlock;
export type DshJsonValue = unknown;

export interface DshToolOutputDefinition {
  schema: Record<string, unknown>;
  render(args: unknown, value: DshJsonValue): DshContentBlock[];
}

export interface DshToolRunContextLike {
  signal: AbortSignal;
}

export interface DshToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: DshToolOutputDefinition;
  execute(args: unknown, exec: DshToolRunContextLike): Promise<unknown>;
}

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

/** 由 tool-surface 条目生成 JSON Schema（唯一来源是 YAML）。 */
function surfaceToJsonSchema(entry: ToolSurfaceEntry): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of entry.parameters) {
    const spec: Record<string, unknown> = {
      type: "string",
      description: param.enum !== undefined
        ? `允许取值: ${param.enum.join(" | ")}`
        : `${param.name}（字符串）`,
    };
    if (param.minLength !== undefined) {
      spec["minLength"] = param.minLength;
    }
    if (param.maxLength !== undefined) {
      spec["maxLength"] = param.maxLength;
    }
    if (param.enum !== undefined) {
      spec["enum"] = [...param.enum];
    }
    properties[param.name] = spec;
    if (param.required) {
      required.push(param.name);
    }
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function buildDefinition(
  entry: ToolSurfaceEntry,
  runtime: ShoppingRuntime,
): DshToolDefinition {
  return {
    name: entry.name,
    description: entry.description,
    parameters: surfaceToJsonSchema(entry),
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    async execute(args: unknown, exec: DshToolRunContextLike): Promise<unknown> {
      if (exec.signal.aborted) {
        throw new Error("工具调用已取消");
      }
      const problems = validateSurfaceToolArgs(entry, args);
      if (problems.length > 0) {
        throw new Error(`参数无效: ${problems.join("; ")}`);
      }
      const typedArgs = args as Record<string, unknown>;

      // 1. 冻结 guard：基于模型上一轮实际看到的 actor-visible 观测校验
      runtime.guardCheck(entry.primitive, typedArgs);

      // 2. 冻结 primitive → 环境 action 映射
      const environmentAction = primitiveToEnvironmentAction(
        entry.primitive,
        typedArgs,
        entry.binding,
      );

      const session = await runtime.ensureSession();
      const recorder = runtime.recorder;

      runtime.evaluator.noteToolStep();
      recorder?.record({
        event: "tool_call",
        tool: entry.name,
        args: typedArgs,
        environment_action: environmentAction,
      });

      runtime.beginCall();
      try {
        runtime.noteStep();
        const result = await session.interact(environmentAction);
        const projected = projectInteract(result);
        runtime.observe(result.observation);

        recorder?.record({
          event: "observation",
          page_type: result.observation?.pageType ?? "unknown",
          done: projected.done,
          observation: result.observation?.state ?? {},
        });

        // 工具结果只返回当前动作与 actor-safe 观测（任务指令在初始 prompt）
        const summary = entry.primitive === "finish"
          ? renderFinishSummary(String(typedArgs["reason"]))
          : renderToolSummary({
            environmentAction,
            done: projected.done,
            observation: result.observation,
          });

        if (projected.done || projected.over) {
          if (projected.over) {
            runtime.evaluator.noteOver();
          }
          runtime.markTerminal();
          await session.release();
          runtime.finalizeEvaluator(
            session.releaseError === null ? "released" : "release_failed",
          );
          recorder?.record({
            event: "terminal",
            done: projected.done,
            local_reason: projected.done ? "environment_done" : "session_over",
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
        // 异常路径也保证归还租约，并写 terminal + evaluator
        if (cause instanceof Error && cause.name === "MaxStepsError") {
          runtime.evaluator.noteMaxSteps();
        } else {
          runtime.evaluator.noteLocalError(
            "code" in (cause as { code?: string })
              && (cause as { code?: string }).code === "environment"
              ? "environment_error"
              : "tool_error",
          );
        }
        runtime.markTerminal();
        await session.release();
        runtime.finalizeEvaluator(
          session.releaseError === null ? "released" : "release_failed",
        );
        recorder?.record({
          event: "terminal",
          done: false,
          local_reason: cause instanceof Error && cause.name === "MaxStepsError"
            ? "max_steps"
            : "tool_error",
          release_status: session.releaseError === null ? "released" : "release_failed",
          error_code: "code" in (cause as { code?: string })
            ? String((cause as { code?: string }).code)
            : cause instanceof Error && cause.name === "MaxStepsError"
              ? "max_steps"
              : "unknown",
        });
        throw cause;
      } finally {
        runtime.endCall();
      }
    },
  };
}

/** 按当前 harness 的 tool surface 构建全部工具定义。 */
export function buildShoppingToolDefinitions(
  runtime: ShoppingRuntime,
): DshToolDefinition[] {
  const harness = runtime.requireHarness();
  return harness.toolSurface.tools.map((entry) => buildDefinition(entry, runtime));
}

/** 把 surface 中的工具注册进给定的注册表，返回 disposer。 */
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
