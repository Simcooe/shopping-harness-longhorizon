/**
 * 12 个购物工具在 DSH 工具注册表中的注册（冻结层）。
 *
 * 依据固定 DSH commit 的真实 API：ToolRuntime.register(ToolDefinition)，
 * ToolDefinition = {name, description, parameters(JSON Schema),
 * output:{schema, render}, execute(args, exec)}（原始 JSON Schema 形态，
 * 注册方自行负责输入校验）。结构类型逐字段对照固定源码，避免依赖
 * 版本漂移的 npm 包；详见 docs/dsh-shopping-plugin.md。
 *
 * 双通道纪律（Phase 6）：execute 只接触 actor 通道（session.interact 的
 * 返回值在类型上就只有 actor 字段）；evaluator 结果证据经 client 的
 * evaluatorSink 直连 runtime.evaluator，本文件拿不到、也不传递它。
 */

import { toEnvironmentAction } from "./actions.ts";
import { SHOPPING_TOOLS, validateToolArgs, type ShoppingToolDefinition } from "./schemas.ts";
import { GuardRejectionError } from "./guard.ts";
import { MaxStepsError, type ShoppingRuntime } from "./runtime.ts";
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
      const typedArgs = args as Record<string, unknown>;

      // 1. 冻结 guard：基于模型上一轮实际看到的 actor-visible 观测校验。
      //    拒绝时不调用 ShopSimulator、不消耗步数，只写 guard_rejection。
      runtime.guardCheck(tool.name, typedArgs);

      const environmentAction = toEnvironmentAction(tool.name, typedArgs);
      const session = await runtime.ensureSession();
      const recorder = runtime.recorder;

      runtime.evaluator.noteToolStep();
      recorder?.record({
        event: "tool_call",
        tool: tool.name,
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

        // 工具结果只返回当前动作与 actor-safe 观测；任务指令已在 DSH
        // 初始 prompt 中（bootstrap 时序），绝不在工具结果中重复注入。
        const summary = tool.name === "finish_without_purchase"
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
        if (cause instanceof MaxStepsError) {
          runtime.evaluator.noteMaxSteps();
        } else if (!(cause instanceof GuardRejectionError)) {
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
          local_reason: cause instanceof MaxStepsError
            ? "max_steps"
            : cause instanceof GuardRejectionError
              ? "guard"
              : "tool_error",
          release_status: session.releaseError === null ? "released" : "release_failed",
          error_code: "code" in (cause as { code?: string })
            ? String((cause as { code?: string }).code)
            : cause instanceof MaxStepsError
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

/** 构建 12 个冻结工具定义（schemas 与映射均来自冻结模块）。 */
export function buildShoppingToolDefinitions(
  runtime: ShoppingRuntime,
): DshToolDefinition[] {
  return SHOPPING_TOOLS.map((tool) => buildDefinition(tool, runtime));
}

/** 把全部工具注册进给定的注册表，返回 disposer。 */
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
