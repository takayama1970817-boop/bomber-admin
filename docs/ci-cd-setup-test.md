# CI/CD セットアップ手順（test 環境）

- **対象**: `.github/workflows/deploy-test.yml`
- **目的**: bomber-admin-test への自動デプロイを構築する
- **対象ブランチ**: develop / feature/phase2-stage1 / workflow_dispatch

## 0. 前提

- Firebase プロジェクト `bomber-admin-test` が存在する
- GitHub リポジトリ `takayama1970817-boop/bomber-admin` にワークフローを追加する権限
- Google Cloud Console と Firebase Console への admin アクセス

## 1. Service Account 作成

### 1.1 Google Cloud Console で作成

1. Google Cloud Console → プロジェクト選択 → **bomber-admin-test**
2. IAM と管理 → サービスアカウント → 「+ サービスアカウントを作成」
3. 名前: `github-actions-deployer`
4. 説明: `GitHub Actions からの自動デプロイ専用`
5. 作成

### 1.2 必要なロール付与

作成したサービスアカウントに以下のロールを付与:

| ロール | 用途 |
|---|---|
| Firebase Admin | Firebase プロジェクト全体の管理 |
| Cloud Functions Admin | Functions のデプロイ |
| Service Account User | Functions のランタイム権限切替 |
| Cloud Datastore User | Firestore rules デプロイ |
| Artifact Registry Writer | Functions のコンテナ push |

「IAM」画面でサービスアカウント選択 → 鉛筆アイコン → 上記ロールを追加。

### 1.3 JSON キー生成

1. 作成したサービスアカウントをクリック
2. 「キー」タブ → 「鍵を追加」→ 「新しい鍵を作成」
3. JSON 形式を選択 → 作成
4. ダウンロードされた JSON を **絶対に git に commit しない**
5. ローカルの安全な場所に保管（例: `~/.firebase-secrets/bomber-admin-test-deploy.json`）

## 2. GitHub Secrets 登録

### 2.1 Secret 登録

1. GitHub リポジトリ → Settings → Secrets and variables → Actions
2. 「New repository secret」
3. Name: `FIREBASE_SERVICE_ACCOUNT`
4. Value: ダウンロードした JSON の **中身全文**（改行含めてそのまま貼り付け）
5. 「Add secret」

### 2.2 追加 Secrets（将来の本番向け）

production 用ワークフローを追加する場合:

- `FIREBASE_SERVICE_ACCOUNT_PROD`（bomber-admin 用の別サービスアカウント）

test と本番は **必ず別の Service Account** を使うこと。

## 3. 動作確認

### 3.1 初回実行

1. GitHub リポジトリ → Actions タブ
2. 左メニューから「Deploy (test)」選択
3. 「Run workflow」→ develop ブランチ選択 → 実行
4. 各ステップが ✅ で完了するか確認

### 3.2 push トリガー確認

```bash
git checkout develop
# または
git checkout feature/phase2-stage1

# 適当な変更を push
git push origin develop
```

Actions タブで自動実行されることを確認。

## 4. Secrets 不足エラーへの対応

Functions のデプロイで Secret Manager エラー（TELNYX_FAX_FROM 等）が出る場合:

1. ローカルで事前に設定しておく:

```powershell
firebase functions:secrets:set TELNYX_FAX_FROM --project bomber-admin-test
# プロンプトで値入力（test 用ダミー可）
```

2. これらの Secrets は **プロジェクト単位で 1 度登録すれば良い**
   CI/CD 側で毎回設定する必要はない

3. 必要な Secrets の一覧:
   - `TELNYX_FAX_FROM`
   - `TELNYX_API_KEY`
   - `SENDGRID_API_KEY`（段階2 以降で使用）
   - `BCART_API_TOKEN`
   - 他、エラーメッセージで要求されたもの

## 5. production 環境切替時の手順

本番反映時は **別ワークフロー** を追加する運用とする:

1. `.github/workflows/deploy-prod.yml` を新規作成
2. トリガー: main ブランチ push + workflow_dispatch
3. `FIREBASE_SERVICE_ACCOUNT_PROD` を Secret に追加
4. project を `bomber-admin` に変更
5. 必要ならゲート（既存 deploy.yml の drill-log-gate 等）を継承

## 6. 既存 deploy.yml との関係

- **既存 `.github/workflows/deploy.yml`**: main → bomber-admin-prod（別スレ管轄の本番向け、バックアップ訓練ゲート付き）
- **新規 `deploy-test.yml`**: develop / feature/phase2-stage1 → bomber-admin-test（本線の test 向け）

両者はトリガーブランチが異なるため競合しない。

## 7. セキュリティ注意事項

- サービスアカウント JSON は **絶対に git に commit しない**
- GitHub Secrets は対応者のみがアクセス可能に制限
- サービスアカウントの権限は「必要最小限」を維持
- 定期的にキーをローテーションする（半年〜1年）
- 退任時のアクセス権剥奪を確実に行う

## 8. ロールバック

CI/CD が暴走した場合:

1. GitHub Actions タブで該当 Workflow を「Cancel workflow」
2. ワークフロー無効化: Actions タブ → 右上メニュー → 「Disable workflow」
3. `.github/workflows/deploy-test.yml` を削除する PR を作成

## 9. DryRun 検証ワークフロー（v1.1 追加）

本番書き込みを一切行わずに関数の挙動を確認するための検証ワークフロー:
`.github/workflows/dryrun-test.yml`

### 9.1 目的

- 社長が CLI を打たずに検証できる
- workflow_dispatch でボタン操作のみ
- dryRun 強制固定（ワークフロー側で本番書き込み不可）

### 9.2 使い方

1. GitHub リポジトリ → Actions タブ
2. 左メニュー「DryRun Verify (test)」
3. 「Run workflow」
4. 入力:
   - function_name: `createMonthlySettlement` or `detectDuplicates`
   - target_month: 省略可（省略時は前月）
5. 実行ボタン

### 9.3 結果の確認

- 実行完了後、該当 Run の「Summary」欄に JSON 形式で結果表示
- createMonthlySettlement: 対象代理店数 / 作成予定件数 / スキップ理由
- detectDuplicates: 走査件数 / 二重検知件数 / 各コレクション別内訳

### 9.4 安全保証

- Admin SDK による **読み取りのみ**（走査 + 存在確認）
- 本番 Function の createMonthlySettlement は呼ばない
- 結果的に kickbacks / invoices / settlementRunLogs への書き込みは **物理的に発生しない**
- dryRun=true は yml 内で固定（ユーザが書き換え不可）

### 9.5 関連ファイル

- `.github/workflows/dryrun-test.yml` - ワークフロー定義
- `scripts/ci-dryrun.mjs` - Admin SDK 経由の検証スクリプト

## 10. 変更履歴

| 日付 | 版 | 変更内容 |
|---|---|---|
| 2026-04-20 | v1 | 初版作成（feature/phase2-stage1 の test 自動デプロイ） |
| 2026-04-20 | v1.1 | DryRun 検証ワークフロー追加（workflow_dispatch 経由、CLI 不要） |
