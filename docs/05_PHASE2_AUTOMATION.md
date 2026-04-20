# 05 Phase 2 自動化設計書（月次自動作成・自動送信・再実行制御）

- **対象**: bomber-admin ERP / 取引精算（kickback + invoice 統合）
- **版**: v0.1（§1 のみ起草）
- **起草開始日**: 2026-04-20
- **起草者**: ロイヤルトラスト社長 + Claude Code
- **承認フロー**: §1〜§3 完成後に社長レビュー → ChatGPT レビュー → 両承認で §4 以降着手

---

## 0. 本設計書の絶対条件（冒頭で固定）

### 0.1 着手順序（明示承認なしに変更不可）

1. **第1段階：重複作成の防止機構**（§1）
2. **第2段階：重複送信の防止機構**（§2）
3. **第3段階：本送信の段階解放**（§7）

### 0.2 判断基準（優先順位）

設計・実装・レビューで判断に迷ったとき、必ず以下の順序で決定する。

1. **二重防止**
2. **監査性**
3. **停止可能性**
4. **運用の便利さ**

「便利だから」を理由に 1〜3 を妥協する判断は禁止。

### 0.3 文書化順序

本設計書は以下の順で起草する（送信機能を後ろに置く）。

- §1 重複作成の防止機構
- §2 重複送信の防止機構
- §3 監査ログ（settlementRunLogs / settlementEmailLogs）
- §4 送信対象判定ロジック（A/B/C）
- §5 自動送信関数の実装
- §6 手動再送 UI
- §7 段階解放の手順

### 0.4 今月（2026-04）の作業範囲

**§1〜§3 の設計確定までが作業範囲**。

§4 以降は社長レビュー + ChatGPT レビュー両承認が下りるまで確定・実装しない。

---

## §1 重複作成の防止機構

### §1.1 目的と原則

#### 目的

月次で自動作成される精算ドキュメント（`kickbacks` / `invoices`）について、
**同じ代理店・同じ月の精算ドキュメントが 2 件以上作成されること** を物理的に防ぐ。

#### 背景：なぜ §2 より先にこれを固めるか

自動送信機構より先に自動作成機構の二重防止を固める理由：

- 作成が二重化していると、片方を送信・片方を送信せず放置という **不整合状態** が生まれる
- 作成が二重化したまま送信機構を動かすと、**二重送信事故** に直結する
- 作成側の二重防止が固まっていれば、送信側は「1 ドキュメント = 1 送信」の前提で単純化できる

つまり作成側の二重防止は、送信側の二重防止の前提条件である。

#### 原則

- 作成は **冪等** にする（何度呼ばれても同じ結果 = 最大 1 件だけ作成）
- 冪等性は **クライアント側の再実行制御** ではなく **データ層（Firestore）** で保証する
- クライアント（Scheduler / 手動トリガー / リトライ）側にはロジックを置かない

### §1.2 docId 設計

#### 採用する docId 形式

```
{type}_{dealerCode}_{YYYY-MM}
```

#### 具体例

| 種別 | dealerCode | 月 | docId |
|---|---|---|---|
| KB 清算 | J0019 | 2026-03 | `kb_J0019_2026-03` |
| 請求書 | J0021 | 2026-03 | `invoice_J0021_2026-03` |
| KB 清算 | J0015 | 2026-04 | `kb_J0015_2026-04` |

#### 採用理由

1. **人間が読める**：監査・障害対応時に Firestore Console 上で即座に識別できる
2. **衝突条件が自明**：同じ型・同じ代理店・同じ月は必ず同じ docId になる
3. **検索が容易**：月次バッチの再実行時、対象 docId が決定的に算出できる
4. **複合キー不要**：`where('dealerCode', '==', ...).where('month', '==', ...)` の複合クエリが不要

#### docId 採用に伴う制約

- `dealerCode` は J 形式（例：J0015, J0019）に正規化済みであること（Phase 1 で完了済）
- 月は必ず `YYYY-MM` 形式（例：2026-03、2026-04）
- 同一代理店が同月内に 2 度精算されるユースケースは想定しない（存在するなら別途設計）

#### 禁止する docId 形式

- 自動採番（Firestore の `addDoc`）：二重作成が原理的に防げない
- タイムスタンプ含み（例：`kb_J0015_2026-03_20260401030012`）：再実行で別 ID になる
- UUID：冪等キーとして機能しない

### §1.3 Cloud Functions 側の create-only ロジック

#### 基本構造

