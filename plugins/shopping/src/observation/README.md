# src/observation — 冻结层

环境信息到模型上下文的投影：白名单原则，只保留明确列出的公共字段。

**冻结层，不允许 Self-Harness patch。**

## 已实现

| 文件 | 职责 |
|---|---|
| `project.ts` | 白名单投影与渲染：显式剔除 reward、reward_detail、goal、goal_options、purchase、instruction 类 goal 文本、user_persona 等隐藏字段 |

## 约束

- 所有 model-visible 内容必须可从 session log 重建：投影输出是工具结果
  的唯一来源，由 DSH agent-loop 记入 `tool/result`（固定 DSH commit 的
  行为），无需插件手动 emit。
- 观测的解析与呈现必须与环境真实状态一致，自进化不得改写观测语义。
- 候选 patch 触碰本目录即视为违规。

当前状态：已实现并通过脱敏测试。
