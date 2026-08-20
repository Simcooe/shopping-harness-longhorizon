# src/environment — 冻结层

ShopSimulator HTTP adapter（`/api/shop_agent` 的 reset / interact /
release_one 生命周期）。**冻结层，不允许 Self-Harness patch。**

## 已实现

| 文件 | 职责 |
|---|---|
| `protocol.ts` | reset/interact/release_one 的最小请求/响应类型与运行时校验；只暴露 actor-safe 公共字段 |
| `client.ts` | `ShopSimulatorHttpClient`：原生 fetch、四类错误（network/http/protocol/environment）、不打印响应体 |
| `session.ts` | `ShoppingEnvironmentSession` 生命周期与 `withShoppingSession` try/finally helper（异常路径也 release） |
| `index.ts` | 公共出口 |

## 边界约束

- 地址只来自显式参数或 `SHOPSIM_BASE_URL`（默认 `http://127.0.0.1:5700`）；
  **不读取任何 API key**。
- 不做工具 schema、action mapping、DSH 注册、策略或轨迹保存；
  未来由 `src/tools/`（同为冻结层）把模型工具调用映射为
  `search[...]` / `click[...]` / `finish[...]`。
- 返回值与错误对象不携带 goal、gold、Reward 明细、完整 observation
  或商品数据（有单元测试断言）。
- 候选 patch 触碰本目录即视为违规。

## 验证方式

- mock 单元测试：`pnpm --dir plugins/shopping test`
  （`tests/environment/client.test.ts`、`tests/environment/session.test.ts`）
- live smoke（需先自行启动环境）：
  `pnpm --dir plugins/shopping smoke-shopping-adapter --live`

当前状态：adapter 已实现并通过 mock 测试；尚未接入 DSH、模型或 Self-Harness。
