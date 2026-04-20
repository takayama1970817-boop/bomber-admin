# バックアップ運用マニュアル

最終更新: 2026-04-18

# 1. 全体構成

多層バックアップ体制


## 層の役割

**層1　GitHub**
ソースコード本体と仕様書（docs/）。push 時点で GitHub 側に履歴保持。

**層2　Firestore PITR**
7日以内の任意時点（1分単位）に復元可能。誤操作の即時リカバリ用。

**層3　GCS 日次 export**
03:00 JST に `gs://bomber-admin-firestore-backup-prod/firestore-exports/YYYY-MM-DD/` へ書き出し。30日保管。

**層4　NAS 取得**
04:30 JST に NAS から GCS と GitHub を世代付きで取得。60日保管。完全オフラインコピー。

# 2. 前提環境

**GCP プロジェクト**
`bomber-admin-prod`

**バックアップバケット**
`bomber-admin-firestore-backup-prod`

**NAS パス**
`/home/shuzo/BackUp`

**GitHub リポジトリ**
`bomber-admin`

# 3. 初期セットアップ手順

## 3-1. GCS バケット（一括セットアップスクリプト）

バケット作成・バージョニング・ライフサイクル・IAM を一気に設定

```bash
bash scripts/backup/setup-gcs.sh
```


これで以下が適用される

**バージョニング**
有効化（誤削除時に旧バージョンから復旧可能）

**ライフサイクル**（3ルールで二重化）

1. 現役オブジェクトは30日で削除
2. 旧バージョンは `noncurrentTime` から7日で削除
3. 同一オブジェクトのバージョン数が3を超えたら古い順に削除


**IAM**

- `datastore.importExportAdmin` （Functions SA）
- `storage.admin` on bucket（Functions SA）


## 3-2. ライフサイクル設定の整合性

Functions 側の `cleanupOldBackups` も同じ30日ルールで削除する。**同じ条件で二重化** しているため、片方が失敗してもデータ溢れは起きない。

Functions 側は `ignoreNotFound` で冪等化。ライフサイクルが先に消していてもエラーにならない。

## 3-3. Cloud Functions 用 IAM 権限付与（手動の場合）

`setup-gcs.sh` を使わない場合は手動で

```bash
# Functions のサービスアカウント（デフォルト）を確認
PROJECT_ID=bomber-admin-prod
SA="${PROJECT_ID}@appspot.gserviceaccount.com"

# Datastore（Firestore）Import/Export 権限
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SA}" \
  --role="roles/datastore.importExportAdmin"

# 対象バケットへの書き込み権限
gsutil iam ch \
  serviceAccount:${SA}:roles/storage.admin \
  gs://bomber-admin-firestore-backup-prod
```


## 3-3. Slack Webhook 設定

Slack で Incoming Webhook を作成し URL を取得。

Functions 環境変数に設定

```bash
cd functions
firebase functions:secrets:set SLACK_WEBHOOK_URL
# プロンプトに貼り付け
```


`firestoreBackup.js` の `onSchedule` オプションに `secrets: ['SLACK_WEBHOOK_URL']` を追加する場合は下記のようにする（下で補足）。

## 3-4. デプロイ

```bash
cd functions
npm install
cd ..
firebase deploy --only functions:scheduledFirestoreBackup,functions:cleanupOldBackups
```


# 4. PITR（Point-In-Time Recovery）有効化

## 4-1. 有効化コマンド

```bash
gcloud firestore databases update \
  --database="(default)" \
  --project=bomber-admin-prod \
  --enable-pitr
```


## 4-2. 有効化確認

```bash
gcloud firestore databases describe \
  --database="(default)" \
  --project=bomber-admin-prod \
  --format="value(pointInTimeRecoveryEnablement)"
```


`POINT_IN_TIME_RECOVERY_ENABLED` が返れば有効。

## 4-3. 運用上の注意点

**保持期間**
7日間のみ。それ以上前は PITR では戻せない（日次 export を使う）。

**コスト**
PITR は通常の Firestore 保管料とほぼ同等。大きな追加コストは発生しない。

