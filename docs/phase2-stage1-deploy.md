# Phase 2 段階1 デプロイ手順書

- **対象**: feature/phase2-stage1 ブランチ
- **設計書**: docs/05_PHASE2_AUTOMATION.md §1
- **作成日**: 2026-04-20
- **版**: v1.1（レビュー反映）

## 0. 本手順の前提

- 本線スレ（受注発注管理）で §1〜§3 v0.8 まで合意済み
- Step A〜D の実装は feature/phase2-stage1 に push 済み
- Step E までは **本番デプロイを行わない** ことを社長が確認済み
- 本手順は Step G の動作確認時に admin 付き添いで実施する

## 1. デプロイ対象

| 対象 | 内容 | コマンド |
|---|---|---|
| Cloud Functions | createMonthlySettlement / createMonthlySettlementScheduled / detectDuplicates / detectDuplicatesScheduled | `firebase deploy --only functions` |
| Firestore rules | settlementRunLogs / settlementDuplicateChecks / adminNotifications の 3 コレクション rule 追加 | `firebase deploy --only firestore:rules` |
| Firestore settings | `settings/settlement_automation` 初期化（enabled=false） | `scripts/init-settlement-automation.mjs` |

本段階では **hosting は対象外**（UI 変更なし）。

## 2. 事前準備

### 2.1 サービスアカウント配置

```
scripts/service-account.json
```

Firebase Console → プロジェクト設定 → サービスアカウント → 新しい秘密鍵 で取得。
**絶対に git に commit しないこと**（.gitignore 済み）。

### 2.2 firebase プロジェクト選択

```bash
firebase use --add    # プロジェクトを選択
# test → bomber-admin-test
# production → bomber-admin
```

### 2.3 環境確認

```bash
firebase use           # 現在のプロジェクト確認
firebase projects:list # 全プロジェクト一覧
```

## 3. デプロイ順序（test 環境で 1 回通す → 本番）

### 3.1 test 環境での動作確認

```bash
# 1. プロジェクト切り替え
firebase use test

# 2. 初期化スクリプトを DRY RUN で確認
node scripts/init-settlement-automation.mjs

# 3. 初期化スクリプトを本番反映
DRY_RUN=false node scripts/init-settlement-automation.mjs

# 4. Firestore rules デプロイ
firebase deploy --only firestore:rules

# 5. Cloud Functions デプロイ
firebase deploy --only functions

# 6. 動作確認（次節 4 参照）
```

### 3.2 本番環境

test で問題なかったら本番に同じ手順で反映。

```bash
firebase use production
node scripts/init-settlement-automation.mjs            # 状態確認
DRY_RUN=false node scripts/init-settlement-automation.mjs  # 初期化
firebase deploy --only firestore:rules
firebase deploy --only functions
```

## 4. 動作確認（Step G で実施）

### 4.1 Cloud Functions の存在確認

```bash
firebase functions:list | grep -E 'createMonthlySettlement|detectDuplicates'
```

期待される出力（4 関数）:
- `createMonthlySettlement`（callable）
- `createMonthlySettlementScheduled`（scheduled）
- `detectDuplicates`（callable）
- `detectDuplicatesScheduled`（scheduled）

### 4.2 Cloud Scheduler の自動作成確認

Cloud Functions v2 の onSchedule は Cloud Scheduler ジョブを自動作成する。
以下で確認できる:

```bash
gcloud scheduler jobs list --location=asia-northeast1
```

期待される出力:
- `firebase-schedule-createMonthlySettlementScheduled-asia-northeast1`（cron: 0 3 1 * *）
- `firebase-schedule-detectDuplicatesScheduled-asia-northeast1`（cron: 0 1 * * *）

### 4.3 dryRun での createMonthlySettlement 呼び出し

admin ユーザーでログインし、ブラウザの DevTools で以下を実行:

```javascript
const { getFunctions, httpsCallable } = firebase.functions
const fn = httpsCallable(getFunctions(firebaseApp, 'asia-northeast1'), 'createMonthlySettlement')
const r = await fn({ dryRun: true })
console.log(r.data)
```

期待される結果（enabled=false なので aborted）:

```json
{
  "status": "aborted",
  "reason": "automation_disabled",
  "targetMonth": "2026-03",
  ...
}
```

### 4.4 enabled を true にした後の dryRun

```javascript
// Firestore Console or admin UI で
settings/settlement_automation.enabled = true
```

の後:

```javascript
const r = await fn({ dryRun: true })
console.log(r.data)
```

期待される結果:

```json
{
  "status": "success",
  "targetMonth": "2026-03",
  "targetDealerCount": 23,
  "createdCount": 23,
  "skippedCount": 0,
  "failedCount": 0,
  "dryRun": true,
  "runLogId": null   // dryRun なので書き込みなし
}
```

### 4.5 本番実行（Step G 最終段階）

社長が明示承認したら:

```javascript
const r = await fn({ dryRun: false, targetMonth: '2026-03' })
console.log(r.data)
```

成功したら:
1. `settlementRunLogs` に 1 レコード追加を確認
2. `kickbacks` / `invoices` に構造化 docId（例 `kb_J0015_2026-03`）が作成されたか確認
3. `isSkeleton: true` フラグが入っているか確認
4. detectDuplicates が post_batch で呼ばれ、0 件検知だったことを確認

## 4.6 1 ヶ月目 → 2 ヶ月目の観測フロー（v1.1 追加 / 軽微3）

