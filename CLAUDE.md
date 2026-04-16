# 社内システム — CLAUDE.md

## プロジェクト概要

ボンバー社（美容・エステ卸売業）の社内スタッフ向けWebアプリ。
取引先サロン管理 + スタッフ勤怠管理を一元化する。

## 技術スタック

- フロントエンド: React + Vite
- 認証: Firebase Authentication（Googleログインのみ）
- DB: Cloud Firestore
- ホスティング: Firebase Hosting
- スタイル: Tailwind CSS

## 認証・権限

- ログインはGoogleアカウントのみ
- **ログイン可能ドメインは社内ドメインに限定**する（AuthContext の初回作成時に弾く。Hosted Domain 制約も併用）
- 役割（role）は二重管理：
  - **Firebase Auth Custom Claims** に `role` を持たせる（セキュリティルールで参照するのはこちら）
  - `users/{uid}` にも `role` を保存（UI表示・admin画面での切替用）
  - Cloud Functions で `users/{uid}.role` の変更を検知して Custom Claims を自動同期
- `admin` : 社長（全機能アクセス可）
- `staff` : 一般スタッフ（自分の勤怠 + サロン閲覧）
- ログイン後、role に応じて表示メニューを切り替える

## Firestoreコレクション設計

### users

```
{
  uid: string,           // Firebase Auth の UID
  name: string,
  email: string,
  role: "admin" | "staff",
  createdAt: timestamp
}
```

### salons （取引先サロン）

```
{
  id: string,
  name: string,          // サロン名
  contact: string,       // サロン側の担当者名
  phone: string,
  email: string,
  plan: string,          // 契約プラン
  bcartRegistered: bool, // Bカート登録済み？
  assignedUid: string,   // 【追加】社内の担当営業のUID
  notes: string,         // 直近メモ（履歴は下の salons/{id}/notes サブコレ）
  lastOrderDate: timestamp,  // orders から派生（Cloud Functions で自動更新）
  createdAt: timestamp,
  updatedAt: timestamp
}
```

### salons/{salonId}/notes （メモ履歴・追記型）

```
{
  id: string,
  text: string,
  authorUid: string,
  authorName: string,
  createdAt: timestamp
}
```

### orders （発注履歴・Bカート連携 or 手入力）

```
{
  id: string,
  salonId: string,
  orderDate: timestamp,
  total: number,
  items: array,       // [{ productCode, name, qty, price }]
  source: string,     // "bcart" | "manual"
  createdAt: timestamp
}
```
※ `salons.lastOrderDate` はここから派生させる（手入力しない）

### attendance （勤怠）

**docId ルール**: `${uid}_${YYYY-MM-DD}` にして同日二重打刻を構造的に不可能にする。

```
{
  uid: string,           // スタッフのUID
  date: string,          // "YYYY-MM-DD"
  clockIn: timestamp,
  clockOut: timestamp,
  breakStart: timestamp, // 休憩開始（押した時刻）
  breakEnd: timestamp,   // 休憩終了（押した時刻）
  breakMinutes: number,  // 自動計算（手入力しない）
  memo: string
}
```

**休憩時間の方針**: 「休憩開始」「休憩終了」ボタン方式。手入力は不可。
打ち忘れた場合のみ、adminが `/admin/users` から修正可能にする。

### attendance_monthly （月次集計キャッシュ）

**docId**: `${uid}_${YYYY-MM}`

```
{
  uid: string,
  yearMonth: string,   // "YYYY-MM"
  totalMinutes: number,
  workDays: number,
  updatedAt: timestamp
}
```
※ Cloud Functions で `attendance` 更新時に自動集計

## 画面構成

1. `/login` — Googleログイン画面
2. `/dashboard` — ダッシュボード（フォロー必要サロン数・今月勤務時間）
3. `/salons` — サロン一覧・検索
4. `/salons/:id` — サロン詳細・編集・メモ
5. `/attendance` — 勤怠打刻（今日の出退勤）
6. `/attendance/history` — 勤怠履歴・月次集計
7. `/admin/users` — スタッフ管理（adminのみ）

