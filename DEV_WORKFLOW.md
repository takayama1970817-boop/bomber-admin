# 開発フロー（DEV_WORKFLOW）

このリポジトリの **共通運用ルール**。
今後の実装・PR・レビュー・デプロイ・自動化の判断は、原則このルールに従う。
例外が必要な場合は勝手に判断せず、社長または ChatGPT の設計判断を確認する。

---

## 1. 目的

- 開発速度を落とさない
- PR の責任範囲を明確にする
- 本番反映を安全にする
- AI 利用時の事故を減らす
- 手動作業を減らしつつ、危険な操作は自動化しすぎない

---

## 2. 役割分担

| 役割 | 担当 | 範囲 |
|---|---|---|
| 実装担当 | **Claude** | コード変更・PR 作成・指示された範囲内での最小差分実装 |
| 設計・レビュー担当 | **ChatGPT** | 設計判断・方針固定・レビュー・リスク判断・マージ判断・Claude への完成指示文作成 |
| 最終決裁者 | **社長** | GitHub UI での手動マージ・Secret 管理・必要最小限の手動実行 |

Claude と ChatGPT は **本番操作を直接叩かない**。本番反映は GitHub Actions 自動化または社長の手元スクリプト実行のみ。

---

## 3. 基本原則

### 原則1: 1 PR = 1 目的

1 つの PR には 1 つの目的だけを含める。関係ない変更を混ぜない。
意図しない変更混入が発覚した場合は、PR をクリーン化する（後述「14. 緊急時ルール」参照）。

### 原則2: 最小差分

実装は常に最小差分を優先する。必要以上のリファクタや「ついで修正」は禁止。
「直せるから直す」ではなく「今回必要だから直す」で判断する。

### 原則3: スコープ固定

実装前に、目的・スコープ・スコープ外を明示する。Claude はその範囲を勝手に広げない。

### 原則4: 変更しない判断を許可する

見た目・レビュー・チェック系タスクでは、問題がなければ **変更なしで終了してよい**。
不要な差分を作るための変更は禁止。

---

## 4. ブランチ運用

- **作業開始前に最新取得**
  ```
  git checkout main
  git pull origin main
  ```

- **原則 feature branch で作業**
  - 命名例: `feature/<目的>` / `fix/<目的>` / `hotfix/<目的>`
  - 例: `feature/dev-workflow-doc`, `fix/square-sync-31day-limit`

- **main へ直接 push しない**
  - `git push origin main` は原則禁止
  - 反映は PR 経由のみ

- **ブランチ切替前に uncommitted changes を確認**
  ```
  git status --short
  ```
  未コミットの変更があれば、退避（stash / backup branch）を先に行う

---

## 5. PR 運用

### 5-1. PR 作成前

- 変更対象を明確化する
- 既存の未コミット変更が混ざっていないか `git status --short` で確認
- 混入の恐れがある場合は stash / backup branch / fresh branch を使う

### 5-2. PR 本文に含める項目

最低限：

- **目的**（何を達成する PR か）
- **変更内容**（追加・変更・削除ファイル）
- **変更しないもの**（スコープ外の明示）
- **権限制御への影響**（UI / assertCan / firestore.rules のどれに触れるか）
- **リスク**（懸念点・副作用の可能性）
- **動作確認**（実施したテスト内容）
- **デプロイ要否**（rules / hosting / その他 / 不要 のどれか）

### 5-3. マージ前

- ChatGPT の AI PR Review を通す
- リスク評価を確認する
- マージ判断を明確にする
- AI レビュー対象 SHA と実変更内容が一致していることを確認する

### 5-4. マージは人間が行う

- **GitHub UI で社長（または権限者）が手動マージ**
- Claude / ChatGPT は `gh pr merge` を直接叩かない
- 緊急時のみ `scripts/ops/merge-pr.ps1` を社長手元で実行（後述）

---

## 6. コミット

### 6-1. 作業完了時の流れ

```
git add <変更ファイル>       # 1 ファイルずつ明示的に、または変更フォルダ単位で
git status --short            # 想定外ファイルが staged に入っていないか確認
git commit -m "<日本語で内容が分かるメッセージ>"
git push -u origin <ブランチ名>
```

`git add .` / `git add -A` は **意図しない変更が混ざる事故の元**。極力避けて、パス指定で add する。

