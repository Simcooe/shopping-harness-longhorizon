/**
 * 冻结 action guard（tools 层）：基于"模型上一轮实际看到的 actor-visible
 * observation"在调用环境前校验工具调用。
 *
 * guard 拒绝时：不调用 ShopSimulator、不消耗步数；向 DSH 返回安全、简短、
 * 可行动的纠正信息（经 GuardRejectionError 消息），并写 actor trace 的
 * guard_rejection 事件。绝不包含 reward/gold/隐藏信息。
 *
 * 本文件为冻结层：未来 Self-Harness 不得修改。
 */

import type { ActorObservation } from "../environment/protocol.ts";
import type { ShoppingToolName } from "./actions.ts";

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

/** 无参数工具 → 当前页面必须可见的按钮文案（与环境常量一致）。 */
const BUTTON_BY_TOOL: Partial<Record<ShoppingToolName, string>> = {
  view_description: "Description",
  view_features: "Features",
  view_reviews: "Reviews",
  view_attributes: "Attributes",
  next_page: "Next >",
  prev_page: "< Prev",
  back_to_search: "Back to Search",
  buy_now: "Buy Now",
};

function lowerSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

/** 当前页面可见商品 asin（搜索结果页）。 */
export function visibleProductAsins(observation: ActorObservation): string[] {
  const products = observation.state["products"];
  if (!Array.isArray(products)) {
    return [];
  }
  const asins: string[] = [];
  for (const product of products) {
    if (typeof product === "object" && product !== null) {
      const asin = (product as Record<string, unknown>)["asin"];
      if (typeof asin === "string" && asin.length > 0) {
        asins.push(asin);
      }
    }
  }
  return asins;
}

/** 当前页面可选选项值（商品详情页）。 */
export function visibleOptionValues(observation: ActorObservation): string[] {
  const values: string[] = [];
  const availableOptions = observation.state["available_options"];
  if (typeof availableOptions === "object" && availableOptions !== null) {
    for (const optionValues of Object.values(
      availableOptions as Record<string, unknown>,
    )) {
      if (Array.isArray(optionValues)) {
        for (const entry of optionValues) {
          if (typeof entry === "string") {
            values.push(entry);
          }
        }
      }
    }
  }
  return values;
}

/**
 * 校验一次工具调用；违规抛出 GuardRejectionError（携带可行动纠正信息）。
 * 纯函数：不产生任何 I/O，更不调用 ShopSimulator。
 */
export function checkToolCall(
  toolName: ShoppingToolName,
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

  const observation = state.observation;

  if (toolName === "finish_without_purchase") {
    if (args["reason"] !== "no_suitable_product") {
      throw new GuardRejectionError(
        "invalid_finish_reason",
        'finish_without_purchase 的 reason 必须严格等于 "no_suitable_product"。',
      );
    }
    return;
  }

  if (toolName === "search_products") {
    if (observation !== null && !observation.searchAvailable) {
      throw new GuardRejectionError(
        "search_unavailable",
        "当前页面没有搜索框，无法搜索。请先 back_to_search 回到搜索首页。",
      );
    }
    return;
  }

  // 其余工具都依赖当前页面可见内容
  if (observation === null) {
    throw new GuardRejectionError(
      "no_observation",
      "当前还没有任何页面观测，请先执行 search_products。",
    );
  }

  if (toolName === "open_product") {
    if (observation.pageType !== "search_results") {
      throw new GuardRejectionError(
        "not_on_search_results",
        "open_product 只能在搜索结果页使用；请先搜索或 back_to_search。",
      );
    }
    const asin = typeof args["asin"] === "string" ? args["asin"] : "";
    const visible = lowerSet(visibleProductAsins(observation));
    if (!visible.has(asin.toLowerCase())) {
      throw new GuardRejectionError(
        "asin_not_visible",
        "该 asin 不在当前页面可见的商品列表中。请只使用当前结果页列出的商品 ID。",
      );
    }
    return;
  }

  if (toolName === "select_option") {
    const value = typeof args["value"] === "string" ? args["value"] : "";
    const allowed = lowerSet([
      ...observation.clickables,
      ...visibleOptionValues(observation),
    ]);
    if (!allowed.has(value.toLowerCase())) {
      throw new GuardRejectionError(
        "option_not_visible",
        "该选项不在当前页面可见选项中。请只选择当前商品页列出的选项值。",
      );
    }
    return;
  }

  const requiredButton = BUTTON_BY_TOOL[toolName];
  if (requiredButton !== undefined) {
    const clickables = lowerSet(observation.clickables);
    if (!clickables.has(requiredButton.toLowerCase())) {
      throw new GuardRejectionError(
        "button_not_visible",
        `当前页面没有 "${requiredButton}" 按钮，不能执行 ${toolName}。请检查当前页面可用的操作。`,
      );
    }
  }
}