```javascript
// Cloud Functions: createMonthlySettlement(dealerCode, month, type)
const docId = `${type}_${dealerCode}_${month}`
const docRef = db.collection(collectionName).doc(docId)

await db.runTransaction(async (tx) => {
  const snap = await tx.get(docRef)
  if (snap.exists) {
    // 既に作成済み → 冪等にスキップ
    throw new AlreadyExistsError(`${docId} は既に作成済み`)
  }
  tx.create(docRef, {
    dealerCode,
    month,
    type,
    status: 'draft',
    createdAt: FieldValue.serverTimestamp(),
    createdBy: 'scheduler',
    version: 1,
    // ... 明細等
  })
})
```

#### 設計ポイント

| 項目 | 設計 | 理由 |
|---|---|---|
| create 関数 | `tx.create()` を使う（`tx.set()` ではない） | `create` は既存ドキュメントがあれば失敗する |
| transaction | 必須 | get → create の間の競合を防ぐ |
| docId | 明示指定（`doc(docId)`） | 自動採番を使わない |
| スキップ時の扱い | 例外ではなくログ記録 | §1.8 参照 |

#### `tx.create()` vs `tx.set()`

- **`tx.create(ref, data)`**: 既存ドキュメントがあれば `ALREADY_EXISTS` エラー → 採用
- **`tx.set(ref, data)`**: 既存ドキュメントを上書き → **絶対に使わない**
- **`tx.set(ref, data, {merge: true})`**: 既存と新規をマージ → **絶対に使わない**

### §1.4 Firestore rules 側の再 create 禁止

#### rules の防衛ライン

Cloud Functions のロジックに穴があった場合の最終防衛ラインとして、
Firestore rules 側でも再 create を禁止する。

```javascript
// firestore.rules
match /kickbacks/{docId} {
  // create: Cloud Functions (Admin SDK) 経由のみ許可
  allow create: if false; // クライアントからの直接 create 禁止

  // update: Cloud Functions + admin のみ、status 遷移とログ記録のみ
  allow update: if request.auth != null
    && hasValidAdminRole()
    && onlyAllowedFieldsChanged(['status', 'updatedAt', 'approvedAt', 'approvedBy']);

  // delete: 物理削除禁止
  allow delete: if false;
}
```

#### 設計ポイント

- **クライアントからの create は一切禁止**（`allow create: if false`）
- Cloud Functions（Admin SDK）経由のみ作成可能（rules は Admin SDK をバイパスする）
- update は status 遷移関連フィールドのみ許可（allowlist 方式）
- delete は一切禁止（論理削除で対応）

#### 二重防衛の意味

| 層 | 防衛内容 |
|---|---|
| 1. Cloud Functions transaction | `tx.create()` で docId 衝突時に失敗 |
| 2. Firestore rules | クライアント直接 create 禁止 |

Cloud Functions が何らかの理由でバグっていても、rules 側でクライアントからの直接操作を遮断しているため、
クライアント経由での二重作成は物理的に不可能。

### §1.5 Scheduler 設計（起点日時・冪等性）

#### 起点日時

**毎月 1 日 03:00 JST**

```
Cloud Scheduler cron: 0 3 1 * *
Time zone: Asia/Tokyo
```

#### 対象月の算出

Scheduler 実行時刻から**前月**を対象月とする。

- 実行：2026-05-01 03:00 JST
- 対象月：2026-04（前月）

#### 採用理由

| 要件 | 実現 |
|---|---|
| 朝の業務開始前に生成完了 | 03:00 開始、通常数分以内に完了 |
| Bカート月末締めを確実にまたぐ | 月初に実行するため前月データは確定済み |
| 手動実行と衝突しない時刻帯 | 深夜帯なので人間の操作と競合しにくい |

#### 冪等性の保証

Scheduler が多重実行されても、§1.3 の `tx.create()` によって
**最初の 1 回だけが成功し、2 回目以降は `ALREADY_EXISTS` でスキップ** される。

### §1.6 再実行シナリオ（多重実行・手動・リトライ耐性）

#### シナリオ 1: Cloud Scheduler が同時に 2 回発火

```
03:00:00 Scheduler 発火 A → tx.create() 成功
03:00:00 Scheduler 発火 B（同時） → tx.get() で existing 検知 → スキップ
```

Firestore transaction が競合を直列化するため、2 回目は必ず existing を検知してスキップする。

#### シナリオ 2: 手動トリガーで再実行

```
03:00 Scheduler 実行 → 作成完了
03:15 admin が手動トリガーで再実行 → tx.get() で existing 検知 → スキップ
```

#### シナリオ 3: Cloud Functions タイムアウトで自動リトライ

```
03:00 Scheduler 実行 → 途中で 60s タイムアウト
03:01 Cloud Functions が自動リトライ
  → tx.create() 済みの代理店 → existing でスキップ
  → tx.create() 未実施の代理店 → 新規作成成功
```

