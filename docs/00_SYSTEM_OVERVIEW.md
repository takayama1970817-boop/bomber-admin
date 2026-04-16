# bomber-admin システム概要（AS-IS 定義書）

> 出典：Miro AI によるコード理解に基づく自動生成。ClaudeCode が実コードと照合し精度確認済み。
> バージョン：v1.0（2026-04-15）

## 1. システム概要

bomber-admin は、Royal Trust / Royal Cosme の二社運用に対応した業務コア SPA です。6ロールに基づき、受発注、請求/領収、在庫、キックバック、CRM、ニュースレター、チャット等を一元管理します。対象ロールは master / admin / staff / dealer / salon / warehouse。二社境界は CompanyContext で rt/rc を厳格分離します。

## 2. 技術スタック詳細

React 18 + Vite 5（SPA）。Tailwind CSS v4 のみ。状態は AuthContext / CompanyContext。react-router-dom v6。Firebase（Auth / Firestore / Storage / Functions asia-northeast1）。PDF は jsPDF + html2canvas、Excel は SheetJS。Firebase Hosting で prod / test 分離。

## 3. プロジェクト構造

src 直下に App.jsx、pages（50+画面）、components（Layout / ProtectedRoute 他）、contexts、hooks（useChatUnread）、lib（firebase.js, generate*Pdf.js, bcartParser.js 等）を配置。ファイル命名は PascalCase.jsx / camelCase.js。

## 4. 認証・認可設計

Auth は Google / Email。onAuthStateChanged で allowedEmails → users コレクションから role / company を解決。ProtectedRoute でロール / 会社境界を検証。master による成り代わりをサポート。

> **実装補足**：Miro 原稿の「監査ログを Functions で記録」は現状未実装（Phase 3 で追加予定）。

## 5. 状態管理アーキテクチャ

AuthContext が user / roles / signin / signout / refresh を提供。CompanyContext が currentCompany と rt/rc 切替を提供。Redux 系は不使用。

## 6. Firestore データモデル

users / allowedEmails / settings、salons(+notes)、dealers / dealerSalons、orders / purchases / quotations / orderInvoices / invoices / kickbacks、products / stockHistory / inventoryMasters / salonProducts、rt_bp_* / rc_bp_*、customers(+visits, +recommendations)、chatRooms(+messages, +readers)、publicReceipts / dealerDocuments、newsletters / nl_readers / nl_templates / nl_logs、attendance / attendance_monthly、lineConfigs。

## 7. ルーティング設計

App.jsx で v6 ルーティング。AppLayout / AuthLayout と ProtectedRoute を組み合わせ、ロールごとにガード。

## 8. コンポーネント設計パターン

関数コンポーネント + Hooks。Atomic 準拠。プレーン HTML × Tailwind。フォームは useState 直書き。

## 9. UI/UX パターン

テーブル / フォームは素の要素。ボタンは `rounded-lg px-3 py-1.5 text-xs`。HQ=Indigo、Salons=Pink、テストは赤バナー。Firestore は各ページで useEffect + getDocs / onSnapshot。関連更新は writeBatch。

## 10. Firebase 統合実装

初期化例（`src/lib/firebase.js`）:
```js
import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore, serverTimestamp } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
})
export const auth = getAuth(app)
export const db = getFirestore(app)
export const storage = getStorage(app)
export const ts = serverTimestamp
```

## 11. 会社別データ分離

コレクション名は `rt_` / `rc_` プレフィックスを CompanyContext で解決し、クロスリードを禁止。

## 12. 権限制御の実装

ルート保護、UI 条件分岐、Firestore Rules でロール / 会社境界を強制。実装は `role` + `settings/permissions.roleAccess` 行列（階層構造ではない）。master > admin > staff の操作範囲は AuthContext の `hasAccess()` で判定。

## 13. PDF / Excel 生成

ReceiptPrintable を DOM 基盤に html2canvas → jsPDF。SheetJS で JSON → ws → xlsx エクスポート。

## 14. Functions / Storage

httpsCallable は asia-northeast1 明示。アップロードは company / role 単位のパス命名と公開 URL 生成。

## 15. 環境分離 / デプロイ

`.env.production` / `.env.test` と `firebase use production/test` でプロジェクト切替。hosting ターゲット分離、赤バナーでテスト明示。`npm run build:test` → `firebase deploy --only hosting`。

## 16. セキュリティ / パフォーマンス

Rules で `auth != null` 必須、role / company 一致、最小権限。インデックスで複合クエリ最適化、limit + cursor、onSnapshot は unsub 管理、コード分割でバンドル抑制。

## 17. テスト / トラブルシュート

> **現状**：テストコード（Vitest + RTL）未導入、Firestore Emulator 未設定。
> **Phase 3 で追加予定**。
>
> 典型トラブル：
> - `permission-denied` → Rules / 会社境界確認
> - リスナー未解放 → useEffect の return で unsub