**読み取り負荷**
過去時点読み取りは通常クエリより僅かに重い。本番からではなく別DBで復元すること。

# 5. NAS 側セットアップ

## 5-1. gcloud CLI ログイン

```bash
gcloud auth login
gcloud config set project bomber-admin-prod
```


## 5-2. スクリプト配置

`scripts/backup/nas-sync.sh` を NAS の `/home/shuzo/scripts/nas-sync.sh` に配置。

```bash
chmod +x /home/shuzo/scripts/nas-sync.sh
```


## 5-3. 環境変数（Slack Webhook）

`~/.bashrc` または cron 実行環境に設定

```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/XXX/YYY/ZZZ"
```


## 5-4. crontab 登録

```bash
crontab -e
```


```
# 毎日 04:30 JST（Functions の export 完了後）
30 4 * * * /home/shuzo/scripts/nas-sync.sh >> /home/shuzo/logs/nas-sync.log 2>&1
```


# 6. 動作確認

## 6-1. Functions の手動実行

Cloud Scheduler 画面から対象ジョブを選び「今すぐ実行」

**確認する場所**

ログ
```bash
gcloud functions logs read scheduledFirestoreBackup --region=asia-northeast1
```


GCS に出ているか
```bash
gsutil ls gs://bomber-admin-firestore-backup-prod/firestore-exports/
```


## 6-2. NAS スクリプトの手動実行

```bash
/home/shuzo/scripts/nas-sync.sh
ls /home/shuzo/BackUp/firestore/
ls /home/shuzo/BackUp/github/
```


## 6-3. Slack 通知のテスト

意図的に失敗させる（バケット名を一時的に間違える等）→ Slack に通知が飛ぶことを確認。

# 7. 復旧手順

## 重要ルール

**本番 `(default)` への直接復元は禁止**

必ず別 Database ID（例: `restore-YYYYMMDD-HHMMSS`）に復元する。

**復旧は専用スクリプト `restore.sh` 経由で実施**

`restore.sh` は本番 DB への復元を構造的にブロックする。自動で `restore-タイムスタンプ` の Database ID を生成し、そちらに復元する。

```bash
# PITR 復元（7日以内）
bash scripts/backup/restore.sh pitr 2026-04-18T10:00:00Z

# GCS export 復元（7日超）
bash scripts/backup/restore.sh gcs 2026-04-10
```


復旧先で中身確認 → 必要な差分のみ本番へ手動コピー → 復旧先 DB を削除、という流れを厳守する。

## 7-1. GitHub からソース復元

```bash
git clone https://github.com/your-org/bomber-admin.git
cd bomber-admin
npm install
```


NAS からの場合
```bash
git clone /home/shuzo/BackUp/github/YYYY-MM-DD/bomber-admin.git restored
```


## 7-2. Firestore PITR 復元（直近7日以内）

復元先 Database を新規作成（本番以外）
```bash
gcloud firestore databases create \
  --database="restore-YYYYMMDD" \
  --location=asia-northeast1 \
  --project=bomber-admin-prod
```


PITR 復元
```bash
gcloud firestore databases restore \
  --source-database="(default)" \
  --source-snapshot-time="2026-04-18T10:00:00Z" \
  --destination-database="restore-YYYYMMDD" \
  --project=bomber-admin-prod
```


## 7-3. GCS export からの復元（8日前以上）

復元先 Database を作成（上と同じ）

```bash
gcloud firestore import \
  gs://bomber-admin-firestore-backup-prod/firestore-exports/2026-04-10/ \
  --database="restore-YYYYMMDD" \
  --project=bomber-admin-prod
```


## 7-4. docs 復元

GitHub または NAS の `docs/` を展開するだけ。

## 7-5. 本番反映（最終ステップ）

復旧先 DB の中身を確認 → 問題なければ

二者択一で慎重に

**A. 差分だけ本番に書き戻す**
Cloud Functions または管理画面から必要なコレクションを復旧 DB → 本番へコピーする専用スクリプトを作る。

