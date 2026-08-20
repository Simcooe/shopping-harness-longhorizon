#!/usr/bin/env bash
# 单条真实 live task runner：DSH + 模型 + shopping plugin + ShopSimulator。
#
# 用法：bash scripts/run_live_task.sh --task-id 0 --live
#
# 退出码：
#   0  运行完成（无论购物任务本身成败）
#   2  用法错误（未传 --live 等）；不调用模型
#   3  ShopSimulator 不可达
#   4  缺少 .env 或模型配置
#   5  准备校验失败（配置/任务注入）
#   6  DSH 运行时安装失败
#
# 安全约束：
#   - 只在显式 --live 时才可能调用模型；
#   - API key 只来自未提交的 .env，绝不打印、绝不入库；
#   - task_id 由本脚本注入（SHOPPING_TASK_ID），模型不得选择；
#   - 任何退出路径都尽力调用 ShopSimulator release（finally 语义）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

usage() {
  cat <<'EOF'
用法: bash scripts/run_live_task.sh --task-id <id> --live

未传 --live 时不会调用模型。前置条件：
  1. cp .env.example .env 并填写 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME
  2. 另一个终端启动环境: bash scripts/start_environment.sh
EOF
}

LIVE=0
TASK_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --task-id) TASK_ID="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 2 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "${LIVE}" -ne 1 ]]; then
  echo "[run_live_task] 未传 --live：不执行任何模型调用。"
  usage
  exit 2
fi
if [[ -z "${TASK_ID}" ]]; then
  echo "[run_live_task] 缺少 --task-id" >&2
  usage
  exit 2
fi

# ---- .env 与模型配置 --------------------------------------------------------
if [[ ! -f .env ]]; then
  echo "[run_live_task] 缺少 .env：请先 cp .env.example .env 并填写模型配置。" >&2
  exit 4
fi
set -a
# shellcheck disable=SC1091
source .env
set +a
for key in SHOPSIM_BASE_URL MODEL_BASE_URL MODEL_API_KEY MODEL_NAME; do
  if [[ -z "${!key:-}" ]]; then
    echo "[run_live_task] .env 缺少 ${key}（不会调用模型）。" >&2
    exit 4
  fi
done

# ---- 离线准备校验（配置/任务注入/脱敏 metadata） ------------------------------
RUN_JSON="$(node plugins/shopping/scripts/prepare_live_run.ts --task-id "${TASK_ID}")" \
  || { echo "[run_live_task] 准备校验失败。" >&2; exit 5; }
RUN_ID="$(printf '%s' "${RUN_JSON}" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>console.log(JSON.parse(d).run_id))')"
MAX_STEPS="$(printf '%s' "${RUN_JSON}" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>console.log(JSON.parse(d).max_environment_steps))')"
echo "[run_live_task] run_id=${RUN_ID} task_id=${TASK_ID} max_steps=${MAX_STEPS}"

# ---- ShopSimulator 可达性 ----------------------------------------------------
PROBE_HTTP="$(curl -s -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "${SHOPSIM_BASE_URL}/api/shop_agent" \
  -H 'Content-Type: application/json' \
  -d '{"action":"release_one","env_idx":1000000000}' || true)"
if [[ "${PROBE_HTTP}" != "200" ]]; then
  echo "[run_live_task] ShopSimulator 不可达 (${SHOPSIM_BASE_URL})。" >&2
  echo "[run_live_task] 请在另一个终端运行: bash scripts/start_environment.sh" >&2
  exit 3
fi

# ---- .live 运行时（DSH_HOME / profile / CLI；全部 gitignore） -----------------
LIVE_DIR="${REPO_ROOT}/.live"
DSH_HOME_DIR="${LIVE_DIR}/dsh-home"
PROFILE_DIR="${DSH_HOME_DIR}/profiles/shopping-base"
CLI_DIR="${LIVE_DIR}/cli"
mkdir -p "${PROFILE_DIR}" "${CLI_DIR}"