### 6-2. コミットメッセージ

- 内容が一目で分かる日本語で書く
- 動詞始まりが読みやすい
  - 例: `来店登録 UI を追加`
  - 例: `orders.read の dealer スコープを strict 化`
  - 例: `fix: Square同期の取得期間を31日制限に準拠`
- prefix の併用は任意（`fix:` / `feat:` など）
- 「更新」「修正」だけの曖昧メッセージは避ける

### 6-3. pull 前の uncommitted changes 確認

pull を実行する前に必ず `git status --short` で未コミット変更を確認する。
未コミットの変更が残ったまま pull すると、merge conflict の原因や混入事故につながる。

---

## 7. コンフリクト時の対応

### 7-1. 勝手に破壊的解決をしない

- `git reset --hard` / `git push --force` / `git clean -fd` を安易に叩かない
- 破壊的操作が必要な場面では `git push --force-with-lease`（他人の変更を上書きしない安全版）を選ぶ

### 7-2. コンフリクト検出時

1. 現状を保全：`git branch backup/before-conflict-<日付>` で退避
2. 両方の変更を読む：`git diff` / `git log` で差分の意味を理解
3. 解消方針を決める（必要なら社長 / ChatGPT に相談）
4. 解消後に動作確認してから commit

### 7-3. PR に混入変更が見つかった場合の優先順

1. backup branch で保全（local + remote 両方）
2. `origin/main` を基準に PR ブランチをクリーン化
3. 必要な変更だけを再コミット
4. `git push --force-with-lease` で上書き

参考コマンド例：
```
git branch backup/pr<番号>-mixed-changes-<日付> HEAD
git push -u origin backup/pr<番号>-mixed-changes-<日付>
git reset --hard origin/main
git checkout backup/pr<番号>-mixed-changes-<日付> -- <必要なファイル>
git commit -m "<クリーンなメッセージ>"
git push --force-with-lease origin <ブランチ名>
```

---

## 8. デプロイ・本番反映

### 8-1. 原則

- 本番反映は `main` 基準
- `main` にマージされたものだけを本番候補とする
- デプロイは原則 GitHub Actions 自動化へ寄せる

### 8-2. 自動化対象

GitHub Actions で自動化してよいもの：

- Hosting デプロイ
- Firestore Rules デプロイ

### 8-3. 自動化しないもの（手動運用）

以下は自動化せず、社長の手元スクリプト（`scripts/ops/*.ps1`）または明示的な手動操作で実行：

- backfill 実行
- データ修正スクリプト
- 同期スクリプトの本番実行（Square 同期など）
- Functions デプロイ（当面）
- Storage Rules デプロイ（当面）
- Secret 設定
- `.env.local` 設定

### 8-4. 本番データを触る処理の必須条件

- dry-run モードが既定
- 再実行安全（冪等性）
- 監査ログ保存（Firestore `<xxx>Logs` コレクション等）
- OPERATOR 明示（記録者名）
- 失敗時の追跡可能性（`failedEntries` を必ず残す）

### 8-5. 運用スクリプト

社長が手元で実行する固定スクリプトは `scripts/ops/` 配下に集約：

- `deploy-prod.ps1` — 本番 rules + hosting デプロイ
- `deploy-rules-only.ps1` — rules のみデプロイ
- `merge-pr.ps1` — PR 番号指定で squash merge
- `sync-square.ps1` — Square 同期 dry-run / production
- `check-env.ps1` — 環境診断（読み取り専用）

各スクリプトは **単体完結・対話なし・エラー時即停止** を守る。詳細は [scripts/ops/README.md](scripts/ops/README.md) を参照。

---

## 9. Secret / 認証情報の扱い

### 9-1. repo に置かないもの

以下はリポジトリに commit しない：

- `.env.local`
- Access Token / API Key
- Service Account JSON
- パスワード類

### 9-2. 管理者のみが扱うもの

- GitHub Secrets
- Firebase service account
- 外部サービスの認証情報（Square Access Token 等）

### 9-3. AI にやらせないこと

- Secret 値の取得・表示
- `.env.local` の中身探索
- token / password / key の grep

AI はキー名の存在確認までに留める（`check-env.ps1` が示すレベル）。

---

## 10. 権限設計の三重防御

