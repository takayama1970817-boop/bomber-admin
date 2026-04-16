# bomber-admin 既存コード サマリー（Miro設計用）

基幹システムの設計図を作るにあたって、既存の bomber-admin に合わせた仕様を組んでもらうための資料です。

---

## 1. 技術スタック（実装済み）

| 項目 | 採用技術 |
|---|---|
| フレームワーク | **React 18 + Vite 5**（Next.js ではない。SPA 構成） |
| ルーティング | react-router-dom v6 |
| スタイリング | **Tailwind CSS v4** (`@tailwindcss/vite`) |
| UIライブラリ | **なし**（MUI/Antd 未使用。Tailwind で全部組んでる） |
| 状態管理 | **React Context のみ**（Redux/Zustand なし）<br>- `AuthContext`（ログイン・権限）<br>- `CompanyContext`（会社切替：ロイヤルトラスト/ロイヤルコスメ） |
| バックエンド | **Firebase**（サーバーレス、自前APIなし） |
| DB | **Firestore**（NoSQL、コレクション/ドキュメント型） |
| 認証 | **Firebase Auth**（Google ログイン + メール&パスワード） |
| ストレージ | Firebase Storage |
| Functions | Cloud Functions（asia-northeast1、部分的に使用） |
| PDF生成 | jsPDF + html2canvas（クライアント側で生成） |
| Excel | xlsx（SheetJS） |
| ホスティング | Firebase Hosting（本番・テスト環境を分離） |

### 環境切替
- 本番: `firebase use production`
- テスト: `firebase use test`（画面上部に赤帯表示）
- `VITE_ENV=test` で区別、`.env.local` に Firebase 設定

---

## 2. ディレクトリ構造

```
bomber-admin/
├── src/
│   ├── App.jsx                    # ルート定義（全ルート集約）
│   ├── main.jsx
│   ├── index.css
│   ├── pages/                     # 画面単位（50ファイル超）
│   │   ├── Login.jsx / DealerLogin.jsx / SalonLogin.jsx / WarehouseLogin.jsx
│   │   ├── Dashboard.jsx          # 本社ダッシュボード
│   │   ├── Salons.jsx / SalonDetail.jsx
│   │   ├── Attendance.jsx / AttendanceHistory.jsx
│   │   ├── Inventory.jsx          # 在庫
│   │   ├── OrderManage.jsx / PurchaseManage.jsx / QuotationManage.jsx
│   │   ├── InvoiceManage.jsx      # 請求書
│   │   ├── KickbackManage.jsx     # 代理店キックバック
│   │   ├── BcartImport.jsx        # Bカート受注メール取込
│   │   ├── DealerDashboard / DealerSalons / DealerChat / DealerDocuments
│   │   ├── SalonDashboard / SalonChat / SalonCustomers / SalonSales ほか
│   │   ├── NewsletterManage.jsx   # メルマガ
│   │   └── public/                # 認証不要の公開サイト（HomePage等）
│   ├── components/
│   │   ├── Layout.jsx             # 本社用サイドバー付きレイアウト
│   │   ├── PublicLayout.jsx       # 公開サイト用
│   │   ├── ProtectedRoute.jsx     # ログイン+権限ガード
│   │   ├── OrderForm.jsx / OrderHistory.jsx
│   │   └── ReceiptPrintable.jsx
│   ├── contexts/
│   │   ├── AuthContext.jsx        # ★ 認証・権限の中核
│   │   └── CompanyContext.jsx     # 会社切替（RT / RC）
│   ├── hooks/
│   │   └── useChatUnread.js
│   └── lib/                       # Firestore 接続・ユーティリティ
│       ├── firebase.js            # Firebase 初期化
│       ├── bcartParser.js         # Bカート受注メール解析
│       ├── bcartApi.js
│       ├── receiptEmail.js        # 領収書メール下書き生成
│       ├── generateReceiptPdf.js / generateInvoicePdf.js
│       ├── generateKickbackPdf.js / generateKbRulesPdf.js
│       ├── generateProjectDoc.js / docGenerator.js
│       ├── createAccountWithoutSignout.js
│       └── taxCalc.js
├── functions/                     # Cloud Functions
├── gas/                           # Google Apps Script 連携
├── firestore.rules                # ★ セキュリティルール（全コレクション定義）
├── firestore.indexes.json
├── storage.rules
└── firebase.json
```

