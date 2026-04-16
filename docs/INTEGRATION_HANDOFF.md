# VAVITTE受注発注管理システム → bomber-admin 統合ガイド

## 概要

別のCoworkセッションで作成した「VAVITTE受注発注管理システム」（単一HTML + GAS バックエンド、localStorage管理）の機能を、bomber-admin（React + Vite + Firebase）に統合する作業を行っています。

**元のシステムの場所**: `C:\Users\takay\OneDrive\Desktop\VAVITTE受注発注管理システム\VAVITTE_受注発注管理.html`（約5,000行の単一HTMLファイル）

## 今回完了した作業

### 1. 新規作成ファイル

#### `src/lib/taxCalc.js`（税計算ユーティリティ）
- `getTaxRateInfo(code)` : 税率コード（'10', '8r', '8', '5'）→ { rate, label, code }
- `calcTax(subtotal, settings)` : 消費税計算（端数処理: floor/ceil/round対応）
- `taxRowLabel(settings)` : 書類用の税行ラベル（例:「消費税（10%）」）
- `taxNoteText(settings)` : 免税・税込時の注記テキスト
- `DEFAULT_TAX_SETTINGS` : デフォルト税設定定数
- 設定は Firestore `settings/company` ドキュメントの `taxRate`, `taxRounding`, `taxDisplayMode` から読む

#### `src/lib/docGenerator.js`（Misoca風統一書類レイアウトHTML生成）
- `buildDocLayout(opts)` : 請求書・見積書・発注書・納品書の統一HTMLを生成
  - 上部右寄せ: 日付＋書類番号
  - 中央: タイトル（「請 求 書」等）
  - 左: 取引先情報（御中、担当者、住所）＋合計金額枠
  - 右: 発行者情報（会社名、住所、TEL、登録番号、印影）
  - テーブル: 品名/数量/単価/金額 ＋ 小計/消費税/合計
  - 下部: 備考、振込先
- `buildStandaloneHtml(title, innerHtml)` : 印刷用の完全なHTML
- `openPrintPreview(title, innerHtml)` : 新規ウインドウで印刷プレビュー
- `docSharedCSS()` : A4印刷対応の共通CSS
- `formatDocDate(d)` : YYYY年MM月DD日 フォーマット
- `fmtYen(n)` : ¥X,XXX フォーマット

#### `src/pages/PurchaseManage.jsx`（発注管理ページ）
- **Firestoreコレクション**: `purchases`
- **ステータス**: pending（下書き）→ confirmed（発注済）→ producing（製造中）→ shipped（出荷済）→ received（検収済）/ cancelled
- **機能**: 
  - 一覧表示（ステータスタブフィルタ＋検索）
  - サマリーカード（未処理数、今月件数、今月金額）
  - 新規作成モーダル（仕入先情報、複数明細行、発注日、納期、備考）
  - 発注番号自動生成（PO-YYYYMMDD-NNN）
  - 行展開で明細詳細表示
  - ステータス変更（個別＋一括）
  - PDF発注書印刷（docGenerator使用）
- **データ構造**: 
```
{
  poNo, factoryName, factoryPerson, factoryEmail, factoryAddress,
  status, orderDate, deliveryDate,
  items: [{ name, code, qty, unitPrice, amount }],
  subtotal, tax, total, notes, relatedSalesId,
  createdAt, updatedAt
}
```

#### `src/pages/QuotationManage.jsx`（見積書管理ページ）
- **Firestoreコレクション**: `quotations`
- **ステータス**: draft（下書き）→ sent（送付済）→ accepted（成約）/ rejected（失注）/ expired（期限切れ）
- **機能**:
  - 一覧表示（ステータスタブフィルタ＋検索）
  - サマリーカード（下書き数、今月作成数、今月金額）
  - 新規作成モーダル（取引先情報、複数明細行、見積日、有効期限、備考）
  - 見積番号自動生成（Q-YYYYMMDD-NNN）
  - PDF見積書印刷（docGenerator使用）
  - **見積→受注変換**: 「受注に変換」ボタンでordersコレクションに新規ドキュメント作成＋見積をacceptedに更新（writeBatch使用）
- **データ構造**:
```
{
  quoteNo, customerName, customerPerson, customerEmail, customerAddress,
  status, quoteDate, validUntil,
  items: [{ name, code, qty, unitPrice, amount }],
  subtotal, tax, total, notes,
  createdAt, updatedAt
}
```

#### `functions/bcartSync.js`（Bカート在庫プッシュ同期 Cloud Function）
- **Callable Function**: `syncBcartInventory`
- **パラメータ**: domain, apikey, items, threshold, mapping
- **処理フロー**:
  1. mapping='code' → GET /products?product_code={code} で商品ID取得 → PUT で在庫更新
  2. mapping='bcart_id' → 直接PUTで在庫更新
  3. 在庫が閾値以下 → stock_display: 'few'（残りわずか）に設定
