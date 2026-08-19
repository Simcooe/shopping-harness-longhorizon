# src/environment — 冻结层

ShopSimulator 环境接入与 HTTP client（`/api/shop_agent` 的
reset / interact / release_one 生命周期）。

**冻结层，不允许 Self-Harness patch。**

- 不得修改 HTTP client 行为、超时与重试语义。
- 不得修改环境 API 调用协议。
- 候选 patch 触碰本目录即视为违规。

当前状态：占位，尚未实现。
