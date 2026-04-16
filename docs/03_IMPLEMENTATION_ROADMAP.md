# 基幹システム化 実装ロードマップ

## Phase 1（今すぐ・テスト環境デプロイ目標）

**ゴール**：経営ダッシュボードをテスト環境で動かして、社長が数値を眺められる状態にする。

### スコープ（最小構成）
- 新規ページ：`src/pages/ExecDashboard.jsx`（`/admin/dashboard-exec`）
- 新規lib：`src/lib/dashboardAggregator.js`
- ルート追加：`App.jsx`
- メニュー追加：`Layout.jsx`（master / admin のみ表示）

### 表示項目（既存 `orders` 集計のみで出せるもの）
1. 当月売上（税込・税抜・前月比）
2. 当月件数・平均単価
3. キャンペーン別売上構成（ミカエル / エンジェル / 単品販売 / 6+1 / その他）
4. 代理店別売上ランキング Top 10
5. サロン別売上ランキング Top 10
6. 月次推移（直近 6 ヶ月、シンプルな棒グラフ）
7. 会社切替（RT / RC / 統合）は CompanyContext 連動

### やらないこと（Phase 2 以降）
- 原価・粗利計算（`productCosts` 未整備のため）
- 売掛買掛、予算、顧客分析、会計連動
- recharts 等のグラフライブラリ導入（Tailwind の div で代用）
- Cloud Functions（Blaze 不要で動かす）

### 完了条件
- `npm run build:test` が通る
- `firebase deploy --only hosting` でテスト環境に上がる
- 社長がログインしてダッシュボードを閲覧できる

---

## Phase 2（Phase 1 稼働後・追加機能）

### スコープ
- 原価マスタ管理画面（`/admin/product-costs`）
- 原価 → 粗利計算をダッシュボードに反映
- 売掛管理画面（`/admin/receivables`）・入金登録
- 買掛管理画面（`/admin/payables`）・支払登録
- 受注確定 → 売掛自動生成（`OrderManage` から writeBatch）
- 予算入力・予実比較（`/admin/budget`）
- 顧客分析画面（`/admin/customer-analytics`、クライアント集計）

### Firestore 追加
- `productCosts`, `receivables`, `payables`, `budgets`, `customerAnalytics`, `expenses`
- セキュリティルール追加
- 複合インデックス追加

---

## Phase 3（Blaze 課金後）

### スコープ
- Cloud Functions 化
  - `aggregateDashboardDaily`（日次バッチ）
  - `updateCustomerAnalytics`（日次バッチ）
  - `markOverdueReceivables`（日次バッチ）
  - `onOrderCreated` / `onPurchaseCreated`（Firestore trigger）
- 会計ソフト連動（freee / マネーフォワード）
- 監査ログ（成り代わり・重要操作）
- Vitest + RTL テストコード追加
- Firestore Emulator セットアップ

---

## デプロイ運用ルール

### テスト環境
- コマンド：`npm run deploy:test`
- プロジェクト：`bomber-admin` のテストプロジェクト
- 画面上部に赤バナー表示（`VITE_ENV=test` で制御）

### 本番環境
- コマンド：`npm run deploy`（`build:prod` + `firebase deploy --only hosting`）
- 必ず**テストで社長確認 → OK → 本番**の順

### ルール反映
- コマンド：`npm run deploy:rules` / `deploy:rules:test`
- 新コレクション追加時は忘れずに実行

---

## 進捗記録

| Phase | 項目 | 状態 | 備考 |
|---|---|---|---|
| 1 | ExecDashboard 実装 | 進行中 | このチャット |
| 1 | dashboardAggregator 実装 | 進行中 | このチャット |
| 1 | App.jsx ルート追加 | 未着手 | |
| 1 | Layout.jsx メニュー追加 | 未着手 | |
| 1 | テスト環境デプロイ | 未着手 | |
| 2 | - | 未着手 | Phase 1 稼働確認後 |
| 3 | - | 未着手 | Blaze 移行後 |
