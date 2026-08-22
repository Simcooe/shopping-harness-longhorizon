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
默认 harness = DSH base（冻结） + shopping plugin（冻结基础设施） + h0 harness 内容（唯一可进化面）
```

### 冻结层（frozen）

| 组件 | 说明 |
|---|---|
| DSH 核心 | 固定 commit SHA，见 `DEPENDENCIES.md`；禁止改源码 |
| 模型 adapter | 冻结；模型权重固定 |
| ShopSimulator 环境 | 本仓库 vendored environment（固定源码 snapshot，见 `DEPENDENCIES.md`）；禁止修改环境语义、Reward 与环境 API |
| `plugins/shopping/src/environment/` | 冻结：环境接入与 HTTP adapter |
| primitive action grammar | 冻结：`search[...]` / `click[...]` / `finish[...]` 文法与安全校验 |
| `plugins/shopping/src/harness/` | 冻结基础设施：tool-surface resolver / schema validator |
| `plugins/shopping/src/tools/` | 冻结：guard 与 DSH 注册装配 |
| `plugins/shopping/src/observation/` | 冻结：观测解析与结构化 |
| `plugins/shopping/src/rollout/` | 冻结：轨迹审计、task source、evaluator record |
| actor/evaluator 双轨迹隔离 | 冻结：reward 只在 evaluator 侧，绝不回灌 |
| Reward / 任务定义 | 冻结：Reward 计算、任务来源与数据红线 |
| 模型权重与模型连接 | 冻结：固定模型；连接配置只在本地 .env |

### 可编辑层（editable，唯一允许 Self-Harness 修改的范围）

- `harnesses/*/system-prompt.md`
- `harnesses/*/tool-surface.yml`
- `harnesses/*/runtime-policy.yml`
- `harnesses/*/verification-policy.yml`
- 明确声明的 Cordis overlay 配置键

注意：**某个 harness 的 YAML/md 内容**才是未来 candidate 可修改对象；
plugin 的 tool-surface resolver / schema validator 是冻结基础设施。
清单细节见 `plugins/shopping/README.md`。任何编辑面之外的改动都视为违规。

### 特别强调

- 自进化优化的是**工具使用协议、上下文组织、失败恢复与终止策略**；
- **不得**修改 ShopSimulator 工具的真实语义；
- **不得**修改 primitive（search/click/finish）到环境 action 的冻结映射；
- **不得**修改 HTTP client、Reward、任务定义或轨迹审计逻辑。

### 闭环（Self-Harness loop v1）

```
h0 baseline（held-in 0-7 / held-out 8-11）
  → held-in failure evidence bundle
  → 同一冻结模型 proposer
  → 受限 candidate Harness
  → held-in + held-out candidate evaluation
  → 自动 gate
  → promote 或 reject
  → lineage / audit
```

1. **rollout / baseline**：冻结 Agent 在 ShopSimulator 上执行购物任务，
   产出 held-in/held-out baseline（`evaluation/baselines/`）。
2. **failure evidence**：从 held-in 失败轨迹提取脱敏、确定性、可审计的
   evidence bundle（`evaluation/evidence/`）。
3. **proposer**：同一冻结模型基于 held-in evidence 提出受限 candidate patch
   （`scripts/propose_harness_candidate.ts`，显式 `--live`）。
4. **candidate**：受限 JSON proposal 落成 `harnesses/candidates/<id>/`，
   经 `loadHarness()` 校验。
5. **gate**：candidate 跑 held-in + held-out，与 base baseline 逐项比较
   （`scripts/evaluate_candidate.sh`，显式 `--live`）。
6. **promote / lineage**：gate accepted 后晋升到 `harnesses/promoted/<id>/`，
   保留完整 lineage（`scripts/promote_harness.ts`，无模型）。

**held-out 只由 gate 读取，绝不进入 proposer / evidence。** Final-200 Clean
始终不参与。

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
│   └── shopping/           # shopping plugin（见其 README）
│       └── src/            # environment/harness/tools/observation/rollout 全冻结
├── harnesses/
│   ├── base/               # 默认 Harness h0（shopping-h0）：harness.yml +
│   │                       # system-prompt.md + tool-surface.yml +
│   │                       # runtime-policy.yml + verification-policy.yml
│   ├── candidates/         # 候选 patch（必须可 diff/可回放/可回滚/可审计）
│   └── promoted/           # 通过 gate 的 harness 及其 lineage
├── trajectories/           # rollout 轨迹与失败证据（后续实现）
├── evaluation/             # evaluator record 与 baseline 结果（运行产物不入库）
├── configs/
│   ├── tasks/              # 任务声明；development.json 为开发任务集
│   └── evaluation/         # development-v1 benchmark manifest + h0 35 步配置
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

## h0 baseline evaluation（35 步，固定 development split）

与单条 smoke（5 步，只验证联通）**严格区分**：

| | 单条 smoke | h0 baseline evaluation |
|---|---|---|
| 配置 | `configs/live-task.example.yml`（5 步，保持不变） | `configs/evaluation/h0-baseline-v1.yml`（35 步） |
| 任务 | task 0 | `configs/evaluation/development-v1.yml` 的 held-in(0-7)/held-out(8-11) |
| 用途 | 联通性验证 | 可比较的 baseline 结果与失败轨迹（后续 failure evidence 的输入） |

```bash
# 终端 A
bash scripts/start_environment.sh

