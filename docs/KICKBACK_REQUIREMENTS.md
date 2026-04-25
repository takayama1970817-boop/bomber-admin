# 清算書（キックバック）機能 要件定義

最終更新: 2026-04-25
ステータス: 確定（社長承認済み）

---

## 1. 設計原則（最重要）

**メール送信** = 任意の通知手段。

**ポータルでの PDF / CSV 取得** = 代理店の必須機能。常に利用可能。

両者は完全に独立。**メール未送信でも、phase が `calculated` / `pdf_ready` であれば代理店ポータルに表示し、PDF / CSV が生成済みであればダウンロード可能とする。**

J0002 特別システムとは切り離し、本要件は全代理店共通ルールとして実装する。

---

## 2. ステータスモデル

社長指定の 5 値要件を、内部表現として 2 軸に分解する。

### 軸 1: 集計フェーズ（`phase` フィールド、必ず 1 つ）

| phase 値      | 意味                       | ポータル表示 |
| ------------- | -------------------------- | ------------ |
| `calculating` | 計算中                     | 非表示       |
| `calculated`  | 計算済み（PDF/CSV 未作成） | 表示         |
| `pdf_ready`   | PDF / CSV 作成済み         | 表示         |

### 軸 2: メール状態（`mailStatus` フィールド、独立フラグ）

| mailStatus 値 | 意味             |
| ------------- | ---------------- |
| `unsent`      | メール未送信     |
| `sent`        | メール送信済み   |
| `failed`      | メール送信失敗   |

### UI 表示時のラベル変換（5 値要件への対応）

| phase + mailStatus           | UI 表示ラベル                |
| ---------------------------- | ---------------------------- |
| `calculating`                | 「計算中」（ポータル非表示） |
| `calculated`                 | 「計算済み」                 |
| `pdf_ready` + `unsent`       | 「PDF作成済み（メール未送信）」 |
| `pdf_ready` + `sent`         | 「メール送信済み」           |
| `pdf_ready` + `failed`       | 「メール送信失敗」           |

---

## 3. ステータス遷移フロー（ハイブリッド）

```
[admin: 集計バッチ実行]
        │
        ▼ 自動
   calculating ──────────────► calculated
                                    │
                                    ▼ admin: 「PDF/CSV作成」ボタン
                               pdf_ready
                                    │
                                    ▼ admin: 「メール送信」ボタン（任意）
                               mailStatus: unsent → sent / failed
```

- `calculating` → `calculated` は集計バッチで自動遷移
- `calculated` → `pdf_ready` は admin の「PDF/CSV作成」ボタン操作
- メール送信は任意操作。送信しなくても代理店ポータルからは取得可能
- 既存ドキュメントへの再生成導線（PDF / CSV を作り直す）も admin 側に用意する

---

## 4. データモデル（kickbacks コレクション）

### 既存フィールド（変更なし）

```
dealerCode, month, entries[], totalKickback, grandTotal,
dealerOrderTotal, adjustments[], createdAt, updatedAt
```

### 追加フィールド

```js
{
  // ─── フェーズ / タイムスタンプ ───
  phase: 'calculating' | 'calculated' | 'pdf_ready',
  calculatedAt: Timestamp,        // calculated に遷移した時刻
  pdfGeneratedAt: Timestamp,      // PDF 生成完了時刻
  csvGeneratedAt: Timestamp,      // CSV 生成完了時刻

  // ─── 成果物（Cloud Storage URL） ───
  pdfUrl: string,                 // 永続化された PDF URL
  pdfFileName: string,            // 表示用ファイル名
  csvUrl: string,                 // 永続化された CSV URL
  csvFileName: string,

  // ─── メール状態（ポータル表示と独立） ───
  mailStatus: 'unsent' | 'sent' | 'failed',
  mailSentAt: Timestamp | null,
  mailRecipients: string[],       // 送信先メール（監査用）
  mailError: string | null,       // failed 時の理由
}
```

---

## 5. CSV フォーマット（dealer 配布用）

dealer 側に配布する CSV は **代理店向け専用フォーマット**。

### 含める項目（代理店が確認に必要なもの）

- 対象月
- サロン名
- 注文件数
- 対象売上（税抜）
- 料率
- キックバック額

### 除外する項目

- 内部メモ
- 管理者用フラグ
- 他代理店の情報
- 集計過程の中間値

admin 画面の既存 CSV（管理用フル項目）は継続利用。dealer 配布版は別ジェネレータとして実装する。

---

## 6. ポータル表示・ダウンロード可否

### 表示条件（DealerKickbacks）

```
phase in ['calculated', 'pdf_ready']
```

`calculating` のドキュメントはポータルに出さない。

### PDF ダウンロード可否

```
!!pdfUrl
```