---

## 3. 認証フロー

### ユーザーロール（5種類）
| role | 用途 | 入口 |
|---|---|---|
| `master` | 全権（社長） | `/login` |
| `admin` | 社内管理者 | `/login` |
| `staff` | 社内スタッフ（機能別権限あり） | `/login` |
| `dealer` | 代理店 | `/dealer-login` |
| `salon` | サロン | `/salon-login` |
| `warehouse` | 倉庫 | `/warehouse-login` |

### 認証の仕組み
1. ログイン可否は `allowedEmails` コレクションに登録されたメールで判定
2. `users/{uid}` に Firestore プロフィール（role, companyName, dealerCode等）
3. `settings/permissions` に **ロール別の機能アクセス表**（`roleAccess`）
4. `ProtectedRoute` で `requireRole` / `requireFeature` / `allowSalon` 等でガード
5. 初回ログインで `allowedEmails` から role / companyName を継承して users を自動生成
6. モバイルGoogleログインは `signInWithRedirect`、PCは `signInWithPopup`
7. 管理者が他ユーザーに**成り代わり**可能（カスタムトークン + `impersonating` claims）

---

## 4. Firestore データモデル（主要コレクション）

### コア
| コレクション | 用途 |
|---|---|
| `users/{uid}` | ユーザープロフィール（role, companyName, dealerCode, salonName等） |
| `allowedEmails/{id}` | ログイン許可リスト |
| `settings/permissions` | ロール別機能アクセス表 |

### 取引関連
| コレクション | 用途 |
|---|---|
| `salons/{id}` | サロンマスタ（name, contact, email, address, assignedUid, lastOrderDate 等） |
| `salons/{id}/notes/{noteId}` | サロンのメモ履歴（追記型、編集不可） |
| `dealers` / `dealerSalons` | 代理店マスタ・代理店↔サロン紐付け |
| `orders/{id}` | 受注（明細配列、bcartOrderNumber, campaign, source, companyName） |
| `purchases/{id}` | 工場発注 |
| `quotations/{id}` | 見積書 |
| `orderInvoices/{id}` | 受注に紐づく請求書 |
| `invoices/{id}` | グループC代理店向け請求書 |
| `kickbacks/{id}` | キックバック清算書（dealerCode で絞込） |

### 商品・在庫
| コレクション | 用途 |
|---|---|
| `products/{id}` | 在庫管理用商品マスタ |
| `stockHistory/{id}` | 入出庫履歴 |
| `inventoryMasters/{id}` | ブランド・分類・倉庫マスタ |
| `salonProducts/{id}` | サロン店販レコメンド用カタログ |

### BPマスタ（会社別 prefix）
- `rt_bp_clients / rt_bp_products / rt_bp_suppliers / rt_bp_destinations`（ロイヤルトラスト）
- `rc_bp_clients / rc_bp_products / rc_bp_suppliers / rc_bp_destinations`（ロイヤルコスメ）
- `rt_projects / rc_projects`：案件管理

### サロン顧客管理（CRM）
| コレクション | 用途 |
|---|---|
| `customers/{id}` | サロンのエンドユーザー顧客（salonCompanyName で絞込） |
| `customers/{id}/visits/{id}` | 来店履歴 |
| `customers/{id}/recommendations/{id}` | おすすめ履歴 |

### チャット
| コレクション | 用途 |
|---|---|
| `chatRooms/{roomId}/messages` | 社内・代理店・サロンのチャット |
| `chatRooms/{roomId}/readers` | 既読管理 |

### 出力系
| コレクション | 用途 |
|---|---|
| `publicReceipts/{id}` | 公開領収書（認証不要で読める） |
| `dealerDocuments/{id}` | 代理店・サロン向け資料 |

### メルマガ
- `newsletters / nl_readers / nl_templates / nl_logs`

### その他
- `attendance/{uid}_YYYY-MM-DD` / `attendance_monthly`（勤怠）
- `lineConfigs/{salonCompanyName}`（LINE Messaging API設定）

---

## 5. UI / UX パターン

### 配色・テーマ
- **本社画面**：インディゴ系（`bg-indigo-600` 等）
- **代理店ポータル**：独自配色
- **サロンポータル**：ピンク系
- **テスト環境**：画面上部に赤帯

