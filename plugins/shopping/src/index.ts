// shopping plugin 入口占位。
//
// TODO(shopping-plugin): 按冻结层/可进化层边界实现：
//   - environment/  环境接入与 HTTP client（冻结）
//   - tools/        工具真实 schema 与 action mapping（冻结）
//   - observation/  观测解析（冻结）
//   - rollout/      rollout 与轨迹审计（冻结）
//   - policy/       工具使用协议/上下文/恢复/终止策略（唯一可进化层）
//
// 参照 @deepseek-ai/dsh-base（dsh/packages/bundle/base/src/index.ts），
// bundle 入口在挂载内容就绪前可以只有空导出；真正的挂载由
// cordis.patch.yml 中的条目完成。本文件不允许注册工具或调用环境。
export {};
