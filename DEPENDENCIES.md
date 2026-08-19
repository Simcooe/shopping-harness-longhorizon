# DEPENDENCIES.md

依赖固定记录。本项目所有外部依赖在此显式登记并固定版本。

## DeepSeek Harness（DSH）

- **Remote URL**: `https://github.com/deepseek-ai/deepseek-harness`
- **固定 commit SHA**: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- **本地路径**: `dsh/`
- **许可证**: MIT（`dsh/LICENSE`）
- **克隆方式**: 普通 clone（非 git submodule），当前为 `--depth 1` 浅克隆；如需历史可 `git fetch --unshallow`。
- **固定原因**: DSH 官方 README 明确声明其处于 **developer preview** 阶段，迭代快速且
  **会有破坏兼容性的变更**（"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"）。
  为保证 harness 演化实验的可复现性与 lineage 可审计性，本项目**必须固定该 commit SHA**；
  升级 DSH 需作为一次显式的依赖变更事件记录在本文件中，并重建 base harness。
- **约束**: `dsh/` 源码在本项目中只读，禁止修改（自进化系统同样禁止）。

## ShopSimulator

- **来源绝对路径**: `/Users/ywwl/self/shopping-grpo-longhorizon/environments/ShopSimulator`
- **角色**: 外部、**只读**环境依赖。
- **约束**:
  - 不复制、不移动、不修改该环境源码。
  - 仅复用其语义/API。
  - 所属项目 `/Users/ywwl/self/shopping-grpo-longhorizon` 整体只读，本项目不写入其中任何文件。

## 数据红线

- **Final-200 Clean**: 仅可作为未来最终盲测数据集；
  绝不能用于失败挖掘、harness patch 生成、调参或候选选择。
