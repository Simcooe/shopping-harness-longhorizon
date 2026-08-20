# src/rollout — 冻结层

rollout 执行与**轨迹审计**逻辑。

**冻结层，不允许 Self-Harness patch。**

## 已实现

| 文件 | 职责 |
|---|---|
| `recorder.ts` | 最小 JSONL rollout 记录器（脱敏：禁写 goal/gold/reward/完整 observation/凭据） |
| `task_source.ts` | 任务来源：task_id 只能由外部 runner 从 `configs/tasks/development.json` 注入，模型不得决定 |

## 约束

- 轨迹审计必须独立于被评估的 policy，否则自进化的证据链不可信。
- 轨迹写入仓库根 `trajectories/`（JSONL 运行产物不入库）。
- 候选 patch 触碰本目录即视为违规。

当前状态：已实现并通过脱敏测试；完整 rollout 执行器（驱动模型循环）
未实现。
