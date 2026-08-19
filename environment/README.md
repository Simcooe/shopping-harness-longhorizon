# environment/

本目录存放本项目内嵌（vendored）的环境依赖。

## ShopSimulator

- **来源**：上游仓库 `https://github.com/ShopAgent-Team/ShopSimulator`，
  固定 source commit 与 upstream base commit 记录于
  `ShopSimulator/EMBEDDED_SOURCE.json` 和根目录 `DEPENDENCIES.md`。
  snapshot 最初从 `/Users/ywwl/self/shopping-grpo-longhorizon/environments/ShopSimulator`
  复制而来（纯复制，非 submodule、非软链接）。
- **冻结状态**：源码 snapshot 冻结。禁止修改环境语义、API 或 Reward；
  **不允许以修改环境或 Reward 作为 harness 自进化手段**——自进化的唯一编辑面是
  shopping plugin / Cordis overlay（见根 README 与 `plugins/shopping/README.md`）。
- **安装与启动**：snapshot 内自带的 `start.sh` / `scripts/build_index.py` 等属于上游
  参考脚本。本项目自身的安装、依赖装配与启动逻辑（虚拟环境创建、索引构建、
  服务编排）**应放在本项目中实现**（后续工作），不在本 snapshot 内新增或修改文件。
- **运行产物**：虚拟环境（`.venv-shopsim*`）、日志、缓存、生成的搜索索引、
  解压商品数据均不入库（见根目录 `.gitignore`）；压缩商品源数据
  （`ShopSimulator/shop_env/data/*.json.gz`）随 snapshot 入库。