**重要**：Cloud Functions の自動リトライは **作成処理のみ** 許可する。
送信処理の自動リトライは §1.7 の原則に従い禁止。

#### シナリオ 4: 手動作成 → Scheduler 実行

```
04-25 admin が手動で 2026-04 の kickback を早期作成
05-01 03:00 Scheduler 実行 → existing でスキップ
```

手動作成した月次精算と Scheduler が衝突しないことを保証する。

### §1.7 失敗時の設計原則

#### 原則：自動再試行を安易に入れない

作成失敗（SendGrid 障害ではなく、Firestore 書き込み失敗 / Bカート API エラー / データ不整合等）が発生した場合、
**Cloud Functions 側で自動リトライしない**。

#### 理由

| 項目 | 説明 |
|---|---|
| 根本原因が残存 | 自動リトライで成功しても根本原因が特定できない |
| 監査性が下がる | リトライ履歴がログに埋もれ、失敗の真因追跡が困難になる |
| 二重作成リスク | タイムアウト後のリトライで稀に二重作成が発生しうる |
| 停止可能性が下がる | 自動化が深くなると、問題発生時に止めづらくなる |

#### 代替：手動確認フロー

1. 失敗は `settlementRunLogs` に `status: 'failed'` + `errorMessage` で記録
2. admin に通知（メール or Slack、手段は §3 で定義）
3. admin が原因を特定してから手動で再実行
4. 手動再実行も同じ Cloud Function を呼ぶ（冪等なので成功済みはスキップ、失敗のみ再試行）

#### Cloud Functions 設定

```javascript
// Cloud Functions v2 設定
{
  retry: false,           // 自動リトライ無効
  timeoutSeconds: 540,    // 9分（月次バッチの最大想定）
  memory: '512MiB',
  maxInstances: 1,        // 多重実行を抑制（transaction で防御済みだが念のため）
}
```

#### Cloud Scheduler 設定

```
retry_config: なし（リトライ無効）
attempt_deadline: 10分
```

#### 例外：作成ロジック内の一時的エラー

Firestore の瞬断等、極めて短時間で回復する可能性のあるエラーは、
**transaction 内の最大 3 回リトライは許可** する（Firestore SDK の標準動作）。

これは「自動再試行を安易に入れない」原則の例外ではなく、
Firestore SDK が transaction の競合解決として提供する標準メカニズムである。

### §1.8 settlementRunLogs との関係

#### settlementRunLogs の役割

月次バッチ 1 回の実行に対して 1 ドキュメントを記録する、**作成実行単位の監査ログ**。

#### docId 形式

```
{YYYY-MM}_{trigger}_{runAt}
例: 2026-04_scheduler_2026-05-01T03:00:00Z
例: 2026-04_manual_2026-04-25T14:32:11Z
```

#### 記録内容

```javascript
{
  targetMonth: '2026-04',
  trigger: 'scheduler' | 'manual',
  runAt: <Timestamp>,
  operator: 'scheduler' | uid,
  targetDealerCount: 23,
  createdCount: 20,
  skippedCount: 2,      // 既存で existing スキップ
  failedCount: 1,       // 失敗
  skipped: [
    { dealerCode: 'J0015', reason: 'already_exists', existingDocId: 'kb_J0015_2026-04' },
    { dealerCode: 'J0016', reason: 'no_kbGroup' },
  ],
  failed: [
    { dealerCode: 'J0020', errorMessage: 'Bカート API timeout', retryable: false },
  ],
  durationMs: 42153,
  createdAt: <Timestamp>,
}
```

#### append-only 保証

```javascript
// firestore.rules
match /settlementRunLogs/{logId} {
  allow read: if hasValidAdminRole();
  allow create: if false;  // Cloud Functions 経由のみ
  allow update: if false;  // 変更禁止
  allow delete: if false;  // 削除禁止
}
```

#### スキップ理由の標準化

| reason | 意味 |
|---|---|
| `already_exists` | 既に作成済み（正常スキップ） |
| `no_kbGroup` | 代理店の kbGroup 未設定（§4 で定義） |
| `dealer_inactive` | 代理店が非アクティブ（`dealers.active === false`） |
| `no_target_orders` | 対象月に注文が 0 件（作成不要） |
| `data_inconsistency` | Bカートと Firestore の不整合を検知（手動確認要） |

`already_exists` 以外のスキップは admin への通知対象とする（詳細は §3）。

### §1.9 段階運用上の解除条件・停止条件

#### 第1段階の位置づけ