**B. 本番 Database を入れ替える**
`(default)` 自体を再作成するのは最終手段。事前に必ずもう一度 export を取ってから実施。

# 8. 復旧訓練（月1回）

毎月第1月曜 10:00 に実施。所要時間 30分目標。

## 訓練シナリオ

**シナリオ1 PITR 復元**

1. 5分前の時刻を指定し、`restore-drill-YYYYMMDD` Database に PITR 復元
2. 任意のコレクション（例: orders）のドキュメント数が本番とほぼ一致するか確認
3. 完了後、復元先 Database を削除


**シナリオ2 GCS export 復元**

1. 昨日の export を `restore-drill-gcs-YYYYMMDD` に import
2. サロン数、注文数を本番と比較
3. 完了後、復元先 Database を削除


**シナリオ3 NAS からのソース復元**

1. NAS の最新 GitHub mirror から `git clone` できるか
2. `npm install && npm run build` が通るか


## 成功判定基準

全シナリオで

1. エラーなく復元処理が完了
2. 復旧先の主要コレクション件数が本番の **95%以上** 一致
3. 所要時間が60分以内


## 訓練記録（必須運用）

`docs/backup-drill-log.md` に以下を記入

- 実施日
- 担当者
- 結果（OK / NG）
- 発見課題
- 次回改善点


**⚠️ 訓練ログ未記入ならデプロイ不可**

`.github/workflows/backup-drill-check.yml` と `deploy.yml` の両方が `scripts/backup/check-drill-log.mjs` を実行する。

前月の YYYY-MM 見出しがログに無いと

1. 毎月1日に Issue が自動作成される
2. 猶予期間（月初10日まで）を過ぎるとデプロイワークフローがブロックされる


猶予期間を変えたい場合は `check-drill-log.mjs` の `GRACE_DAYS` を調整。


# 9. 運用ルール

## バックアップスケジュール

- 03:00 JST 　Firestore → GCS export（Cloud Functions）
- 04:00 JST 　GCS 古い世代削除（30日超）
- 04:30 JST 　NAS 取得（gsutil + git clone）

## 禁止事項

**rsync --delete 禁止**
NAS バックアップは世代付きコピー。--delete オプションは誤消去の温床になるため絶対に使わない。

**本番 `(default)` への直接 import 禁止**
`restore.sh` 経由以外の復元は原則禁止。専用スクリプトが別 Database ID を自動生成する。

**GCS バケットのバージョニング OFF 禁止**
バージョニングはオブジェクト単位での復旧を可能にする。ライフサイクル側で noncurrent バージョンも制御しているため OFF にする必要はない。

**開発用プロジェクトから本番バケットへのアクセス禁止**
IAM の Principal を本番 SA のみに制限。

**NAS の MIN_GENERATIONS 未満への縮小禁止**
`nas-sync.sh` の `MIN_GENERATIONS=7` は下げない。異常時の最終防衛ライン。

**訓練ログ未記入でのデプロイ禁止**
CI ゲートで自動ブロック。緊急時のみ管理者が手動オーバーライド可能（ただし直後に訓練ログを追記すること）。

## 高リスク操作の制御

以下の操作はすべて社長（master）または admin の承認＋手動実行のみ

- Firestore の `(default)` Database 削除
- GCS バケットのライフサイクル変更
- PITR 無効化
- NAS のディレクトリ丸ごと削除


# 10. cleanup / lifecycle の境界定義

誰が何を消すか・消さないかを明文化する。将来の誤修正を防ぐための契約書として扱う。

## 責任分界

**GCS ライフサイクル側**

1. 現役オブジェクト（live = true）で age 30日超 → 削除
2. 旧バージョン（live = false）で noncurrentTime から7日超 → 削除
3. 同一オブジェクトの newerVersions が3超 → 古い順に削除

定義場所: `scripts/backup/gcs-lifecycle.json`


**Cloud Functions `cleanupOldBackups` 側**

- 現役オブジェクト（`versions: false` で取得）のみ対象
- updated 時刻 30日超のものを `ignoreNotFound: true` で削除

