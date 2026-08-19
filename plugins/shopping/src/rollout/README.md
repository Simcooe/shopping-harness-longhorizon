# src/rollout — 冻结层

rollout 执行与**轨迹审计**逻辑：任务领取、步数记录、租约
（reset → interact → release_one）管理、轨迹落盘格式。

**冻结层，不允许 Self-Harness patch。**

- 轨迹审计必须独立于被评估的 policy，否则自进化的证据链不可信。
- 候选 patch 触碰本目录即视为违规。

当前状态：占位，尚未实现。
