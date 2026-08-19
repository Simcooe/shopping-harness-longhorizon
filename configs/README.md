# configs

运行与评测配置。

## tasks/

任务声明目录：

- `tasks/development.json`：本项目自行声明的**开发/smoke 专用任务集**
  （`purpose: development_smoke_only`）。`scripts/smoke_environment.py`
  从这里读取 task ID，不再硬编码。
  - 不包含 Final-200 Clean 的任何 task ID；
  - 正式与 Final-200 的隔离验证将在未来引入 benchmark manifest 后执行。

其余运行与评测配置（rollout 任务子集划分、seed、预算与循环上限、gate
判定阈值等）后续实现；所有配置需保证可回放。