# 终端 B：先验证 development task IDs（不调用模型）
python3 scripts/validate_development_tasks.py --manifest configs/evaluation/development-v1.yml

# 用户确认 .env 已填写后，显式运行 h0 baseline
bash scripts/run_h0_baseline_eval.sh --all --live
# 或分开：--split held-in --live / --split held-out --live
```

要点：

- 没有 `--live` 直接退出，不调用模型；不读取、不打印 API key。
- 每个 task 独立 run_id / bootstrap / actor trace / evaluator record；
  task 之间重新 reset，不共享会话；每个 task 完成后 `release_one`
  （绝不 `release_all`）；单 task 失败不阻断其余。
- 结果写入 `evaluation/baselines/<baseline_run_id>/`（gitignore）：
  `manifest.json`（baseline 元信息 + task→run 映射）、`held-in.json` /
  `held-out.json`（split 结果严格分开）、`summary.json`（状态计数、
  `environment_done_rate` 执行状态、reward type 汇总——只在 evaluator 侧聚合）。
- 结果语义绝不伪造：DSH 在环境 terminal 前退出且无 evaluator record →
  `missing_evaluator_record`；runner 非零 → `runner_failure`；
  `shop_finish` 不算成功，environment done + evaluator 证据才算数。
- **held-out 隔离**：held-out 结果单独文件并声明用途；后续 proposer
  绝不读取 held-out，它只用于 candidate gate。
- baseline 结果只用于后续 failure evidence；当前仍未实现 Self-Harness
  proposer / candidate / gate；Final-200 Clean 不在本流程中。

## held-in failure evidence bundle（h0 baseline → 下一阶段）

闭环路线：

```
h0 baseline（held-in 0-7 / held-out 8-11）
  → held-in failure evidence bundle（本阶段）
  → future proposer（同一冻结模型，仅基于 held-in evidence 提出 harness 修改）
  → future candidate gate（held-out 只做 gate）
