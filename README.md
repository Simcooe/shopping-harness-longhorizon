# shopping-harness-longhorizon

基于 **DeepSeek Harness（DSH）** 与现有 **ShopSimulator** 的“无训练”Self-Harness 购物 Agent 原型。

## 研究边界

- **固定 Agent 模型权重**：本项目不做 SFT、GRPO、LoRA，不训练任何模型，也不训练独立的 harness engineer 模型。
- 进化只发生在 **harness 层**：Agent 在 ShopSimulator 中执行购物任务，失败轨迹被记录为证据；随后由**同一个冻结模型**针对失败证据提出 harness 修改建议。
- ShopSimulator 以**固定源码 snapshot** 内嵌于 `environment/ShopSimulator/`（vendored environment）；本仓库可独立安装与运行环境，不依赖 `shopping-grpo-longhorizon` 的运行时代码、训练代码或数据。
- 禁止事项（硬性红线）：
  - 禁止修改 DSH 源码（`dsh/`）。
  - 禁止修改 ShopSimulator 环境源码（`environment/ShopSimulator/`，vendored snapshot），尤其禁止以修改环境语义或 Reward 作为 harness 自进化手段。
  - 禁止修改模型权重。
  - 禁止将 Final-200 Clean 用于失败挖掘、harness patch 生成、调参或候选选择；它只能作为**未来最终盲测**。
- 本版本仅为脚手架：不实现完整 agent，不启动训练或大规模评测。

## 架构

```
默认 harness = DSH base（冻结） + shopping-base plugin（唯一自进化面）
```

### 冻结层（frozen）

| 组件 | 说明 |
|---|---|
| DSH 核心 | 固定 commit SHA，见 `DEPENDENCIES.md`；禁止改源码 |
| 模型 adapter | 冻结；模型权重固定 |
| ShopSimulator 环境 | 本仓库 vendored environment（固定源码 snapshot，见 `DEPENDENCIES.md`）；禁止修改环境语义、Reward 与环境 API |
| `plugins/shopping/src/environment/` | 冻结：环境接入与 HTTP client |
| `plugins/shopping/src/tools/` | 冻结：工具真实 schema 与 search/open/buy 等工具到环境 action 的映射 |
| `plugins/shopping/src/observation/` | 冻结：观测解析与结构化 |
| `plugins/shopping/src/rollout/` | 冻结：rollout 执行与轨迹审计逻辑 |
| Reward / 任务定义 | 冻结：Reward 计算、任务来源与数据红线 |

### 可进化层（editable，唯一允许 Self-Harness 修改的范围）

- `plugins/shopping/src/policy/`
- `harnesses/*/shopping-policy.yml`
- `harnesses/*/system-prompt.md`
- 明确声明的 Cordis overlay 配置键

清单细节见 `plugins/shopping/README.md`。任何编辑面之外的改动都视为违规。

### 特别强调

- 自进化优化的是**工具使用协议、上下文组织、失败恢复与终止策略**；
- **不得**修改 ShopSimulator 工具的真实语义；
- **不得**修改 search/open/buy 等工具到环境 action 的映射；
- **不得**修改 HTTP client、Reward、任务定义或轨迹审计逻辑。

### 闭环（后续实现）

```
rollout → failure evidence → candidate patch → held-in/held-out gate → promoted harness lineage
```

1. **rollout**：冻结 Agent 在 ShopSimulator 上执行购物任务（`trajectories/`）。
2. **failure evidence**：从失败轨迹中提取结构化证据（`evaluation/`）。
3. **candidate patch**：同一模型基于证据提出 patch，写入 `harnesses/candidates/`。
4. **gate**：held-in / held-out 评测门槛（不使用 Final-200 Clean）。
5. **promote**：通过门槛的 harness 晋升到 `harnesses/promoted/`，保留完整 lineage。

### 候选 patch 的四个硬性要求

每个候选 patch 必须满足：

- **可 diff**：以标准 diff 形式表达，编辑面之外的文件零改动。
- **可回放**：可在固定 seed / 固定任务子集上重放对比。
- **可回滚**：任意候选可被干净撤销，不影响 base。
- **可审计**：附失败证据来源、生成记录与 gate 结果。

## 目录结构

```
shopping-harness-longhorizon/
├── dsh/                    # DeepSeek Harness（外部 clone，SHA 固定，见 DEPENDENCIES.md）
├── environment/
│   └── ShopSimulator/      # vendored 环境 snapshot（固定 source commit，见 DEPENDENCIES.md）
├── plugins/
│   └── shopping/           # shopping plugin；仅 src/policy/ 为可进化层（见其 README）
│       └── src/            # environment/tools/observation/rollout 冻结，policy 可进化
├── harnesses/
│   ├── base/               # 冻结基线 harness = DSH base + shopping-base
│   ├── candidates/         # 候选 patch（必须可 diff/可回放/可回滚/可审计）
│   └── promoted/           # 通过 gate 的 harness 及其 lineage
├── trajectories/           # rollout 轨迹与失败证据（后续实现）
├── evaluation/             # held-in/held-out gate 评测（后续实现）
├── configs/
│   └── tasks/              # 任务声明；development.json 为开发/smoke 专用任务集
├── scripts/                # 环境 setup/start 与 smoke test 包装脚本
├── tests/                  # 脚手架与约束的测试
├── README.md
└── DEPENDENCIES.md
```

## 本地环境 smoke test（无需任何 API key）

验证内嵌 ShopSimulator 可独立启动并完成 reset → interact → release 生命周期，
全程**不接入模型、DSH，不需要 `MODEL_BASE_URL` / `MODEL_API_KEY`**：

```bash
# 1. 创建独立 venv、安装环境依赖、解压商品数据、构建搜索索引
bash scripts/setup_environment.sh

# 2. 启动服务（默认 http://127.0.0.1:5700，可用 SHOPSIM_PORT 覆盖端口）
bash scripts/start_environment.sh

# 3. 另开一个终端，运行 smoke test
python3 scripts/smoke_environment.py
```

- smoke test 使用的任务来自 `configs/tasks/development.json` 声明的开发任务集
  （`purpose: development_smoke_only`）；当前 smoke 仅使用项目声明的开发任务，
  正式与 Final-200 的隔离验证将在未来引入 benchmark manifest 后执行。
- 环境变量模板见 `.env.example`（仅本地地址配置；`.env` 不入库）。
- 注意：snapshot 的 `pack_api.py` 绑定 `0.0.0.0`（上游冻结行为），本项目所有
  调用默认走 `127.0.0.1`。

## 当前状态

- 脚手架与依赖固定：完成。
- 内嵌 ShopSimulator 独立启动与 HTTP smoke test：完成（`scripts/`）。
- 完整 agent、rollout、patch 生成与 gate：未实现，见各目录 README 占位说明。