- **目的**：作成機構のみを本番稼働させ、送信は一切行わない
- **期間**：本番環境で 1 か月（= 1 回の月次バッチ）
- **対象**：全代理店（A/B/C グループすべて）
- **送信**：**無効化**（送信関数はデプロイしない、または `settings/settlement_automation.enabled = false`）

#### 解除条件（第 2 段階に進んでよい条件）

以下 3 条件を **すべて** 満たした場合のみ、第 2 段階（重複送信の防止機構）に進む。

| # | 条件 | 確認方法 |
|---|---|---|
| 1 | 1 か月間の月次バッチでエラー 0 件 | `settlementRunLogs` の `failedCount` 合計が 0 |
| 2 | 二重作成 0 件 | `kickbacks` / `invoices` で同一 `{dealerCode, month}` 複数存在 = 0 件 |
| 3 | スキップ理由が想定範囲内 | `already_exists` 以外のスキップについて原因特定済み |

#### 停止条件（即座に自動作成を止める条件）

以下のいずれか **1 つでも** 発生した場合、即座に自動作成を停止する。

| # | 条件 |
|---|---|
| 1 | 二重作成を 1 件でも検知 |
| 2 | Cloud Functions のエラー率 5% 超（1 か月の `failedCount / targetDealerCount`） |
| 3 | Firestore rules の異常 create 試行を検知（rules 違反ログで判定） |
| 4 | 社長判断で停止指示 |

#### 停止方法

```javascript
// Firestore: settings/settlement_automation
{
  enabled: false,          // ← false にすると Scheduler が即座にスキップ
  disabledAt: <Timestamp>,
  disabledBy: uid,
  disabledReason: '...',
}
```

Cloud Functions は実行開始時に必ず `enabled` を確認し、false なら即座に return する。

```javascript
// Cloud Functions 冒頭
const config = await db.doc('settings/settlement_automation').get()
if (config.data()?.enabled !== true) {
  console.log('[SKIP] settlement_automation is disabled')
  return { skipped: true, reason: 'automation_disabled' }
}
```

### §1.10 第1段階の検証計画（本番 1 か月空運用）

#### 空運用の定義

- 作成機構（§1）のみ本番稼働
- 送信機構（§2〜§5）は **一切デプロイしない**
- 月次バッチで作成された `kickbacks` / `invoices` は Firestore に保存されるのみ
- 代理店・サロンへの通知は一切発生しない

#### 検証期間

- **開始**: §1〜§3 レビュー承認後の翌月 1 日 03:00
- **終了**: その翌月 1 日 03:00 の月次バッチが完了した時点

つまり **2 回の月次バッチ** が走る期間を観測する（1 回目 = 初回稼働、2 回目 = 再実行耐性確認）。

#### 観測項目

| # | 項目 | 観測方法 |
|---|---|---|
| 1 | 1 回目バッチ正常終了 | `settlementRunLogs` |
| 2 | 1 回目バッチの作成件数が想定と一致 | `createdCount` を手動集計と照合 |
| 3 | 2 回目バッチで 1 回目分がすべて `already_exists` でスキップ | `skipped[].reason` 確認 |
| 4 | 二重作成が発生していない | `kickbacks` / `invoices` の件数確認クエリ |
| 5 | 手動トリガーでもスキップされる | admin が実際に手動トリガーして確認 |
| 6 | rules 違反の直接 create 試行 0 件 | Firestore rules ログ確認 |

#### 検証成功条件

観測項目 6 点 **すべて成功** した場合のみ §1 を本番合格とし、第 2 段階（§2）の本番稼働に進む。

1 点でも失敗した場合は、第 2 段階の本番稼働を延期し、§1 の修正・再検証から始める。

#### 検証失敗時の復旧手順

1. `settings/settlement_automation.enabled = false` で即座に停止
2. `settlementRunLogs` と Firestore の実データを照合し、二重作成が発生している場合は該当ドキュメントを admin が手動で論理削除（`isDeprecated: true`、物理削除は禁止）
3. 根本原因を特定
4. §1 の本文を修正し、再レビューを受けてから再稼働

---

## §2 重複送信の防止機構

（未起草。§1 の社長レビュー + ChatGPT レビュー承認後に起草開始）

---

## §3 監査ログ（settlementRunLogs / settlementEmailLogs）

（未起草。§2 完成後に起草開始）

---

## §4 以降

（§1〜§3 のレビュー承認まで起草禁止）

---

## 変更履歴

| 日付 | 版 | 変更内容 | 担当 |
|---|---|---|---|
| 2026-04-18 | v0.0 | 初期章立て策定、Phase 2 着手条件確定 | 社長 + Claude |
| 2026-04-20 | v0.1 | §1 起草完了 | Claude |