## 開発ルール

- コンポーネントは `src/components/` に配置
- Firebase の初期化は `src/lib/firebase.js` に集約
- 認証状態は React Context（`AuthContext`）で管理
- 環境変数は `.env.local` に記載（Gitに含めない）
- コミットメッセージは日本語OK

## 環境変数（.env.local）

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

## セットアップ手順

```bash
npm create vite@latest bomber-admin -- --template react
cd bomber-admin
npm install
npm install firebase tailwindcss @tailwindcss/vite
npx claude  # Claude Code起動
```

## 最初に作るもの（Step 1）

1. Firebase プロジェクト作成（Firebase Console）
2. Authentication → Googleログイン有効化
3. Firestore データベース作成
4. `src/lib/firebase.js` 作成
5. `AuthContext` + ログイン画面実装
6. role チェックのルーティング実装

---

## セキュリティ方針

### Firestore セキュリティルール（本番）

**絶対にテストモードのまま公開しない**。`firestore.rules` を用意し、デプロイ時に適用。
Custom Claims を使って `request.auth.token.role == "admin"` で判定する（users コレクションの二重読み取りを避ける）。

方針の骨子：
- `users/{uid}` : 本人のみ読める。書き込みは admin のみ
- `salons/{id}` : 全スタッフ読める。書き込みは admin と `assignedUid == request.auth.uid` のスタッフ
- `salons/{id}/notes/{noteId}` : 全スタッフ読める。追記のみ可、編集・削除は不可
- `attendance/{id}` : 本人のみ読み書き可。admin は全員分読めるが書けるのは修正時のみ
- `attendance_monthly/{id}` : 本人と admin のみ読める。書き込みは Cloud Functions のみ
- `orders/{id}` : 全スタッフ読める。書き込みは admin と Cloud Functions のみ

### ログイン可能ドメイン制限

`@bomber-corp.co.jp` 等の社内ドメインのみログイン可。AuthContext の初回ユーザー作成時にメールアドレスのドメインをチェックして弾く。
※ 実ドメインは `.env.local` に `VITE_ALLOWED_EMAIL_DOMAIN` として定義する

---

## ビジネスロジックの定義

### 「フォロー必要サロン」の定義

以下のいずれかに該当：
- 最終発注日から **30日以上経過**
- 最終メモ更新から **14日以上経過**
- `bcartRegistered == false` かつ初回登録から7日以上経過

ダッシュボードで件数表示、`/salons?filter=follow-needed` で一覧表示できるようにする。

### サロン検索

- 200件未満：現状のクライアント側フィルタでOK
- 200件以上：Algolia か Typesense を検討（Step 3以降）

---

## 運用ルール

- `.env.local` は絶対にコミットしない（`.gitignore` 済み）
- `firebase-debug.log` も同様
- Firebase Console の API キーを共有する場合は 1Password 等経由
- 本番デプロイは `main` ブランチのみ（Firebase Hosting の GitHub Actions 連携）
- Cloud Functions のロジック変更時は必ずローカルエミュレータで動作確認

---

## Step 2 以降で対応する改善項目

### Step 2-A（Blaze 課金不要・実装済）

- [x] **Firestore 本番ルール** （`firestore.rules` 作成＋ Console から手動デプロイ）
  - Firestore-based の `isAdmin()` ヘルパー関数で role 判定
  - users/salons/attendance/attendance_monthly/orders に対して権限分離
- [x] **ログイン可能ドメイン制限**（フロント側）
  - `VITE_ALLOWED_EMAIL_DOMAIN` を `.env.local` で設定
  - AuthContext で初回ログイン時に弾く
- [x] **勤怠の休憩ボタン方式** 実装
  - 「休憩開始」「休憩終了」ボタン化、`breakMinutes` は自動計算
  - 退勤時に休憩中だった場合は自動で休憩終了
