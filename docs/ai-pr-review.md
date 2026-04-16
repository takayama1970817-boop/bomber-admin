# AI PR Review

GitHub Pull Request の差分を OpenAI に投げて、自動でレビューコメントを PR に投稿する仕組みです。

## 仕組みの概要

```
PR open / push
   │
   ▼
GitHub Actions ( .github/workflows/ai-pr-review.yml )
   │  1. base ブランチをチェックアウト（信頼できるスクリプト）
   │  2. base..head の diff だけ取得（pr.diff）
   │  3. .github/scripts/ai_pr_review.py を実行
   ▼
OpenAI Responses API
   │  Structured Outputs (JSON Schema) でレビュー結果を受け取る
   │  store=False（OpenAI 側に保存しない）
   ▼
GitHub PR に Markdown コメントとして投稿
   ・既存の AI レビューコメントがあれば PATCH で上書き
   ・無ければ新規 POST
   ▼
Artifact 保存（14日）
   ・ai_review_result.json
   ・ai_review_comment.md
   ・pr.diff
```

---

## 必要な GitHub Secrets

リポジトリの **Settings → Secrets and variables → Actions → Secrets** に登録します。

| Secret 名         | 必須 | 用途                        |
| ----------------- | ---- | --------------------------- |
| `OPENAI_API_KEY`  | ✅   | OpenAI Responses API 呼び出し |
| `GITHUB_TOKEN`    | 自動 | GitHub Actions が自動付与（手動登録不要） |

> `GITHUB_TOKEN` はワークフローで自動的に発行されるため、登録不要です。

### 任意で設定できる環境変数

**Settings → Secrets and variables → Actions → Variables** に登録します（Secrets ではなく Variables）。

| Variable 名     | デフォルト       | 用途                                       |
| --------------- | ---------------- | ------------------------------------------ |
| `OPENAI_MODEL`  | `gpt-4.1-mini`   | 使用するモデル ID。差し替えで品質/コスト調整 |

---

## 動作フロー（詳細）

1. **トリガー**: `pull_request` の `opened` / `synchronize` / `reopened` / `ready_for_review`。Draft PR ではスキップ。
2. **チェックアウト**: PR の **base ブランチ** をチェックアウト。PR 側のコードはチェックアウトしない。
3. **差分生成**: `git fetch` で base/head の SHA を取り込み、`git diff base..head` を生成。
   - `package-lock.json` / `dist/` / `node_modules/` / バイナリ（画像・PDF）/ `.env*` / Firebase service-account JSON は除外。
   - 差分が **120,000 文字** を超えたら先頭だけ残してトリム。
4. **OpenAI 呼び出し**: Responses API + Structured Outputs（JSON Schema 厳格モード, `store=False`）で以下の構造を強制取得。
   ```json
   {
     "summary": "...",
     "overall_risk": "low | medium | high",
     "findings": [
       {
         "severity": "blocker | major | minor",
         "file": "src/...",
         "line": 123,
         "title": "...",
         "reason": "...",
         "suggestion": "..."
       }
     ]
   }
   ```
5. **コメント投稿**: Markdown に整形して PR にコメント。既存 AI レビューコメント（HTML コメントタグ `<!-- ai-pr-review:auto -->` で識別）があれば PATCH で上書き。
6. **Artifact 保存**: `ai_review_result.json` / `ai_review_comment.md` / `pr.diff` を 14 日間保存。

### コメントの構成

```
## AIレビュー結果
**対象**: PR #N (`abc1234`) / モデル: `gpt-4.1-mini`

### 総評
（PR 全体の3〜6文サマリー）

### リスク
- 総合リスク: 🟢 Low / 🟡 Medium / 🔴 High
- 指摘件数: N 件

### 指摘一覧
（重要度順。指摘がなければ「重大な指摘は見当たりませんでした」）
```

### レビュー方針（OpenAI への指示）

優先度順に以下の観点で見ています：

1. Correctness / bug risk
2. Security
3. Data loss / destructive behavior
4. Reliability / error handling
5. Performance issues likely to matter
6. Maintainability and test gaps

スタイルや命名の好みは指摘しません。**実害重視・少数精鋭・高シグナル**を方針にしています。

---

## 注意点

### セキュリティ

