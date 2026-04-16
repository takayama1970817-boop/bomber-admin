# 基幹システム実装仕様書（bomber-admin 拡張）

## 1. 概要

bomber-admin に「経営判断に直結する数値の可視化と、原価・利益・資金繰りの一元管理」を追加し、**真の基幹システム（ERP）化**を行う。既存のサロン管理・受注・在庫・勤怠・代理店管理を土台に、**売上分析／原価管理／会計連動／予実管理／顧客分析**の5モジュールを増設する。Claude Code 環境での実装を想定し、React + Vite + Firestore の既存スタックに完全準拠する。

---

## 2. 基本パラメータ

### 会計年度
- 期首：毎年 1 月 1 日
- 集計単位：日次／月次／四半期／年次
- 締日：月末締／翌月末払（取引先別に上書き可）

### 通貨・税
- 表示通貨：JPY 固定
- 消費税率：10%（軽減税率対象は 8%、商品マスタで保持）
- 端数処理：円未満切捨（売上）／円未満切上（原価）

### 会社構成
- ロイヤルトラスト（RT、prefix `rt_`）：本体事業
- ロイヤルコスメ（RC、prefix `rc_`）：別法人
- 集計は会社別／統合の両方を出力可能

### KPI 目標値
- 月次売上目標：`settings/kpi_targets` で会社別に保持
- 粗利率目標：35%（VAVITTE ブランド）
- リピート率目標：60%（30 日以内再注文）

### 権限
- 経営ダッシュボード閲覧：`master`, `admin`
- 原価編集：`master`, `admin`
- 会計連動操作：`master` のみ
- 予算入力：`admin`

---

## 3. データ構造

### 3-1. 経営ダッシュボード（読み取り専用、集計キャッシュ）
コレクション：`dashboards/{period}` （例：`2026-04-monthly`）
```
{
  company: 'rt' | 'rc' | 'all',
  period: '2026-04',
  revenue: { gross, net, byCampaign, bySalon, byDealer },
  cogs: { total, byProduct, byCategory },
  grossProfit: { amount, rate },
  expenses: { kickback, systemFee, paymentFee, shipping, other },
  operatingProfit: number,
  customerStats: { newCount, repeatCount, repeatRate, churnedCount },
  productStats: { topSeller[], deadStock[] },
  generatedAt: serverTimestamp,
  generatedBy: 'manual' | 'cron'
}
```

### 3-2. 原価マスタ
コレクション：`productCosts/{productId}`
```
{
  productId: string,        // products コレクションの ID と一致
  jan: string,
  unitCost: number,         // 1個あたり原価（税別）
  factoryPrice: number,     // 工場仕入単価
  packagingCost: number,    // 容器・パッケージ
  shippingCost: number,     // 1個あたり配送原価
  effectiveFrom: timestamp, // この原価がいつから有効か
  effectiveTo: timestamp | null,
  source: 'manual' | 'purchase',  // purchase コレクションから自動算出可
  updatedAt, updatedBy
}
```
※ 履歴を残すため、変更時は新しいドキュメントを追加（既存は `effectiveTo` を入れて閉じる）

### 3-3. 売掛管理
コレクション：`receivables/{id}`
```
{
  orderId: string,            // 紐付く受注
  invoiceId: string,          // 紐付く請求書
  customerType: 'salon' | 'dealer',
  customerId: string,
  customerName: string,
  amount: number,             // 税込
  invoiceDate: date,
  dueDate: date,              // 支払期限
  status: 'open' | 'paid' | 'overdue' | 'partial',
  paidAmount: number,
  paidDate: date | null,
  paymentMethod: '銀行振込' | 'クレカ' | 'Paid' | '代引' | 'その他',
  notes: string,
  createdAt, updatedAt
}
```

### 3-4. 買掛管理
コレクション：`payables/{id}`
```
{
  purchaseId: string,         // purchases コレクションの ID
  supplierId: string,
  supplierName: string,
  amount: number,
  invoiceDate: date,
  dueDate: date,
  status: 'open' | 'paid' | 'overdue',
  paidAmount: number,
  paidDate: date | null,
  notes: string,
  createdAt, updatedAt
}
```

### 3-5. 予算（年次・月次）
コレクション：`budgets/{year}_{company}`
```
{
  year: 2026,
  company: 'rt' | 'rc',
  monthly: [
    { month: 1, revenue: 8000000, cogs: 3000000, expenses: 2000000, profit: 3000000 },
    { month: 2, ... }, ...
  ],
  notes: string,
  approvedAt, approvedBy
}
```

### 3-6. 顧客分析（CRMキャッシュ）
コレクション：`customerAnalytics/{customerType}_{customerId}`
```
{
  customerType: 'salon' | 'dealer',
  customerId: string,
  customerName: string,
  firstOrderDate: date,
  lastOrderDate: date,
  totalOrders: number,
  totalRevenue: number,
  ltv: number,                // 累計売上
  avgOrderValue: number,
  daysSinceLastOrder: number,
  churnRisk: 'low' | 'medium' | 'high',  // 30/60/90日基準
  topProducts: [{ productId, qty, revenue }],
  updatedAt
}
```

