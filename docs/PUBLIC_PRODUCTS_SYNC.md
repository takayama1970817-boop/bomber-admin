# publicProducts 運用手順

公開サイト（https://bomber-admin.web.app/）の商品情報は Firestore `publicProducts` コレクションを正とする。
静的フォールバック（`src/data/productsGenerated.js`）を併用して「Firestore 失敗時も表示が壊れない」構成。

## 設計方針（合意事項）

| # | 方針 | 実装 |
|---|---|---|
| 1 | 公開サイトの商品情報は `publicProducts` を参照 | `src/hooks/usePublicProducts.js` |
| 2 | 静的フォールバックは維持 | `src/data/productsGenerated.js` → `products.js` |
| 3 | 同期は `bcart-sync.mjs --products-master` を正式手順 | `scripts/bcart-sync.mjs` |
| 4 | Firestore には公開用項目のみ保存 | `transformBcartProduct` で `price` 等を除外 |
| 5 | 同期失敗時に既存公開データを壊さない | 検証先行（slug一意性）→ 失敗時は書込前に中止 |
| 6 | slug の一意性を担保 | 取込時に衝突検出 → 中止 |
| 7 | 表示順の安定性を担保 | `displayOrder asc → code asc` のタイブレーカ |

## Firestore コレクション設計

### `publicProducts/{code}`

docId = Bカート商品コード（`code` フィールドと同値）

```
{
  slug: string,            // URL 用 / 一意
  code: string,            // docId と同じ
  name: string,
  category: string,        // 表示用ラベル
  categoryKey: string,     // フィルタ用（aging/moisture/lotion/cleansing/essence/other）
  badge: string | null,
  unit: string | null,     // 例: "200g", "業務用"
  tagline: string | null,
  shortDesc: string,       // 一覧カード用
  description: string,     // 詳細ページ用
  features: string[],
  usage: string | null,
  image: string | null,    // 画像URL（Phase 3 で拡張）
  gradient: string,        // 画像未設定時のビジュアル代替
  displayOrder: number,    // 小さいほど先頭
  isPublic: boolean,       // false は公開対象外（サイトで非表示）
  syncedAt: Timestamp,     // 最終同期時刻
}
```

**除外フィールド**（Firestore / 生成ファイルのどちらにも保存しない）:
- `price`（Bカート側の卸価格）
- `cost_price`, `stock` 等の在庫・原価系
- Bカート内部 ID（`bcartProductId` は将来必要なら別コレクションで管理）

### セキュリティルール

```
match /publicProducts/{productId} {
  allow read:  if true;    // 誰でも読める（公開サイト用）
  allow write: if isAdmin();
}
```

## 正式運用手順

### 初回セットアップ

1. **Firestore ルール反映**（Firebase Console → ルール）
   - `firestore.rules` の `publicProducts` ブロックを含めてデプロイ

2. **DRY-RUN で計画確認**（書き込みせず件数だけ見る）
   ```bash
   node scripts/bcart-sync.mjs --products-master --dry-run
   ```
   - 取得件数 / 公開対象 / 非公開化 / スキップ の内訳を表示
   - slug 衝突があればここで検出される（同期は実行されない）

3. **本番同期**
   ```bash
   node scripts/bcart-sync.mjs --products-master
   ```
   - 検証を全件 PASS してから書き込みを開始
   - `src/data/productsGenerated.js` も同時に再生成される

4. **フロント反映**
   - `npm run build` → Firebase Hosting デプロイ

### 定期運用

Bカート側で商品マスタを編集したあと、以下を実行するだけでサイトに反映：

```bash
node scripts/bcart-sync.mjs --products-master
npm run build
firebase deploy --only hosting
```

### 障害時の挙動

| 発生場所 | 挙動 |
|---|---|
| Bカート API 取得失敗 | Firestore 書き込みせず中止（既存データ保護） |
| 取得件数が 0 件 | 異常として中止（既存データ保護） |
| slug 衝突を検出 | 中止。衝突ペアを表示してオペレータに修正を促す |
| Firestore 読み取り失敗（フロント） | 静的 `productsGenerated.js` にフォールバック |
| Firestore 空（フロント） | 静的データにフォールバック |
| 全件 `isPublic=false`（フロント） | 静的データにフォールバック |

