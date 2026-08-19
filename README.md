# shopping-harness-longhorizon

基于 **DeepSeek Harness（DSH）** 与现有 **ShopSimulator** 的“无训练”Self-Harness 购物 Agent 原型。

## 研究边界

- **固定 Agent 模型权重**：本项目不做 SFT、GRPO、LoRA，不训练任何模型，也不训练独立的 harness engineer 模型。
- 进化只发生在 **harness 层**：Agent 在 ShopSimulator 中执行购物任务，失败轨迹被记录为证据；随后由**同一个冻结模型**针对失败证据提出 harness 修改建议。
- 禁止事项（硬性红线）：
  - 禁止修改 DSH 源码（`dsh/`）。
  - 禁止修改 ShopSimulator 环境源码（外部只读依赖，见 `DEPENDENCIES.md`）。
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
| 基础工具执行 | 冻结 |
| ShopSimulator 环境 | 外部只读依赖，复用其语义/API，不复制、不移动、不修改 |

### 可进化层（editable）

仅允许自进化系统修改 **shopping plugin / Cordis overlay 中显式声明的编辑面**，
清单见 `plugins/shopping/README.md`。任何编辑面之外的改动都视为违规。

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
├── plugins/
│   └── shopping/           # shopping plugin：唯一自进化编辑面（见其 README）
├── harnesses/
│   ├── base/               # 冻结基线 harness = DSH base + shopping-base
│   ├── candidates/         # 候选 patch（必须可 diff/可回放/可回滚/可审计）
│   └── promoted/           # 通过 gate 的 harness 及其 lineage
├── trajectories/           # rollout 轨迹与失败证据（后续实现）
├── evaluation/             # held-in/held-out gate 评测（后续实现）
├── configs/                # 运行与评测配置（后续实现）
├── tests/                  # 脚手架与约束的测试（后续实现）
├── README.md
└── DEPENDENCIES.md
```

## 当前状态

仅完成脚手架与依赖固定。完整 agent、rollout、patch 生成与 gate 均未实现，见各目录 README 占位说明。
