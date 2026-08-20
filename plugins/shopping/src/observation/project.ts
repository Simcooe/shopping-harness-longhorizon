/**
 * observation 投影（冻结层）：把环境返回的信息投影为 actor-safe 的
 * 模型上下文。
 *
 * 原则：**白名单投影**。只保留明确列出的公共字段；任何未列出的键
 * （包括 reward、reward_detail、goal、goal_options、purchase、
 * instruction 类 goal 文本、user_persona 等隐藏字段）一律剔除。
 *
 * 说明：ShopSimulator 在 reset 与 interact 中都使用 `instruction` 键，
 * 但语义不同——reset 的 instruction 是任务 goal 文本（隐藏），interact
 * 的是页面观测。由于无法从键名区分，且本阶段 adapter 只暴露
 * envIdx/done/over 等最小字段，投影层对 `instruction` 一律剔除；
 * 未来如需页面观测文本，必须通过冻结层的显式版本化扩展。
 *
 * 所有 model-visible 内容都必须可从 session log 重建：本层输出是
 * 工具结果的唯一来源，工具结果由 DSH agent-loop 记入 tool/result。
 */

import type { InteractResult, ResetResult } from "../environment/protocol.ts";

/** 显式剔除的服务端字段（文档化红线，非运行时唯一防线——白名单本身即防线）。 */
export const HIDDEN_RESULT_FIELDS = [
  "reward",
  "reward_detail",
  "goal",
  "goal_options",
  "purchase",
  "instruction",
  "instruction_simple",
  "user_persona",
  "reason_key",
  "verbose_info",
] as const;

/** 白名单：原始服务端 result 中唯一允许进入投影的键。 */
export const ALLOWED_RAW_FIELDS = [
  "env_idx",
  "done",
  "over",
  "message",
  "environment_version",
] as const;

/** 投影后的 reset 观测。 */
export interface ProjectedReset {
  envIdx: number;
  environmentVersion: string | null;
}

/** 投影后的 interact 观测（模型可见的最小页面状态摘要）。 */
export interface ProjectedInteract {
  envIdx: number;
  done: boolean;
  over: boolean;
}

/**
 * 对任意未知来源的原始 result 对象做白名单投影。
 * 未列入 ALLOWED_RAW_FIELDS 的键全部丢弃；类型不符的键也丢弃。
 */
export function projectRawResult(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of ALLOWED_RAW_FIELDS) {
    const value = record[key];
    switch (key) {
      case "env_idx":
        if (typeof value === "number" && Number.isInteger(value)) {
          projected[key] = value;
        }
        break;
      case "done":
      case "over":
        if (typeof value === "boolean") {
          projected[key] = value;
        }
        break;
      case "message":
      case "environment_version":
        if (typeof value === "string") {
          projected[key] = value;
        }
        break;
    }
  }
  return projected;
}

/** adapter 的 reset 结果 → 投影。 */
export function projectReset(result: ResetResult): ProjectedReset {
  return {
    envIdx: result.envIdx,
    environmentVersion: result.environmentVersion,
  };
}

/** adapter 的 interact 结果 → 投影。 */
export function projectInteract(result: InteractResult): ProjectedInteract {
  return {
    envIdx: result.envIdx,
    done: result.done,
    over: result.over,
  };
}

/**
 * 把投影结果渲染为 model-visible 的纯文本摘要（工具结果的呈现形式）。
 * 只含状态信息，不含 goal/gold/reward/完整 observation。
 */
export function renderInteractSummary(
  projected: ProjectedInteract,
  environmentAction: string,
): string {
  const actionText = environmentAction.length > 120
    ? `${environmentAction.slice(0, 120)}…`
    : environmentAction;
  return [
    `已执行环境动作: ${actionText}`,
    `任务状态: ${projected.done ? "已结束" : "进行中"}`,
    projected.over ? "会话已达上限（over）。" : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** finish 类动作的 model-visible 摘要。 */
export function renderFinishSummary(reason: string): string {
  return `购物结束：未购买（原因: ${reason}）。`;
}
