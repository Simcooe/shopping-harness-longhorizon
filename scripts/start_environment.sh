#!/usr/bin/env bash
# 启动本仓库内嵌 ShopSimulator 的 HTTP 服务（pack_api，/api/shop_agent）。
#
# - 默认地址 SHOPSIM_BASE_URL=http://127.0.0.1:5700，可用 SHOPSIM_PORT 覆盖端口。
# - 不需要、也不读取任何 API key / 模型配置；本服务不接入模型。
# - 不修改 snapshot 源码：仅以包装方式运行 snapshot 自带的 start.sh。
#
# 注意：snapshot 的 pack_api.py 将 socket 绑定到 0.0.0.0（上游冻结行为，
# 不可修改）；本项目所有调用默认走 127.0.0.1。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_ROOT="${REPO_ROOT}/environment/ShopSimulator"
SHOP_ENV="${ENV_ROOT}/shop_env"
VENV_DIR="${ENV_ROOT}/.venv-shopsim"

export SHOPSIM_PORT="${SHOPSIM_PORT:-5700}"
export SHOPSIM_BASE_URL="${SHOPSIM_BASE_URL:-http://127.0.0.1:${SHOPSIM_PORT}}"

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  echo "[start_environment] 未找到虚拟环境 ${VENV_DIR}" >&2
  echo "[start_environment] 请先运行: bash scripts/setup_environment.sh" >&2
  exit 1
fi
if [[ ! -f "${SHOP_ENV}/search_engine/products.sqlite3" ]]; then
  echo "[start_environment] 未找到搜索索引（snapshot 的 start.sh 会要求它）" >&2
  echo "[start_environment] 请先运行: bash scripts/setup_environment.sh" >&2
  exit 1
fi

# 让 snapshot 的 start.sh 中的裸 `python` 解析到本项目的独立 venv
export PATH="${VENV_DIR}/bin:${PATH}"

echo "[start_environment] 服务地址: ${SHOPSIM_BASE_URL}  (SHOPSIM_PORT=${SHOPSIM_PORT})"
echo "[start_environment] API 端点: ${SHOPSIM_BASE_URL}/api/shop_agent"
echo "[start_environment] 停止方式: 在本终端按 Ctrl+C，或 kill 该进程"
echo "[start_environment] 日志: stdout + ${SHOP_ENV}/shop_env/shop_agent.log"

exec bash "${SHOP_ENV}/start.sh"
