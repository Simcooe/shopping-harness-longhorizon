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

## ShopSimulator（本仓库内嵌，固定源码依赖）

- **本地路径**: `environment/ShopSimulator/`
- **引入方式**: 从 `/Users/ywwl/self/shopping-grpo-longhorizon/environments/ShopSimulator`
  复制的**固定源码 snapshot**（vendored，非 git submodule、非软链接）。
- **上游仓库**: `https://github.com/ShopAgent-Team/ShopSimulator`
- **upstream base commit**: `51bb26012cee31aea7ac26177c5ffe807026ac07`
- **source commit**: `9ecba272963960ab4a10e1a781bd05cd7634ce20`
- **版本元信息**: `environment/ShopSimulator/EMBEDDED_SOURCE.json`（记录上游来源、
  内嵌范围与排除项）。
- **许可证**: snapshot 未携带 LICENSE 文件，上游仓库亦未声明许可证；来源与 commit
  以 `EMBEDDED_SOURCE.json` 为准。
- **约束**:
  - snapshot 冻结，禁止修改环境语义、API 或 Reward。
  - 运行时生成物（虚拟环境、日志、缓存、搜索索引、解压商品数据）不入库，见 `.gitignore`。

## 版本固定总则

DSH（`dsh/`，固定 commit SHA）与 ShopSimulator（`environment/ShopSimulator/`，
固定 source commit）是本项目的**固定核心源码依赖**，两者均固定版本。
升级任一方都必须作为显式依赖变更事件记录在本文件中。

各依赖的包管理归属：

- **ShopSimulator Python 依赖**：由
  `environment/ShopSimulator/shop_env/requirements.txt` 管理，安装于
  `environment/ShopSimulator/.venv-shopsim/`（不入库）。
- **DSH 的 Node/pnpm 依赖**：由 dsh 自身的 lockfile（`dsh/pnpm-lock.yaml`）
  管理；本项目不在仓库外安装或改动它们。
- **shopping plugin 依赖**：将由 `plugins/shopping/package.json` 及其
  lockfile 管理（当前该包无运行时依赖，尚未接入 DSH profile）。
- **模型 endpoint**：属于本地运行配置（环境变量），**不是**提交进仓库的
  源码依赖；本仓库不提交任何 API key 或真实 endpoint。

## 与 shopping-grpo-longhorizon 的关系

本项目**不依赖** `shopping-grpo-longhorizon` 的任何运行时产物：不引用其
`src/`、`data/`、`scripts/`、`configs/`、`tests/`，不使用其 GRPO / SFT / veRL
训练与评测代码或数据。ShopSimulator snapshot 已使本仓库可独立安装与运行环境。

## 数据红线

- **Final-200 Clean**: 仅可作为未来最终盲测数据集；
  绝不能用于失败挖掘、harness patch 生成、调参或候选选择。