新機能で書き込みがある場合は、必ず以下 3 層で整合を取る：

1. **UI 非表示**（ボタン・メニューを出さない）
2. **assertCan / 保存前ガード**（`src/lib/permissions.js` で判定）
3. **firestore.rules**（最終防衛線）

新機能追加時は以下を明文化：

- 誰が見えるか
- 誰が操作できるか
- 誰が削除できるか
- UI と rules が一致しているか

詳細は `src/lib/permissions.js` の冒頭コメントを参照。

---

## 11. バッチ / 同期 / バックフィルの原則

必須条件：

- dry-run が既定
- production は明示フラグ必須（`DRY_RUN=false` 等）
- 再実行安全
- 監査ログ保存
- `failedEntries` を残す
- 不正データを握りつぶさない（可能な限り継続処理）
- `scriptVersion` を残す

監査対象バッチは Firestore 上で追跡できること：

- `operator`
- `runAt`
- `mode`（dry-run / production）
- `results`（total / updated / failed 等）
- `failedEntries`

---

## 12. 公開前チェック

公開前チェックでは以下を確認：

- スマホ表示で CTA が重くないか
- 余白崩れがないか
- CTA 文言が統一されているか
- ボタン優先度が一貫しているか
- ファーストビューが縦長すぎないか

問題がなければ **変更なしでクローズしてよい**。無理に差分を作らない。

---

## 13. 外部連携の原則

- 外部 SaaS は「入口」として使ってよい
- 業務の中核データモデルは自社側で保持する
- `reservations` のような自社コレクションに `source` を持たせる
- 将来自前運用へ寄せられる構造を優先する
- 現場にはコンソール操作・API 設定・Secret 管理をさせない

---

## 14. 緊急時ルール

### 14-1. PR に混入変更が見つかった

- そのまま進めない
- backup branch を切る（local + remote）
- `origin/main` 基準でクリーン化
- 必要な変更だけ再コミット → `force-with-lease` で PR を上書き

### 14-2. 本番同期 / バッチで問題が出た

- まず dry-run 結果を確認
- 監査ログを見る
- `failedEntries` を確認
- データ修正は別タスクとして切り出す
- その場でスコープ拡張しない

### 14-3. 外部 API が想定と違った

- その場で無理に対応を広げない
- Step 0 調査に戻る（スコープと仕様の再確認）
- 設計確定後に再開する

### 14-4. 障害時は現状保全優先

- 破壊的操作より先に `git branch backup/...` で現状を保存
- ログ・監査ログ・エラー出力を保全してから対処
- 影響範囲を把握してから復旧

---

## 15. 標準フロー

### 15-1. 新機能追加

1. 社長がテーマを提示
2. ChatGPT が設計判断 + Claude 用完成指示文作成
3. Claude が feature branch で実装 + PR 作成
4. ChatGPT が AI PR Review 実施 + マージ判断
5. 社長が GitHub UI で手動マージ
6. 自動デプロイ（Hosting / rules）または必要最小限の手動作業

### 15-2. 修正

1. 問題確認
2. 最小差分で修正方針固定
3. Claude 実装
4. ChatGPT レビュー
5. 社長マージ

### 15-3. データ系処理

1. Step 0 調査（コード変更なし）
2. dry-run 実行
3. 結果確認（`failedEntries` まで見る）
4. production 実行（明示フラグ + OPERATOR 指定）
5. 監査ログ確認
6. 必要なら strict 化や後続 PR

---

## 16. AI（Claude / ChatGPT）への期待

- 実装責任の範囲を守る
- スコープ外を広げない
- 危険な操作を勝手に進めない
- 変更混入を防ぐ
- 報告形式を揃える
- 「安全に進める」ことを優先する
- 複合コマンド（`cd && ... && ...`）の提示は避ける、1 コマンドずつ出す
- Secret 値を読みに行かない

---

## 17. 参照ドキュメント

- [README.md](README.md) — セットアップ手順・本番デプロイ自動化
- [scripts/ops/README.md](scripts/ops/README.md) — 運用スクリプト群の仕様
- [docs/ai-pr-review.md](docs/ai-pr-review.md) — AI PR Review の仕組み

---

この文書はプロジェクトの **共通運用ルール**。
例外が必要なときは勝手に判断せず、社長または ChatGPT に確認すること。