- [x] **salons に assignedUid 追加** + 担当者フィルタ
  - SalonDetail で社内営業担当を選択（admin のみ変更可）
  - Salons 一覧に「自分の担当」フィルタ追加
  - 「フォロー必要サロン（30日超）」フィルタも追加
- [x] **AdminUsers 拡張**
  - スタッフ毎の今月勤怠を表示・休憩分修正
  - role 変更時に確認ダイアログ
- [x] **firebase.json + firestore.indexes.json** 用意（Hosting デプロイ準備）

### Step 2-B（Blaze 課金後・Cloud Functions 系）

- [ ] **Custom Claims** による role 管理 + Cloud Functions 同期
- [ ] **orders コレクション** の `lastOrderDate` 自動派生化を Cloud Functions に移管（現状はクライアント側 batch write で代用）
- [ ] **attendance_monthly** 集計キャッシュ（onWrite トリガー）

### Step 3-① 完了（2026-04-10）

- [x] **orders コレクション**（手入力対応）
  - `OrderForm.jsx`：明細複数行・自動合計・発注日選択
  - `OrderHistory.jsx`：発注一覧（明細展開可）
  - SalonDetail に統合
  - **batch write** で `salons.lastOrderDate` を同時更新（Cloud Functions の代替）
- [x] firestore.indexes.json に `orders(salonId, orderDate desc)` 複合インデックス追加

### Step 3-①+ Bカート連動（2026-04-10 完了）

- [x] **Bカートメール取り込み機能**（`/admin/bcart-import`）
  - `src/lib/bcartParser.js`：Bカート受注通知メールの解析
    - 対応する揺れ: 部署名あり/なし、携帯番号あり/なし、品番（JAN）空OK、入数の単位揺れ、セット名混在
    - 「お客様からの連絡事項」も抽出
  - `src/pages/BcartImport.jsx`：貼り付け → プレビュー → 保存
    - 注文番号で重複チェック（`bcartOrderNumber` フィールド）
    - サロン名（会社名）で既存サロン自動紐付け
    - 未登録サロンは同時に自動新規登録（住所・電話・メール自動入力）
    - `orders` に `source: 'bcart-email'`, `campaign`, `customerNote` フィールド追加
  - **batch write** で orders 追加 + salons 作成/更新を一発化
- [x] **領収書ワンクリック発行機能**
  - `src/lib/receiptEmail.js`：領収書メール本文生成 + Gmail 下書きURL生成
  - 「お客様からの連絡事項」に「領収書/領収証/レシート」が含まれると検出してアラート表示
  - ボタン → Gmail の compose 画面が新タブで開き、宛先・件名・本文自動入力
  - 電子取引のため収入印紙不要の注記を本文に含む
  - 常時ボタンも配置（領収書希望無し注文でも任意発行可）

### Step 3 以降の積み残し

- [ ] **メモ履歴サブコレクション** 実装（`salons/{id}/notes`）
- [ ] **ダッシュボードの実データ接続**（フォロー必要サロン件数・今月勤務時間）
- [ ] **既存エクセル → Firestore インポート** スクリプト
- [ ] **Bカート連携**（API 確認後）
- [ ] **エラー監視**（Sentry）導入 — 本番公開前に必須
- [ ] **ダークモード**（任意）

---

## 🆕 サロン管理プロジェクト（売れるサロン化システム）

bomber-admin に「サロン⇔エンドユーザー（来店客）」を管理する機能を増設するプロジェクト。
社内呼称は **「サロン管理」**。サロンポータル（`/salon/*`）配下に追加していく。

### コンセプト
ただの管理ツールではなく **「売れるサロン化システム」**。以下3つの結果に特化：
1. 売上が伸びる
2. リピート率が上がる
3. 店販が売れる