- ❌ `pull_request_target` は使っていません。**PR コードを実行しない方針**です。
- ✅ ワークフローは PR の **base SHA** （`github.event.pull_request.base.sha` 固定）からスクリプトを取得します。`Show checked out ref` ステップで実際の SHA とスクリプトの sha256 を毎回ログに出力し、base 側で動いている証跡を残します。これにより、悪意ある PR が `ai_pr_review.py` を改変して `OPENAI_API_KEY` を抜き取る攻撃を防いでいます。
- ✅ チェックアウトは `persist-credentials: false` で行い、Git 認証情報を後続ステップに残しません。
- ✅ diff の生成時に `.env*` / `service-account*.json` / Firebase Admin SDK 鍵ファイルを除外しています（ファイル名フィルタ）。
- ✅ さらに Python 側で **diff 本文のパターンマスク**（PEM 秘密鍵 / `AIza...` / `sk-...` / `ghp_...` / `xox[abprs]-...` / `AKIA...` / JWT / AWS Secret Access Key）を OpenAI 送信前にかけています。検知件数のみログに残し、内容は出しません。
- ✅ OpenAI には `store=False` を渡しており、リクエスト/レスポンスはサーバ側に保存されません。
- ✅ 秘密情報はログに出しません。GitHub Actions のマスキングに加えて、エラー時のレスポンス本文は先頭 500 文字に切っています。

#### フォーク PR の挙動（重要）

- フォーク元（外部コントリビューター）からの PR では、GitHub の既定で **`secrets.OPENAI_API_KEY` がジョブに渡されません**。これは GitHub Actions の標準的なセキュリティ動作です。
- 本ワークフローはこのケースを Python スクリプト側で検知し、AI 呼び出しをスキップした結果（findings 空 + skip 理由のサマリー）を生成して、**通常実行と同じ upsert 経路** で 1 つの PR コメントを上書きします。これにより重複コメントは構造的に発生しません（同じ HTML マーカー `<!-- ai-pr-review:auto -->` の既存コメントを PATCH で更新）。
- フォーク PR でも AI レビューを動かしたい場合は、**Settings → Actions → General → Fork pull request workflows from outside collaborators** の設定を変更する必要があります。ただし秘密情報を未信頼コントリビューターのコードに晒す扱いになるため、リスクを理解した上で行ってください（基本は変更しない方を推奨）。
- フォーク PR では `GITHUB_TOKEN` も読み取り中心の権限に絞られ、PR コメントの POST/PATCH が 401/403 で拒否されることがあります。その場合 Python 側で警告ログを出し、ジョブは success のまま終了させます（`ai_review_result.json` / `ai_review_comment.md` は Artifact から確認可能）。

### 運用上の注意

- **コスト**: 大きな PR では入力トークンが増えます。`OPENAI_MODEL` を `gpt-4.1-mini` 等の安価モデルにしておくのが基本。重要 PR だけ手動で上位モデルに切り替える運用も可能。
- **誤検知**: AI のレビューには誤検知がつきものです。最終判断は必ず人間レビュアーが行ってください。
- **巨大 PR**: 120,000 文字を超える diff は **先頭 90,000 文字 + 末尾 30,000 文字** のハイブリッドで保持し、中央のみ落とします。それでも超大型 PR では精度が落ちるので、論理的に分割した PR にするのが望ましいです。
- **プライベートコード**: Responses API にコードが送信されます。社外秘リポジトリでこの仕組みを使う場合は、社内ポリシーを確認してから有効化してください。
- **Draft PR**: Draft の間はワークフローが走りません。Ready for review にしたタイミングで初回レビューが走ります。

---

## 動作確認手順（初心者向け・詳細版）

GitHub の Web 画面だけで完結します。コマンド操作は不要です。
「✅ 確認できればOK」のところまで進めれば、動作確認は完了です。

### Step 0: 前提

このリポジトリ（`bomber-admin`）が GitHub にプッシュ済みで、`.github/workflows/ai-pr-review.yml` を含んでいることが前提です。
プッシュがまだの場合は先にプッシュしてください。

---

### Step 1: OpenAI API キーを用意する

1. ブラウザで https://platform.openai.com/api-keys を開く
2. OpenAI アカウントでログイン（未登録なら **Sign up** → メールアドレスで登録）
3. 右上の **+ Create new secret key** をクリック
4. 名前欄に `bomber-admin-pr-review` などと入力 → **Create secret key**
5. `sk-...` で始まる文字列が表示されるので、**この場でコピーしてメモ帳に貼っておく**
   - ⚠️ この画面を閉じると二度と表示されません。閉じる前に必ずコピー。
