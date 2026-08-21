/**
 * 冻结 action guard（primitive 化）：基于"模型上一轮实际看到的
 * actor-visible observation"在调用环境前校验 primitive 调用。
 *
 * guard 拒绝时：不调用 ShopSimulator、不消耗步数；向模型返回安全、
 * 简短、可行动的纠正信息，并写 actor trace 的 guard_rejection 事件。
 * 绝不包含 reward/gold/隐藏信息。
 *
 * 本文件为冻结层：未来 Self-Harness 不得修改。
 */

import type { ActorObservation } from "../environment/protocol.ts";
import type { Primitive } from "../harness/surface.ts";

/** guard 所依据的 actor-visible 状态（全部来自模型实际可见的观测）。 */
export interface GuardState {
  /** 最近一次 actor 观测；尚未有任何观测时为 null。 */
  observation: ActorObservation | null;
  /** 任务是否已 terminal（done/over/release）。 */
  terminal: boolean;
  /** 是否有购物工具调用正在执行（每轮最多一个购物工具调用）。 */
  inFlight: boolean;
}

export class GuardRejectionError extends Error {
  /** 机器可读的拒绝类别（写入 actor trace）。 */
  readonly guardReason: string;

  constructor(guardReason: string, message: string) {
    super(message);
    this.name = "GuardRejectionError";
    this.guardReason = guardReason;
  }
}

/**
 * 校验一次 primitive 调用；违规抛出 GuardRejectionError。
 * 纯函数：不产生任何 I/O，更不调用 ShopSimulator。
 *
 * guard 状态只反映**当前页面**观测（每次 interact 后被替换），
 * 因此历史页面的 target 天然不可用。
 */
export function checkPrimitiveCall(
  primitive: Primitive,
  args: Record<string, unknown>,
  state: GuardState,
): void {
  if (state.terminal) {
    throw new GuardRejectionError(
      "terminal",
      "任务已结束，不能再调用购物工具。",
    );
  }
  if (state.inFlight) {
    throw new GuardRejectionError(
      "concurrent_call",
      "已有购物工具调用在执行：每轮最多一个购物工具调用，请等待结果。",
    );
  }

  switch (primitive) {
    case "search": {
      if (state.observation !== null && !state.observation.searchAvailable) {
        throw new GuardRejectionError(
          "search_unavailable",
          "当前页面没有搜索框，无法搜索。",
        );
      }
      return;
    }
    case "click": {
      if (state.observation === null) {
        throw new GuardRejectionError(
          "no_observation",
          "当前还没有任何页面观测，请先执行 shop_search。",
        );
      }
      const target = typeof args["target"] === "string" ? args["target"] : "";
      const visible = new Set(
        state.observation.clickables.map((entry) => entry.toLowerCase()),
      );
      if (target.length === 0 || !visible.has(target.toLowerCase())) {
        throw new GuardRejectionError(
          "target_not_visible",
          "该 target 不在当前页面可见的可点击项中。请只使用当前页面上实际可见的可点击项。",
        );
      }
      return;
    }
    case "finish": {
      if (args["reason"] !== "no_suitable_product") {
        throw new GuardRejectionError(
          "invalid_finish_reason",
          'shop_finish 的 reason 必须严格等于 "no_suitable_product"。',
        );
      }
      return;
    }
    default:
      throw new GuardRejectionError(
        "unknown_primitive",
        `未知 primitive: ${String(primitive)}`,
      );
  }
}
