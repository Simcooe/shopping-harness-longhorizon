#!/usr/bin/env bash
# 为 environment/ShopSimulator 准备独立的 Python 虚拟环境与运行数据。
#
# 只做三件事：
#   1. 创建独立 venv 并安装 environment/ShopSimulator/shop_env/requirements.txt
#      （不含 veRL / PyTorch / SFT / GRPO / 模型相关依赖）
#   2. 解压随仓库内嵌的压缩商品源数据（运行时产物，不入库）
#   3. 构建环境源码要求的 BM25 搜索索引（运行时产物，不入库）
#
# 不读取、不依赖旧仓库 shopping-grpo-longhorizon 的任何文件。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_ROOT="${REPO_ROOT}/environment/ShopSimulator"
SHOP_ENV="${ENV_ROOT}/shop_env"
VENV_DIR="${ENV_ROOT}/.venv-shopsim"
PYTHON_BIN="${PYTHON:-python3}"

fail() {
  echo "" >&2
  echo "[setup_environment] 失败：$1" >&2
  echo "[setup_environment] 修复提示：$2" >&2
  exit 1
}

[[ -d "${SHOP_ENV}" ]] || fail \
  "未找到 ${SHOP_ENV}" \
  "请确认 environment/ShopSimulator snapshot 已在仓库中。"

# ---- 1. 独立虚拟环境 -------------------------------------------------------
echo "[setup_environment] 使用解释器: $(${PYTHON_BIN} --version 2>&1)"
if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  echo "[setup_environment] 创建虚拟环境: ${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}" \
    || fail "创建 venv 失败" "确认已安装 python3 与 venv 模块（macOS 可: brew install python）。"
else
  echo "[setup_environment] 复用已有虚拟环境: ${VENV_DIR}"
fi
VENV_PY="${VENV_DIR}/bin/python"
VENV_PIP=("${VENV_PY}" -m pip --disable-pip-version-check)

# ---- 2. 安装环境自身依赖（仅 requirements.txt）------------------------------
echo "[setup_environment] 安装 requirements.txt（flask/gym/numpy 等，无训练框架）"
"${VENV_PIP[@]}" install --quiet --upgrade pip \
  || fail "升级 pip 失败" "检查网络或 PyPI 镜像设置。"
"${VENV_PIP[@]}" install --quiet --requirement "${SHOP_ENV}/requirements.txt" \
  || fail "安装 requirements.txt 失败" \
     "确认 Python 版本兼容（建议 3.9–3.11），并检查网络/PyPI 镜像设置。"

# ---- 3. 解压商品源数据（snapshot 自带压缩数据 -> 运行时 JSON）---------------
DATA_JSON="${SHOP_ENV}/data/items_eval_train.json"
DATA_GZ="${SHOP_ENV}/data/fine_items_eval_train_all.json.gz"
if [[ -f "${DATA_JSON}" ]]; then
  echo "[setup_environment] 商品数据已存在: data/items_eval_train.json"
else
  [[ -f "${DATA_GZ}" ]] || fail \
    "缺少压缩商品源数据 ${DATA_GZ}" \
    "snapshot 不完整，请重新同步 environment/ShopSimulator。"
  echo "[setup_environment] 解压商品数据: $(basename "${DATA_GZ}") -> items_eval_train.json"
  gzip -dc "${DATA_GZ}" > "${DATA_JSON}" \
    || fail "解压商品数据失败" "确认 gzip 可用且 .gz 文件完整（gzip -t 校验）。"
fi

# ---- 4. 构建搜索索引（环境源码 start.sh 要求 index 必须存在）----------------
INDEX="${SHOP_ENV}/search_engine/products.sqlite3"
if [[ -f "${INDEX}" ]]; then
  echo "[setup_environment] 搜索索引已存在: search_engine/products.sqlite3"
else
  echo "[setup_environment] 构建 BM25 搜索索引（可能需要一两分钟）"
  "${VENV_PY}" "${SHOP_ENV}/scripts/build_index.py" \
    || fail "构建搜索索引失败" \
       "确认商品数据解压成功，且 venv 中依赖安装完整。"
fi

echo "[setup_environment] 完成。启动服务: bash scripts/start_environment.sh"
