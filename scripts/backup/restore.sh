#!/bin/bash
#
# Firestore 復旧スクリプト（安全ガード付き）
#
# 仕様:
#   - 必ず別 Database ID に復元（本番 "(default)" は絶対に上書きしない）
#   - PITR 復元 と GCS import の両方に対応
#   - --force フラグを付けても "(default)" には復元させない
#
# 使い方:
#   bash scripts/backup/restore.sh pitr 2026-04-18T10:00:00Z
#   bash scripts/backup/restore.sh gcs  2026-04-10
#
# ===============================================================

set -euo pipefail

PROJECT_ID="bomber-admin-prod"
BACKUP_BUCKET="bomber-admin-firestore-backup-prod"
SOURCE_DB="(default)"
LOCATION="asia-northeast1"

MODE="${1:-}"
ARG="${2:-}"

usage() {
  cat <<EOF
使い方:
  $0 pitr <ISO8601時刻>          # 例: $0 pitr 2026-04-18T10:00:00Z
  $0 gcs  <YYYY-MM-DD>           # 例: $0 gcs  2026-04-10

復旧先 Database ID は自動生成されます（restore-YYYYMMDD-HHMMSS）。
本番 "(default)" への直接復元はスクリプトとして禁止されています。
EOF
  exit 1
}

[ -z "${MODE}" ] && usage
[ -z "${ARG}" ] && usage

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEST_DB="restore-${TIMESTAMP}"

# ---- 安全チェック: 復旧先 DB 名のバリデーション ----
# ルール:
#   1. 空でないこと
#   2. "(default)" でないこと
#   3. "restore-" で始まること（命名規則固定）
#   4. 危険な名前を含まないこと
#   5. 英数字とハイフンのみ
DANGEROUS_NAMES="prod production main master live staging default primary"

validate_dest_db() {
  local name="$1"

  # 空チェック
  if [ -z "${name}" ]; then
    echo "❌ 復旧先 DB 名が空です"
    exit 2
  fi

  # (default) チェック
  if [ "${name}" = "(default)" ]; then
    echo "❌ 本番 DB '(default)' への復元は禁止されています"
    exit 2
  fi

  # restore- プレフィックス必須
  if [[ ! "${name}" =~ ^restore- ]]; then
    echo "❌ 復旧先 DB 名は 'restore-' で始まる必要があります: '${name}'"
    exit 2
  fi

  # 危険な単語チェック
  for dangerous in ${DANGEROUS_NAMES}; do
    if [[ "${name}" == *"${dangerous}"* ]]; then
      echo "❌ 危険な名前 '${dangerous}' を含む DB ID は使用できません: '${name}'"
      exit 2
    fi
  done

  # 文字種チェック（英数字とハイフンのみ）
  if [[ ! "${name}" =~ ^[a-z0-9-]+$ ]]; then
    echo "❌ 復旧先 DB 名は小文字英数字とハイフンのみ使用可能: '${name}'"
    exit 2
  fi

  # 長さチェック（Firestore の制限: 4〜63文字）
  local len=${#name}
  if [ "${len}" -lt 4 ] || [ "${len}" -gt 63 ]; then
    echo "❌ 復旧先 DB 名の長さが不正（4〜63文字）: '${name}' (${len}文字)"
    exit 2
  fi
}

validate_dest_db "${DEST_DB}"

# ---- モード別の表示名とソース詳細 ----
case "${MODE}" in
  pitr)
    MODE_LABEL="PITR (Point-In-Time Recovery)"
    SOURCE_DETAIL="スナップショット時刻: ${ARG}"
    ;;
  gcs)
    MODE_LABEL="GCS export インポート"
    SOURCE_DETAIL="gs://${BACKUP_BUCKET}/firestore-exports/${ARG}/"
    ;;
  *)
    usage
    ;;
esac

# ---- 明示確認プロンプト ----
cat <<EOF

╔═══════════════════════════════════════════════════════════╗
║          Firestore 復旧処理 確認                          ║
╚═══════════════════════════════════════════════════════════╝

  ▼ プロジェクト
      ${PROJECT_ID}

  ▼ 復旧モード（ソース種別）
      ${MODE_LABEL}

  ▼ ソース（対象日時 / 対象ファイル）
      ${SOURCE_DETAIL}

  ▼ 復旧先 Database ID（新規作成）
      ${DEST_DB}

  ▼ 安全確認
      ✓ 命名規則: restore- プレフィックス OK
      ✓ 危険な名前チェック: クリア
      ✓ 本番 "(default)" は変更されません

═══════════════════════════════════════════════════════════════

この操作で本番 "(default)" データベースは一切変更されません。
新しい Database "${DEST_DB}" が作成され、そこに復元されます。

EOF

# 復旧先 DB 名を正確にタイプさせて確認（誤操作防止）
read -r -p "続行するには復旧先 DB 名を正確に入力してください: " typed_name
if [ "${typed_name}" != "${DEST_DB}" ]; then
  echo "❌ 入力が一致しません。中断しました"
  echo "   期待値: ${DEST_DB}"
  echo "   入力値: ${typed_name}"
  exit 1
fi

read -r -p "本当に実行しますか？ [yes/NO] " confirm
if [ "${confirm}" != "yes" ]; then
  echo "中断しました"
  exit 0
fi

# ---- 復旧先 Database を作成 ----
echo ""
echo "[1/2] 復旧先 Database 作成: ${DEST_DB}"
gcloud firestore databases create \
  --database="${DEST_DB}" \
  --location="${LOCATION}" \
  --project="${PROJECT_ID}" \
  --type=firestore-native

# ---- モード別に復元 ----
if [ "${MODE}" = "pitr" ]; then
  echo ""
  echo "[2/2] PITR 復元: ${ARG} → ${DEST_DB}"
  gcloud firestore databases restore \
    --source-database="${SOURCE_DB}" \
    --source-snapshot-time="${ARG}" \
    --destination-database="${DEST_DB}" \
    --project="${PROJECT_ID}"
else
  IMPORT_URI="gs://${BACKUP_BUCKET}/firestore-exports/${ARG}"
  echo ""
  echo "[2/2] GCS からインポート: ${IMPORT_URI} → ${DEST_DB}"
  gcloud firestore import "${IMPORT_URI}" \
    --database="${DEST_DB}" \
    --project="${PROJECT_ID}"
fi

cat <<EOF

============================================
  復旧完了
============================================
  復旧先 Database ID: ${DEST_DB}

次のステップ:
  1. 復旧先 DB の中身を確認
     gcloud firestore operations list --database=${DEST_DB}
  2. 必要なドキュメントを本番へコピー（手動 or 専用スクリプト）
  3. 確認後、復旧先 DB を削除
     gcloud firestore databases delete --database=${DEST_DB} --project=${PROJECT_ID}

⚠️ 本番 "(default)" への直接反映は手動作業で慎重に行うこと
EOF
