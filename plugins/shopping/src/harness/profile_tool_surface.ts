/**
 * shopping-base profile 的 model-facing tool surface 约束（冻结基础设施）。
 *
 * h0 要求模型可见工具面**恰好只有** shop_search / shop_click / shop_finish，
 * 因此 shopping-base profile patch（harnesses/base/cordis.patch.yml）必须用
 * 固定 DSH 的 `disabled: true` row override 禁用 DSH base 的全部 model-facing
 * 默认工具 row。本清单与固定 DSH base bundle
 * （dsh/packages/bundle/base/cordis.patch.yml）中的 model-facing tool row
 * 一一对应，是 offline 校验的唯一权威来源。
 *
 * 注意：`plan-mode` 的 id 不以 `tool-` 开头，但它通过 ctx.tools.register 注册
 * model-facing 的 `exit_plan_mode`，因此同样必须禁用。`tools`（DSH 工具注册表
 * 本身）**不在**禁用清单内，运行时基础设施（agent loop / headless runner /
 * llm adapter / session / system prompt）亦不受影响。
 */

export const DEFAULT_MODEL_FACING_TOOL_ROWS = [
  "tool-bash",
  "tool-pwsh",
  "tool-jobs",
  "tool-fs",
  "tool-fs-search",
  "tool-skill",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-report",
  "tool-workflow",
  "tool-todo",
  "tool-goal",
  "tool-ralph",
  "tool-str-replace-editor",
  "tool-web",
  "plan-mode",
] as const;

/**
 * 行 id 以 `tool-` 开头、但**并非** model-facing 工具的 row（不在禁用清单内）。
 * 例如 `tool-result-pruner`（@deepseek-ai/dsh-compaction-tool-result-pruner）是
 * 工具结果裁剪器，不通过 ctx.tools.register 向模型暴露工具。
 */
export const NON_MODEL_FACING_TOOL_PREFIXED_ROWS = [
  "tool-result-pruner",
] as const;

/** 这些工具名绝不允许出现在 h0 的 model-facing tool surface 中。 */
export const FORBIDDEN_MODEL_TOOL_NAMES = [
  "get_goal",
  "create_goal",
  "update_goal",
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "todo_write",
  "subagent",
  "subagent_fork",
  "send_message",
  "list_agents",
  "report",
  "workflow",
  "ralph",
  "str_replace_editor",
  "web_search",
  "exit_plan_mode",
  "ask_user_question",
] as const;
