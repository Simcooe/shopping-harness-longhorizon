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
ENV_FILE="${SHOPPING_ENV_FILE:-.env}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[run_live_task] 缺少 ${ENV_FILE}：请先 cp .env.example .env 并填写模型配置。" >&2
  exit 4
fi
set -a
# shellcheck disable=SC1091
source "${ENV_FILE}"
set +a
for key in SHOPSIM_BASE_URL MODEL_BASE_URL MODEL_API_KEY MODEL_NAME; do
  if [[ -z "${!key:-}" ]]; then
    echo "[run_live_task] .env 缺少 ${key}（不会调用模型）。" >&2
    exit 4
  fi
done

# ---- harness 目录（可由调用方覆盖，默认 base；绝不硬编码为 base） --------------
# 导出给 prepare / generate_profile_patch / DSH 子进程使用。
HARNESS_DIR="${SHOPPING_HARNESS_DIR:-${REPO_ROOT}/harnesses/base}"
export SHOPPING_HARNESS_DIR="${HARNESS_DIR}"

# ---- 离线准备校验（配置/任务注入/脱敏 metadata） ------------------------------
# SHOPPING_LIVE_TASK_CONFIG 可覆盖默认 live-task 配置（批量 baseline 用
# configs/evaluation/h0-baseline-v1.yml 的 35 步；单条 smoke 默认 5 步不变）。
PREPARE_ARGS=(--task-id "${TASK_ID}")
if [[ -n "${SHOPPING_LIVE_TASK_CONFIG:-}" ]]; then
  PREPARE_ARGS+=(--config "${SHOPPING_LIVE_TASK_CONFIG}")
fi
RUN_JSON="$(node plugins/shopping/scripts/prepare_live_run.ts "${PREPARE_ARGS[@]}")" \
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
LIVE_DIR="${SHOPPING_LIVE_DIR:-${REPO_ROOT}/.live}"
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
# effective profile patch：persona 来自当前 harness 的 system-prompt.md；
# 冻结禁用行 + agent-default-model（MODEL_NAME）由 generate_profile_patch 安全生成。
node scripts/generate_profile_patch.ts --profile-dir "${PROFILE_DIR}" \
  || { echo "[run_live_task] effective profile patch 生成失败（harness 校验失败？）。" >&2; exit 5; }
# 与固定 DSH commit 的 initProfile 完全一致（app-boot/profile.ts 的
# PROFILE_PNPM_WORKSPACE）：pnpm ≥10 从 pnpm-workspace.yaml 读设置，
# 且必须包含 packages 字段。
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' \
  > "${PROFILE_DIR}/pnpm-workspace.yaml"

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

if [[ -n "${SHOPPING_DSH_BIN:-}" ]]; then
  # 测试/调试钩子：显式指定 dsh 可执行文件时跳过安装
  DSH_BIN="${SHOPPING_DSH_BIN}"
else
  # 1. 确保本地 plugin 已构建（lib/ 为最新构建产物；sync 指纹覆盖 lib/）
  echo "[run_live_task] 构建本地 plugin（pnpm --dir plugins/shopping build）..."
  (cd "${REPO_ROOT}" && pnpm --dir plugins/shopping build) \
    || { echo "[run_live_task] plugin 构建失败。" >&2; exit 6; }

  # 2. DSH CLI（官方固定版本，与 plugin 无关，只装一次）
  if [[ ! -d "${CLI_DIR}/node_modules" ]]; then
    echo "[run_live_task] 安装 DSH CLI（@deepseek-ai/dsh@0.1.0-rc.7）..."
    (cd "${CLI_DIR}" && pnpm install --silent) \
      || { echo "[run_live_task] DSH CLI 安装失败。" >&2; exit 6; }
  fi

  # 3. profile bundle 同步（指纹变化才重装；否则复用 node_modules）
  node scripts/sync_live_profile.ts --profile-dir "${PROFILE_DIR}" \
    || { echo "[run_live_task] profile 依赖同步失败。" >&2; exit 6; }

  DSH_BIN="${CLI_DIR}/node_modules/.bin/dsh"
fi
[[ -x "${DSH_BIN}" ]] || { echo "[run_live_task] 未找到 dsh CLI: ${DSH_BIN}" >&2; exit 6; }