6. 必要なら **Settings → Billing** で支払い方法を登録（無料枠を使い切ると 401 エラーになります）

---

### Step 2: GitHub に API キーを登録する

1. ブラウザで https://github.com/takayama1970817-boop/bomber-admin を開く
2. 上部メニューの **Settings**（歯車アイコン、右端に近い）をクリック
3. 左サイドバーの **Secrets and variables** → **Actions** をクリック
4. 緑色の **New repository secret** ボタンをクリック
5. 入力欄に以下を入れる：
   - **Name**: `OPENAI_API_KEY`（一字一句このまま、大文字小文字も同じ）
   - **Secret**: Step 1 でコピーした `sk-...` をそのまま貼り付け
6. **Add secret** をクリック
7. ✅ `Repository secrets` の一覧に `OPENAI_API_KEY` が表示されていれば登録完了

> 登録後は値を見ることはできません（更新しか不可）。これは正常です。

---

### Step 3: テスト用の Pull Request を作る

最小の変更で動作確認します。`README.md` に 1 行足すだけです。

1. https://github.com/takayama1970817-boop/bomber-admin を開く
2. ファイル一覧から **`README.md`** をクリック
3. 右上の **鉛筆アイコン**（Edit this file）をクリック
4. 一番下に空行を 1 つ追加して、適当に1行書く（例: `<!-- AI レビュー動作確認用 -->`）
5. 右上の **Commit changes...** ボタンをクリック
6. ダイアログで以下を選択：
   - **Commit message**: そのままでOK（例: `Update README.md`）
   - **Create a new branch for this commit and start a pull request.** にチェック
   - ブランチ名は `test/ai-review` などにする
7. **Propose changes** をクリック
8. PR 作成画面が開くので、そのまま **Create pull request** をクリック
9. ✅ PR が作成され、PR ページに飛んだら成功

---

### Step 4: ワークフローが走っていることを確認する

PR ページで少し下にスクロールすると、自動チェックの状況が表示されます。

1. **Some checks haven't completed yet** という表示の中に **`ai-review / AI PR Review`** が見えるはず
2. 黄色の丸（実行中）→ 緑のチェック（成功）に変わるまで待つ（通常 1〜2 分）
3. もし途中で見たい場合は、PR ページ上部の **Checks** タブをクリック → 左の **AI PR Review** をクリック
4. ✅ 緑のチェックマークがついたら成功

#### うまくいかないとき

- **赤い × が出る**：左の **AI PR Review** をクリックして、赤くなったステップを開くとエラーログが見えます。よくある原因：
  - `OPENAI_API_KEY` のスペル間違い → Step 2 を見直す
  - OpenAI の支払い方法未登録 → ログに `401 Unauthorized` や `insufficient_quota` が出ていれば、OpenAI の Billing を確認
  - `OPENAI_MODEL` を変えていてモデル名が間違っている → 既定 `gpt-4.1-mini` に戻す
- **そもそもチェックが出てこない**：
  - PR が **Draft** になっていないか確認（Draft はスキップされます。**Ready for review** に切り替える）
  - Repository **Settings → Actions → General** で Actions が有効になっているか確認

---

### Step 5: AI レビューコメントが PR に投稿されているか確認する

1. PR ページの **Conversation** タブを開く
2. 少し待つと、コメント欄に `## AIレビュー結果` という見出しのコメントが表示される
3. ✅ 以下が含まれていれば成功：
   - 「総評」セクション（PR 全体の要約）
   - 「リスク」セクション（🟢 Low など）
   - 「指摘一覧」セクション（重大な指摘がなければ「重大な指摘は見当たりませんでした」）

#### うまくいかないとき

- **コメントが出ない**：
  - Step 4 のチェックは成功しているのに出ない場合、Actions ログの `Run AI review` ステップを開いて、最後に `AI PR review completed.` が出ているか確認
  - GitHub Token の権限不足の可能性 → Repository **Settings → Actions → General** の一番下「**Workflow permissions**」が **Read and write permissions** になっているか確認

---

### Step 6: 2 回目の push でコメントが「上書き」されることを確認する

重複コメントが出ないことの確認です。