段階2 進行判定（§7）には **2 回の月次バッチ観測** が必須。
初回デプロイ後、以下の時間軸チェックリストに沿って運用する。

### タイムライン

```
[T0]   feature/phase2-stage1 を main にマージ + 本番デプロイ（enabled=false）
         ↓
[T0+Δ] 社長判断で settings/settlement_automation.enabled = true に切替
         ↓
[T+1d] detectDuplicatesScheduled が日次保険で 1 回走ることを確認
         ↓
[T+月初] 1 ヶ月目の createMonthlySettlementScheduled 実行（前月分作成）
         ↓
[観測] 1 ヶ月間：settlementRunLogs / settlementDuplicateChecks / adminNotifications を監視
         ↓
[T+月初×2] 2 ヶ月目の createMonthlySettlementScheduled 実行
           1 ヶ月目分がすべて already_exists でスキップされることが観測の目的
         ↓
[判定] §7 解除条件 3 点を満たしたら段階2 進行
```

### 1 ヶ月目観測後の追加確認

2 回目のバッチ実行前に以下を確認する：

| # | 項目 | 確認先 |
|---|---|---|
| 1 | 1 ヶ月目の作成件数 = 代理店数 | `settlementRunLogs.createdCount` |
| 2 | 1 ヶ月目以降に手動 addDoc が混在していないか | `kickbacks` / `invoices` の件数 |
| 3 | detectDuplicates の日次保険が 30 日で 30 回走ったか | `settlementDuplicateChecks` |
| 4 | adminNotifications に critical が出ていないか | `adminNotifications` where severity='critical' |
| 5 | enabled が意図せず false に落ちていないか | `settings/settlement_automation.enabled` |

### 2 ヶ月目バッチ実行後の確認

| # | 項目 | 期待 |
|---|---|---|
| 1 | 2 ヶ月目 runLogs に 1 ヶ月目分の `already_exists` スキップが全代理店分記録 | skipped[].reason === 'already_exists' |
| 2 | 2 ヶ月目 runLogs の createdCount が 1 ヶ月目と同数 | 新規月分のみ作成成功 |
| 3 | 二重作成検知 0 件維持 | settlementDuplicateChecks.duplicatesFound === 0 |

### 次回 Scheduler 実行予定日を記録

運用担当が次回実行日を把握できるよう、`docs/phase2-stage1-observation.md`（別途作成）に
観測ログを記録する運用とする。

## 5. 停止方法（緊急時）

問題があれば即座に停止:

```javascript
// Firestore Console で
settings/settlement_automation.enabled = false
settings/settlement_automation.disabledBy = 'emergency'
settings/settlement_automation.disabledReason = '原因記載'
```

Scheduler は次回起動時に enabled=false を検知して即 return する。
既に走っているバッチも代理店ループの冒頭で enabled=false を検知して break 離脱する。

## 6. 監視項目（段階1 の 2 ヶ月観測）

| 項目 | 確認先 | 頻度 |
|---|---|---|
| 月次バッチ正常終了 | `settlementRunLogs` | 毎月 1 日午前 |
| 二重作成検知 | `settlementDuplicateChecks` + adminNotifications | 毎日 |
| pending 残留なし（今回は送信無効なので原則 0） | `settlementEmailLogs`（存在しない前提） | 毎日 |
| enabled=false 未変化 | `settings/settlement_automation` | 毎日 |
| admin 通知 | `adminNotifications`（severity=critical） | 都度 |

## 7. 段階2 進行判定（2 ヶ月後）

設計書 §1.9 の解除条件を全て満たしたら段階2 着手判断:

1. 2 ヶ月の月次バッチで failedCount 合計が 0
2. 二重作成 0 件（structured docId 同士の衝突が 0）
3. スキップ理由が想定範囲内（`already_exists` 以外を原因特定済み）

## 8. ロールバック手順

デプロイ後に問題が発覚した場合:

1. enabled=false に切り替え（§5）
2. Cloud Functions を 1 世代前にロールバック:
   ```bash
   gcloud functions deploy createMonthlySettlement --region=asia-northeast1 --source=<previous-commit>
   ```
3. または該当 Function を削除:
   ```bash
   firebase functions:delete createMonthlySettlement
   firebase functions:delete createMonthlySettlementScheduled
   firebase functions:delete detectDuplicates
   firebase functions:delete detectDuplicatesScheduled
   ```
4. rules は一つ前の firestore.rules を deploy して戻す

## 9. 注意事項

- **段階1 では送信機能（§2 / §5）は一切デプロイしない**
  本段階は作成機構のみの空運用
- **既存 UI の kickbacks / invoices 書き込みは触らない**
  rules も今回は厳格化せず、既存 addDoc フローを維持
- **1 ヶ月目と 2 ヶ月目の 2 回のバッチ観測が必須**
  1 ヶ月だけでは再実行耐性を確認できない

## 10. 変更履歴

| 日付 | 版 | 変更内容 | 担当 |
|---|---|---|---|
| 2026-04-20 | v1 | Step E 完了時点の初版 | Claude |
| 2026-04-20 | v1.1 | レビュー反映: (重大1) FORCE_OVERWRITE 時の enabled=true 誤上書き対策として ACKNOWLEDGE_ENABLED_OVERRIDE 必須化 / (軽微1) init payload に disabledAt 追加 / (軽微3) §4.6 に 2 ヶ月観測フロー追記 / (軽微5) rules コメントに初期配備時の完全静止状態を補足 | Claude |
