# PR 本文 Phase 2 段階1（重複作成防止機構）

> このファイルは PR 作成時の本文テンプレート。
> GitHub の PR 作成画面にそのままコピペしてください。

---

## 🎯 概要

Phase 2 段階1「重複作成の防止機構」の実装を `feature/phase2-stage1` → `main` にマージする PR です。

設計書: [docs/05_PHASE2_AUTOMATION.md](docs/05_PHASE2_AUTOMATION.md) §1

段階1 のスコープは「**月次自動作成の骨組み構築 + 既存 UI 非破壊**」です。
送信機構（§2）は後続段階で別 PR に分けます。

## 📋 本 PR に含まれる主要コミット

| # | コミット | 内容 |
|---|---|---|
| 1 | Step A | `functions/lib/` 3ファイル（settlementIdUtils / notifyAdmin / settlementAutomation） |
| 2 | Step B | `functions/createMonthlySettlement.js` 本体（onCall + onSchedule + 内部関数） |
| 3 | Step C | `functions/detectDuplicates.js` 二重作成検知（structured docId 限定） |
| 4 | Step D | `firestore.rules` に監査系 3 コレクション追加 + `isSkeleton` フラグ |
| 5 | Step E | `scripts/init-settlement-automation.mjs` + デプロイ手順書 |
| 6 | Step E v1.1 | レビュー反映（重大1 / 軽微1,3,5） |
| 7 | CI/CD | `.github/workflows/deploy-test.yml`（test 自動デプロイ） |
| 8 | CI/CD | `.github/workflows/dryrun-test.yml`（CLI 不要の DryRun 検証） |

以前の設計ドキュメント（§1〜§3 v0.8 ロック）も本ブランチに含まれます。

## ✅ test 環境での動作確認（完了）

| # | 確認項目 | 結果 |
|---|---|---|
| 1 | Firestore rules デプロイ（test） | ✅ Success |
| 2 | Functions デプロイ（test） | ✅ Success（Secrets: TELNYX_FAX_FROM / SLACK_WEBHOOK_URL をダミー設定済み） |
| 3 | Cloud Scheduler 自動作成 | ✅ 月次（0 3 1 * *）+ 日次（0 1 * * *）|
| 4 | settings/settlement_automation 初期化 | ✅ enabled=false で配備 |
| 5 | DryRun Verify - createMonthlySettlement（enabled=false） | ✅ DISABLED notes 確認 |
| 6 | DryRun Verify - detectDuplicates | ✅ duplicatesFound:0 確認 |
| 7 | DryRun Verify - createMonthlySettlement（enabled=true） | ✅ ENABLED notes 確認 |
| 8 | test の enabled を false に戻す | ✅ 完了 |

test 環境には dealers データが無いため `targetDealerCount: 0` となりますが、
コード自体の動作は全ルートで確認済みです。

## 🔒 安全保証（非破壊）

- **既存 UI の kickbacks / invoices への addDoc は触っていません**
  KickbackManage.jsx / InvoiceManage.jsx は一切変更なし
- **kickbacks / invoices の rules は変更していません**
  既存の `allow write: if isAdmin()` は維持
- **Cloud Functions が作成する骨組みドキュメントには `isSkeleton: true` フラグ**
  将来 UI 非表示 / migrate / 監査切り分けに活用
- **detectDuplicates は structured docId のみを検知対象**
  既存の addDoc 自動採番データは除外（`isStructuredSettlementDocId()` で判定）
- **本番配備時は `enabled: false` で静止状態から開始**
  社長の明示 GO まで自動作成は発火しない

## 📚 設計書の参照関係

- `docs/05_PHASE2_AUTOMATION.md` §1（重複作成の防止機構）... 本実装
- `docs/phase2-stage1-deploy.md` ... デプロイ手順書
- `docs/ci-cd-setup-test.md` ... CI/CD セットアップ手順

## 🔍 レビュー観点

### 1. 既存 UI 非破壊の確認
- [ ] `src/pages/KickbackManage.jsx` に変更なし
- [ ] `src/pages/InvoiceManage.jsx` に変更なし
- [ ] `src/hooks/useDealerKickbacks.js` に変更なし
- [ ] `src/hooks/useDealerInvoices.js` に変更なし

### 2. firestore.rules の変更範囲
- [ ] 変更は監査系 3 コレクション追加のみ
  - `settlementRunLogs`
  - `settlementDuplicateChecks`
  - `adminNotifications`
- [ ] 既存コレクションの rule 変更なし
- [ ] 新規 3 コレクションは admin 読み取りのみ / クライアント書き込み禁止

### 3. Cloud Functions の安全性
- [ ] `createMonthlySettlement` は `enabled=true` 時のみ本番書き込み
- [ ] `detectDuplicates` は structured docId のみ検知対象
- [ ] `retry: false` / `maxInstances: 1` が設定されている
- [ ] 各代理店ループで enabled を再確認（§1.6 break 離脱構造）

### 4. isSkeleton フラグ
- [ ] `createOneSettlementInTx` が create するドキュメントに `isSkeleton: true` が入る
- [ ] `createdSource: 'createMonthlySettlement'` とセット

### 5. CI/CD の security
- [ ] `deploy-test.yml` はプロジェクト `bomber-admin-test` に固定
- [ ] `dryrun-test.yml` は workflow_dispatch のみ（push 発火なし）
- [ ] `dryrun-test.yml` は project_id が bomber-admin-test 以外なら即中断
- [ ] Service Account JSON は GitHub Secrets のみ（コミット内になし）

### 6. 設計書との整合
- [ ] docId 形式 `{type}_{dealerCode}_{YYYY-MM}`（§1.2）
- [ ] type enum: 'kb' / 'invoice' のみ（§1.2）
- [ ] dealerCode 正規化 `^J\d{4}$`（§1.2）
- [ ] tx.create 使用（tx.set ではない）（§1.3）
- [ ] settlementRunLogs は addDoc 自動採番（§3.3）
- [ ] kind: 'creation' | 'email' フィールド（§3.5）

## ⚠️ 注意事項

### production 配備時の追加作業

本 PR マージ後、production への配備には以下が追加で必要です。

1. production 用 Service Account 作成
2. production 用 GitHub Secrets 登録（`FIREBASE_SERVICE_ACCOUNT_PROD`）
3. `deploy-prod.yml` ワークフロー追加
4. production で `scripts/init-settlement-automation.mjs` 実行（enabled=false 初期化）
5. production で Secrets（TELNYX_FAX_FROM 等）を dummy-no-op で設定
6. production で DryRun 検証
7. 社長判断で production の `enabled=true` 切替

これらは **本 PR のスコープ外** です。マージ後に別タスクで実施します。

### 本番書き込みは発生しない

本 PR がマージされても、`settings/settlement_automation.enabled = false` の間は
月次バッチも日次検知も **即 return** します。実際の書き込みは社長の明示 GO が必要です。

## 🚨 ロールバック

問題発覚時は以下で即座に停止できます。

1. `settings/settlement_automation.enabled = false`（Firestore Console から）
2. 必要なら GitHub Actions の workflow 無効化
3. 最悪 revert PR で main から削除可能

詳細: `docs/phase2-stage1-deploy.md` §8

## 👤 Co-Authored

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