- **レート制限**: 100ms間隔（300req/300sec対応）
- **リージョン**: asia-northeast1
- **権限**: admin/masterロールのみ実行可

### 2. 更新ファイル

#### `src/pages/GeneralSettings.jsx`
- 課税設定セクション追加:
  - 課税表示方式（税別/税込/免税）
  - 消費税率（10%/軽減8%/8%/5%）
  - 消費税端数処理（切り捨て/切り上げ/四捨五入）
  - 源泉徴収税チェックボックス
- DEFAULT_COMPANYに taxRate, taxRounding, taxDisplayMode, withholdingTax を追加

#### `src/App.jsx`
- import追加: PurchaseManage, QuotationManage
- Route追加:
  - `/admin/purchases` → PurchaseManage（requireFeature="orders"）
  - `/admin/quotations` → QuotationManage（requireFeature="orders"）

#### `src/components/Layout.jsx`
- サイドバーナビの「受注発注管理」をMenuGroupに変更:
  - サブメニュー: 受注管理(/admin/orders)、発注管理(/admin/purchases)、見積書管理(/admin/quotations)

#### `firestore.rules`
- `purchases/{docId}` ルール追加（admin/staffが読み書き可）
- `quotations/{docId}` ルール追加（admin/staffが読み書き可）

#### `functions/index.js`
- bcartSync モジュールのエクスポート追加

## まだ完了していない作業（次のセッションで対応）

### 優先度: 高

1. **OrderManageへの受注ワークフロー統合**
   - 元システムには受注→請書メール→工場発注→製造→納品→請求書の一括ワークフローがある
   - OrderManage.jsxに「🚀 処理」ボタンを追加し、ステップ式ダイアログでワークフロー実行
   - Step1: 受注確認メール送信
   - Step2: PurchaseManage連携（自動で発注書作成）
   - Step3: 製造開始ステータス更新
   - Step4: 納品完了
   - Step5: 請求書自動作成

2. **InvoiceManage.jsxのMisoca風PDF対応**
   - 既存の請求書管理がdocGenerator.jsの統一レイアウトを使うように更新
   - buildDocLayout() を使ってPDFを生成
   - taxCalc.jsで税計算を統一

3. **Bカート在庫同期UIのInventory.jsxへの統合**
   - 在庫管理ページに「Bカート在庫同期」ボタン追加
   - Bカート設定（ドメイン、APIキー、閾値、マッピング方式）をGeneralSettingsに追加
   - 同期結果モーダル表示
   - フロントエンドからCloud Function `syncBcartInventory` を呼ぶコード

### 優先度: 中

4. **在庫管理ページに発注点・残りわずか表示を追加**
   - 在庫が発注点以下の商品に「残りわずか」バッジ表示
   - 元システムの `reorder_point` に相当するフィールドをinventoryMastersに追加

5. **納品書管理**
   - 受注に紐づく納品書の生成機能
   - docGenerator.jsのbuildDocLayout()で統一レイアウト

6. **ダッシュボードに発注・見積統計の追加**
   - 未処理発注件数、今月の発注金額
   - 見積中の件数

### 優先度: 低

7. **工場マスタ / 納品先マスタ**
   - 元システムにはfactories, destinationsコレクションがある
   - 発注時に仕入先を過去データから選択できるように

8. **Bカート在庫同期のスケジュール実行**
   - Cloud Schedulerで定期同期（1日1回など）

## テスト環境での確認方法

```bash
# テスト環境に切り替え
firebase use test

# .env.testの内容で起動
cp .env.test .env.local

# ローカル開発サーバー起動
npm run dev

# ビルド＆デプロイ
npm run build
firebase deploy --only hosting

# Cloud Functionsデプロイ（Blazeプラン必要）
firebase deploy --only functions

# Firestoreルールデプロイ
firebase deploy --only firestore:rules
```

## 技術的な注意点

- PurchaseManage / QuotationManage は Firestore コレクションが空の状態から動作する（初回は空一覧が表示される）
- 税設定は `settings/company` ドキュメントに保存される。GeneralSettingsの「設定を保存」ボタンで反映
- docGenerator.js は window.open() で新ウインドウにHTMLを書き出すため、ポップアップブロッカーに注意
- bcartSync.js は Cloud Functions v2 (firebase-functions/v2) で書かれている。functionsフォルダにnode-fetchが必要
- firestore.indexes.json に purchases/quotations の複合インデックスが必要な場合は追加すること（orderDateでのソート等）