### よく使うコンポーネントパターン
- **テーブル**：素の `<table>` + Tailwind。ライブラリ未使用
- **フォーム**：素の `<input>` + `useState`。react-hook-form なし
- **ボタン**：`rounded-lg px-3 py-1.5 text-xs font-medium` 系
- **フィルタバー**：ボタン群 + キーワード検索（例: Salons.jsx:58-82）
- **サイドバー**：Layout.jsx で権限別メニュー出し分け

### Firestore 呼び出しパターン（典型例）
```js
// src/pages/Salons.jsx
useEffect(() => {
  (async () => {
    const q = query(collection(db, 'salons'), orderBy('name'))
    const snap = await getDocs(q)
    setSalons(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  })()
}, [])
```

- カスタムフック化せず、各ページで `useEffect` + `getDocs`/`onSnapshot` を直書き
- リアルタイム更新が必要な箇所のみ `onSnapshot`（チャット等）
- 書き込みは `addDoc / setDoc / updateDoc` を直書き
- 複数更新は `writeBatch`（例: orders追加時に salons.lastOrderDate も更新）

---

## 6. 既に実装済みの業務機能

- ✅ サロン管理（一覧/詳細/メモ履歴/担当営業割当/フォロー必要フィルタ）
- ✅ 受注管理（Bカートメール取込、手動入力、明細複数行、自動合計）
- ✅ 請求書・領収書発行（PDF + Gmail下書き生成）
- ✅ 代理店管理・キックバック清算
- ✅ 工場発注・見積書
- ✅ 在庫管理（入出庫履歴、複数倉庫対応）
- ✅ 勤怠管理（休憩ボタン方式、月次集計）
- ✅ 代理店ポータル（ダッシュボード/サロン一覧/チャット/資料DL）
- ✅ サロンポータル（店販CRM/チャット/資料DL/売上実績）
- ✅ 社内チャット（DM・グループ、既読管理）
- ✅ メルマガ配信・公開登録フォーム
- ✅ 案件管理（RT / RC 2社分離）
- ✅ 公開サイト（商品紹介/サロン検索/パートナー募集）
- ✅ 成り代わりログイン（管理者 → 任意ユーザー）

---

## 7. 基幹システム設計時の推奨事項

### ✅ そのまま引き継ぐべき
- 技術スタック（React + Vite + Tailwind + Firebase）
- AuthContext の権限モデル（role + roleAccess の二層）
- Firestore のコレクション命名規則（単数名詞の複数形、会社別 prefix）
- `ProtectedRoute` による機能ガード
- 会社切替（CompanyContext）の考え方

### ⚠️ 設計時に注意
- **Firestore のクエリ制約**：複合クエリは必ず `firestore.indexes.json` に複合インデックスを追加
- **サブコレクション vs 別コレクション**：メモ履歴はサブコレ、注文は別コレで `salonId` 参照（集計しやすさで判断）
- **会社分離**：ロイヤルトラスト(rt) / ロイヤルコスメ(rc) の2社がある。新機能も prefix 命名で分ける
- **Blaze課金が必要な機能**：Cloud Functions、外部API呼び出し

### 🆕 基幹化で追加したい候補（社長と未確認）
- 売上サマリー・経営ダッシュボード（会社別・代理店別・サロン別）
- 原価管理・利益率計算
- 仕入れ買掛管理
- 会計ソフト連動（freee / マネーフォワード）
- バーコード入出庫
- LINE Messaging API を使った自動配信

---

## 8. サンプルコード（渡せるキー）

もし Miro 側で具体ファイルが見たければ、以下を渡せます：

| ファイル | 用途 |
|---|---|
| `src/App.jsx` | ルート定義全貌 |
| `src/lib/firebase.js` | Firebase初期化 |
| `src/contexts/AuthContext.jsx` | 認証・権限ロジック |
| `src/pages/Salons.jsx` | 一覧画面の典型パターン |
| `src/pages/SalonDetail.jsx` | 詳細画面 + batch write の例 |
| `src/components/Layout.jsx` | サイドバー + 権限別メニュー |
| `firestore.rules` | 全コレクションのスキーマ・権限 |
| `CLAUDE.md`（プロジェクト直下） | 実装方針・チェックリスト |

---

**連絡先**：このファイルは bomber-admin コードベース調査に基づき ClaudeCode が作成。
不明点があれば実コードを直接確認可能。
