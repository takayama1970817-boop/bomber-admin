# scripts/ops — 運用スクリプト群（Step 1）

bomber-admin の頻出運用操作を、**人の判断・許可ダイアログなし**で完走できる PowerShell スクリプト群。

## 🎯 最終原則（絶対ライン）

> **「人が判断する」のではなく、「仕組みが自動で止まる or 完走する」状態を正とする。**

この原則に反する実装は採用しない。

---

## 🚫 禁止事項（最終ロック）

この scripts/ops 配下のスクリプトは、以下を**理由に関わらず**行わない。

1. **AI が直接 CLI/API を実行する設計** — これらのスクリプトは社長 or CI が叩く
2. **スクリプトが他 .ps1 に依存する構造** — dot-source / Import-Module / 前提参照は全部 NG
3. **インタラクティブな入力（Read-Host / yes/no 確認）** — 人の応答待ちは全部 NG
4. **実行環境によって結果が変わる処理** — 現在時刻・ランダム値等で挙動が変わるのは NG
5. **成功/失敗が曖昧な実装** — 明示的に `exit 0` / `exit 1`
6. **エラー時に継続する処理** — `$ErrorActionPreference = 'Stop'` を守る

---

## 🧠 実装判断ルール（優先順位）

禁止事項に該当しない範囲で迷った時は、以下の順で決める。

1. AI が実行しない設計になっているか
2. スクリプト単体で完結しているか
3. インタラクティブ操作がないか
4. CI にそのまま移行できる構造か
5. 失敗時に安全に止まるか

---

## 🔒 単体完結ルール

**各 .ps1 は他の .ps1 に依存しない**。

- dot-source 禁止 / Import-Module 禁止 / 他 .ps1 呼び出しを前提にしない
- ログ関数等の共通処理は各ファイルにコピペで持つ（DRY より単体完結を優先）
- 理由：CI 化（GitHub Actions）で個別ジョブに切り出せるように

---

## 📋 スクリプト一覧

### `deploy-prod.ps1`

**用途**：本番（bomber-admin）へ firestore:rules + hosting を一括デプロイ

**引数**：なし（完全自動）

**動作**：
1. `firebase use` が production か確認
2. `firebase use production` に切替
3. `npm run build`
4. `firebase deploy --only firestore:rules`
5. `firebase deploy --only hosting`

**使用例**：
```powershell
.\scripts\ops\deploy-prod.ps1
```

**失敗条件**：
- firebase CLI が未インストール
- firebase use production が通らない（プロジェクト設定ミス）
- npm run build が失敗
- rules または hosting のデプロイが失敗（部分成功でも exit 1）

---

### `deploy-rules-only.ps1`

**用途**：firestore.rules のみ本番反映（hosting は触らない）

**引数**：なし

**動作**：
1. `firebase use` 確認 → production 切替
2. `firebase deploy --only firestore:rules --dry-run`（構文チェック）
3. 問題なければ本番 deploy

**使用例**：
```powershell
.\scripts\ops\deploy-rules-only.ps1
```

**いつ使う**：
- rules だけ変更した PR のマージ後
- hosting 側がまだデプロイ準備できていない時

---

### `merge-pr.ps1`

**用途**：指定 PR 番号を squash merge + ブランチ削除

**引数**：
- `-PrNumber <int>` **必須**

**動作**：
1. `gh auth status` 確認
2. PR の状態（state / mergeable）を確認
3. `mergeable == MERGEABLE` なら `gh pr merge --squash --delete-branch`

**使用例**：
```powershell
.\scripts\ops\merge-pr.ps1 -PrNumber 24
```

**失敗条件**：
- gh CLI が未認証
- PR が OPEN でない（既にクローズ/マージ済み）
- PR が `mergeable != MERGEABLE`（衝突・CI 赤・レビュー未承認 等）

---

### `sync-square.ps1`

**用途**：Square Bookings 同期を dry-run または production モードで実行

**引数**：
- `-Mode dry-run|production` **必須**
- `-Operator <string>` 任意（既定: "unknown"、監査ログに残す）

