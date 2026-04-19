#!/bin/bash
#
# NAS バックアップ取得スクリプト
# 場所: NAS (Linux) の crontab から実行する想定
#
# 設計方針:
#   - 同期ではなく「世代付きコピー」
#   - rsync --delete は使わない（誤消去防止）
#   - 失敗時のみ Slack 通知
#   - GCS → NAS/BackUp/firestore/YYYY-MM-DD/
#   - GitHub → NAS/BackUp/github/YYYY-MM-DD/
#
# crontab 例:
#   30 4 * * * /home/shuzo/scripts/nas-sync.sh >> /home/shuzo/logs/nas-sync.log 2>&1
#
# 必要: gcloud CLI ログイン済み / git インストール済み / curl
# ============================================================

set -u  # 未定義変数エラー（-e は個別制御するため付けない）

# ---- 設定 ----
GCS_BUCKET="bomber-admin-firestore-backup-prod"
BACKUP_ROOT="/home/shuzo/BackUp"
GITHUB_REPO="https://github.com/your-org/bomber-admin.git"   # 要更新
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"                    # 環境変数から
RETENTION_DAYS=60                                             # 60日で世代削除

DATE=$(date +%Y-%m-%d)
FIRESTORE_DIR="${BACKUP_ROOT}/firestore/${DATE}"
GITHUB_DIR="${BACKUP_ROOT}/github/${DATE}"
LOG_TAG="[nas-sync ${DATE}]"

# ---- Slack 通知関数（失敗時のみ） ----
notify_error() {
  local msg="$1"
  echo "${LOG_TAG} ERROR: ${msg}" >&2
  if [ -n "${SLACK_WEBHOOK_URL}" ]; then
    curl -s -X POST -H 'Content-Type: application/json' \
      --data "{\"text\":\"🚨 *NASバックアップ失敗* ${DATE}\\n${msg}\"}" \
      "${SLACK_WEBHOOK_URL}" > /dev/null || true
  fi
}

# ---- 世代削除（安全ガード付き） ----
#  - RETENTION_DAYS より古いものを削除
#  - ただし、残り世代が MIN_GENERATIONS を下回る場合は削除しない
#  - 一気に全消失する事故を構造的に防止
MIN_GENERATIONS=7   # 最低7世代は絶対に残す

cleanup_old() {
  local dir="$1"
  [ -d "${dir}" ] || return 0

  # 現在の世代数
  local current_count
  current_count=$(find "${dir}" -maxdepth 1 -mindepth 1 -type d | wc -l)

  # 削除候補リストアップ（古いものから）
  local old_dirs
  old_dirs=$(find "${dir}" -maxdepth 1 -mindepth 1 -type d -mtime +${RETENTION_DAYS} | sort)
  [ -z "${old_dirs}" ] && return 0

  # 各古いディレクトリを削除。ただし残り MIN_GENERATIONS 以上を維持
  while IFS= read -r target; do
    if [ "${current_count}" -le "${MIN_GENERATIONS}" ]; then
      notify_error "世代削除を中断: ${dir} の残り世代が ${MIN_GENERATIONS} を下回る（現在 ${current_count} 世代）"
      break
    fi
    rm -rf "${target}"
    current_count=$((current_count - 1))
    echo "${LOG_TAG} 削除: ${target}（残${current_count}世代）"
  done <<< "${old_dirs}"
}

# ===== 1. Firestore export 取得（GCS → NAS） =====
echo "${LOG_TAG} Firestore バックアップ取得開始"
mkdir -p "${FIRESTORE_DIR}"

# 当日分を GCS から gsutil で取得（-n: 既存はスキップ、-m: 並列）
if ! gsutil -m cp -r -n "gs://${GCS_BUCKET}/firestore-exports/${DATE}/*" "${FIRESTORE_DIR}/" 2>&1; then
  notify_error "Firestore バックアップ取得失敗（gs://${GCS_BUCKET}/firestore-exports/${DATE}/）"
  FIRESTORE_OK=0
else
  # 中身があるかチェック
  if [ -z "$(ls -A "${FIRESTORE_DIR}" 2>/dev/null)" ]; then
    notify_error "Firestore バックアップは取得したが中身が空（${DATE}）"
    FIRESTORE_OK=0
  else
    echo "${LOG_TAG} Firestore OK: ${FIRESTORE_DIR}"
    FIRESTORE_OK=1
  fi
fi

# ===== 2. GitHub リポジトリのスナップショット =====
echo "${LOG_TAG} GitHub バックアップ取得開始"
mkdir -p "${GITHUB_DIR}"

if ! git clone --mirror "${GITHUB_REPO}" "${GITHUB_DIR}/bomber-admin.git" 2>&1; then
  notify_error "GitHub clone 失敗（${GITHUB_REPO}）"
  GITHUB_OK=0
else
  echo "${LOG_TAG} GitHub OK: ${GITHUB_DIR}/bomber-admin.git"
  GITHUB_OK=1
fi

# ===== 3. 古い世代削除 =====
cleanup_old "${BACKUP_ROOT}/firestore"
cleanup_old "${BACKUP_ROOT}/github"

# ===== 4. 終了コード決定 =====
if [ "${FIRESTORE_OK:-0}" = "1" ] && [ "${GITHUB_OK:-0}" = "1" ]; then
  echo "${LOG_TAG} 全バックアップ成功"
  exit 0
else
  echo "${LOG_TAG} 一部バックアップ失敗"
  exit 1
fi