# profile 文件（plugin 依赖改写为绝对 file: 路径）
node -e '
const fs = require("fs");
const src = JSON.parse(fs.readFileSync("harnesses/base/package.json", "utf-8"));
src.dependencies["@shopping-harness/plugin-shopping"] = "file:" + process.argv[1];
fs.writeFileSync(process.argv[2], JSON.stringify(src, null, 2) + "\n");
' "${REPO_ROOT}/plugins/shopping" "${PROFILE_DIR}/package.json"
cp harnesses/base/cordis.patch.yml "${PROFILE_DIR}/cordis.patch.yml"
printf 'nodeLinker: hoisted\nautoInstallPeers: false\n' > "${PROFILE_DIR}/pnpm-workspace.yaml"

# CLI（官方发布的固定版本 0.1.0-rc.7，与固定 DSH SHA 一致）
cat > "${CLI_DIR}/package.json" <<'EOF'
{
  "name": "shopping-live-cli",
  "private": true,
  "type": "module",
  "dependencies": {
    "@deepseek-ai/dsh": "0.1.0-rc.7"
  }
}
EOF

if [[ ! -d "${CLI_DIR}/node_modules" ]]; then
  echo "[run_live_task] 安装 DSH CLI（@deepseek-ai/dsh@0.1.0-rc.7）..."
  (cd "${CLI_DIR}" && pnpm install --silent) \
    || { echo "[run_live_task] DSH CLI 安装失败。" >&2; exit 6; }
fi
if [[ ! -d "${PROFILE_DIR}/node_modules" ]]; then
  echo "[run_live_task] 安装 profile bundles（dsh-base/dsh-headless/shopping plugin）..."
  (cd "${PROFILE_DIR}" && pnpm install --silent) \
    || { echo "[run_live_task] profile 依赖安装失败。" >&2; exit 6; }
fi
DSH_BIN="${CLI_DIR}/node_modules/.bin/dsh"
[[ -x "${DSH_BIN}" ]] || { echo "[run_live_task] 未找到 dsh CLI: ${DSH_BIN}" >&2; exit 6; }

# ---- finally 语义：任何退出路径都尽力归还 ShopSimulator 租约 -------------------
LIVE_STARTED=0
cleanup() {
  if [[ "${LIVE_STARTED}" -eq 1 ]]; then
    curl -s -m 10 -o /dev/null -X POST "${SHOPSIM_BASE_URL}/api/shop_agent" \
      -H 'Content-Type: application/json' \
      -d '{"action":"release_all"}' || true
  fi
}
trap cleanup EXIT

# ---- 启动 headless DSH task（真实模型调用发生在这里） --------------------------
# 官方 adapter 读取 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL（固定 DSH commit 行为），
# 由 .env 的 MODEL_API_KEY / MODEL_BASE_URL 映射而来。
# 已知限制：任务的具体购买目标（环境 reset 返回的 instruction）当前不向模型
# 暴露（冻结层脱敏策略）；把任务指令安全地注入模型上下文是下一增量，
# 见 docs/dsh-shopping-plugin.md。
LIVE_STARTED=1
echo "[run_live_task] 启动 dsh --profile shopping-base（模型: ${MODEL_NAME}）"
set +e
DSH_HOME="${DSH_HOME_DIR}" \
  DEEPSEEK_API_KEY="${MODEL_API_KEY}" \
  DEEPSEEK_BASE_URL="${MODEL_BASE_URL}" \
  SHOPPING_TASK_ID="${TASK_ID}" \
  SHOPPING_TASK_SOURCE="${REPO_ROOT}/configs/tasks/development.json" \
  SHOPPING_RUN_ID="${RUN_ID}" \
  SHOPPING_TRAJECTORIES_DIR="${REPO_ROOT}/trajectories" \
  SHOPPING_MAX_STEPS="${MAX_STEPS}" \
  "${DSH_BIN}" --profile shopping-base \
  "执行注入的购物任务（任务由运行器通过 SHOPPING_TASK_ID=${TASK_ID} 注入）。只使用 search_products / open_product / finish_without_purchase 三个工具。"
DSH_EXIT=$?
set -e
LIVE_STARTED=0
cleanup
trap - EXIT

echo "[run_live_task] 运行结束（dsh exit=${DSH_EXIT}）"
echo "[run_live_task] run_id=${RUN_ID}"
echo "[run_live_task] 脱敏轨迹: trajectories/${RUN_ID}.jsonl"
echo "[run_live_task] 提示: 报告中不含 API key / goal / gold / reward / 完整 observation。"
exit "${DSH_EXIT}"