定義場所: `functions/firestoreBackup.js`


## Functions 側が「しないこと」

**旧バージョンは触らない**

`versions: false` を明示。旧バージョンの削除は完全にライフサイクルに委ねる。Functions 側でバージョンを列挙すると件数が爆発するリスクもあり、責務分離が正解。

**ignoreNotFound = true の理由**

ライフサイクルと Functions の両方が同じオブジェクトを削除対象にする可能性がある。先に消えていても 404 を無視して処理を続けるため冪等。片方が壊れても他方で削除が行われ、二重起動時もエラーで止まらない。

## なぜ二重化するのか

- ライフサイクルの設定が誤って消された場合 → Functions が拾う
- Functions がデプロイミスで動かなくなった場合 → ライフサイクルが拾う
- どちらか片方で十分だが、重要データなので冗長化

## 禁止変更

以下を変更するときは docs を更新し、復旧訓練で動作確認すること

- `versions: false` → `true` への変更
- `ignoreNotFound: true` → `false` への変更
- ライフサイクルのルール追加/削除
- 保管日数の短縮（長くするのは自由）


# 11. 復旧スクリプト 使用例

## 基本フロー

```bash
# 1. 復旧実行（別 DB に）
bash scripts/backup/restore.sh pitr 2026-04-18T10:00:00Z

# 2. 復旧先 DB の中身確認
gcloud firestore operations list \
  --database="restore-20260418-150230" \
  --project=bomber-admin-prod

# 3. 本番への差分反映（手動 or 専用スクリプト）

# 4. 復旧先 DB 削除
gcloud firestore databases delete \
  --database="restore-20260418-150230" \
  --project=bomber-admin-prod
```


## シナリオ別

**シナリオA. 5分前の状態に戻したい（誤削除直後）**

PITR で戻す。`restore.sh pitr` にタイムスタンプ指定。

```bash
bash scripts/backup/restore.sh pitr 2026-04-18T09:55:00Z
```


**シナリオB. 3日前の特定コレクションだけ戻したい**

まず PITR で別 DB に戻す → 該当コレクションのみ本番にコピーする専用スクリプトを書いて実行。

```bash
# (1) 別 DB に復元
bash scripts/backup/restore.sh pitr 2026-04-15T00:00:00Z

# (2) 任意のコレクションだけ本番にコピー（自前スクリプト）
node scripts/restore-specific-collection.mjs \
  --source=restore-20260418-150230 \
  --collection=orders \
  --dry-run
```


**シナリオC. 10日前の完全復旧（PITR 期限外）**

GCS export から別 DB に import する。

```bash
bash scripts/backup/restore.sh gcs 2026-04-08
```


## 安全機構（スクリプトが自動でやること）

- 復旧先 DB 名は `restore-YYYYMMDD-HHMMSS` 固定
- `(default)`, `prod`, `production`, `main`, `master`, `live`, `staging`, `primary` を含む名前を拒否
- `restore-` プレフィックス必須
- 実行前に復旧先 DB 名を正確にタイプさせて確認
- 最終 yes 確認

## 誤操作時の動作

- DB 名タイプミス → 中断
- `yes` 以外を入力 → 中断
- 禁止キーワード含む DB 名 → 即座にエラー終了


# 12. GitHub Actions に必要な Secret 一覧

`.github/workflows/deploy.yml` が参照する Secret を **GitHub リポジトリの Settings → Secrets and variables → Actions** で登録する。

## 必須 Secret

**`FIREBASE_TOKEN`**
取得方法
```bash
firebase login:ci
```
出力された長い文字列を登録。`firebase deploy` に使用。

## 任意 Secret

**`SLACK_WEBHOOK_URL`**
CI 通知用（現状は Functions 側でのみ使用）。CI でエラー通知を追加する場合に使う。

## Functions 側の Secret（GitHub とは別）

Firebase 側の Secret Manager に登録

```bash
firebase functions:secrets:set SLACK_WEBHOOK_URL
firebase functions:secrets:set BCART_API_TOKEN
```

