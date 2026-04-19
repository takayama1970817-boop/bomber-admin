#!/bin/bash
#
# GCS バケット初期セットアップ
# - バージョニング有効化
# - ライフサイクル設定（現役30日 / 旧バージョン7日 / 世代3超過で削除）
# - 対象サービスアカウントの権限付与
#
# 実行: bash scripts/backup/setup-gcs.sh
# ==========================================================

set -euo pipefail

PROJECT_ID="bomber-admin-prod"
BUCKET="bomber-admin-firestore-backup-prod"
SA="${PROJECT_ID}@appspot.gserviceaccount.com"
LIFECYCLE_FILE="$(dirname "$0")/gcs-lifecycle.json"

echo "=== GCS バケットセットアップ ==="
echo "プロジェクト: ${PROJECT_ID}"
echo "バケット: gs://${BUCKET}"
echo ""

# 1. バケット作成（存在しなければ）
if ! gsutil ls -b "gs://${BUCKET}" > /dev/null 2>&1; then
  echo "1. バケット新規作成..."
  gsutil mb -p "${PROJECT_ID}" -l asia-northeast1 -c STANDARD "gs://${BUCKET}/"
else
  echo "1. バケットは既に存在（スキップ）"
fi

# 2. バージョニング有効化
echo "2. バージョニング有効化..."
gsutil versioning set on "gs://${BUCKET}"
gsutil versioning get "gs://${BUCKET}"

# 3. ライフサイクル適用
echo "3. ライフサイクル設定..."
gsutil lifecycle set "${LIFECYCLE_FILE}" "gs://${BUCKET}"
gsutil lifecycle get "gs://${BUCKET}"

# 4. IAM（Functions SA への書き込み権限）
echo "4. IAM 権限付与..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA}" \
  --role="roles/datastore.importExportAdmin" \
  --condition=None > /dev/null

gsutil iam ch "serviceAccount:${SA}:roles/storage.admin" "gs://${BUCKET}"

echo ""
echo "=== 完了 ==="
echo ""
echo "確認コマンド:"
echo "  gsutil versioning get gs://${BUCKET}"
echo "  gsutil lifecycle get gs://${BUCKET}"
echo "  gsutil iam get gs://${BUCKET}"
