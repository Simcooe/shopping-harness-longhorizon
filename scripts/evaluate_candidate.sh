#!/usr/bin/env bash
# candidate 评测 + gate v1（显式用户触发 --live）。
#
# 用法：
#   bash scripts/evaluate_candidate.sh \
#     --candidate-id <candidate_id> \
#     --base-harness harnesses/base \
#     --baseline-held-in <baseline_id> \
#     --baseline-held-out <baseline_id> \
#     --live
#
# 语义：
#   - 没有 --live 直接退出（exit 2），不调用模型；
#   - candidate_id 仅接受纯 ID（路径由代码生成 harnesses/candidates/<id>）；
#   - 在任何 candidate rollout 之前先校验 base held-in / held-out baseline；
#     缺 base held-out baseline 时零模型调用退出并明确提示（绝不拿 held-in
#     代替 held-out，也绝不自动运行真实 held-out baseline）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

usage() {
  cat <<'EOF'
用法:
  bash scripts/evaluate_candidate.sh \
    --candidate-id <candidate_id> \
    --base-harness harnesses/base \
    --baseline-held-in <baseline_id> \
    --baseline-held-out <baseline_id> \
    --live

未传 --live 时不会调用模型。前置条件：
  1. cp .env.example .env 并填写 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME
  2. 另一个终端启动环境: bash scripts/start_environment.sh
  3. 已运行 base held-in / held-out baseline：
       bash scripts/run_h0_baseline_eval.sh --split held-in --live
       bash scripts/run_h0_baseline_eval.sh --split held-out --live
EOF
}

LIVE=0
CANDIDATE_ID=""
BASE_HARNESS=""
HELD_IN=""
HELD_OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --candidate-id) CANDIDATE_ID="${2:-}"; shift 2 ;;
    --base-harness) BASE_HARNESS="${2:-}"; shift 2 ;;
    --baseline-held-in) HELD_IN="${2:-}"; shift 2 ;;
    --baseline-held-out) HELD_OUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 2 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "${LIVE}" -ne 1 ]]; then
  echo "[evaluate_candidate] 未传 --live：不执行任何模型调用。"
  usage
  exit 2
fi
if [[ -z "${CANDIDATE_ID}" || -z "${BASE_HARNESS}" || -z "${HELD_IN}" || -z "${HELD_OUT}" ]]; then
  echo "[evaluate_candidate] 缺少 --candidate-id / --base-harness / --baseline-held-in / --baseline-held-out" >&2
  usage
  exit 2
fi

# ---- 模型配置存在性（只检查键，不打印值） ------------------------------------
ENV_FILE="${SHOPPING_ENV_FILE:-.env}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[evaluate_candidate] 缺少 ${ENV_FILE}：请先 cp .env.example .env 并填写模型配置。" >&2
  exit 4
fi
set -a
# shellcheck disable=SC1091
source "${ENV_FILE}"
set +a
for key in SHOPSIM_BASE_URL MODEL_BASE_URL MODEL_API_KEY MODEL_NAME; do
  if [[ -z "${!key:-}" ]]; then
    echo "[evaluate_candidate] ${ENV_FILE} 缺少 ${key}（不会调用模型）。" >&2
    exit 4
  fi
done

# ---- ShopSimulator 可达性 ----------------------------------------------------
PROBE_HTTP="$(curl -s -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "${SHOPSIM_BASE_URL}/api/shop_agent" \
  -H 'Content-Type: application/json' \
  -d '{"action":"release_one","env_idx":1000000000}' || true)"
if [[ "${PROBE_HTTP}" != "200" ]]; then
  echo "[evaluate_candidate] ShopSimulator 不可达 (${SHOPSIM_BASE_URL})。" >&2
  echo "[evaluate_candidate] 请先在另一个终端运行: bash scripts/start_environment.sh" >&2
  exit 3
fi

exec node scripts/candidate_evaluator.ts \
  --candidate-id "${CANDIDATE_ID}" \
  --base-harness "${BASE_HARNESS}" \
  --baseline-held-in "${HELD_IN}" \
  --baseline-held-out "${HELD_OUT}"