mailStatus は問わない。pdfUrl があれば常にダウンロード可。

### CSV ダウンロード可否

```
!!csvUrl
```

同上。mailStatus は問わない。

### UI 上のメール状態表示

メール状態は補助バッジとして表示するのみ。**ボタンの活性/非活性に影響させない。**

---

## 7. Cloud Storage 配置ルール

```
kickbacks/{dealerCode}/{month}/{kickbackId}.pdf
kickbacks/{dealerCode}/{month}/{kickbackId}.csv
```

- 月単位でフォルダを切る（過去ファイルとの混同を避ける）
- 再生成時は同じパスを上書き（旧 URL が失効しない）

---

## 8. 権限ルール

### Firestore rules（kickbacks コレクション）

| ロール | read 条件 | write |
| ---- | ---- | ---- |
| dealer | `phase != 'calculating'` かつ自分の dealerCode 一致 | 不可 |
| admin / master | 全件 | 可 |

### Cloud Storage rules

`kickbacks/{dealerCode}/{month}/*.pdf` および `*.csv` は、認証ユーザーのうち以下の条件で read 可。

- 該当 dealerCode の dealer
- admin / master

---

## 9. 既存データのバックフィル

PR-A に簡易バックフィルスクリプトを含める。安全優先で以下の推定ルールを採用。

| 既存データの状態 | バックフィル後の値 |
| ---- | ---- |
| `phase` フィールドなし、`totalKickback` または `grandTotal` がある | `phase = 'calculated'` |
| 既に `pdfUrl` がある | `phase = 'pdf_ready'` |
| `mailStatus` フィールドなし | `mailStatus = 'unsent'` |
| `mailSentAt` がある | `mailStatus = 'sent'` |
| `pdfUrl` / `csvUrl` が無い既存分 | admin 側に**再生成導線**を用意 |

### バックフィルスクリプトの配置

`scripts/backfill-kickback-phase.mjs` として実装。`--dry-run` オプションで影響範囲を確認できる構成にする。

---

## 10. 実装フェーズ（PR 分割）

### PR-A: データモデル基盤（admin 側）

- `kickbacks` のスキーマ拡張（`phase` / `mailStatus` / `pdfUrl` / `csvUrl` / 各タイムスタンプ）
- PDF 生成完了時に Cloud Storage upload + Firestore へ `pdfUrl` 永続化
- dealer 向け CSV 生成と Cloud Storage upload + `csvUrl` 永続化
- メール送信時に `mailStatus` / `mailSentAt` / `mailRecipients` を Firestore に書き戻し
- KickbackManage.jsx に「PDF/CSV作成」「メール送信」「再生成」ボタンを追加（操作分離）
- バックフィルスクリプト追加

### PR-B: 代理店ポータル表示拡張

- `useDealerKickbacks` のフィルタを `phase in ['calculated', 'pdf_ready']` に変更
- `canDownloadKickbackPdf` を `!!pdfUrl` 単純判定に変更
- `canDownloadKickbackCsv` を新設
- DealerKickbacksTable に CSV ボタンを追加
- DealerKickbackDetailModal に PDF / CSV ボタンを追加
- ステータス表示を 5 パターンに統一（メール状態は補助バッジ）

### PR-C: Firestore rules / Storage rules

- Firestore rules: dealer の read 条件を `phase != 'calculating'` に拡張
- Cloud Storage rules: dealerCode スコープ追加

---

## 11. リリース順序と安全性

1. **PR-A をマージ**
   - データモデル拡張のみ。バックフィルは `--dry-run` で確認後、本番実行
   - dealer ポータルは既存ロジックのまま動く（後方互換）
2. **PR-B をマージ**
   - dealer ポータル UI 拡張。新フィールドが入った前提で表示
3. **PR-C をマージ**
   - rules を緩める。**最後に分離する理由**: 誤動作で他代理店の清算書が見える事故を防ぐため

---

## 12. 非対応・対象外

- **J0002 特別システム** — 横展開対象外。本要件は全代理店共通ルール。
- **支払い実行ワークフロー** — 本要件外（`paid` ステータスは現時点で扱わない）
- **承認フロー** — 本要件外（`approved` 中間ステータスは廃止扱い）

---

## 13. 確定した方針（社長判断）

| 項目 | 判断 |
| ---- | ---- |
| ステータス遷移 | ハイブリッド（バッチ自動 + admin ボタン手動） |
| CSV フォーマット | dealer 専用フォーマット（管理者用は別） |
| バックフィル | PR-A に簡易スクリプト同梱、`--dry-run` 付き |
| PR 粒度 | PR-A / PR-B / PR-C の 3 本 |
| 優先順位 | キレイにスキーマから揃える（B 案） |
| 最終目的 | メール送信有無に関係なく、代理店がポータルから PDF/CSV を取れること |