### 5つのコア機能
| # | 機能 | 状態 | 場所 |
|---|---|---|---|
| ① | 顧客管理（来店履歴・肌状態・使用商品） | 🟡 MVP実装済 | `/salon/customers` |
| ② | LINE連動（自動配信） | ⬜ 未着手 | Cloud Functions（Blaze必要） |
| ③ | 店販サポート（レコメンド + 提案セリフ） | ⬜ 未着手 | 顧客詳細にプレースホルダ設置済 |
| ④ | 売上ダッシュボード（月商・客単価・リピ率・店販比率） | 🟡 骨組み有 | `/salon`（既存） |
| ⑤ | 予約管理 | 外部連携で対応 | STORES予約 / RESERVA |

### データモデル

#### `customers`（トップレベル・サロン識別は `salonCompanyName`）
```
customers/{customerId}
├─ salonCompanyName         サロン識別キー（既存 orders と同方式）
├─ name, nameKana, phone
├─ lineUserId               LINE連動用
├─ birthday, gender
├─ skinType[], concerns[]   肌タイプ・お悩みタグ
├─ skinNotes                肌状態自由記述（★レコメンドの源泉）
├─ memo, tags[]
├─ firstVisit, lastVisit
├─ visitCount, totalSpent   集計値（visits 登録時に更新）
└─ createdAt, createdBy, updatedAt
```

#### `customers/{customerId}/visits`（来店履歴サブコレクション）
```
├─ visitDate
├─ menu[], menuPrice
├─ productsUsed[]    施術消費（VAVITTE製品）
├─ productsSold[]    店販で売れた製品 ★店販比率の源泉
├─ totalAmount
├─ skinConditionNote, nextRecommendation
└─ staffUid
```

#### `customers/{customerId}/recommendations`（おすすめ履歴）
```
├─ productId, productName     ← Bカート商品マスタ参照
├─ reason, suggestedScript    ★「○○様の乾燥には〜」提案セリフ
└─ status: suggested | sold | declined
```

#### `lineConfigs/{salonCompanyName}`（サロン別LINE設定）
```
├─ channelAccessToken, channelSecret
├─ messageTemplates: { afterVisit, birthday, reminder }
├─ reminderDays
└─ enabled
```

### セキュリティルール方針
- サロンユーザーは `salonCompanyName == userDoc().companyName` のデータのみアクセス可
- 本社 admin/staff は集計用に全件読めるが、**画面側で個別表示しない運用**で約束担保
  - 将来的に Cloud Functions による集計コレクション分離へ移行予定（Blaze化と同時）

### Step S-1 完了状況（2026-04-15）
- [x] `firestore.rules` に customers / visits / recommendations / lineConfigs ルール追加
- [x] `firestore.indexes.json` に customers 用インデックス3種 + visits collection group 追加
- [x] `src/pages/SalonCustomers.jsx` 新規作成
  - 顧客一覧（テーブル + 検索 + フィルタ：すべて/フォロー必要/今月誕生日）
  - KPIカード（登録数・フォロー必要・今月誕生日）
  - 新規/編集モーダル（基本情報・肌タイプ/お悩みタグ・肌状態メモ）
  - 詳細パネル（インライン展開、来店履歴 + おすすめ商品プレースホルダ）
- [x] `App.jsx` に `/salon/customers` ルート追加
- [x] `SalonLayout.jsx` のサイドバーに「顧客管理」追加
- [x] `npm run build` 通過確認（509 modules）
- **未デプロイ**: `firestore.rules` と `firestore.indexes.json` を Firebase Console から手動コピペ必要

### Step S-2 完了状況（2026-04-15）
- [x] **来店登録機能**（visits サブコレクション追加 UI）
  - `SalonCustomers.jsx` の CustomerDetail に「+ 来店を登録」ボタン追加
  - VisitForm: 来店日 / 施術メニュー / 施術料金 / 店販商品（複数行・数量・単価）/ 肌状態メモ / 次回提案
  - 保存時 `writeBatch` で visit 追加 + customer の `lastVisit` / `visitCount(+1)` / `totalSpent(+amount)` / `firstVisit`(初回時) を一発更新