### 3-7. 会計連動ジョブ
コレクション：`accountingExports/{id}`
```
{
  type: 'sales' | 'purchase' | 'payment',
  target: 'freee' | 'mfcloud' | 'csv',
  period: '2026-04',
  status: 'pending' | 'success' | 'failed',
  exportedCount: number,
  fileUrl: string | null,     // Storage に置いた CSV/JSON
  errorLog: string | null,
  createdAt, createdBy
}
```

---

## 4. 計算ロジック

### 4-1. 売上集計
- 対象：`orders` コレクションの `orderDate` がその期間内のもの
- 売上総額（gross）= `totalAmount` 合計（税込）
- 売上正味（net）= gross − 返品額（`isReturn=true` の `returnAmount`）
- キャンペーン別：`campaign` フィールドでグルーピング（「ミカエル」「エンジェル」「単品販売」「6+1」「その他」）
- サロン別／代理店別：`companyName` / `dealerCode` でグルーピング

### 4-2. 原価（COGS）集計
- 対象：受注明細の各行
- 行原価 = `productCosts` の `unitCost`（受注日時点で有効なもの）× 数量
- 月次 COGS = Σ 行原価
- 在庫評価方法：**移動平均**（簡易版。purchases から自動更新）

### 4-3. 粗利
- 粗利額 = 売上正味 − COGS
- 粗利率 = 粗利額 ÷ 売上正味 × 100

### 4-4. 営業利益
- 営業利益 = 粗利額 − 経費（kickback, systemFee, paymentFee, shipping, その他経費）
- 経費は `expenses` コレクションから期間集計（手動入力＋自動連動）

### 4-5. 売掛・買掛の自動生成
- 受注確定（`orders` 追加）→ `receivables` を自動作成（dueDate = invoiceDate + 30日、上書き可）
- 工場発注確定（`purchases` 追加）→ `payables` を自動作成
- 入金登録 → `receivables.status = 'paid'`、領収書を自動発行（既存 `receiptEmail.js` を再利用）
- 過去日のものは日次バッチで `overdue` に自動更新

### 4-6. 顧客分析
- 日次バッチで `customers` / `salons` / `dealers` から `customerAnalytics` を再生成
- LTV = 該当顧客の `orders` 全期間の `totalAmount` 合計
- リピート率 = （30日以内に2回以上注文した顧客数 ÷ 全顧客数）× 100
- 離脱リスク：最終注文から 30 日 = low、60 日 = medium、90 日 = high

### 4-7. 予実管理
- 予算実績差異 = 実績 − 予算
- 達成率 = 実績 ÷ 予算 × 100
- ダッシュボードに月次達成率グラフ表示

### 4-8. ダッシュボード再生成
- トリガー：
  - 受注追加／更新（リアルタイム反映）
  - 日次バッチ（毎日 02:00 JST）
  - 手動再生成ボタン（`master` のみ）
- 計算は **Cloud Functions（Blaze 必須）** または **クライアント側 batch 処理**（既存 KickbackManage と同方式）

---

## 5. 実装要件

### 5-1. 画面構成（追加ページ）
| ルート | 画面 | 権限 |
|---|---|---|
| `/admin/dashboard-exec` | 経営ダッシュボード | master, admin |
| `/admin/product-costs` | 原価マスタ管理 | master, admin |
| `/admin/receivables` | 売掛一覧・入金登録 | master, admin, staff |
| `/admin/payables` | 買掛一覧・支払登録 | master, admin |
| `/admin/budget` | 予算入力・予実比較 | master, admin |
| `/admin/customer-analytics` | 顧客分析 | master, admin, staff |
| `/admin/accounting-export` | 会計ソフト連動 | master |

### 5-2. 既存画面の拡張
- `Dashboard.jsx`：実データ接続（今はスタブ）。売上速報・今月達成率を上部に追加
- `Inventory.jsx`：原価表示（粗利率を行ごとに表示）
- `OrderManage.jsx`：受注確定時に売掛自動生成
- `KickbackManage.jsx`：経費として `expenses` に自動計上
- `BcartImport.jsx`：取込時に売掛自動生成

### 5-3. UI コンポーネント追加
- `<MetricCard>`：数値カード（タイトル・数値・前期比・矢印）
- `<TrendChart>`：折れ線グラフ（recharts ライブラリ追加）
- `<RankingTable>`：商品/顧客ランキング表
- `<DonutChart>`：構成比ドーナツ（売上の代理店別構成など）
- `<DateRangeFilter>`：日次／月次／四半期／年次切替
- `<CompanyToggle>`：RT / RC / 統合 切替（CompanyContext と連動）

### 5-4. 新規 lib モジュール
- `lib/dashboardAggregator.js`：ダッシュボード集計ロジック
- `lib/costCalculator.js`：原価計算（移動平均・原価有効期間）
- `lib/receivablesAuto.js`：売掛自動生成
- `lib/payablesAuto.js`：買掛自動生成
- `lib/accountingExport.js`：freee / マネーフォワード CSV 生成
- `lib/customerAnalytics.js`：LTV・リピート率計算
- `lib/budgetCompare.js`：予実比較

