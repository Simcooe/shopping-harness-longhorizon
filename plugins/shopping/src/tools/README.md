# src/tools — 冻结层

三个 model-facing 购物工具的**真实 schema**、到 ShopSimulator 环境
action 的固定映射，以及 DSH 工具注册装配。

**冻结层，不允许 Self-Harness patch。**

## 已实现

| 文件 | 职责 |
|---|---|
| `schemas.ts` | 三个工具的严格 JSON Schema（additionalProperties: false）与参数校验 |
| `actions.ts` | 固定映射：`search_products → search[...]`、`open_product → click[...]`、`finish_without_purchase → finish[no_suitable_product]` |
| `runtime.ts` | 会话持有者：task_id 只能由外部 runner 注入 |
| `register.ts` | 按固定 DSH commit 的 `ToolRuntime.register(ToolDefinition)` 形态构建并注册工具 |

## 三个工具

1. `search_products({ query })`
2. `open_product({ asin })`
3. `finish_without_purchase({ reason: "no_suitable_product" })`

## 边界约束

- 不得修改工具真实语义，不得修改工具到环境 action 的映射。
- 工具 handler 不决定 task_id，不创建新任务。
- 工具结果经 observation 层投影，不泄漏 goal/gold/reward/完整 observation。
- 候选 patch 触碰本目录即视为违规。

当前状态：已实现并通过 mock 测试；尚未被真实 DSH runtime 加载执行。
