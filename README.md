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

## 运行一条真实任务（需要用户显式填写模型配置 + 显式 --live）

```bash
cd /Users/ywwl/self/shopping-harness-longhorizon

# 仅首次：准备 ShopSimulator 环境
bash scripts/setup_environment.sh

# 用户填写模型连接信息；该文件不会提交
cp .env.example .env
# 编辑 .env，填写 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME

# 终端 A：启动 ShopSimulator
bash scripts/start_environment.sh

# 终端 B：运行一条真实开发任务
bash scripts/run_live_task.sh --task-id 0 --live
```

要点：

- 未传 `--live` 不会调用模型；缺 `.env` 或任一模型字段会明确报错且不调用模型。
- `task_id` 必须属于 `configs/tasks/development.json`，由 runner 注入，
  模型不得选择；最大环境步数与工具白名单来自 `configs/live-task.example.yml`。
- runner 使用官方发布的 `@deepseek-ai/dsh@0.1.0-rc.7` CLI（与固定 DSH SHA
  版本一致）+ `harnesses/base` 的 shopping-base profile；运行时安装在
  `.live/`（gitignore）。模型密钥映射为官方 adapter 读取的
  `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`。
- **任务指令先于第一次模型决策**：runner 在启动 DSH 之前对环境 reset 一次
  （整个 run 唯一一次），把 actor-safe 的 `{run_id, task_id, env_idx,
  instruction_text}` 写入 `.live/runs/<run_id>/bootstrap.json`（0600，按 run 隔离）；真实任务文本以
  `<shopping_task>` 边界注入 DSH 初始 prompt（argv 传递，无 shell 注入面）；
  plugin 在 boot 阶段接管同一 `env_idx`，绝不二次 reset。
- 任何退出路径（正常/异常/Ctrl-C）都只 `release_one` 当前 `env_idx`
  （幂等；绝不使用 `release_all`）。cleanup 失败时**不会**删除 bootstrap
  文件、也不会静默声称已释放，手动重试：
  `SHOPPING_BOOTSTRAP=/abs/path/to/bootstrap.json SHOPSIM_BASE_URL=http://127.0.0.1:5700 node scripts/cleanup_live_session.ts`
- actor trace 写入 `trajectories/actor/<run_id>.jsonl`，evaluator record
  写入 `evaluation/runs/<run_id>.json`（均不入库）。
- Final-200 Clean 绝不进入本流程。

## 当前状态

- 脚手架与依赖固定：完成。
- 内嵌 ShopSimulator 独立启动与 HTTP smoke test：完成（`scripts/`）。
- shopping plugin environment adapter（HTTP client + session 生命周期）：
  完成，mock 单元测试通过；`pnpm --dir plugins/shopping smoke-shopping-adapter --live`
  可在环境运行时做 live 验证。
- shopping plugin 已按 DSH 真实 bundle/profile 机制装配：**12 个冻结购物
  工具**（search_products / open_product / select_option / view_description /
  view_features / view_reviews / view_attributes / next_page / prev_page /
  back_to_search / buy_now / finish_without_purchase）经 `ctx.tools.register`
  注册，带冻结 action guard（参数必须来自模型实际看到的页面观测）；
  `harnesses/base/` 为 shopping-base profile。
  离线装配检查：`pnpm --dir plugins/shopping check:dsh`。
  机制与限制见 `docs/dsh-shopping-plugin.md`。
- **双轨迹记录（Phase 6）**：
  - `trajectories/actor/<run_id>.jsonl` — **actor trace**：模型实际可见的
    证据（任务指令、工具调用、环境 action、脱敏页面观测、guard 拒绝、
    terminal/release），未来 Self-Harness 从这里挖掘失败模式；
  - `evaluation/runs/<run_id>.json` — **evaluator record**：结果证据
    （环境 reward / reward 类型 / 有效性、终止原因、步数与 guard 统计、
    失败标签），与 actor trace 以 `run_id` 关联。
  - **Reward 只在 evaluator 侧**：evaluator 证据经 client 的 evaluatorSink
    直达记录器，工具结果/prompt/DSH session 在类型上拿不到它，绝无回灌
    同一任务模型的路径。两者均为运行产物，不入库。
- **本阶段仍不是 Self-Harness**：不根据 evaluator record 修改 harness，
  不做失败挖掘/候选 patch/训练。
- live runner 已就绪：用户填写 `.env` 模型配置并显式 `--live` 后，
  `bash scripts/run_live_task.sh --task-id 0 --live` 运行单条真实任务
  （见上节）。本仓库未提交任何 `.env`，未代为执行模型调用。
- Self-Harness（候选 patch 生成与 gate）：未实现，见各目录 README。

## 本地开发流程

```bash
# 1. 环境准备与启动（见上文 smoke test 小节）
bash scripts/setup_environment.sh
bash scripts/start_environment.sh

# 2. shopping plugin：构建、测试、离线装配检查
pnpm --dir plugins/shopping install
pnpm --dir plugins/shopping build
pnpm --dir plugins/shopping test:all     # mock 测试（含脱敏与映射）
pnpm --dir plugins/shopping check:dsh    # 无模型装配检查

# 3. Python 侧测试
python3 -m unittest discover -s tests -p "test_*.py" -v
```

以上所有步骤**不需要任何 API key**；接入模型是独立的后续步骤。