### 5-5. Firestore セキュリティルール追加
```
match /dashboards/{docId}        { allow read: if isAdmin(); allow write: if isAdmin(); }
match /productCosts/{docId}      { allow read: if isAdmin() || isStaff(); allow write: if isAdmin(); }
match /receivables/{docId}       { allow read, write: if isAdmin() || isStaff(); }
match /payables/{docId}          { allow read, write: if isAdmin(); }
match /budgets/{docId}           { allow read: if isAdmin(); allow write: if isMaster(); }
match /customerAnalytics/{docId} { allow read: if isAdmin() || isStaff(); allow write: if isAdmin(); }
match /accountingExports/{docId} { allow read, write: if isMaster(); }
match /expenses/{docId}          { allow read, write: if isAdmin(); }
```

### 5-6. 複合インデックス追加
```
orders: (companyName ASC, orderDate DESC)
orders: (campaign ASC, orderDate DESC)
receivables: (status ASC, dueDate ASC)
payables: (status ASC, dueDate ASC)
customerAnalytics: (customerType ASC, ltv DESC)
```

### 5-7. Cloud Functions（Blaze 必須）
| 関数 | トリガー | 用途 |
|---|---|---|
| `aggregateDashboardDaily` | スケジュール 02:00 JST | ダッシュボード再生成 |
| `updateCustomerAnalytics` | スケジュール 03:00 JST | 顧客分析再生成 |
| `markOverdueReceivables` | スケジュール 04:00 JST | 期限超過マーキング |
| `onOrderCreated` | Firestore trigger | 売掛自動生成 |
| `onPurchaseCreated` | Firestore trigger | 買掛自動生成 + 原価更新 |

### 5-8. 段階的リリース計画
**Phase 1（即着手・既存活用）**
1. 経営ダッシュボード（既存 `orders` 集計のみ、Functions なしクライアント側）
2. 原価マスタ画面（手入力）
3. 売掛・買掛画面（手動登録）

**Phase 2（自動化）**
4. 受注 → 売掛自動生成（writeBatch で `OrderManage` から）
5. 顧客分析画面（クライアント集計）
6. 予算入力・予実比較

**Phase 3（Blaze 課金後）**
7. Cloud Functions 化（日次バッチ・トリガー）
8. 会計ソフト連動（CSV → API へ段階移行）
9. ダッシュボードのリアルタイム更新

### 5-9. 既存資産の活用方針
| 既存機能 | 連動内容 |
|---|---|
| `lib/firebase.js` | そのまま使用（Firebase 初期化） |
| `AuthContext` | 新権限を `roleAccess` に追加 |
| `CompanyContext` | RT/RC 切替に流用 |
| `Layout.jsx` | サイドバーに新メニュー追加 |
| `ProtectedRoute` | `requireFeature` を新機能用に拡張 |
| `bcartParser.js` | Bカート受注 → 売掛自動生成のトリガーに |
| `generateInvoicePdf.js` | 売掛画面の請求書発行ボタンに流用 |
| `receiptEmail.js` | 入金登録時の領収書発行に流用 |
| `taxCalc.js` | 全画面の税計算に流用 |

### 5-10. テスト・検証
- 環境分離：本番（`firebase use production`）／テスト（`firebase use test`）
- テスト環境で 1 ヶ月分のダミーデータを投入し、ダッシュボード集計値を Excel と突合
- 原価変更が過去 orders に遡及反映されないこと（`effectiveFrom/To` の検証）
- 売掛自動生成の冪等性（同じ受注を 2 回処理しても重複しない）

### 5-11. KPI（基幹システム稼働後の評価指標）
- 月次決算所要時間：2週間 → 3 営業日
- 売上把握タイムラグ：月末 → 当日
- キックバック計算：手作業ゼロ
- 売掛回収率：90% 以上
- 在庫回転率：年 6 回以上

---

## 6. 未確認事項（社長との確認が必要）

1. **会計ソフト**：freee / マネーフォワード / 弥生 / その他？（連動先確定）
2. **既存原価データ**：Excel か紙か？（マイグレーション方法）
3. **支払サイト**：取引先別の支払期限ルール（30日／60日 等）
4. **予算策定プロセス**：誰がいつ作る？（年初一括 or 四半期見直し）
5. **Blaze プラン移行**：Cloud Functions 必須機能の実装時期
6. **顧客分析の対象**：サロン単位／エンドユーザー単位（`customers` 配下）どちらを優先？
7. **ダッシュボード閲覧者**：社長のみ／幹部全員／代理店も自分の数値だけ見られる？

---

## 7. 既存「キックバック計算システム実装仕様書」との関係

- キックバック仕様書は本基幹システムの**経費モジュールの一部**として位置付ける
- `kickbacks` コレクションの `finalSettlement` を `expenses` に自動転記し、営業利益計算に組み込む
- 経営ダッシュボードに「キックバック支払額」を独立項目として表示

---

**作成**：ClaudeCode（bomber-admin コードベース調査に基づく）
**バージョン**：v1.0（2026-04-15）
**フォーマット**：既存「キックバック計算システム実装仕様書」と同じ章立て・粒度