## 非公開化（soft delete）ルール

同期実行時、以下の商品は自動的に `isPublic=false` に降格する：

- Bカートから削除された商品
- Bカート側で `is_public=0` に変更された商品

`publicProducts` からのドキュメント物理削除は行わない（監査用に履歴を残す）。

## CSV 代替経路（API 不可用時）

Bカート API が使えない環境でも、CSV からローカル取込で静的フォールバックを更新できる：

```bash
node scripts/import-products-csv.mjs ./docs/bcart-products-sample.csv
```

- 同じ検証ロジック（slug 一意性）が走る
- `src/data/productsGenerated.js` を再生成
- Firestore には触らない（書き込み権限が無くても動く）

CSV 列仕様: `docs/bcart-products-sample.csv` 参照（14列、UTF-8、ヘッダー必須）。

## 表示順の決め方

1. `display_order` / `sort_order` を小さい順
2. 同値の場合は `code` の辞書順

Bカート側で「主力商品を先頭、次に価格帯高い順」等を表現したい場合は `display_order` に 10, 20, 30 … のように間隔を空けて設定すると後からの差し込みが容易。

## レート制限対策（Bカート API 429 / 503）

Bカートは大量リクエスト時にレート制限をかけてきます。本スクリプトは以下で耐性を持たせています。

### 自動動作（`bcart-sync.mjs` 全モード共通）
- **指数バックオフ**: 5 / 10 / 20 / 40 / 60 / 120 / 180 / 240 / 300 秒、最大 10 回再試行
- **Retry-After ヘッダ尊重**: API が返してきた秒数を優先
- **成功後の throttle**: 既定 250ms（`--throttle-ms=500` 等で調整可）
- **checkpoint 自動保存**（受注明細取得のみ）:
  - 25 ページ（= 500 件）ごとに `.bcart-sync-checkpoint-<yearLabel>.json` を保存
  - 中断後の再実行で**自動再開**（`--fresh` を付けない限り）
  - 完走すると自動削除

### 詰まったときの手順

1. **30分〜1時間あける**（Bカート側のレート制限は時間経過でリセット）
2. 同じコマンドを**そのまま再実行**（checkpoint から自動で続きを取得）

```bash
# 例: 受注同期が途中で止まった場合
node scripts/bcart-sync.mjs --year=2026
# ↑ このまま再実行すれば checkpoint から再開
```

### throttle を強めに

```bash
# 500ms に緩めて再実行（約 2rps）
node scripts/bcart-sync.mjs --year=2026 --throttle-ms=500
```

### 受注明細をスキップして高速化

受注明細（order_products）はレート制限の主な原因。ホームページ公開には不要なので、
下記フラグで一次同期を先に済ませる手もあります。

```bash
node scripts/bcart-sync.mjs --year=2026 --skip-products
```

### checkpoint を無視して最初から

CSV 仕様変更等で取り直したいときのみ：

```bash
node scripts/bcart-sync.mjs --year=2026 --fresh
```

### DRY-RUN（書き込みなしでAPIだけ叩く）

```bash
node scripts/bcart-sync.mjs --year=2026 --dry-run
```

### ⚠️ ホームページ公開だけなら受注同期は不要

ホームページ（`/products`, `/products/:slug`）は `publicProducts` のみ参照します。
受注同期（order_products のフェーズ）はダッシュボード系の機能が使うもので、
**公開デプロイだけなら `--products-master` を使えば受注・明細フェーズは通りません**。

```bash
# これだけで公開ページは最新化される
node scripts/bcart-sync.mjs --products-master --dry-run
node scripts/bcart-sync.mjs --products-master
```

## トラブルシュート

### Q. サイトで商品が古いまま更新されない
- ブラウザキャッシュを強制リロード
- `firebase deploy --only hosting` が実行されているか確認
- Firebase Console で `publicProducts` に `syncedAt` が最新か確認

### Q. 特定商品が表示されない
- `publicProducts/{code}.isPublic` を確認（false なら公開対象外）
- Bカート側で `is_public` フラグが OFF になっていないか確認

### Q. slug 衝突のエラーが止まらない
- 同一の slug を持つ複数商品の `code` を確認
- CSV の `slug` 列を手動指定するか、`code` を一意化する
