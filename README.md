# bomber-admin

ボンバー社 社内スタッフ向けWebアプリ（取引先サロン管理 + 勤怠管理）

## セットアップ手順（初回のみ）

### 1. Node.js をインストール

まだ入っていないので以下のどちらかで導入：

**方法A: 公式インストーラ（推奨・迷ったらこっち）**
1. https://nodejs.org/ja にアクセス
2. 「LTS」版（左側の緑ボタン）をダウンロード
3. インストーラを実行 → 全部「Next」でOK
4. インストール後、PowerShell または コマンドプロンプトを**開き直して** `node -v` でバージョンが出ればOK

**方法B: winget（PowerShell を管理者で開いて）**
```powershell
winget install OpenJS.NodeJS.LTS
```

### 2. 依存関係のインストール

PowerShell または コマンドプロンプトで：

```bash
cd "C:\Users\takay\OneDrive\Desktop\bomber-admin"
npm install
```

（初回は数分かかります）

### 3. Firebase プロジェクトを作る

1. https://console.firebase.google.com にアクセス（Googleログイン）
2. 「プロジェクトを追加」→ 名前は `bomber-admin` など
3. 左メニュー「ビルド」→「Authentication」→「始める」→「Google」を有効化
4. 左メニュー「ビルド」→「Firestore Database」→「データベースを作成」
   - ロケーション: `asia-northeast1`（東京）
   - 最初は「テストモード」でOK（あとで本番ルールに差し替え）
5. 左メニュー ⚙️ →「プロジェクトの設定」→「全般」タブを下にスクロール
6. 「マイアプリ」で `</>` （ウェブ）アイコンをクリック
7. アプリ名を入れて登録 → 表示された設定値をコピー

### 4. 環境変数を設定

`.env.local.example` を **コピーして** `.env.local` という名前にして、
Firebase Console からコピーした値を貼り付けます：

```
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=bomber-admin.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=bomber-admin
VITE_FIREBASE_STORAGE_BUCKET=bomber-admin.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abc...
```

⚠️ `.env.local` は `.gitignore` 済み。絶対にコミットしないでください。

### 5. 開発サーバー起動

```bash
npm run dev
```

→ http://localhost:5173 が開けば成功

### 6. 最初の社長アカウント設定

初回ログインすると自動で `users/{uid}` ドキュメントが `role: "staff"` で作られます。
**社長（あなた）の役割を admin に変更**するには：

1. Firebase Console → Firestore Database
2. `users` コレクション → 自分の UID のドキュメントを開く
3. `role` フィールドを `"admin"` に書き換え → 保存
4. アプリをリロード → 左メニューに「スタッフ管理」が出れば成功

---

## ディレクトリ構成

```
bomber-admin/
├── CLAUDE.md            # 仕様書（Claude Code用）
├── README.md            # このファイル
├── package.json
├── vite.config.js
├── index.html
├── .env.local.example   # ← コピーして .env.local を作る
├── .gitignore
└── src/
    ├── main.jsx
    ├── App.jsx          # ルーティング
    ├── index.css        # Tailwind
    ├── lib/
    │   └── firebase.js  # Firebase 初期化
    ├── contexts/
    │   └── AuthContext.jsx  # 認証状態 + role
    ├── components/
    │   ├── ProtectedRoute.jsx
    │   └── Layout.jsx   # サイドバー付きレイアウト
    └── pages/
        ├── Login.jsx
        ├── Dashboard.jsx
        ├── Salons.jsx
        ├── SalonDetail.jsx
        ├── Attendance.jsx
        ├── AttendanceHistory.jsx
        └── AdminUsers.jsx
```

## 使っているもの

- React 18 + Vite 5
- Firebase v11（Auth + Firestore）
- React Router v6
- Tailwind CSS v4

## 開発支援

- AI 自動 PR レビュー → [docs/ai-pr-review.md](docs/ai-pr-review.md)