- [x] **店販レコメンド機能**（②コア）
  - 新規 `salonProducts` コレクション（admin のみ書き込み、サロン読取可）
  - `firestore.rules` に salonProducts ルール追加・本番デプロイ済
  - 新規 admin ページ `SalonProductsAdmin.jsx`（`/admin/salon-products`）
    - 商品名・価格・対応肌タイプ・対応お悩み・**提案セリフ** (`{name}` プレースホルダ対応) ・推薦理由・公開フラグ・bcartProductId（将来連動用）
  - サロン側顧客詳細にレコメンド枠を設置：`skinType × concerns` のマッチで商品をスコアリングしトップ3表示
    - 既購入は「リピ提案」タグ表示でスコア下げる
- [x] **売上KPIダッシュボード拡張**（③コア）
  - `SalonDashboard.jsx` 上部に「📊 今月の経営KPI」セクション追加
  - 月商 / 客単価 / リピート率 / 店販比率 の4指標 + 前月比
  - 45日以上未来店アラート（顧客管理への動線）
  - 既存「本社からの仕入れ」は別セクションとして残す
- [x] **CSV インポート**（④コア）
  - `SalonCustomers.jsx` トップに「📥 CSV取込」ボタン追加
  - 日本語/英語見出し両対応（name / お名前 / 氏名 など）
  - プレビュー表示 → 400件ずつ batch 書き込み → 進捗・エラー表示
- [x] admin Layout サイドバーに「サロン管理」グループ追加（サロンアカウント・店販商品マスタ）
- [x] `npm run build` 通過確認（510 modules）
- [x] `firestore.rules` 本番デプロイ済（salonProducts 含む）

### Step S-3 以降の積み残し
- [ ] **LINE Messaging API 連携**（残った最重要機能） — Blaze 課金タイミング
  - friend追加 → lineUserId 自動紐付けフロー
  - Cloud Functions スケジューラで自動配信（来店後フォロー / 誕生日 / 45日リマインド）
  - レコメンド結果を LINE で配信（顧客全員にパーソナライズ提案）
- [ ] **本社向け集計コレクション**（`customerStats`）で個別顧客アクセスを技術的に遮断
- [ ] **来店登録の編集・削除UI**（現状は追加のみ）
- [ ] **店販レコメンド推薦ログ**（`recommendations` サブコレクションへの記録 + 成約率測定）
- [ ] **Bカート商品マスタ → salonProducts 一括同期**スクリプト（`bcartProductId` をキーに）
- [ ] **STORES予約 / RESERVA 連携**（⑤予約管理）

### Step S-2 設計判断ログ
- **2026-04-15**: レコメンド用商品マスタは `salonProducts` を新規作成（既存 `bp_products` を流用しない）
  - 理由: 既存マスタは仕入れ用で複雑、サロン向けは「提案セリフ」「肌タイプタグ」が必要なため別構造が適切
  - 将来 Bカート連動するための `bcartProductId` フィールドを準備済
- **2026-04-15**: KPI集計はクライアント側で実施（visits の collection group ではなく顧客毎ループ）
  - 理由: 当面サロンあたり顧客数千件以下を想定。Cloud Functions 集計は Blaze 化後に検討

### 設計判断ログ
- **2026-04-15**: bomber-admin と同じ Firebase プロジェクトで作る（別サーバー案を却下）
  - 理由: Bカート商品マスタとの即時連携が「神機能」の前提・運用コスト2倍を回避
- **2026-04-15**: `customers` をトップレベルに配置（`salons` 配下のサブではなく）
  - 理由: 既存 `orders` の `companyName` 識別パターンに揃え、本社の集計クエリを簡素化
- **2026-04-15**: 本社の個別顧客アクセスは「運用ルール縛り」で開始
  - 理由: MVPを早く出すため。Blaze化と同時に技術的分離へ移行