```

```bash
node scripts/build_failure_evidence.ts --baseline-dir evaluation/baselines/<baseline_run_id>
# 默认输出 evaluation/evidence/<baseline_run_id>/{manifest.json,held-in-evidence.json}
```

要点：

- **只使用 held-in**：evidence builder 只读 baseline 的 `manifest.json` /
  `held-in.json` 及其引用的 actor trace / evaluator record；绝不读
  `held-out.json`。传入 `--split held-out`、`--split all` 或 `--all` 会被明确拒绝。
- **held-out 永远不进入 proposer / evidence**；它只留给未来的 candidate gate。
- **确定性、脱敏、可审计**：聚类完全确定性（无 LLM、无随机），相同输入重复
  构建输出稳定；evidence 只含 task_id / run_id / 文件相对路径 / 工具名与计数 /
  guard 拒绝计数 / terminal reason / evaluator failure label 与 reward type 的
  类别名 / 执行状态与统计数量，**绝不含** goal / gold / reward 数值 / purchase /
  原始 instruction / observation / query / target / 工具参数 / 模型文本。
- **成功/失败/未知只以 evaluator 证据为准**：environment done 是执行状态，
  不等于成功；`shop_finish` 更不等于成功；成功 = evaluator
  `reward_valid=true` 且 `reward_type ∈ {gold_purchase, valid_alternative_purchase}`；
  失败 = evaluator 明确失败 label / reward type / reward_valid=false；
  证据不足一律 `unknown`（绝不伪装 pass）。不完整 run（runner_failure /
  missing_evaluator_record / evaluator record 损坏）归入 `infra_failure`，
  不据此推断"任务失败原因"。
- **evidence bundle 不等于 patch**：`candidate_editable_surfaces` 只是"可能
  相关的可编辑面"白名单，不是 patch 建议，也不自动改 harness。
- **当前仍未实现** proposer / candidate / gate / promotion；Final-200 Clean
  不在本流程中。evidence builder 是冻结基础设施（`plugins/shopping/src/evidence/`）。

## 当前状态

- 脚手架与依赖固定：完成。
- 内嵌 ShopSimulator 独立启动与 HTTP smoke test：完成（`scripts/`）。
- shopping plugin environment adapter（HTTP client + session 生命周期）：
  完成，mock 单元测试通过；`pnpm --dir plugins/shopping smoke-shopping-adapter --live`
  可在环境运行时做 live 验证。
- **默认 Harness h0（shopping-h0）**：机器可读的 canonical 表示
  （`harnesses/base/harness.yml` + tool-surface/runtime-policy/
  verification-policy + system-prompt）。h0 只向模型暴露三个 primitive
  工具：`shop_search` / `shop_click` / `shop_finish`，经冻结映射对应
  `search[...]` / `click[...]` / `finish[...]`；工具名与 schema 的唯一
  来源是 `tool-surface.yml`。`shop_click.target` 必须来自模型实际看到的
  当前页面可点击项（冻结 guard）。
  离线装配检查：`pnpm --dir plugins/shopping check:dsh`
  （输出 registered=[shop_click, shop_finish, shop_search]）。
  机制与限制见 `docs/dsh-shopping-plugin.md`。
- **shopping-only 模型工具面**：shopping-base profile 的
  `harnesses/base/cordis.patch.yml` 用固定 DSH 的 `disabled: true` row
  override 禁用 DSH base 的全部 model-facing 默认工具（bash/fs/todo/goal/
  subagent/workflow/ralph/web_search/exit_plan_mode 等 18 个 row），使模型
  请求中的 tool schema 恰好只有三个 h0 工具；DSH base 的运行时基础设施
  （tools registry / agent loop / headless runner / llm adapter / session /
  system prompt）不受影响。清单见
  `plugins/shopping/src/harness/profile_tool_surface.ts`。
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
- **固定 development benchmark（shopping-development-v1）**：12 个经
  vendored ShopSimulator reset/release 验证的 task（held-in 0-7 /
  held-out 8-11）；task 发现/验证脚本 `scripts/validate_development_tasks.py`
  （无模型、可复现）；不导入 shopping-grpo-longhorizon 的任何内容，
  不宣称与 Final-200 不相交（其构成在本仓库未知），Final-200 绝不进入流程。
- **h0 批量 baseline evaluator**：`scripts/run_h0_baseline_eval.sh`
  （显式 --live）批量运行 split，聚合脱敏结果到
  `evaluation/baselines/<baseline_run_id>/`（35 步正式配置）。
- **held-in failure evidence bundle**：`scripts/build_failure_evidence.ts`
  把一个 baseline 的 held-in 运行记录转换为脱敏、确定性、可审计的
  failure evidence bundle（`evaluation/evidence/<baseline_run_id>/`），
  作为未来同一冻结模型 proposer 的唯一失败输入；只读 held-in，绝不读
  held-out，绝不使用 Final-200。
- **Self-Harness loop v1 骨架**：proposer（`scripts/propose_harness_candidate.ts`，
  显式 `--live`）、candidate materializer（`plugins/shopping/src/candidate/`，
  proposal/audit/patch）、candidate 评测 + gate
  （`scripts/evaluate_candidate.sh`，显式 `--live`）、promotion + lineage
  （`scripts/promote_harness.ts`，无模型）。proposer/candidate/gate/promotion
  默认都不调用模型；只有带 `--live` 的 proposer / evaluation 才可能调用模型。
- **当前 h0 已有真实 held-in evidence**（`evaluation/evidence/
  baseline-2026-08-21T12-52-23-022Z/`）；**held-out baseline 尚未运行**，
  需要用户显式执行 `bash scripts/run_h0_baseline_eval.sh --split held-out --live`
  后，candidate gate 才能比较 held-out（缺 base held-out baseline 时 gate 会
  明确拒绝，绝不拿 held-in 代替 held-out）。
- **执行一致性**：DSH 运行时 persona 来自 `$SHOPPING_HARNESS_DIR/system-prompt.md`
  （经 `.live` effective profile patch 生成），actor 的 model selection 绑定
  `MODEL_NAME`；`SHOPPING_HARNESS_DIR` 可由调用方覆盖（默认 base），candidate
  修改 system-prompt.md 后下一次运行会触发 profile 同步。
- live runner 已就绪：用户填写 `.env` 模型配置并显式 `--live` 后，
  `bash scripts/run_live_task.sh --task-id 0 --live` 运行单条真实任务
  （见上节）。本仓库未提交任何 `.env`，未代为执行模型调用。

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