1. 同じ PR を開いた状態で、上部の **Files changed** タブをクリック
2. `README.md` の右上の **...（三点メニュー）** → **Edit file**
3. もう 1 行適当に追加（例: `<!-- 2回目テスト -->`）
4. 右上の **Commit changes...** → **Commit directly to the `test/ai-review` branch** を選択 → **Commit changes**
5. **Conversation** タブに戻る
6. 数分待つ
7. ✅ 確認ポイント：
   - 古い AI レビューコメントが**上書き更新**されている（`edited` の表記がつく）
   - **新しい AI レビューコメントが追加されていない**（コメントが2つに増えていない）

---

### Step 7: Artifact（成果物）をダウンロードして中身を見る（任意）

ワークフローが生成した JSON / Markdown / diff を確認できます。

1. PR ページ上部の **Checks** タブをクリック
2. 左の **AI PR Review** をクリック
3. 右上の **Artifacts** セクションに `ai-pr-review-1` のようなリンクがある
4. クリックして ZIP をダウンロード → 解凍
5. 中に以下のファイルがあるはず：
   - `ai_review_result.json`：AI から返ってきた JSON 結果（プログラム可読）
   - `ai_review_comment.md`：PR に投稿された Markdown 本文と同じ
   - `pr.diff`：レビュー対象として送られた差分

---

### Step 8: テスト PR を片付ける

1. PR ページ上部の **Close pull request** ボタンをクリック（マージしない）
2. もしくは、コメントを残したい場合はそのままで OK
3. ブランチを消すには PR 下部の **Delete branch** ボタン

---

### 動作確認チェックリスト

- [ ] Step 1: OpenAI API キーを発行した
- [ ] Step 2: GitHub Secrets に `OPENAI_API_KEY` を登録した
- [ ] Step 3: テスト PR を作った
- [ ] Step 4: Actions の `AI PR Review` が緑になった
- [ ] Step 5: PR に `## AIレビュー結果` コメントが投稿された
- [ ] Step 6: 2 回目 push でコメントが上書き更新された（重複なし）
- [ ] Step 7: Artifact から JSON / Markdown / diff を確認できた

すべてチェックが付けば、AI PR レビューは正常に動いています 🎉

---

## 今後の改善案

### 軽微改善候補（次回着手）

- **GitHub job summary にレビュー要約を出力**: `$GITHUB_STEP_SUMMARY` に `ai_review_comment.md` の内容（または短縮版）を書き出す。Actions の Run 詳細画面で PR コメントを開かなくても結果が見られるようになる。実装は Python 側で `os.environ.get("GITHUB_STEP_SUMMARY")` のパスに append するだけ。
- **redact 対象パターンのユニットテスト追加**: `tests/test_redact.py` を新設。既知の秘密情報サンプル（PEM/AIza/sk-/ghp_/xox*/AKIA/JWT/AWS Secret Access Key）と「秘密ではない近似文字列」（例: `AIzaaa` のような短い AIza、コメント中の `xoxb-` の説明文等）の境界ケースを網羅。CI では別ジョブで `pytest .github/scripts/tests/` を回す。
- **大規模 PR の分割レビュー**: 現在は先頭 90,000 + 末尾 30,000 のハイブリッドトリム。ファイル単位 / ハンク単位に分割して並列リクエスト → 結果をマージする実装にすると、超大型 PR でも全体像を捉えたレビューが可能。実装ポイントは、(1) `git diff --name-only` でファイル単位に分割、(2) ファイル毎に `call_openai_review()` を並列実行、(3) `findings` を全件結合 + `summary` のみ別途 reduce 用呼び出し、の3段。

### より大きな拡張

- **行単位コメント対応**: 現在は 1 つの issue コメントにまとめている。`POST /repos/{owner}/{repo}/pulls/{pr}/reviews` を使い、`findings[*].file` / `line` ごとに review comment として貼ると視認性が上がる。
- **既存コメント上書きの粒度**: 現状は 1 PR につき 1 コメントを upsert。シリーズコメント方式（push ごとに新規）に切り替える選択肢もあり。
- **Claude への自動修正依頼**: blocker / major 指摘を抽出して、Claude API に修正パッチを依頼 → suggestion ブロック付きの review コメントを貼る、というフローも組み込み可能。
- **キャッシュ**: 同じ HEAD SHA に対して複数回レビューが走るのを防ぐため、SHA をキーに artifact を再利用するワークフロー条件分岐を追加する。
- **モデル A/B 比較**: `OPENAI_MODEL` をマトリクス化して、複数モデルのレビューを並べてコメント投稿し、品質比較する運用も可能。
