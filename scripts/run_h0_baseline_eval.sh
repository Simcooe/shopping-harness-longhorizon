#!/usr/bin/env bash
# h0 baseline 批量 evaluation（显式用户触发）。
#
# 用法：
#   bash scripts/run_h0_baseline_eval.sh --split held-in --live
#   bash scripts/run_h0_baseline_eval.sh --split held-out --live
#   bash scripts/run_h0_baseline_eval.sh --all --live
#
# 语义：
#   - 没有 --live 直接退出（exit 2），不调用模型；
#   - 不读取、不打印 API key（.env 由单 task runner 自行 source）；
#   - 复用现有 .env / ShopSimulator / bootstrap / DSH runner；
#   - 每个 task 独立 run_id / bootstrap / actor trace / evaluator record；
#     task 之间重新 reset（单 task runner 的 bootstrap 时序保证），
#     不共享会话；每个 task 完成后由其 runner release_one（绝不 release_all）；
#   - 单 task 失败不阻断其余 task；
#   - 默认 harnesses/base 的 h0；正式步数 35（configs/evaluation/
#     h0-baseline-v1.yml），不改单条 smoke 的 5 步配置；
#   - 结果写入 evaluation/baselines/<baseline_run_id>/（gitignore）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

usage() {
  cat <<'EOF'
用法:
  bash scripts/run_h0_baseline_eval.sh --split held-in --live
  bash scripts/run_h0_baseline_eval.sh --split held-out --live
  bash scripts/run_h0_baseline_eval.sh --all --live

未传 --live 时不会调用模型。前置条件：
  1. cp .env.example .env 并填写 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME
  2. 另一个终端启动环境: bash scripts/start_environment.sh
  3. （可选）先验证 task IDs: python3 scripts/validate_development_tasks.py \
       --manifest configs/evaluation/development-v1.yml
EOF
}

LIVE=0
SPLIT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --split) SPLIT="${2:-}"; shift 2 ;;
    --all) SPLIT="all"; shift ;;
    -h|--help) usage; exit 2 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "${LIVE}" -ne 1 ]]; then
  echo "[run_h0_baseline_eval] 未传 --live：不执行任何模型调用。"
  usage
  exit 2
fi
if [[ -z "${SPLIT}" ]]; then
  echo "[run_h0_baseline_eval] 缺少 --split held-in|held-out 或 --all" >&2
  usage
  exit 2
fi

# ---- 模型配置存在性（只检查键，不打印值） ------------------------------------
ENV_FILE="${SHOPPING_ENV_FILE:-.env}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[run_h0_baseline_eval] 缺少 ${ENV_FILE}：请先 cp .env.example .env 并填写模型配置。" >&2
  exit 4
fi
set -a
# shellcheck disable=SC1091
source "${ENV_FILE}"
set +a
for key in SHOPSIM_BASE_URL MODEL_BASE_URL MODEL_API_KEY MODEL_NAME; do
  if [[ -z "${!key:-}" ]]; then
    echo "[run_h0_baseline_eval] ${ENV_FILE} 缺少 ${key}（不会调用模型）。" >&2
    exit 4
  fi
done

# ---- ShopSimulator 可达性 ----------------------------------------------------
PROBE_HTTP="$(curl -s -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "${SHOPSIM_BASE_URL}/api/shop_agent" \
  -H 'Content-Type: application/json' \
  -d '{"action":"release_one","env_idx":1000000000}' || true)"
if [[ "${PROBE_HTTP}" != "200" ]]; then
  echo "[run_h0_baseline_eval] ShopSimulator 不可达 (${SHOPSIM_BASE_URL})。" >&2
  echo "[run_h0_baseline_eval] 请先在另一个终端运行: bash scripts/start_environment.sh" >&2
  exit 3
fi

# ---- orchestrator（聚合/写结果目录） ------------------------------------------
exec node scripts/baseline_orchestrator.ts --split "${SPLIT}"
