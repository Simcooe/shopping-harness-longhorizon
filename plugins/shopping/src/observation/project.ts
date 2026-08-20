/**
 * observation 投影（冻结层）：把环境返回的信息投影为 actor-safe 的
 * 模型上下文（Phase 6 双通道版本）。
 *
 * actor 通道允许记录/呈现**模型真正看到的**任务 instruction 与页面观测；
 * evaluator 通道（reward/gold/termination 证据）绝不经过本层。
 * 剔除名单见 protocol.ts 的 ACTOR_FORBIDDEN_KEYS（goal、goal_options、
 * reward、reward_detail、purchase、user_persona 等）；渲染输出全部由
 * 白名单字段构造，不复制未知字段。
 */

import {
  MAX_ACTOR_TEXT_CHARS,
  type ActorObservation,
  type InteractResult,
  type ResetResult,
} from "../environment/protocol.ts";
import { visibleOptionValues, visibleProductAsins } from "../tools/guard.ts";

/** 显式剔除的服务端字段（文档化红线）。 */
export const HIDDEN_RESULT_FIELDS = [
  "reward",
  "reward_detail",
  "goal",
  "goal_options",
  "purchase",
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

export interface ProjectedReset {
  envIdx: number;
  environmentVersion: string | null;
}

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

export function projectReset(result: ResetResult): ProjectedReset {
  return {
    envIdx: result.envIdx,
    environmentVersion: result.environmentVersion,
  };
}

export function projectInteract(result: InteractResult): ProjectedInteract {
  return {
    envIdx: result.envIdx,
    done: result.done,
    over: result.over,
  };
}

function truncate(text: string, limit: number = MAX_ACTOR_TEXT_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function money(value: unknown): string {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "object" && value !== null) {
    const price = (value as Record<string, unknown>)["price"]
      ?? (value as Record<string, unknown>)["current_price"];
    if (typeof price === "number") {
      return String(price);
    }
  }
  return "?";
}

/**
 * 渲染 actor-visible 页面观测（模型可见的完整脱敏版本）。
 * 仅使用白名单结构化字段构造，绝不复制隐藏字段。
 */
export function renderObservation(observation: ActorObservation | null): string {
  if (observation === null) {
    return "（暂无页面观测）";
  }
  const lines: string[] = [`页面类型: ${observation.pageType}`];
  const state = observation.state;

  if (observation.pageType === "search_results") {
    const query = typeof state["query"] === "string" ? state["query"] : "";
    const page = state["page"];
    const totalPages = state["total_pages"];
    const totalResults = state["total_results"];
    lines.push(
      `搜索词: ${query}；第 ${String(page)} / ${String(totalPages)} 页，共 ${String(totalResults)} 个结果`,
    );
    const products = Array.isArray(state["products"])
      ? (state["products"] as Array<Record<string, unknown>>)
      : [];
    if (products.length === 0) {
      lines.push("（本页无商品）");
    }
    for (const product of products.slice(0, 20)) {
      const rank = product["rank"];
      const asin = String(product["asin"] ?? "");
      const title = String(product["title"] ?? "");
      const price = money(product["price"]);
      const brand = String(product["brand"] ?? "");
      lines.push(`${String(rank)}. [${asin}] ${title}（品牌: ${brand}，价格: ${price}）`);
    }
  } else if (
    observation.pageType === "product_detail"
    || observation.pageType === "information_subpage"
  ) {
    const product = typeof state["product"] === "object" && state["product"] !== null
      ? state["product"] as Record<string, unknown>
      : {};
    lines.push(
      `当前商品: [${String(product["asin"] ?? "")}] ${String(product["title"] ?? "")}（价格: ${money(product["price"])}）`,
    );
    const selectedOptions = typeof state["selected_options"] === "object"
      && state["selected_options"] !== null
      ? state["selected_options"] as Record<string, unknown>
      : {};
    if (Object.keys(selectedOptions).length > 0) {
      lines.push(`已选规格: ${JSON.stringify(selectedOptions)}`);
    }
    const optionValues = visibleOptionValues(observation);
    if (optionValues.length > 0) {
      lines.push(`可选规格值: ${optionValues.slice(0, 30).join(" | ")}`);
    }
    if (state["selected_price"] !== undefined) {
      lines.push(`当前规格价格: ${money(state["selected_price"])}`);
    }
    if (observation.pageType === "information_subpage") {
      const subpage = String(state["subpage"] ?? "");
      const content = String(state["content"] ?? "");
      lines.push(`子页: ${subpage}`);
      lines.push(truncate(`内容: ${content}`, 1200));
    }
  }

  const buttons = observation.clickables.filter(
    (entry) => !visibleProductAsins(observation).map((asin) => asin.toLowerCase())
      .includes(entry.toLowerCase()),
  );
  if (buttons.length > 0) {
    lines.push(`可用按钮/选项: ${buttons.slice(0, 30).join(" | ")}`);
  }
  lines.push(`搜索功能: ${observation.searchAvailable ? "可用" : "不可用"}`);
  return truncate(lines.join("\n"));
}

/**
 * 渲染 model-visible 的工具结果摘要（动作 + 页面观测）。
 * 任务指令不在此注入：它由 runner bootstrap 放进 DSH 初始 prompt，
 * 工具结果绝不重复携带任务全文。
 */
export function renderToolSummary(options: {
  environmentAction: string;
  done: boolean;
  observation: ActorObservation | null;
}): string {
  const sections: string[] = [];
  sections.push(`已执行环境动作: ${truncate(options.environmentAction, 120)}`);
  sections.push(`任务状态: ${options.done ? "已结束" : "进行中"}`);
  sections.push(`【当前页面】\n${renderObservation(options.observation)}`);
  return sections.join("\n\n");
}

/** finish 类动作的 model-visible 摘要。 */
export function renderFinishSummary(reason: string): string {
  return `购物结束：未购买（原因: ${reason}）。`;
}