- `SLACK_WEBHOOK_URL` — Firestore バックアップ失敗通知
- `BCART_API_TOKEN` — BカートAPIプロキシ用


# 13. トラブル時の連絡先

- 社内: ボンバー社長（master）
- 外部: Firebase サポート（Blaze プランなら有料サポートあり）


# 14. 🚀 初回運用開始前チェックリスト

本番運用を開始する前に、以下をすべてクリアすること。

## 14-1. GCP / Firebase 設定

- [ ] GCS バケット `bomber-admin-firestore-backup-prod` 作成済み
- [ ] `bash scripts/backup/setup-gcs.sh` 実行済み
- [ ] `gsutil versioning get gs://bomber-admin-firestore-backup-prod` で `Enabled` が返る
- [ ] `gsutil lifecycle get gs://...` で3ルール表示される
- [ ] Functions SA に `datastore.importExportAdmin` / `storage.admin` 付与済み
- [ ] PITR 有効化済み（`gcloud firestore databases describe` で確認）

## 14-2. Cloud Functions

- [ ] `functions/` で `npm install` 実行済み
- [ ] `firebase functions:secrets:set SLACK_WEBHOOK_URL` 登録済み
- [ ] `firebase deploy --only functions:scheduledFirestoreBackup,functions:cleanupOldBackups` 成功
- [ ] Cloud Scheduler 画面で2つのジョブが有効化されている
- [ ] 手動実行（「今すぐ実行」）でエラーが出ない
- [ ] GCS バケットに `firestore-exports/YYYY-MM-DD/` が作成されている

## 14-3. NAS 側

- [ ] `scripts/backup/nas-sync.sh` を NAS の `/home/shuzo/scripts/` に配置
- [ ] `chmod +x` で実行権限付与
- [ ] gcloud CLI ログイン済み（`gcloud auth list`）
- [ ] 環境変数 `SLACK_WEBHOOK_URL` 設定済み
- [ ] `crontab -l` で `30 4 * * *` のエントリ確認
- [ ] 手動実行で `/home/shuzo/BackUp/firestore/YYYY-MM-DD/` にファイルが作成される
- [ ] `/home/shuzo/BackUp/github/YYYY-MM-DD/bomber-admin.git` が作成される

## 14-4. GitHub Actions

- [ ] `FIREBASE_TOKEN` を Secrets に登録済み
- [ ] `.github/workflows/deploy.yml` が main にマージ済み
- [ ] `.github/workflows/backup-drill-check.yml` が main にマージ済み
- [ ] テスト PR で drill-log-gate ジョブが動くことを確認

## 14-5. 運用ドキュメント

- [ ] **drill log のサンプル行削除済み**（`docs/backup-drill-log.md` の `2026-03-02` ダミーエントリを削除）
- [ ] `docs/backup-operations.md` 全体を確認済み
- [ ] 社長（master）と admin 全員に本マニュアルを共有済み

## 14-6. 復旧訓練（本番開始の条件）

- [ ] **復旧訓練を最低1回実施済み**
- [ ] 3シナリオすべて OK
- [ ] `docs/backup-drill-log.md` に訓練記録を記入済み
- [ ] `node scripts/backup/check-drill-log.mjs` がパス

## 14-7. Slack 通知確認

- [ ] 意図的に失敗させ、Slack に通知が届くことを確認（Functions / NAS 両方）
- [ ] 成功時には通知が飛ばないことを確認

---

すべてチェックが完了したら **バックアップ体制の本番運用開始** ✅


# 付録 補足

## Cloud Functions に Secret を使う場合の設定例

```js
exports.scheduledFirestoreBackup = onSchedule(
  {
    schedule: '0 3 * * *',
    timeZone: 'Asia/Tokyo',
    region: 'asia-northeast1',
    secrets: ['SLACK_WEBHOOK_URL'],
  },
  async () => { /* ... */ }
)
```

Secret は `firebase functions:secrets:set SLACK_WEBHOOK_URL` で登録する。