# ---- bootstrap 时序（instruction-before-first-decision） ----------------------
#   确定 bootstrap path → 安装 EXIT trap → runner reset（整个 run 唯一一次）
#   → instruction_text 进 DSH 初始 prompt → 模型第一次决策
#   → plugin 接管同一 env_idx（绝不二次 reset）
# run_id 由 prepare 生成（run-<时间戳>），此处再做一次字符校验防路径穿越。
if [[ ! "${RUN_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "[run_live_task] run_id 非法: ${RUN_ID}" >&2
  exit 5
fi
BOOTSTRAP_PATH="${LIVE_DIR}/runs/${RUN_ID}/bootstrap.json"

# ---- cleanup：只 release_one 当前 env_idx（幂等），绝不 release_all ----------
# bootstrap 文件存在即代表可能持有或曾持有租约；EXIT trap 尝试清理。
CLEANED=0
cleanup() {
  if [[ "${CLEANED}" -eq 1 ]]; then
    return 0
  fi
  CLEANED=1
  if [[ -z "${BOOTSTRAP_PATH:-}" ]]; then
    return 0
  fi
  if SHOPPING_BOOTSTRAP="${BOOTSTRAP_PATH}" node scripts/cleanup_live_session.ts; then
    echo "[run_live_task] cleanup 完成：env_idx 已释放，bootstrap 已清理。"
  else
    # 不得静默声称已释放：保留 bootstrap 文件并给出恢复命令
    echo "[run_live_task] 警告: cleanup 失败，bootstrap 保留于 ${BOOTSTRAP_PATH}" >&2
    echo "[run_live_task] 手动重试: SHOPPING_BOOTSTRAP=${BOOTSTRAP_PATH} SHOPSIM_BASE_URL=${SHOPSIM_BASE_URL} node scripts/cleanup_live_session.ts" >&2
  fi
}
cleanup_and_exit() {
  # INT/TERM 兜底（launcher 未启动等早期路径）：先转发信号；
  # launcher 运行中时只转发不退出——必须等 child 退出后才 cleanup，
  # 防止 cleanup 与仍在运行的 DSH 并发释放 env_idx。
  if [[ -n "${LAUNCHER_PID:-}" ]] && kill -0 "${LAUNCHER_PID}" 2>/dev/null; then
    kill -s "${1}" "${LAUNCHER_PID}" 2>/dev/null || true
    return 0
  fi
  cleanup
  exit "$([ "${1}" = "INT" ] && echo 130 || echo 143)"
}
trap cleanup EXIT
trap 'cleanup_and_exit INT' INT
trap 'cleanup_and_exit TERM' TERM

# ---- bootstrap reset（helper 在 handoff 前失败/中断会自行 release） -----------
BOOTSTRAP_JSON="$(node scripts/bootstrap_live_session.ts \
  --task-id "${TASK_ID}" --run-id "${RUN_ID}" --output "${BOOTSTRAP_PATH}")" \
  || { echo "[run_live_task] bootstrap（环境 reset/写入）失败。" >&2; exit 3; }
ENV_IDX="$(printf '%s' "${BOOTSTRAP_JSON}" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>console.log(JSON.parse(d).envIdx))')"
export SHOPPING_BOOTSTRAP="${BOOTSTRAP_PATH}"
echo "[run_live_task] bootstrap 完成: env_idx=${ENV_IDX}（任务指令已就绪，将注入 DSH 初始 prompt）"

# ---- 启动 headless DSH task（真实模型调用发生在这里） --------------------------
# 官方 adapter 读取 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL（固定 DSH commit 行为），
# 由 .env 的 MODEL_API_KEY / MODEL_BASE_URL 映射而来。
# 任务 prompt（含 <shopping_task> 边界内的真实指令）由 launch_dsh_task.ts
# 以 argv 数组传递给 dsh，不经过 shell 解析，无注入面。
#
# 信号链：runner(trap) → launcher(转发) → DSH child。
# launcher 后台启动 + wait：bash 在 wait 期间可立即执行 trap（转发信号），
# 然后继续等待 launcher/DSH 真正退出，之后才 cleanup——保证 cleanup 不与
# 仍在运行的 DSH 并发。launcher 按惯例以 130(SIGINT)/143(SIGTERM) 退出。
echo "[run_live_task] 启动 dsh --profile shopping-base（模型: ${MODEL_NAME}）"
LAUNCHER_PID=""
set +e
DSH_HOME="${DSH_HOME_DIR}" \
  DEEPSEEK_API_KEY="${MODEL_API_KEY}" \
  DEEPSEEK_BASE_URL="${MODEL_BASE_URL}" \
  SHOPPING_BOOTSTRAP="${BOOTSTRAP_PATH}" \
  SHOPPING_HARNESS_DIR="${HARNESS_DIR}" \
  SHOPPING_RUN_ID="${RUN_ID}" \
  SHOPPING_TRAJECTORIES_DIR="${REPO_ROOT}/trajectories" \
  SHOPPING_MAX_STEPS="${MAX_STEPS}" \
  node scripts/launch_dsh_task.ts --dsh-bin "${DSH_BIN}" --profile shopping-base &
LAUNCHER_PID=$!
wait "${LAUNCHER_PID}"
DSH_EXIT=$?
# 若 wait 被已捕获信号打断（>128）且 launcher 仍在运行：继续等它退出
if [[ "${DSH_EXIT}" -gt 128 ]] && kill -0 "${LAUNCHER_PID}" 2>/dev/null; then
  wait "${LAUNCHER_PID}"
  DSH_EXIT=$?
fi
set -e
LAUNCHER_PID=""

# ---- DSH 已返回：先 cleanup，成功后撤销 trap，返回原始退出码 ------------------
cleanup
trap - EXIT
trap - INT
trap - TERM

echo "[run_live_task] 运行结束（dsh exit=${DSH_EXIT}）"
echo "[run_live_task] run_id=${RUN_ID}"
echo "[run_live_task] actor trace: trajectories/actor/${RUN_ID}.jsonl"
echo "[run_live_task] evaluator record: evaluation/runs/${RUN_ID}.json"
echo "[run_live_task] 提示: 报告与轨迹不含 API key / goal / gold / reward / 隐藏字段。"
exit "${DSH_EXIT}"