**動作**：
1. `.env.local` と `scripts/sync-square-bookings.mjs` の存在確認
2. `$env:DRY_RUN` / `$env:OPERATOR` をセット
3. `node scripts/sync-square-bookings.mjs` 起動
4. 終了コードを伝搬

**使用例**：
```powershell
# dry-run（書き込みなし、まずこれで件数確認）
.\scripts\ops\sync-square.ps1 -Mode dry-run

# 本番同期（監査ログに OPERATOR が残る）
.\scripts\ops\sync-square.ps1 -Mode production -Operator "社長 ボンバー"
```

**失敗条件**：
- `.env.local` が存在しない
- `sync-square-bookings.mjs` が存在しない
- Square API 呼び出しが失敗（31日制限違反など）
- `SCRIPT_VERSION v2` で 31日超過 env 指定 → 事前停止

---

### `check-env.ps1`

**用途**：現在の実行環境を読み取り専用で一覧表示（診断用）

**引数**：なし

**動作**（すべて読み取り、副作用なし、exit 0 固定）：
1. `firebase use`
2. `git status --short`
3. `git log -1 --oneline`
4. `git branch --show-current`
5. `.env.local` の存在とキー名（値は表示しない）
6. `node --version` / `npm --version`

**使用例**：
```powershell
.\scripts\ops\check-env.ps1
```

**いつ使う**：
- デプロイ前の確認（「今どのプロジェクトにいる？」）
- .env.local の設定漏れ確認
- trouble-shooting の最初の1歩

---

## 前提条件

### ローカル環境

- Windows 11
- PowerShell（RemoteSigned 実行ポリシー）
- Node.js v20+（`node --version` / `npm --version` で確認）
- Firebase CLI（`firebase --version`）
- GitHub CLI（`gh --version`）
- git（`git --version`）

### 認証

- **Firebase**：`firebase login` で OAuth 済み、かつ `bomber-admin` プロジェクトへのアクセス権
- **GitHub**：`gh auth login` で認証済み、`takayama1970817-boop/bomber-admin` への write 権限

### ファイル

- `.env.local`（`.env.local.example` をコピーして値入れ）
- `scripts/service-account.json`（Admin SDK 用。一部スクリプトでのみ使用）

---

## 初回セットアップ手順

```powershell
# 1. PowerShell 実行ポリシー確認（初回のみ）
Get-ExecutionPolicy
# RemoteSigned が推奨。違っていれば管理者 PowerShell で:
# Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# 2. 環境診断
.\scripts\ops\check-env.ps1

# 3. .env.local の準備（なければ）
# .env.local.example をコピーして SQUARE_* などを入れる

# 4. 軽い動作確認（書き込みなし）
.\scripts\ops\sync-square.ps1 -Mode dry-run
```

---

## 失敗時の一般的な対処

| 症状 | 対処 |
|---|---|
| `firebase CLI が見つかりません` | `npm install -g firebase-tools` |
| `gh CLI が未認証` | `gh auth login` |
| `.env.local が見つかりません` | `.env.local.example` をコピー |
| `firebase use production に失敗` | `.firebaserc` に production エイリアスがあるか確認 |
| `mergeable != MERGEABLE` | GitHub で衝突解消 / CI緑化 / レビュー承認 |
| `node が見つかりません` | Node.js v20+ をインストール |

---

## AI は本スクリプト群を直接叩かない

**このスクリプトは社長 or CI が叩く**。AI（Claude 等）が `firebase deploy` や `gh pr merge` を直接実行する運用は、方針転換により禁止された。

AI の役割：
- 仕様書作成
- コード生成（feature ブランチ）
- PR 作成

AI がやらない：
- `firebase deploy` の直接実行
- `gh pr merge` の直接実行
- 本番に影響する CLI コマンド全般

---

## Step 2 以降（予定）

- Step 2: GitHub Actions による自動デプロイ（main merge → rules + hosting）
- Step 3: cron スケジュール同期（定期 Square 同期）
- Step 4: memory 更新（AI の新ガードレール明文化）

それぞれ、ここで作った PowerShell スクリプトの内容を CI ワークフロー（YAML）にコピペで移行できる構造にしてある。
