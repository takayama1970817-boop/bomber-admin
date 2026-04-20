# 05 Phase 2 自動化設計書（月次自動作成・自動送信・再実行制御）

- **対象**: bomber-admin ERP / 取引精算（kickback + invoice 統合）
- **版**: v0.6（§3 起草）
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

#### type の enum 固定（ChatGPT レビュー反映 / 必須1）

`type` は以下の **2 値のみ** 許可する。それ以外の値は docId 生成前に throw する。

```javascript
const ALLOWED_TYPES = Object.freeze(['kb', 'invoice'])

/*
 * 将来拡張（現時点では実装不要・本コメントは設計メモ）:
 *   - 'refund'     : 返金（代理店への返金が発生した月の精算）
 *   - 'adjustment' : 調整（過月分の修正・再計算・手動調整）
 *   - 'payment'    : 支払系（RT から代理店への別建て支払が発生した場合）
 *
 * 追加時の手順:
 *   1. 本 ALLOWED_TYPES を改訂
 *   2. collectionName のマッピング（§1.3 基本構造）を更新
 *   3. rules 側の match /{type}/{docId} を追加
 *   4. 社長承認 + 設計書 §13 変更履歴に記録
 *
 * 新種別は既存 kb / invoice の意味論を壊さない独立した種別として追加する。
 * 既存 docId との衝突は type プレフィクスで自然に防がれる。
 */
function validateType(type) {
  if (!ALLOWED_TYPES.includes(type)) {
    throw new Error(`Invalid type: ${type}. Must be one of ${ALLOWED_TYPES.join(', ')}`)
  }
}
```

| type | 意味 | 対象 kbGroup |
|---|---|---|
| `kb` | KB 清算（kickbacks コレクション） | A / B |
| `invoice` | 請求書（invoices コレクション） | C |

新種別（例：`refund` / `adjustment` / `payment` 等）を追加する場合は §1.2 の ALLOWED_TYPES を改訂し、
改訂時は必ず社長承認 + 設計書 §13 変更履歴への記録を行う。

#### dealerCode の正規化（ChatGPT レビュー反映 / 必須2）

`dealerCode` は J 形式（`J` + 4 桁数字）のみ許可する。

```javascript
const DEALER_CODE_REGEX = /^J\d{4}$/

function validateDealerCode(code) {
  if (typeof code !== 'string' || !DEALER_CODE_REGEX.test(code)) {
    throw new Error(`Invalid dealerCode: ${code}. Must match /^J\\d{4}$/`)
  }
}
```

Phase 1 で 8 代理店（v1-V7, I001）を J 形式（J0016-J0023）に統一済み。
新規代理店登録時も J 形式を強制する（dealers コレクションの rules 側でも検証予定）。

#### month の形式

`YYYY-MM` 形式のみ許可する。

```javascript
const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/

function validateMonth(month) {
  if (typeof month !== 'string' || !MONTH_REGEX.test(month)) {
    throw new Error(`Invalid month: ${month}. Must match YYYY-MM`)
  }
}
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
5. **enum 固定で破綻検知容易**：不正な type / dealerCode / month は docId 生成前に throw

#### docId 採用に伴う制約

- `type` は `'kb' | 'invoice'` のみ（ALLOWED_TYPES で enum 固定）
- `dealerCode` は J 形式（`^J\d{4}$`）
- `month` は `YYYY-MM` 形式（`^\d{4}-(0[1-9]|1[0-2])$`）
- 同一代理店が同月内に 2 度精算されるユースケースは想定しない（存在するなら別途設計）

#### 禁止する docId 形式

- 自動採番（Firestore の `addDoc`）：二重作成が原理的に防げない
- タイムスタンプ含み（例：`kb_J0015_2026-03_20260401030012`）：再実行で別 ID になる
- UUID：冪等キーとして機能しない

### §1.3 Cloud Functions 側の create-only ロジック

#### 本節の原則（ChatGPT レビュー反映 / 推奨2）

**§1 の思想は「再生成しないこと」で統一する。**

- 一度 `create` に成功したドキュメントは、**物理的に上書きも再作成もしない**
- 月次バッチの再実行は「**未作成分のみ create する**」という冪等動作
- 既存ドキュメントの `status === 'failed'` は `update` で状態管理する（再 create はしない）
- `failed` を「作成されなかった」とみなすことはしない（既に 1 件存在している事実は消さない）

#### 基本構造

```javascript
// Cloud Functions: createMonthlySettlement(dealerCode, month, type)
validateType(type)
validateDealerCode(dealerCode)
validateMonth(month)

const docId = `${type}_${dealerCode}_${month}`
const collectionName = type === 'kb' ? 'kickbacks' : 'invoices'
const docRef = db.collection(collectionName).doc(docId)

await db.runTransaction(async (tx) => {
  const snap = await tx.get(docRef)
  if (snap.exists) {
    // 既に存在 → 再 create は行わず、冪等にスキップ
    // status === 'failed' であっても update で状態管理するのみ（§1.7 参照）
    return { skipped: true, reason: 'already_exists', existingStatus: snap.data().status }
  }
  // 未作成分のみ create
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
  return { skipped: false }
})
```

#### 設計ポイント

| 項目 | 設計 | 理由 |
|---|---|---|
| create 関数 | `tx.create()` を使う（`tx.set()` ではない） | `create` は既存ドキュメントがあれば失敗する |
| transaction | 必須 | get → create の間の競合を防ぐ |
| docId | 明示指定（`doc(docId)`） | 自動採番を使わない |
| 既存検知 | `snap.exists` なら skip | 再生成しないという思想 |
| skip の扱い | 例外ではなく戻り値で記録 | §1.8 参照 |

#### `tx.create()` vs `tx.set()`

- **`tx.create(ref, data)`**: 既存ドキュメントがあれば `ALREADY_EXISTS` エラー → 採用
- **`tx.set(ref, data)`**: 既存ドキュメントを上書き → **絶対に使わない**
- **`tx.set(ref, data, {merge: true})`**: 既存と新規をマージ → **絶対に使わない**

#### 既存ドキュメントの状態遷移（再 create しない）

一度 create 成功したドキュメントは、以降 `update` のみで状態管理する。

| 現状 status | 想定される次の遷移 | 遷移手段 |
|---|---|---|
| `draft` | `approved` / `cancelled` | admin が UI から `update` |
| `approved` | `sent` / `failed` | 送信処理（§2）が `update` |
| `sent` | （最終状態） | なし |
| `failed` | `approved`（リトライ後）/ `cancelled` | admin が UI から `update` |
| `cancelled` | （最終状態） | なし |

**どの状態であっても再 create は行わない。** 必要に応じて status を update するのみ。

### §1.4 Firestore rules 側の再 create 禁止

#### Admin SDK bypass の明文化（ChatGPT レビュー反映 / 必須3）

**重要な前提**：Firestore rules は **クライアント SDK 経由のアクセスにのみ適用される**。
Cloud Functions が使う **Admin SDK は rules を完全にバイパスする**。

これが意味することは：

- rules は「クライアントからの直接操作」を遮断する防衛ラインである
- rules は「Cloud Functions 内部のロジックバグ」に対する防衛にはならない
- Admin SDK で書き込む Cloud Functions のコード品質は、**Cloud Functions 側の責任**

したがって本設計の二重防衛は「層 A（Cloud Functions 内部）＋ 層 B（クライアント遮断）」という
**並列関係** であって、rules が Cloud Functions の背後に立つ直列的な防衛ではない。

#### 二重防衛の正確な位置付け

| 層 | 防衛対象 | 防衛手段 | Admin SDK に効くか |
|---|---|---|---|
| A. Cloud Functions 内部 | Scheduler / 手動トリガー / リトライによる重複起動 | transaction + `tx.create()` + validate* | — |
| B. クライアント経由 | 悪意ある / バグったクライアントコード | Firestore rules `allow create: if false` | ✗（bypass される） |

**層 A が Admin SDK 経由の書き込みを防ぐ唯一の手段** であり、
layer B はクライアントからの不正操作を防ぐもの。どちらか片方に依存しない。

#### rules 本体

```javascript
// firestore.rules
match /kickbacks/{docId} {
  // create: クライアント直接 create は一切禁止（Cloud Functions Admin SDK 経由のみ許可）
  // Admin SDK は rules をバイパスするため、この rule は Admin SDK を制限しない
  allow create: if false;

  // update: クライアントからは admin のみ、かつ status 遷移関連フィールドのみ
  // Admin SDK（Cloud Functions）は bypass するので本 rule の制約を受けない
  allow update: if request.auth != null
    && hasValidAdminRole()
    && request.resource.data.diff(resource.data).affectedKeys()
        .hasOnly(['status', 'updatedAt', 'approvedAt', 'approvedBy', 'cancelledAt', 'cancelledBy', 'cancelReason']);

  // delete: 物理削除禁止（Admin SDK も含めて運用上禁止、論理削除で対応）
  allow delete: if false;
}

match /invoices/{docId} {
  // kickbacks と同じポリシー
  allow create: if false;
  allow update: if request.auth != null
    && hasValidAdminRole()
    && request.resource.data.diff(resource.data).affectedKeys()
        .hasOnly(['status', 'updatedAt', 'approvedAt', 'approvedBy', 'cancelledAt', 'cancelledBy', 'cancelReason']);
  allow delete: if false;
}
```

#### Admin SDK 側の自己防衛

Cloud Functions のコードでも「rules のような防衛」を自力で実装する必要がある：

```javascript
// Cloud Functions 冒頭
// Admin SDK は rules をバイパスするので、以下を Functions 側で必ずチェック
validateType(type)              // §1.2 で定義
validateDealerCode(dealerCode)  // §1.2 で定義
validateMonth(month)            // §1.2 で定義
assertEnabled()                 // §1.9 で定義
```

これを怠ると、Admin SDK の特権で不正な docId / 不正なフィールドが Firestore に書き込まれうる。

#### 設計ポイント

- **クライアントからの create は rules で一切禁止**（`allow create: if false`）
- **Admin SDK からの create は Cloud Functions 内部の validate + transaction で担保**
- update は クライアント側で status 遷移関連フィールドのみ許可（allowlist 方式）
- delete は rules で一切禁止（論理削除で対応）

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

### §1.6 再実行シナリオ（多重実行・手動・リトライ耐性・部分成功）

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
03:00 Scheduler 実行 → 途中で 540s タイムアウト
03:10 Cloud Functions が自動リトライ（注: retry: false なので手動トリガーに限る）
  → tx.create() 済みの代理店 → existing でスキップ
  → tx.create() 未実施の代理店 → 新規作成成功
```

**重要**：Cloud Functions の自動リトライは **無効化**（`retry: false`）。
タイムアウト後は admin が手動で同じ Function を再実行する運用とする。
再実行しても冪等（既存分は `already_exists` でスキップ、未作成分のみ create）。

#### シナリオ 4: 手動作成 → Scheduler 実行

```
04-25 admin が手動で 2026-04 の kickback を早期作成
05-01 03:00 Scheduler 実行 → existing でスキップ
```

手動作成した月次精算と Scheduler が衝突しないことを保証する。

#### シナリオ 5: 部分成功（ChatGPT レビュー反映 / 推奨1）

```
03:00 Scheduler 実行（対象 23 代理店）
  代理店 J0015〜J0017: tx.create() 成功 → created: 3
  代理店 J0018: 既に存在（手動早期作成） → skipped: already_exists
  代理店 J0019: 既に存在（4/25 の手動作成） → skipped: already_exists
  代理店 J0020: kbGroup 未設定 → skipped: no_kbGroup
  代理店 J0021〜J0037: 残り 17 代理店 → created: 17
  代理店 J0038: Bカート API timeout → failed: 1

最終:
  targetDealerCount: 23
  createdCount: 20
  skippedCount: 2
  failedCount: 1
  → status: partial_success
```

#### 部分成功時の扱い

| 分類 | 処理 |
|---|---|
| created（成功） | 確定。ドキュメントが Firestore に作成された事実は取り消さない |
| skipped（スキップ） | 確定。既存扱い。次回バッチでも同様にスキップされる |
| failed（失敗） | **ドキュメントは作成されていない**（tx.create が throw したため）。次回実行時に再度 create を試行（冪等） |

#### 重要：failed でも「作成されていない」のが正しい状態

- tx.create() が throw した場合、**Firestore にドキュメントは 1 件も存在しない**
- 次回手動トリガーまたは翌月 Scheduler で再試行すれば作成される
- 「failed のドキュメントが半端に残る」状態は **発生しない**（transaction で保証）

#### 部分成功の通知

1. `settlementRunLogs` に `status: 'partial_success'` で記録
2. `failed[]` 配列に失敗詳細（dealerCode / errorMessage）を記録
3. admin に通知（§3 で詳細定義）
4. admin が失敗原因を特定後、手動トリガーで再実行（冪等）

#### シナリオ 6: enabled が途中で false になる（ChatGPT レビュー反映 / 推奨3）

```
03:00:00 Scheduler 実行開始（対象 23 代理店）
03:00:30 代理店 J0015〜J0017 処理完了（created: 3）
03:00:35 社長が障害を検知し、settings/settlement_automation.enabled = false
03:00:36 代理店 J0018 処理開始前に enabled を再確認 → false 検知 → 残り全員を skip（reason: 'automation_disabled_midrun'）
```

#### enabled の再確認タイミング（本線レビュー反映 / 指摘3-2）

バッチ開始時の一度きりでなく、**各代理店ループの冒頭で毎回 enabled を再確認** する。
ただし Firestore read は「毎ループ必ず取得」ではなく「状態変化を検知したら以降はスキップ」の
**break 離脱構造** を採用する。

```javascript
let enabled = true  // 初期値 true（バッチ開始前のチェックで true 確認済み前提）

for (const dealer of targetDealers) {
  if (!enabled) {
    // 一度 false を検知したら以降は追加 read せず全部 skip（意図明示）
    skipped.push({ dealerCode: dealer.dealerCode, reason: 'automation_disabled_midrun' })
    continue
  }

  // 毎回 Firestore read で最新の enabled を確認
  const config = await db.doc('settings/settlement_automation').get()
  enabled = config.data()?.enabled === true

  if (!enabled) {
    // この代理店から以降は skip（break でも良いが continue で全件 skip 記録を残す）
    skipped.push({ dealerCode: dealer.dealerCode, reason: 'automation_disabled_midrun' })
    continue
  }

  await createSettlement(dealer, month, type)
}
```

#### なぜ break 構造にするか

| 項目 | 理由 |
|---|---|
| 負荷削減 | enabled=false 検知後は追加 read 不要 |
| **意図明示** | 「一度停止したら元に戻らない」というバッチ内の不可逆性を明示 |
| 再実行安全 | バッチ中に false→true に戻っても、当バッチは停止を貫く（次回手動トリガーで再開） |

read コストは 1 代理店あたり 1 回の Firestore read（= 数十ミリ秒）。
23 代理店で約 1 秒のオーバーヘッド。false 検知後は 0 秒。緊急停止の即応性を優先する。

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

#### docId 形式（ChatGPT レビュー反映 / 必須4）

**`addDoc` による自動採番を採用** する。

```javascript
const logRef = await db.collection('settlementRunLogs').add({
  targetMonth: '2026-04',
  trigger: 'scheduler',
  runAt: FieldValue.serverTimestamp(),
  // ... (記録内容)
})
```

#### 自動採番を採用する理由

`settlementRunLogs` は **実行単位の記録** であって冪等キーは不要。
むしろ同秒同ミリ秒で複数トリガーが走った場合、固定 docId では衝突する。

| 代替案 | 問題点 |
|---|---|
| `{YYYY-MM}_{trigger}_{runAt-sec}` | 同秒で複数実行があると衝突 |
| `{YYYY-MM}_{trigger}_{runAt-ms}` | 極めて稀だが同ミリ秒衝突リスク |
| `{YYYY-MM}_{trigger}_{runAt}_{random4}` | 可読性低下 |
| **`addDoc`（自動採番）** | ✅ **衝突リスクなし、実行単位は重複しても問題なし** |

settlementRunLogs は「何回実行したか」を記録するログであって、
**実行 1 回 = 1 ログが冪等性を担保する必要はない**（実行履歴は重複しない）。

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

#### 停止条件（即座に自動作成を止める条件・ChatGPT レビュー反映 / 必須5）

以下のいずれか **1 つでも** 発生した場合、即座に自動作成を停止する。

| # | 条件 | 判定単位 |
|---|---|---|
| 1 | **二重作成を 1 件でも検知**（件数問わず即停止） | 都度検知（日次集計 §1.10 参照） |
| 2 | **1 回のバッチで** エラー率 5% 超 **かつ** 失敗件数 ≥ 2 | バッチ単位（月1回） |
| 3 | Firestore rules の異常 create 試行を検知 | 都度検知（rules 違反ログ） |
| 4 | 社長判断で停止指示 | 随時 |

#### エラー率条件の補足

旧案「1 か月合計のエラー率 5% 超」は月末まで検知できない問題があった（ChatGPT レビュー指摘）。
修正後は以下の 2 条件を **AND** で判定：

```javascript
// 1 回のバッチ単位で判定
const errorRate = failedCount / targetDealerCount
const shouldStop = errorRate > 0.05 && failedCount >= 2

// failedCount >= 2 を併用する理由:
//   - 1 件の一時的エラー（Bカート API timeout 等）で全停止しない
//   - ただし 2 件以上の同時失敗は構造的問題の可能性があるため停止
```

**二重作成検知は件数条件なし**（1 件でも即停止）。

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
| 4 | 二重作成が発生していない | §1.10 の「二重作成検知クエリ」を毎日自動実行 |
| 5 | 手動トリガーでもスキップされる | admin が実際に手動トリガーして確認 |
| 6 | rules 違反の直接 create 試行 0 件 | Firestore rules ログ確認 |

#### 二重作成検知クエリ（ChatGPT レビュー反映 / 推奨4・本線レビュー反映 / 指摘3-1）

観測項目 #4 の自動検知を具体化する。**2 つのタイミングで起動** する（即検知 + 日次保険）。

| # | タイミング | 起動方法 | 目的 |
|---|---|---|---|
| 1 | 月次バッチ終了直後 | `createMonthlySettlement` の最後で `detectDuplicates()` を呼ぶ | **即検知**（バッチ起因の二重作成を数秒以内に検知） |
| 2 | 毎日 01:00 JST | Cloud Scheduler 独立ジョブ | **日次保険**（手動作成・CS 事故・過去分の不整合も網羅） |

#### なぜ 2 系統にするか

**旧案の「毎日 01:00 のみ」は最大 24 時間気付かない**（本線レビュー指摘）。
月次バッチは代理店全件をまとめて処理する最大のリスク源なので、
バッチ直後の即検知を必ず通す。

| 単独案 | 問題 |
|---|---|
| バッチ直後のみ | 手動作成・過去分不整合を見逃す |
| 日次のみ（01:00） | 月次バッチ起因の二重作成に最大 24 時間気付かない |
| **2 系統併用（採用）** | ✅ 即検知 + 網羅性 を両立 |

#### バッチ直後の呼び出し

```javascript
// Cloud Functions: createMonthlySettlement の末尾
// バッチ処理完了後、同一 Functions 内で detectDuplicates を呼ぶ
// （独立した Cloud Functions として分離するより、呼び出し漏れが起きにくい）
try {
  await detectDuplicates({ triggeredBy: 'post_batch', targetMonth: month })
} catch (e) {
  // 検知ロジック自体の失敗はバッチ全体を失敗扱いにしない
  // （作成は既に完了しているため、日次保険に任せる）
  console.error('[WARN] post-batch detectDuplicates failed:', e)
  await db.collection('settlementRunLogs').add({
    type: 'duplicate_check_failed',
    triggeredBy: 'post_batch',
    targetMonth: month,
    errorMessage: String(e),
    createdAt: FieldValue.serverTimestamp(),
  })
}
```

#### 日次保険の呼び出し

Cloud Scheduler から毎日 01:00 JST に起動する。

```javascript
// Cloud Functions: detectDuplicateSettlements
//   - 日次保険: Cloud Scheduler から毎日 01:00 JST 起動
//   - 即検知: createMonthlySettlement 末尾から呼び出し
//
// 目的: kickbacks / invoices で同一 {type, dealerCode, month} の
//       ドキュメントが 2 件以上存在していないか検知する
//
// 仕組み:
//   - docId が {type}_{dealerCode}_{YYYY-MM} 形式なので、
//     同一キーの複数ドキュメントは原理的に発生しない
//   - ただし「意味的重複」（別の docId で同一 {dealerCode, month}）は
//     手動作成バグ等で発生しうるためこれを検知する

async function detectDuplicates({ triggeredBy = 'scheduled_daily', targetMonth = null } = {}) {
  const collections = ['kickbacks', 'invoices']
  const duplicates = []

  for (const colName of collections) {
    const snap = await db.collection(colName).get()
    const seen = new Map() // key: "dealerCode|month", value: [docId, ...]

    for (const doc of snap.docs) {
      const { dealerCode, month } = doc.data()
      if (!dealerCode || !month) continue
      const key = `${dealerCode}|${month}`
      if (!seen.has(key)) seen.set(key, [])
      seen.get(key).push(doc.id)
    }

    for (const [key, ids] of seen) {
      if (ids.length > 1) {
        duplicates.push({ collection: colName, key, docIds: ids })
      }
    }
  }

  if (duplicates.length > 0) {
    // 停止条件 #1 発動（件数問わず即停止）
    await db.doc('settings/settlement_automation').update({
      enabled: false,
      disabledAt: FieldValue.serverTimestamp(),
      disabledBy: 'duplicate_detector',
      disabledReason: `二重作成検知: ${JSON.stringify(duplicates).slice(0, 500)}`,
    })
    // admin 通知
    await notifyAdmin({
      severity: 'critical',
      title: '【緊急】二重作成を検知しました',
      body: `自動作成を即停止しました。詳細: ${JSON.stringify(duplicates, null, 2)}`,
    })
  }

  // 検知結果を監査ログに記録（triggeredBy で即検知/日次保険を区別）
  await db.collection('settlementDuplicateChecks').add({
    runAt: FieldValue.serverTimestamp(),
    triggeredBy,                    // 'post_batch' | 'scheduled_daily' | 'manual'
    targetMonth: targetMonth || null, // post_batch 時のみ指定
    checkedCollections: collections,
    duplicatesFound: duplicates.length,
    duplicates,
  })
}
```

#### 検知クエリの配置

| 配置 | 理由 |
|---|---|
| バッチ直後（post_batch） | 月次バッチ起因の二重作成を数秒以内に即検知 |
| 日次 01:00 JST（scheduled_daily） | 手動作成・過去分不整合も網羅する保険 |
| 検知時は自動で automation を停止 | 停止可能性の担保（判断基準 #3） |
| 検知ロジック失敗は非致命 | バッチ完了は既に確定、日次保険でカバー |

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

### §2.1 目的と原則

#### 目的

自動作成された精算ドキュメント（`kickbacks` / `invoices`）に対して、
**1 ドキュメントが自動送信メカニズムで複数回送信されること** を物理的に防ぐ。

#### 前提：§1 の成果を前提とする

§1 で「1 代理店 × 1 月 = 最大 1 ドキュメント」が保証されている。
したがって §2 は **「1 ドキュメント = 最大 1 回だけ自動送信」** を実現すればよい。

§1 の作成側二重防止が効いていない状態では §2 は意味を持たない。
本節は §1 が本番合格した後でなければ実装・有効化しない。

#### 原則

- 送信の冪等性は **クライアント側の再実行制御** ではなく **ログ層（settlementEmailLogs）** で保証する
- 送信処理は「**ログ確定 → SES 送信 → 結果更新**」の 3 段階で進め、途中で落ちても安全
- **SES 送信成功だけでは「送信済み」と判定しない**（ログ整合込みで判定）
- 送信失敗時に **自動再送しない**（手動確認後の手動再送のみ）
- 手動再送は admin 限定、かつ自動送信とは別経路で実行し、監査ログは共通テーブルに記録

#### 設計判断の優先順位（§0.2 の再掲）

1. **二重防止**
2. **監査性**
3. **停止可能性**
4. **運用の便利さ**

「届かないより重複のほうがマシ」という判断はしない。重複送信は信用問題に直結する。

### §2.2 settlementEmailLogs の役割と docId 設計

#### settlementEmailLogs の役割

送信 1 回分に対して 1 ドキュメントを記録する、**送信単位の監査ログ**。

§1.8 の `settlementRunLogs`（実行単位）とは明確に分離する。作成事故と送信事故を切り分けるため。

| ログ | 単位 | 記録タイミング | 目的 |
|---|---|---|---|
| `settlementRunLogs` | 月次バッチ 1 実行 | 作成バッチの開始〜終了 | 作成事故の切り分け |
| `settlementEmailLogs` | 送信 1 通 | 送信処理の各段階 | 送信事故の切り分け |

#### docId 設計：kickbackId / invoiceId を採用

**settlementEmailLogs の docId は、送信対象ドキュメントの ID（kickbackId または invoiceId）をそのまま使う**。

```
docId 形式: {kickbackId} または {invoiceId}

具体例:
  settlementEmailLogs/kb_J0015_2026-04
  settlementEmailLogs/invoice_J0021_2026-04
```

#### 採用理由

1. **1 ドキュメント = 1 ログ**：同一精算に対して複数の送信ログが作られない（冪等キー）
2. **§1 の docId を流用**：`kb_J0015_2026-04` の形式を踏襲し、監査時に即対応付け可能
3. **docId 衝突で二重送信を物理防止**：`tx.create()` で既存検知すれば自動送信の二重化は原理的に防げる
4. **参照が自明**：送信ログから元の精算ドキュメントを直接取得できる（同じ docId）

#### 自動採番（addDoc）を使わない理由

`settlementEmailLogs` を `addDoc` にすると、同一精算に対して複数ログが作れてしまう。
それでは「1 ドキュメント = 1 送信」の保証をデータ層で担保できない。

| 代替案 | 問題 |
|---|---|
| `addDoc`（自動採番） | 同一精算に複数ログ → 二重送信を検知できない |
| `{kickbackId}_{attemptNo}` | attemptNo の採番ロジックが必要 → 複雑化 |
| **`{kickbackId}` そのまま（採用）** | ✅ データ層で一意性保証、複雑度最小 |

#### 再送の扱い

再送は「新規ログを作る」のではなく「既存ログを update する」設計とする（§2.7 で詳述）。
これにより「何度送ったか」は同一ドキュメントの attempt 履歴として記録される。

### §2.3 送信対象判定の前提条件

送信対象に含めるためには **以下 5 条件を AND ですべて満たす** 必要がある。
1 つでも欠けた代理店・精算は送信対象外とし、理由を記録する。

| # | 条件 | 判定方法 |
|---|---|---|
| 1 | 対象月が確定していること | `kickback.status === 'approved'` または `invoice.status === 'issued'` |
| 2 | 代理店が存続していること | `dealers/{dealerCode}.active === true` |
| 3 | kbGroup が A/B/C のいずれかであること | `dealers.kbGroup in ['A', 'B', 'C']` |
| 4 | `dealers.settlementEmail` が有効な形式で設定されていること | `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` にマッチ |
| 5 | 対象帳票（kickback または invoice）が既に作成済み | Firestore に docId が存在する |

#### 条件未達のスキップ理由コード

```javascript
const SKIP_REASONS = Object.freeze([
  'not_approved',       // #1: status が approved / issued でない
  'dealer_inactive',    // #2: dealers.active === false
  'no_kbGroup',         // #3: kbGroup 未設定
  'invalid_email',      // #4: settlementEmail が未設定 or 不正形式
  'document_missing',   // #5: 対象帳票が存在しない（通常ありえない異常）
])
```

スキップは `settlementEmailLogs` には記録しない（送信を試みていないため）。
代わりに `settlementRunLogs`（§2 用の別バッチログ = `settlementSendRunLogs`、§3 で定義）に記録する。

#### 判定時の原則

- 判定は送信実行の **直前** に行う（§2.4 の pending-first の前段）
- キャッシュした判定結果を使わない（Firestore 最新値で毎回判定）
- 判定コスト増は許容する（二重送信リスクより安い）

### §2.4 Cloud Functions 側の pending-first ロジック

#### 3 段階構造

送信処理は **必ず以下の 3 段階** を順番に実行する。途中で落ちても再実行で安全に復帰できるよう設計する。

```
Stage 1: ログ確定（pending）
  ├─ settlementEmailLogs/{id} に transaction で pending 作成
  ├─ 既に sent / pending が存在すれば reject
  └─ failed のみ上書き許可

Stage 2: SES（SendGrid）送信
  ├─ Stage 1 が完了してから初めて SES API を叩く
  └─ 成功時は x-message-id を取得

Stage 3: 結果更新
  ├─ 成功 → status を sent に update（最大 3 回リトライ）
  ├─ 失敗 → status を failed に update（errorMessage 記録）
  └─ Stage 3 失敗時は pending 残留（admin が手動で resolve）
```

#### Stage 1 のコード（pending-first）

```javascript
const logRef = db.collection('settlementEmailLogs').doc(kickbackId)

await db.runTransaction(async (tx) => {
  const snap = await tx.get(logRef)
  if (snap.exists) {
    const prev = snap.data() || {}
    if (prev.status === 'sent') {
      throw new HttpsError('already-exists', `既に送信済み (messageId: ${prev.sesMessageId})`)
    }
    if (prev.status === 'pending') {
      throw new HttpsError('already-exists', '送信処理中です')
    }
    // status === 'failed' のみ再試行許可（pending で上書き）
  }
  tx.set(logRef, {
    kickbackId,
    dealerCode,
    dealerName,
    month,
    status: 'pending',
    toEmail,
    ccCount, ccDomains, ccSource,
    bccCount, bccDomains, bccSource,
    isTestSend,
    sentBy,
    sentByEmail,
    createdAt: snap.exists ? (snap.data().createdAt || now) : now,
    updatedAt: now,
    sesMessageId: null,
    errorMessage: null,
    attemptCount: (snap.exists ? (snap.data().attemptCount || 0) : 0) + 1,
  })
})
```

#### なぜ pending を先に確定させるか

| 理由 | 説明 |
|---|---|
| 二重送信防止 | pending を先に書き込めば、同時実行の 2 回目は即座に拒否できる |
| 送信中表示 | UI が「送信中…」を表示できる（ユーザーの二重ボタン押下を抑止） |
| 再実行安全 | Stage 2 / 3 で落ちても pending 残留を検知して手動リカバリ可能 |
| 監査性 | 送信を試みた事実が必ず記録される（SES API が落ちていても記録は残る） |

#### Stage 1 失敗時の挙動

Stage 1 の transaction が throw した場合、**Stage 2（SES 送信）は絶対に実行しない**。
これにより「ログ未記録 + 実送信済み」という最悪ケースを防ぐ。

### §2.5 送信前ログ確定 → SES送信 → 結果更新 の3段階

#### Stage 2: SES（SendGrid）送信

Stage 1 完了後、SendGrid API を呼び出す。

```javascript
// Stage 1 が成功した前提で Stage 2 に進む
const sgApiKey = process.env.SENDGRID_API_KEY || settings.sendgridApiKey
if (!sgApiKey) {
  // Stage 1 は完了している → failed に update してから throw
  await logRef.update({
    status: 'failed',
    errorMessage: 'SendGrid API キーが未設定',
    updatedAt: FieldValue.serverTimestamp(),
  })
  throw new HttpsError('failed-precondition', 'SendGrid API キーが未設定')
}

sgMail.setApiKey(sgApiKey)

let sesMessageId
try {
  const [response] = await sgMail.send(msg)
  const headers = response?.headers || {}
  sesMessageId = headers['x-message-id'] || null
} catch (err) {
  // Stage 2 失敗 → failed に update
  const errMsg = String(err?.message || err)
  await logRef.update({
    status: 'failed',
    errorMessage: errMsg.slice(0, 1000),
    updatedAt: FieldValue.serverTimestamp(),
  })
  throw new HttpsError('internal', `メール送信失敗: ${errMsg}`)
}
```

#### Stage 3: 結果更新（成功確定）

SES 送信成功後、Firestore の status を `sent` に更新する。ここが落ちると最悪ケース。

```javascript
// Stage 3: status=sent 確定（3回リトライ）
const finalUpdate = {
  status: 'sent',
  sesMessageId,
  sentAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
}
let updateErr = null
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    await logRef.update(finalUpdate)
    updateErr = null
    break
  } catch (e) {
    updateErr = e
    if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt))
  }
}

if (updateErr) {
  // 最悪ケース: SES 送信済みだが status 更新失敗 → pending 残留
  // v0.4 変更: warning で返すのではなく「即停止 + CRITICAL通知」に変更
  // 理由: pending 残留を1件でも放置すると isSettlementSent() の整合性が崩れる。
  //       送信事故の潜在リスクを早期に顕在化させるため、即座に自動送信を止める。

  // ① settings/settlement_automation.enabled = false で即停止
  try {
    await db.doc('settings/settlement_automation').update({
      enabled: false,
      disabledAt: FieldValue.serverTimestamp(),
      disabledBy: 'stage3_failure_detector',
      disabledReason: `Stage3 失敗により自動停止（kickbackId: ${kickbackId}, sesMessageId: ${sesMessageId}）`,
    })
  } catch (stopErr) {
    // 停止操作自体の失敗は別ログ（settings 書き込みも Firestore 不調なら手動停止）
    console.error('[CRITICAL] Stage3 失敗 + 停止操作も失敗', stopErr)
  }

  // ② admin へ CRITICAL 通知
  await notifyAdmin({
    severity: 'critical',
    title: '【緊急】Stage3 失敗：SES 送信成功だが Firestore 更新失敗',
    body: `自動送信を即停止しました。
  kickbackId: ${kickbackId}
  sesMessageId: ${sesMessageId}
  error: ${updateErr.message}

  対応:
    1. SendGrid ダッシュボードで sesMessageId の実送信を確認
    2. resolveSettlementEmailLog({ targetStatus: 'sent', sesMessageId, reason }) で手動確定
    3. settings/settlement_automation.enabled = true に戻して再開`,
  })

  console.error('[CRITICAL] Stage3 失敗 → automation 即停止', {
    kickbackId, sesMessageId, error: updateErr.message,
  })

  // ③ 呼び出し元には HttpsError で throw（warning ではなく明確なエラー扱い）
  throw new HttpsError(
    'data-loss',
    `Stage3 失敗：SES 送信成功だが Firestore 更新失敗。自動送信を停止しました。admin 手動確定が必要です。(kickbackId: ${kickbackId}, sesMessageId: ${sesMessageId})`,
  )
}

return { success: true, kickbackId, sesMessageId }
```

#### Stage3 失敗を warning ではなく CRITICAL 扱いにする理由（v0.4 変更）

旧案（v0.3）は Stage3 失敗を warning として呼び出し元に返していた。本線レビュー指摘により、
以下の理由で **即停止 + CRITICAL 通知** に変更した。

| 理由 | 説明 |
|---|---|
| 整合性崩壊 | pending 残留 1 件でも `isSettlementSent()` の 3 条件 AND 判定が乱れる |
| 潜在事故の顕在化 | warning だと「気付かずに運用継続」が起こりうる |
| 停止可能性の担保 | 判断基準 #3「停止可能性」に従い、疑わしきは止める |
| admin 介入の強制 | 自動リカバリさせず必ず人の判断を通す（§1.7 原則の徹底） |

#### なぜ Stage 3 に 3 回リトライを入れるか

- Stage 1 / Stage 2 は「自動再試行しない」原則（§1.7）に従う
- Stage 3 は「**SES は既に送信済み**」という既成事実があるため、ログ整合のほうが優先
- リトライしないとログが pending のまま残り、後の送信済み判定（§2.8）で混乱する
- ただし 3 回で諦め、それ以上は admin に通知する（自動無限リトライはしない）

#### Stage 3 の 3 回リトライが §1.7 原則と矛盾しない理由

§1.7 の「自動再試行禁止」は **「実アクション（送信・作成）の再試行」** を禁止するもの。
Stage 3 のリトライは **「既に完了した実アクションの結果記録」** のリトライであり、性質が異なる。

| §1.7 対象（禁止） | Stage 3 リトライ（許可） |
|---|---|
| 送信自体を再試行 | 送信済みの結果を記録する update を再試行 |
| 二重送信リスクあり | 二重送信リスクなし（既に送信済み） |
| 根本原因隠蔽のリスク | 一時的 Firestore 瞬断への耐性 |

### §2.6 送信ログの status 遷移

#### 状態遷移図

```
        (なし)
           │
           ▼
       [pending]  ← Stage 1 完了
           │
           ├─ SES 成功 → [sent]       (最終状態)
           │
           └─ SES 失敗 → [failed]     (admin 手動再送で [pending] に戻る)
```

#### 許可される遷移

| from | to | 遷移手段 | 備考 |
|---|---|---|---|
| (なし) | `pending` | `tx.create` or `tx.set` | Stage 1 |
| `pending` | `sent` | `update` | Stage 3 成功 |
| `pending` | `failed` | `update` | Stage 2 / 3 失敗 |
| `failed` | `pending` | `update` | admin 手動再送（§2.7） |
| `pending` | `failed` | `update` | admin 手動 resolve（§2.9） |
| `pending` | `sent` | `update` | admin 手動 resolve（§2.9、sesMessageId 明示） |

#### 禁止される遷移

| from | to | 理由 |
|---|---|---|
| `sent` | (任意) | sent は最終状態。書き換え禁止 |
| (任意) | (なし)（削除） | append-only（§2.10 参照） |

#### status 遷移の rules 側制約

```javascript
// firestore.rules
match /settlementEmailLogs/{docId} {
  allow read: if hasValidAdminRole();
  // create / update は Cloud Functions（Admin SDK）経由のみ
  // Admin SDK は rules をバイパスするため、クライアント側は完全遮断
  allow create, update: if false;
  allow delete: if false;
}
```

Cloud Functions 側で以下を必ずチェック：

```javascript
function assertStatusTransition(from, to) {
  const allowed = {
    '__none__': ['pending'],
    'pending':  ['sent', 'failed'],
    'failed':   ['pending'],  // 再送
    'sent':     [],            // 最終状態
  }
  if (!allowed[from]?.includes(to)) {
    throw new Error(`Invalid status transition: ${from} → ${to}`)
  }
}
```

### §2.7 再送シナリオ（自動再試行禁止・手動再送のみ）

#### 原則

- 送信失敗時の **自動再送は行わない**（§1.7 の原則を送信側にも適用）
- 再送は **admin の手動操作** でのみ可能
- 手動再送は **別の Cloud Function**（`manualResendSettlementEmail`）で行い、自動送信関数とは完全分離
- 手動再送の監査は `settlementEmailLogs` の同一ドキュメントに attempt 履歴として追記

#### 自動再送を禁止する理由

| 理由 | 説明 |
|---|---|
| 真因隠蔽 | API 障害が自動リトライで「成功」するとログに障害事実が残らない |
| 二重送信リスク | 送信側のタイムアウトと自動再送の組み合わせは重複送信事故の典型 |
| 停止可能性 | 自動再送を止めるには別の停止スイッチが必要 → 設計が複雑化 |
| 監査性 | 自動再送の履歴は監査側で「人の判断」と区別できない |

#### 手動再送の責務分離

| 経路 | Cloud Function | 権限 | 対象 status |
|---|---|---|---|
| 自動送信 | `sendSettlementEmail` | admin 限定 + testDealerCode 制限（段階解放後は全代理店） | `pending` が作成可能（なし / failed） |
| 手動再送 | `manualResendSettlementEmail` | **admin 限定**（§2.9） | `failed` のみ |
| 手動確定 | `resolveSettlementEmailLog` | admin 限定 | `pending` 残留のみ（5分経過） |

#### 手動再送の流れ

1. admin が SettlementManage UI で失敗ログを確認
2. `status === 'failed'` のログに「再送」ボタンが表示される
3. admin が再送ボタンを押下 → `manualResendSettlementEmail` 呼び出し
4. Cloud Function 内で Stage 1（pending に戻す）→ Stage 2（SES 送信）→ Stage 3（結果更新）
5. attemptCount をインクリメント、resentBy / resentAt を記録

#### 手動再送のログ追記

新規ログを作らず、既存ログを update する。attempt 履歴は `attemptCount` で数え、
詳細は `resendHistory[]` 配列に追記する（肥大化防止のため最新 10 件まで）。

```javascript
// v0.4 変更: resentAt は ISO 8601 文字列で記録する
// 理由: Firestore の arrayUnion() 内部では serverTimestamp() が使用不可のため。
//       旧案の Date.now() は数値なので人間の可読性が低い。
//       ISO 文字列なら Firestore Console 上で即座に時刻を確認できる。

const nowIso = new Date().toISOString()  // 例: '2026-04-20T15:32:11.234Z'

await logRef.update({
  status: 'pending',  // failed → pending に戻す（Stage 1 相当）
  attemptCount: FieldValue.increment(1),
  resendHistory: FieldValue.arrayUnion({
    resentAt: nowIso,              // ISO 文字列（UTC）
    resentBy: adminUid,
    resentByEmail: adminEmail,
    previousStatus: 'failed',
    previousError: prevErrorMessage,
  }),
  updatedAt: FieldValue.serverTimestamp(),  // ルート直下は serverTimestamp 使用可
})
```

#### resendHistory の時刻形式

| フィールド | 型 | 理由 |
|---|---|---|
| `resentAt`（配列内） | ISO 8601 文字列 | arrayUnion 内で serverTimestamp 不可 |
| `updatedAt`（ルート） | serverTimestamp | Firestore サーバ時刻で厳密記録 |
| `createdAt`（ルート） | serverTimestamp | 同上 |
| `sentAt`（ルート） | serverTimestamp | 同上 |

ISO 文字列はクライアント時刻に依存するため厳密性は劣るが、
`updatedAt`（serverTimestamp）を併用することで実時刻の照合は可能。
監査時は `resendHistory[].resentAt` と `updatedAt` を突き合わせて整合確認する。

### §2.8 送信済み判定の厳密化

#### 原則：SES 成功 **だけ** では sent 判定しない

「送信済み」の判定は以下 **3 条件を AND** で満たすときのみとする。

| # | 条件 |
|---|---|
| 1 | `settlementEmailLogs/{id}.status === 'sent'` |
| 2 | `settlementEmailLogs/{id}.sesMessageId` が非 null（SendGrid の x-message-id 保持済み） |
| 3 | 元の精算ドキュメント（kickbacks / invoices）側にも `sentAt` が記録されている |

#### 3 条件 AND を採用する理由

SES API は「送信成功」を返したが、その直後に Firestore 書き込みが落ちた場合、
`settlementEmailLogs` は pending のまま残る。このときシステム的には「送信済み」だが
データ的には「未送信」と判定できてしまう。

これを防ぐため、ログ層と本体ドキュメント層の **両方** に sent 記録を残し、
判定時は両方揃っているときのみ sent 扱いとする。

#### 精算ドキュメント側の sentAt 記録

Stage 3 の結果更新時、**同一 batch で** 両方を更新する：

```javascript
const batch = db.batch()
batch.update(logRef, {
  status: 'sent',
  sesMessageId,
  sentAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
})
batch.update(kickbackRef, {
  sentAt: FieldValue.serverTimestamp(),
  lastSendLogId: kickbackId,  // logRef.id と同じ
})
await batch.commit()
```

batch 失敗時は §2.5 の 3 回リトライで復旧を試みる。
**リトライ失敗時は v0.4 方針に従い以下を実行する**（v0.5 整合性修正）：

1. `settings/settlement_automation.enabled = false` で即停止
2. admin へ CRITICAL 通知（notifyAdmin severity: 'critical'）
3. 呼び出し元には `HttpsError('data-loss')` で throw（warning 扱いにしない）
4. admin が SendGrid ダッシュボードで実送信確認後、`resolveSettlementEmailLog` で手動確定

**注意**：旧 v0.3 の「warning を返す」挙動は v0.4 で撤回済み。
§2.5 / §2.8 / §2.10 のすべての記述は「Stage3 リトライ失敗 = 即停止 + CRITICAL」で統一されている。

#### 「送信済み判定」関数の共通化

```javascript
function isSettlementSent({ emailLog, settlement }) {
  return (
    emailLog?.status === 'sent' &&
    !!emailLog?.sesMessageId &&
    !!settlement?.sentAt
  )
}
```

この関数を UI（SettlementManage.jsx）とバッチ両方で使い、判定ロジックを一本化する。

#### 整合性不一致の検知（v0.4 追加 / 推奨4）

3 条件 AND で「sent」と判定できない中間状態を検知する `detectSentInconsistency()` を別途用意する。
これは日次 01:00 JST の二重送信検知と同じ Scheduler で起動し、不一致を発見したら即停止する。

```javascript
// Cloud Functions: detectSentInconsistency（日次 01:00 JST）
//
// 検知する不整合パターン:
//   A. emailLog.status='sent' かつ sesMessageId あり なのに settlement.sentAt が null
//   B. emailLog.status='sent' かつ sesMessageId なし（x-message-id 取得失敗）
//   C. settlement.sentAt あり なのに emailLog が存在しない or status != 'sent'
//   D. emailLog.status='pending' が一定時間以上残留（§2.11 で別途扱う）

async function detectSentInconsistency() {
  const inconsistencies = []

  const logsSnap = await db.collection('settlementEmailLogs').get()
  for (const logDoc of logsSnap.docs) {
    const log = logDoc.data()
    const kickbackId = log.kickbackId

    // パターン B: sent なのに sesMessageId が無い
    if (log.status === 'sent' && !log.sesMessageId) {
      inconsistencies.push({
        pattern: 'B_sent_without_messageId',
        kickbackId,
        logId: logDoc.id,
      })
      continue
    }

    // パターン A: emailLog=sent だが settlement.sentAt が null
    if (log.status === 'sent' && log.sesMessageId) {
      const colName = kickbackId.startsWith('kb_') ? 'kickbacks' : 'invoices'
      const settlementSnap = await db.collection(colName).doc(kickbackId).get()
      if (!settlementSnap.exists) {
        inconsistencies.push({
          pattern: 'C_log_exists_settlement_missing',
          kickbackId,
          logId: logDoc.id,
        })
      } else if (!settlementSnap.data().sentAt) {
        inconsistencies.push({
          pattern: 'A_sent_log_no_settlement_sentAt',
          kickbackId,
          logId: logDoc.id,
        })
      }
    }
  }

  // パターン C（settlement.sentAt あり かつ emailLog なし）は別ループで検知
  // ※ コード省略（上記と同様の構造で kickbacks / invoices 両方をスキャン）

  if (inconsistencies.length > 0) {
    // 即停止（停止条件 #2 相当）
    await db.doc('settings/settlement_automation').update({
      enabled: false,
      disabledAt: FieldValue.serverTimestamp(),
      disabledBy: 'sent_inconsistency_detector',
      disabledReason: `整合性不一致検知: ${JSON.stringify(inconsistencies).slice(0, 500)}`,
    })
    await notifyAdmin({
      severity: 'critical',
      title: '【緊急】送信整合性の不一致を検知しました',
      body: `自動送信を即停止しました。詳細: ${JSON.stringify(inconsistencies, null, 2)}`,
    })
  }

  await db.collection('settlementInconsistencyChecks').add({
    runAt: FieldValue.serverTimestamp(),
    checked: logsSnap.size,
    inconsistenciesFound: inconsistencies.length,
    inconsistencies,
  })
}
```

#### 整合性チェックの目的

| パターン | 意味 | 想定原因 | 対応 |
|---|---|---|---|
| A | emailLog=sent だが settlement.sentAt なし | Stage3 の batch 部分失敗 | resolveSettlementEmailLog で手動確定 + settlement 側更新 |
| B | emailLog=sent だが sesMessageId なし | SendGrid レスポンス異常 | SendGrid ダッシュボードで実送信確認 |
| C | settlement.sentAt あり だが emailLog なし | 手動操作ミス or 過去データ | 監査ログとして別途記録（実害なし） |

このチェックで「isSettlementSent() が検知できない中間状態」を日次で洗い出す。

### §2.9 失敗時の扱い（admin 手動確認）

#### 失敗の分類

| 分類 | 起因 | 対応 |
|---|---|---|
| Stage 1 失敗 | 既に sent / pending が存在 | 正常挙動。拒否メッセージを呼び出し元へ |
| Stage 2 失敗 | SendGrid API 障害 / 宛先不正 / API キー未設定 | failed 確定。admin が原因特定後に手動再送 |
| Stage 3 失敗 | Firestore 瞬断等（3 回リトライ後） | pending 残留。admin が resolveSettlementEmailLog で手動確定 |

#### admin 手動確認フロー

```
Stage 2 失敗（failed 確定）
  ├─ SettlementManage UI に「再送」ボタン表示
  ├─ admin が errorMessage を確認
  ├─ 原因特定後に「再送」押下
  └─ manualResendSettlementEmail 呼び出し

Stage 3 失敗（pending 残留）
  ├─ SettlementManage UI に「pending解除」ボタン表示（5分経過後のみ有効）
  ├─ admin が SendGrid ダッシュボードで実送信確認
  ├─ sesMessageId を取得
  └─ resolveSettlementEmailLog({ targetStatus: 'sent', sesMessageId, reason }) 呼び出し
```

#### admin 手動再送の制約

| 制約 | 理由 |
|---|---|
| admin 限定 | staff / dealer / salon は再送不可（誤操作防止） |
| reason 必須 | 再送理由を必ず記録（何度目か・どんな判断か） |
| status=failed のみ対象 | pending / sent は再送対象外 |
| 短時間連打防止 | 同一ログへの再送は 60 秒クールダウン |

#### admin 手動 resolve の制約

| 制約 | 理由 |
|---|---|
| admin 限定 | pending の強制確定は特権操作 |
| 5 分経過後のみ | 送信処理との競合防止（§2.5 の Stage 3 リトライは 1-2 秒で完了する） |
| reason 必須 | 何を根拠に sent / failed に確定したか記録 |
| targetStatus='sent' 時は sesMessageId 必須 | SendGrid ダッシュボードから確認した実 ID を要求 |

#### 通知設計（§3 で詳細）

- Stage 2 / Stage 3 失敗時は admin に即時通知（メール / Slack）
- 通知内容：kickbackId / errorMessage / 推奨アクション（再送 / resolve）

### §2.10 段階運用上の解除条件・停止条件

#### 第 2 段階の位置づけ

- **目的**：送信機構の二重防止を **テスト代理店 1 件のみ** で本番検証する
- **期間**：本番環境で 1 か月
- **対象**：`settings/rt_company.testDealerCode` で指定された 1 代理店のみ（現状 J0015）
- **送信方法**：**手動送信のみ**（Scheduler 自動化は第 3 段階）

#### 第 2 段階で行うこと

1. 自動送信関数（`sendSettlementEmail`）をデプロイ（ただし Scheduler 連携なし）
2. SettlementManage UI から手動トリガーでの送信を検証
3. pending-first ロジック・3 段階遷移・Stage 3 リトライを実地確認
4. 二重送信防止（409 Conflict）を実地確認
5. 再送機能・resolve 機能を実地確認

#### 解除条件（第 3 段階に進んでよい条件）

以下 5 条件を **すべて** 満たした場合のみ、第 3 段階（段階解放）に進む。

| # | 条件 | 確認方法 |
|---|---|---|
| 1 | テスト代理店への送信が 1 か月間エラー 0 件 | `settlementEmailLogs` の status=failed 合計が 0 |
| 2 | 二重送信 0 件 | 同一 kickbackId に対して status=sent が 1 件のみ |
| 3 | pending 残留 0 件 | 5 分以上経過した pending が 0 件 |
| 4 | SES 成功 + Firestore 更新の整合性 100% | `isSettlementSent()` で sent 判定された全件が 3 条件揃っている |
| 5 | 手動再送・resolve 機能が 1 回以上実地検証済み | 意図的に failed を起こして再送を通す |

#### 停止条件（即座に自動送信を止める条件）

以下のいずれか **1 つでも** 発生した場合、即座に自動送信を停止する。

| # | 条件 | 判定単位 |
|---|---|---|
| 1 | **二重送信を 1 件でも検知**（件数問わず即停止） | 都度検知（§2.11 の二重送信検知） |
| 2 | **Stage 3 失敗が 1 回でも発生（v0.4: 即停止 + CRITICAL 通知）** | 都度検知（§2.5 Stage3 ロジック内で自動停止） |
| 3 | **pending 長期残留（10 分超）が 1 件でも発生（v0.4 追加）** | 10 分毎検知（§2.11 detectStalePending） |
| 4 | **送信整合性不一致（A/B/C パターン）が 1 件でも発生（v0.4 追加）** | 日次検知（§2.8 detectSentInconsistency） |
| 5 | SES エラー率 5% 超（送信試行数に対する failed 数） | 1 週間単位で集計 |
| 6 | 手動再送で意図と異なる結果が 1 件でも発生 | 都度検知 |
| 7 | 社長判断で停止指示 | 随時 |

#### 停止方法

§1.9 と同じく `settings/settlement_automation.enabled = false` で即時停止。
自動送信 Scheduler（第 3 段階以降）がこのフラグを見て動作を中断する。

手動送信（第 2 段階）は `enabled` とは別に、UI 側で送信ボタンを非表示にする
フラグを `settings/rt_company.settlementManualSendDisabled = true` として追加する。

```javascript
// settings/rt_company
{
  settlementManualSendDisabled: false,  // true で手動送信 UI も全停止
  settlementManualSendDisabledAt: null,
  settlementManualSendDisabledBy: null,
  settlementManualSendDisabledReason: null,
}
```

### §2.11 第 2 段階の検証計画

#### 検証期間

- **開始**: §1〜§3 レビュー承認 + §1 第 1 段階合格後の任意日
- **終了**: 開始から 1 か月経過 + 解除条件 5 点すべて達成時点

#### 観測項目

| # | 項目 | 観測方法 |
|---|---|---|
| 1 | Stage 1 の pending 作成が毎回成功 | `settlementEmailLogs` に pending 記録が確実に残る |
| 2 | Stage 2 の SES 送信が成功 | `sesMessageId` が記録される |
| 3 | Stage 3 の status=sent 遷移が成功 | `isSettlementSent()` が true を返す |
| 4 | 二重送信試行が 409 Conflict で拒否 | 実地で同一精算に 2 回送信して確認 |
| 5 | failed からの手動再送が成功 | 意図的に API キー不正で failed を作り、再送で sent に |
| 6 | pending 残留の resolve が成功 | 5 分経過後に resolveSettlementEmailLog で sent 確定 |
| 7 | 代理店側にメール到達（本文・BCC 非表示） | 実メール受信確認 3 点（§2026-04-19 の送信テストで検証済） |
| 8 | isTest=true のテスト清算書でのみ件名プレフィクスが付く | 本番実データに誤って付かないことを確認 |
| 9 | pending 長期残留 0 件 | `detectStalePending` の 10 分毎チェックで 0 件継続 |
| 10 | 整合性不一致 0 件（A/B/C パターン） | `detectSentInconsistency` の日次チェックで 0 件継続 |

#### 二重送信検知クエリ（§2.10 停止条件 #1 対応）

§1.10 の二重作成検知と同様、2 系統で起動する。

| # | タイミング | 起動方法 | 目的 |
|---|---|---|---|
| 1 | 送信処理完了直後 | `sendSettlementEmail` の最後で検知ロジック呼び出し | 即検知 |
| 2 | 毎日 01:00 JST | Cloud Scheduler 独立ジョブ | 日次保険 |

```javascript
// Cloud Functions: detectDuplicateSettlementEmails
//
// 目的: 同一 kickbackId に対して status=sent のログが 2 件以上ないか検知
//       （docId 固定なので原理的に発生しないが、意味的重複を検知する）

async function detectDuplicateEmails() {
  const snap = await db.collection('settlementEmailLogs')
    .where('status', '==', 'sent')
    .get()

  const seen = new Map()  // key: kickbackId, value: [logId, ...]
  for (const doc of snap.docs) {
    const kickbackId = doc.data().kickbackId
    if (!kickbackId) continue
    if (!seen.has(kickbackId)) seen.set(kickbackId, [])
    seen.get(kickbackId).push(doc.id)
  }

  const duplicates = []
  for (const [kickbackId, ids] of seen) {
    if (ids.length > 1) duplicates.push({ kickbackId, logIds: ids })
  }

  if (duplicates.length > 0) {
    // 停止条件 #1 発動
    await db.doc('settings/settlement_automation').update({
      enabled: false,
      disabledAt: FieldValue.serverTimestamp(),
      disabledBy: 'duplicate_email_detector',
      disabledReason: `二重送信検知: ${JSON.stringify(duplicates).slice(0, 500)}`,
    })
    await notifyAdmin({
      severity: 'critical',
      title: '【緊急】二重送信を検知しました',
      body: `自動送信を即停止しました。詳細: ${JSON.stringify(duplicates, null, 2)}`,
    })
  }
}
```

#### pending 長期残留検知（v0.4 追加 / 必須2）

Stage3 失敗が起きた場合（v0.4 で即停止扱いに変更）や、
手動再送中に処理が中断した場合、`status=pending` が長時間残留しうる。

これを検知する独立した Cloud Functions を追加する。

| 項目 | 設計 |
|---|---|
| 起動方法 | Cloud Scheduler（毎分 01:00 / 11:00 / 21:00 / 31:00 / 41:00 / 51:00 など、10分毎） |
| 検知条件 | `settlementEmailLogs.status === 'pending'` かつ `updatedAt < now - 10分` |
| 対応 | admin に通知 + `settings/settlement_automation.enabled = false` で即停止 |
| 閾値 | 10 分（Stage3 の 3 回リトライ最大 1.5 秒 + SES 送信最大 60 秒を考慮して余裕を持たせる） |

```javascript
// Cloud Functions: detectStalePending（10分毎実行）

const STALE_PENDING_THRESHOLD_MS = 10 * 60 * 1000  // 10分

async function detectStalePending() {
  const now = Date.now()
  const threshold = new Date(now - STALE_PENDING_THRESHOLD_MS)

  const snap = await db.collection('settlementEmailLogs')
    .where('status', '==', 'pending')
    .where('updatedAt', '<', threshold)
    .get()

  if (snap.empty) return

  const stale = snap.docs.map((d) => ({
    logId: d.id,
    kickbackId: d.data().kickbackId,
    attemptCount: d.data().attemptCount || 1,
    createdAt: d.data().createdAt?.toDate?.()?.toISOString() || 'unknown',
    updatedAt: d.data().updatedAt?.toDate?.()?.toISOString() || 'unknown',
    stalledMinutes: Math.floor((now - d.data().updatedAt.toMillis()) / 60000),
  }))

  // 即停止
  await db.doc('settings/settlement_automation').update({
    enabled: false,
    disabledAt: FieldValue.serverTimestamp(),
    disabledBy: 'stale_pending_detector',
    disabledReason: `pending 長期残留 ${stale.length} 件検知（10分超）`,
  })

  await notifyAdmin({
    severity: 'critical',
    title: '【緊急】pending 長期残留を検知しました',
    body: `自動送信を即停止しました。詳細:\n${JSON.stringify(stale, null, 2)}`,
  })

  await db.collection('settlementStalePendingLogs').add({
    runAt: FieldValue.serverTimestamp(),
    staleCount: stale.length,
    staleLogs: stale,
  })
}
```

#### pending 長期残留の復旧フロー

1. 検知通知を admin が受信
2. SendGrid ダッシュボードで各 kickbackId の実送信状況を確認
3. 実送信済み → `resolveSettlementEmailLog({ targetStatus: 'sent', sesMessageId, reason })` で sent 確定
4. 実送信未済 → `resolveSettlementEmailLog({ targetStatus: 'failed', reason })` で failed 確定
5. 全件処理後 `settings/settlement_automation.enabled = true` に戻して再開

#### manualResend の対象拡張（v0.4 追加 / v0.5 安全策強化）

旧案（v0.3）では manualResend の対象は `status === 'failed'` のみだった。
本線レビュー指摘により、**「長時間 pending（10分超）」も手動再送対象に含める** ように拡張する。

#### 原則：未確認 pending に直接 resend はしない（v0.5 強化）

**重要**：UI のチェックボックスだけでは再送を許可しない。

長時間 pending からの再送は、以下 **2 経路のいずれか** を事前に通過している必要がある。
これに満たないリクエストは Cloud Functions 側で throw する。

| 経路 | 事前条件 | 判定フィールド |
|---|---|---|
| **A. failed 経由** | `resolveSettlementEmailLog({ targetStatus: 'failed', reason })` 済み | `status === 'failed'` に遷移済み |
| **B. admin 専用承認** | admin が明示承認フラグを記録済み | `manualResendApprovedAt` / `manualResendApprovedBy` が存在 |

UI のチェックボックスは「admin の注意喚起」として残すが、それ **だけ** では再送許可の根拠にならない。
Cloud Functions 側は Firestore ドキュメントの状態を見て判定する。

#### 2 経路の違い

**経路 A（failed 経由・推奨）**

長時間 pending を `resolveSettlementEmailLog` でいったん `failed` に落としてから、通常の failed 再送として扱う。

```
長時間 pending 検知
  ↓
admin が SendGrid ダッシュボードで実送信を確認
  ↓ 未送信と判定
resolveSettlementEmailLog({ targetStatus: 'failed', reason: '...' })
  ↓ status が failed に遷移
manualResend（通常フロー）
```

この経路は「一度 failed に落とす」という明示的な状態変化を経るため、監査ログが明瞭。

**経路 B（admin 専用承認・緊急時のみ）**

`resolveSettlementEmailLog` を経由せず、admin が直接「承認フラグ」を立てる経路。
緊急時や、resolveSettlementEmailLog に何らかの不具合がある場合のフォールバック。

```javascript
// admin 専用承認の記録
await logRef.update({
  manualResendApprovedAt: FieldValue.serverTimestamp(),
  manualResendApprovedBy: adminUid,
  manualResendApprovedByEmail: adminEmail,
  manualResendApprovalReason: reason,  // 必須・詳細必須
})
```

承認フラグは **1 回の manualResend につき 1 回有効**（再送完了時にクリアされる）。
承認フラグが残った状態で複数回再送できないようにする。

#### Cloud Functions 側の実装

```javascript
// Cloud Functions: manualResendSettlementEmail（v0.5 強化版）
async function manualResend({ kickbackId, reason }) {
  const logRef = db.collection('settlementEmailLogs').doc(kickbackId)
  const snap = await logRef.get()
  if (!snap.exists) throw new HttpsError('not-found', '対象ログなし')

  const log = snap.data()
  const now = Date.now()
  const updatedAtMs = log.updatedAt?.toMillis?.() || 0

  // === ケース1: 通常の failed からの再送 ===
  if (log.status === 'failed') {
    // 60 秒クールダウンのみ
    if (log.lastResendAttemptAt && now - log.lastResendAttemptAt.toMillis() < 60 * 1000) {
      throw new HttpsError('resource-exhausted', '60秒クールダウン中')
    }
    // 通常フロー（Stage 1 → 2 → 3）
    return await runResendStages({ log, logRef, reason, fromStalePending: false })
  }

  // === ケース2: 長時間 pending（10分超）からの再送 ===
  const isStalePending =
    log.status === 'pending' && now - updatedAtMs > 10 * 60 * 1000

  if (!isStalePending) {
    throw new HttpsError(
      'failed-precondition',
      `再送不可: status=${log.status}${log.status === 'pending' ? '（10分未経過）' : ''}`,
    )
  }

  // v0.5 追加: 未確認 pending への直接 resend は禁止
  //   経路A（failed 経由）または 経路B（admin 専用承認）のいずれかが必須
  const hasAdminApproval =
    log.manualResendApprovedAt &&
    log.manualResendApprovedBy &&
    (now - log.manualResendApprovedAt.toMillis() < 10 * 60 * 1000)  // 承認は10分有効

  if (!hasAdminApproval) {
    throw new HttpsError(
      'failed-precondition',
      '長時間 pending からの直接再送は不可です。' +
      '先に resolveSettlementEmailLog({ targetStatus: "failed" }) で failed に落とすか、' +
      'admin 専用承認フラグ（manualResendApprovedAt）を記録してください。',
    )
  }

  // 5 分クールダウン（stale pending は通常より厳しい）
  if (log.lastResendAttemptAt && now - log.lastResendAttemptAt.toMillis() < 5 * 60 * 1000) {
    throw new HttpsError('resource-exhausted', '5分クールダウン中')
  }

  // 承認フラグは 1 回きりで消費（再送完了後にクリア、または失敗時もクリア）
  return await runResendStages({
    log,
    logRef,
    reason,
    fromStalePending: true,
    clearApprovalOnComplete: true,
  })
}
```

#### 長時間 pending からの再送の安全策（v0.5 更新）

| 安全策 | 内容 |
|---|---|
| **直接 resend 禁止（v0.5 強化）** | UI チェックボックスだけでは不可。経路 A（failed 経由）または 経路 B（admin 専用承認）必須 |
| 承認フラグの有効期限 | `manualResendApprovedAt` から 10 分以内のみ有効（古い承認の再利用を防ぐ） |
| 承認フラグは 1 回消費 | 再送完了（成功・失敗どちらも）で自動クリア |
| reason 必須 | 通常の再送より詳細な理由を要求（文字数下限を設ける） |
| 監査強化 | `resendFromStalePending: true` フラグを `resendHistory[]` に記録 |
| cool-down | stale pending からの再送は 5 分（通常 failed 再送は 60 秒） |

#### なぜ UI checkbox だけでは不可なのか

| 観点 | UI checkbox のみ | Firestore 状態判定（v0.5） |
|---|---|---|
| Cloud Functions の判定根拠 | クライアント申告（信頼できない） | サーバ側 Firestore ドキュメント |
| 回避経路 | DevTools で checkbox 強制 ON にできる | Firestore rules + Cloud Functions で遮断 |
| 監査性 | ログ残すが根拠薄弱 | 明示的な状態遷移（failed 経由）または承認記録 |

クライアント側の UI 制約は「admin の注意喚起」にはなるが、**セキュリティ境界にはならない**。
Cloud Functions 側で Firestore の実状態を見て判定することで、物理的に不可能な経路にする。

#### 承認フラグの rules

```javascript
// firestore.rules
match /settlementEmailLogs/{docId} {
  // manualResendApprovedAt / ApprovedBy の書き込みは Cloud Functions のみ
  // クライアントからは設定不可
  allow read: if hasValidAdminRole();
  allow create, update, delete: if false;
}
```

admin 専用承認フラグを立てる専用 Cloud Function `approveStalePendingResend` を用意し、
admin の認証 + reason 必須 + 詳細監査ログで厳密に管理する。

長時間 pending は「SES では既に送信済み」の可能性が現実的にある。
**確認せず再送すると二重送信事故になる** ため、通常の failed 再送より厳しい安全策を課す。

#### 検証成功条件

観測項目 10 点 **すべて成功** かつ §2.10 解除条件 5 点 **すべて達成** で §2 本番合格。
1 点でも失敗・未達成の場合は第 3 段階を延期し、§2 の修正・再検証から始める。

#### 検証失敗時の復旧手順

1. `settings/rt_company.settlementManualSendDisabled = true` で手動送信 UI を即停止
2. 必要に応じて `settings/settlement_automation.enabled = false` も併用
3. `settlementEmailLogs` と代理店実受信箱を照合し、二重送信が発生している場合は代理店へ即謝罪連絡
4. 根本原因を特定
5. §2 の本文を修正し、再レビューを受けてから再稼働

---

## §3 監査ログ（settlementRunLogs / settlementEmailLogs）

### §3.1 目的と原則

#### 目的

Phase 2 自動化（月次自動作成・自動送信・再実行制御）で発生する **すべてのイベントを監査可能な形で記録** し、
事故発生時の原因追跡・責任所在の明確化・再発防止策の策定を可能にする。

#### §1 / §2 との関係

§1・§2 の各節で散在していたログ仕様を §3 に集約する。§3 は以下の役割を担う。

- ログコレクションの責務マップを一元提示（§3.2）
- 各コレクションの正式スキーマ定義（§3.3〜§3.5）
- append-only と書き込み境界の総合ポリシー（§3.6）
- 通知・保持期間・監査クエリ・PII 方針（§3.7〜§3.10）

#### 原則

- **2 系統分離**：作成側（settlementRunLogs）と送信側（settlementEmailLogs）を明確に分ける
- **append-only**：一度書いたログは update / delete しない（rules 層で物理保証）
- **Admin SDK も含めた書き込み境界**：Cloud Functions 経由のみ書き込み可能。それ以外は read のみ
- **PII 最小化**：メール本文・フル宛先・金額明細は残さず、集計値とドメイン情報に留める
- **再現性重視**：事故が起きたとき、ログだけで「何が起きたか」を時系列で再構築できる粒度

#### 判断基準（§0.2 の再掲）

1. **二重防止**：ログ自身の二重書き込みも防ぐ（§3.3 / §3.4 の docId ポリシー）
2. **監査性**：ログがログとして機能する最優先条件
3. **停止可能性**：異常検知時にログが足枷にならない（通知経路の独立性）
4. **運用の便利さ**：監査性を犠牲にしない範囲で便利にする

### §3.2 コレクション全体像

Phase 2 で使用する監査コレクションは **5 つ**。責務・docId・起源・書き込みタイミングを一覧化する。

| # | コレクション | 責務 | docId 方式 | 書き込み起源 | 参照節 |
|---|---|---|---|---|---|
| 1 | `settlementRunLogs` | 作成バッチ実行単位の記録 | `addDoc`（自動採番） | `createMonthlySettlement` 実行終了時 | §3.3 |
| 2 | `settlementEmailLogs` | 送信 1 通単位の記録 | `{kickbackId}`（固定） | `sendSettlementEmail` の Stage 1〜3 | §3.4 |
| 3 | `settlementDuplicateChecks` | 二重作成・二重送信の検知結果 | `addDoc`（自動採番） | `detectDuplicates` / `detectDuplicateEmails` | §3.5 |
| 4 | `settlementInconsistencyChecks` | 送信整合性の不一致検知結果 | `addDoc`（自動採番） | `detectSentInconsistency` | §3.5 |
| 5 | `settlementStalePendingLogs` | pending 長期残留の検知結果 | `addDoc`（自動採番） | `detectStalePending` | §3.5 |

#### 参照関係の整理

```
settlementRunLogs (作成バッチ単位)
       │
       │ runLogId 参照
       ▼
   kickbacks / invoices (精算本体)
       │
       │ docId 一致
       ▼
settlementEmailLogs (送信単位)
       │
       │ kickbackId 参照
       ▼
   [各検知ログ]
     ├─ settlementDuplicateChecks
     ├─ settlementInconsistencyChecks
     └─ settlementStalePendingLogs
```

精算本体（kickbacks / invoices）は **監査ログではない**（業務データ）が、
監査ログから参照される中心ドキュメントとして位置付ける。

#### settlementRunLogs と settlementEmailLogs を分離する根拠

| 観点 | settlementRunLogs | settlementEmailLogs |
|---|---|---|
| 単位 | 月次バッチ 1 実行 | 送信 1 通 |
| 粒度 | 全代理店分の集計 | 1 代理店 1 月分 |
| 発火頻度 | 月 1 回（手動含めて年 20 回程度） | 代理店数 × 月（年 数百件） |
| 事故種別 | 作成漏れ・作成失敗・スキップ理由不明 | 未送信・二重送信・宛先誤り |
| 冪等キー | 不要（addDoc） | 必要（kickbackId 固定） |

**事故調査の切り分けを明確にするため**、粒度も事故種別も異なる 2 つを同一コレクションに混ぜない。

### §3.3 settlementRunLogs 詳細仕様

#### 目的

月次バッチ（`createMonthlySettlement`）の 1 回の実行について、対象件数・作成件数・スキップ件数・失敗件数を
集計して 1 ドキュメントに記録する。

#### docId

`addDoc` による自動採番（§1.8 で確定済）。

```javascript
const logRef = await db.collection('settlementRunLogs').add({ /* data */ })
```

#### 完全スキーマ

```javascript
{
  // --- 基本情報 ---
  targetMonth: '2026-04',                    // 対象月（YYYY-MM）
  trigger: 'scheduler' | 'manual',           // 起動経路
  runAt: <Timestamp>,                        // serverTimestamp
  operator: 'scheduler' | '<uid>',           // scheduler or admin uid
  operatorEmail: '<email>' | null,           // manual 時のみ
  runLogId: '<auto-id>',                     // 自己参照（arrayUnion で精算本体に埋め込む用）

  // --- 対象件数 ---
  targetDealerCount: 23,                     // 送信対象の全代理店数
  createdCount: 20,                          // tx.create 成功
  skippedCount: 2,                           // 既存 or 条件未達でスキップ
  failedCount: 1,                            // 失敗（ドキュメント作成に至らず）

  // --- 詳細配列（最大 500 件まで） ---
  // 500件超の場合は後述の「分割保存」で対応
  skipped: [
    { dealerCode: 'J0015', reason: 'already_exists', existingDocId: 'kb_J0015_2026-04' },
    { dealerCode: 'J0016', reason: 'no_kbGroup' },
  ],
  failed: [
    { dealerCode: 'J0020', errorMessage: 'Bカート API timeout', retryable: false },
  ],

  // --- ステータス ---
  status: 'success' | 'partial_success' | 'failed' | 'aborted',
  //   success:         failedCount === 0
  //   partial_success: createdCount > 0 かつ failedCount > 0
  //   failed:          createdCount === 0 かつ failedCount > 0
  //   aborted:         途中で enabled=false により中断

  // --- 時刻・計測 ---
  durationMs: 42153,                         // 開始〜終了の経過時間
  createdAt: <Timestamp>,                    // serverTimestamp

  // --- Phase 2 以降の拡張用 ---
  scriptVersion: '2026-04-20.v1',            // 実装バージョン
  environmentFlags: {                        // 実行時の automation 状態
    enabledAtStart: true,
    enabledAtEnd: true,
  },
}
```

#### スキップ理由コード（§1.8 から継承）

| reason | 意味 |
|---|---|
| `already_exists` | 既に作成済み（正常スキップ） |
| `no_kbGroup` | 代理店の kbGroup 未設定 |
| `dealer_inactive` | `dealers.active === false` |
| `no_target_orders` | 対象月に注文 0 件 |
| `data_inconsistency` | Bカートと Firestore の不整合 |
| `automation_disabled_midrun` | バッチ途中で enabled=false 検知 |

#### 大量失敗時の分割保存

`skipped[]` / `failed[]` は Firestore ドキュメント 1MB 制限を避けるため **最大 500 件** まで。
それを超える場合は以下のサブコレクション形式で分割保存する。

```
settlementRunLogs/{runLogId}
  ├─ skipped[] : 最大 500 件（最新優先）
  ├─ failed[]  : 最大 500 件（最新優先）
  └─ overflow/ : サブコレクション（500件超分）
        ├─ chunk_001 : { skipped: [...], failed: [...] }
        └─ chunk_002 : { ... }
```

#### 代表クエリ例

**A. 直近 1 か月の実行履歴を取得（管理画面）**

```javascript
const snap = await db.collection('settlementRunLogs')
  .where('targetMonth', '==', '2026-04')
  .orderBy('runAt', 'desc')
  .get()
// 結果: 4月分のバッチ実行が scheduler 1回 + manual N回 の全履歴
```

**B. 失敗が発生したバッチのみ抽出**

```javascript
const snap = await db.collection('settlementRunLogs')
  .where('status', 'in', ['failed', 'partial_success'])
  .orderBy('runAt', 'desc')
  .limit(20)
  .get()
```

**C. 特定代理店が過去にスキップされた履歴を追う**

```javascript
// skipped は配列なので array-contains ではなく、dealerCode を抽出したセカンダリインデックスが必要
// 2026-04 時点では小規模なので、全件取得してクライアント側フィルタでも許容
const snap = await db.collection('settlementRunLogs')
  .orderBy('runAt', 'desc')
  .limit(12)  // 直近 1 年
  .get()
const history = snap.docs
  .map(d => d.data())
  .filter(r => r.skipped?.some(s => s.dealerCode === 'J0015'))
```

**D. scheduler 実行のみを集計（自動化の稼働率確認）**

```javascript
const snap = await db.collection('settlementRunLogs')
  .where('trigger', '==', 'scheduler')
  .where('targetMonth', '>=', '2026-01')
  .where('targetMonth', '<=', '2026-12')
  .orderBy('targetMonth')
  .get()
// 結果: 2026 年の毎月 1 回の自動実行記録
```

### §3.4 settlementEmailLogs 詳細仕様

#### 目的

送信 1 通に対して 1 ドキュメントを記録する。同一精算（同一 kickbackId）に対する
複数回の送信試行は **同一ドキュメントの attempt 履歴として追記** する（新規ドキュメントを作らない）。

#### docId

**`{kickbackId}` または `{invoiceId}` 固定**（§2.2 で確定済）。

```
例: kb_J0015_2026-04
例: invoice_J0021_2026-04
```

#### 完全スキーマ

```javascript
{
  // --- 基本情報 ---
  kickbackId: 'kb_J0015_2026-04',            // docId と一致
  dealerCode: 'J0015',
  dealerName: 'featuring one',
  month: '2026-04',
  type: 'kb' | 'invoice',

  // --- ステータス ---
  status: 'pending' | 'sent' | 'failed',
  attemptCount: 2,                           // Stage1 を通過した総回数

  // --- 送信先・送信経路 ---
  toEmail: 'sato.featuring.one@gmail.com',
  ccCount: 0,
  ccDomains: [],                             // フルアドレスは残さない（§3.10）
  ccSource: null,                            // 'request' | 'settings' | null
  bccCount: 1,
  bccDomains: ['@royaltrust.jp'],
  bccSource: 'settings',
  isTestSend: false,

  // --- 操作者 ---
  sentBy: '<admin-uid>',
  sentByEmail: 'admin@royaltrust.jp',

  // --- SES 結果 ---
  sesMessageId: 'eIP3hdluQS6KnFKohJqLvA',    // SendGrid x-message-id
  errorMessage: null,                        // failed 時のみ

  // --- 時刻 ---
  createdAt: <Timestamp>,                    // Stage1 初回作成時
  updatedAt: <Timestamp>,                    // 最新の update
  sentAt: <Timestamp>,                       // Stage3 成功時のみ
  lastResendAttemptAt: <Timestamp> | null,   // クールダウン判定用

  // --- 再送履歴（最新 10 件のみ、ISO 文字列） ---
  resendHistory: [
    {
      resentAt: '2026-04-20T15:32:11.234Z',
      resentBy: '<admin-uid>',
      resentByEmail: 'admin@royaltrust.jp',
      previousStatus: 'failed',
      previousError: 'SendGrid 401',
      fromStalePending: false,
    },
  ],

  // --- stale pending からの resend 承認フラグ（§2.11 v0.5）---
  manualResendApprovedAt: null,
  manualResendApprovedBy: null,
  manualResendApprovedByEmail: null,
  manualResendApprovalReason: null,

  // --- resolve 履歴（pending 残留解除）---
  resolvedBy: null,
  resolvedByEmail: null,
  resolvedAt: null,
  resolvedReason: null,
}
```

#### 許可される状態遷移（§2.6 より）

```
(なし) → pending → sent (最終)
                → failed → pending (再送) → sent (最終)
                        → failed (再送失敗)
pending → sent (resolve 手動確定)
pending → failed (resolve 手動失敗確定)
```

#### resendHistory の上限管理

最大 10 件を保持し、超過分は古い順に削除する。

```javascript
// 書き込み時のロジック（Cloud Functions 側）
const current = snap.data()?.resendHistory || []
const updated = [...current, newEntry].slice(-10)  // 新しい順で最新 10 件
await logRef.update({ resendHistory: updated })
```

11 件目以降の履歴が必要なケースは極めて稀（= 1 通に対して 11 回以上再送する状況）。
その場合は `resolvedReason` や `errorMessage` にまとめ、個別案件として手動記録する。

#### 代表クエリ例

**A. 送信済み判定（§2.8 の isSettlementSent）**

```javascript
// UI / バッチ共通で使う関数を再掲
function isSettlementSent({ emailLog, settlement }) {
  return (
    emailLog?.status === 'sent' &&
    !!emailLog?.sesMessageId &&
    !!settlement?.sentAt
  )
}

// 使用例: 特定精算が完全送信済みか判定
const logSnap = await db.collection('settlementEmailLogs').doc(kickbackId).get()
const settSnap = await db.collection('kickbacks').doc(kickbackId).get()
const sent = isSettlementSent({
  emailLog: logSnap.data(),
  settlement: settSnap.data(),
})
```

**B. 特定代理店の送信履歴（過去 12 か月）**

```javascript
const snap = await db.collection('settlementEmailLogs')
  .where('dealerCode', '==', 'J0015')
  .orderBy('createdAt', 'desc')
  .limit(24)  // 24 = 12 か月 × 2 種別（kb / invoice）
  .get()
```

**C. pending 残留の検知（§2.11 detectStalePending）**

```javascript
const threshold = new Date(Date.now() - 10 * 60 * 1000)  // 10 分前
const snap = await db.collection('settlementEmailLogs')
  .where('status', '==', 'pending')
  .where('updatedAt', '<', threshold)
  .get()
// 10 分以上 pending のまま残留しているログ
```

**D. failed 一覧（admin の手動再送候補）**

```javascript
const snap = await db.collection('settlementEmailLogs')
  .where('status', '==', 'failed')
  .orderBy('updatedAt', 'desc')
  .limit(50)
  .get()
```

**E. 整合性チェック（§2.8 detectSentInconsistency パターンA）**

```javascript
// emailLog=sent なのに settlement.sentAt が null のケースを拾う
const logsSnap = await db.collection('settlementEmailLogs')
  .where('status', '==', 'sent')
  .get()

const inconsistencies = []
for (const logDoc of logsSnap.docs) {
  const log = logDoc.data()
  const colName = log.kickbackId.startsWith('kb_') ? 'kickbacks' : 'invoices'
  const settSnap = await db.collection(colName).doc(log.kickbackId).get()
  if (settSnap.exists && !settSnap.data().sentAt) {
    inconsistencies.push({ kickbackId: log.kickbackId, pattern: 'A' })
  }
}
```

### §3.5 補助コレクション仕様

3 つの検知ログコレクションは共通構造を持つ。

#### 共通構造

```javascript
{
  runAt: <Timestamp>,                        // 検知実行時刻
  triggeredBy: 'post_batch' | 'scheduled_daily' | 'scheduled_10min' | 'manual',
  ... (コレクション固有のフィールド)
}
```

#### settlementDuplicateChecks

二重作成・二重送信の検知結果。

```javascript
{
  runAt: <Timestamp>,
  triggeredBy: 'post_batch' | 'scheduled_daily',
  targetMonth: '2026-04' | null,             // post_batch 時のみ
  checkedCollections: ['kickbacks', 'invoices'],
  duplicatesFound: 0,
  duplicates: [
    // 0件なら空配列
    { collection: 'kickbacks', key: 'J0015|2026-04', docIds: ['kb_J0015_2026-04', 'duplicate_xxx'] },
  ],
}
```

#### settlementInconsistencyChecks

送信整合性の不一致検知結果（§2.8 パターン A/B/C）。

```javascript
{
  runAt: <Timestamp>,
  triggeredBy: 'scheduled_daily',
  checked: 42,                               // チェック対象ログ数
  inconsistenciesFound: 0,
  inconsistencies: [
    { pattern: 'A_sent_log_no_settlement_sentAt', kickbackId: '...', logId: '...' },
    { pattern: 'B_sent_without_messageId', kickbackId: '...', logId: '...' },
    { pattern: 'C_log_exists_settlement_missing', kickbackId: '...', logId: '...' },
  ],
}
```

#### settlementStalePendingLogs

pending 長期残留（10 分超）の検知結果（§2.11）。

```javascript
{
  runAt: <Timestamp>,
  triggeredBy: 'scheduled_10min',
  staleCount: 0,
  staleLogs: [
    {
      logId: 'kb_J0015_2026-04',
      kickbackId: 'kb_J0015_2026-04',
      attemptCount: 2,
      createdAt: '2026-04-20T14:00:00.000Z',
      updatedAt: '2026-04-20T14:00:30.000Z',
      stalledMinutes: 15,
    },
  ],
}
```

### §3.6 書き込み境界と append-only 保証

#### 書き込み境界の原則

| 境界 | 書き込み可否 | 手段 |
|---|---|---|
| **クライアント SDK**（ブラウザ） | ✗ **完全禁止** | rules で `allow create, update, delete: if false` |
| **Admin SDK**（Cloud Functions） | ✅ **create のみ** | rules バイパス + 運用ルール |
| **Admin SDK**（手動スクリプト） | ⚠ **例外時のみ** | 社長承認 + 監査記録必須 |

#### クライアント SDK への rules 設定（全コレクション共通）

```javascript
// firestore.rules
match /settlementRunLogs/{id} {
  allow read: if hasValidAdminRole();
  allow create, update, delete: if false;
}
match /settlementEmailLogs/{id} {
  allow read: if hasValidAdminRole();
  allow create, update, delete: if false;
}
match /settlementDuplicateChecks/{id} {
  allow read: if hasValidAdminRole();
  allow create, update, delete: if false;
}
match /settlementInconsistencyChecks/{id} {
  allow read: if hasValidAdminRole();
  allow create, update, delete: if false;
}
match /settlementStalePendingLogs/{id} {
  allow read: if hasValidAdminRole();
  allow create, update, delete: if false;
}
```

クライアント側からは **admin だけが read 可能**、write は完全禁止。

#### Admin SDK の運用ルール

Admin SDK は rules をバイパスするため、rules 層では防げない。
以下を **Cloud Functions のコード側で必ず守る**：

| ルール | 実装 |
|---|---|
| 1. create は Cloud Functions 関数内のみ | 該当する関数名一覧（§3.2）以外から書かない |
| 2. update / delete は一切しない | コードレビューで明示的にブロック（lint ルール検討） |
| 3. 例外時の書き換えは専用関数のみ | `resolveSettlementEmailLog` のような承認付き関数 |

#### append-only 保証（2 層防衛）

| 層 | 防衛内容 | 有効範囲 |
|---|---|---|
| A. rules 層 | `allow update, delete: if false` | クライアント SDK |
| B. Cloud Functions コード規約 | update / delete を書かない | Admin SDK |

**重要な例外**：`settlementEmailLogs` の status 遷移（pending → sent / failed 等）は
append-only 原則の例外とする。理由：

- status 遷移は「新規ログを作る」のではなく「既存ログの進行状態を更新する」性質
- 同一 kickbackId に対して複数ログを作らないことが §2.2 の docId 固定の根拠
- ただし過去の状態は `resendHistory[]` や `attemptCount` で保存される

このため **`settlementEmailLogs` のみ Cloud Functions 経由で update 許可**（ただしクライアントからは完全禁止）。
他の 4 コレクションは Cloud Functions からも update しない厳格 append-only。

| コレクション | Cloud Functions update | 例外理由 |
|---|---|---|
| settlementRunLogs | ✗ 禁止 | 実行単位の記録は不変 |
| settlementEmailLogs | ✅ 許可（status 遷移のみ） | docId 固定と両立させるため |
| settlementDuplicateChecks | ✗ 禁止 | 検知単位の記録は不変 |
| settlementInconsistencyChecks | ✗ 禁止 | 同上 |
| settlementStalePendingLogs | ✗ 禁止 | 同上 |

#### 物理削除の完全禁止

いかなる場合も Firestore の物理削除（`doc.delete()`）は行わない。
誤書き込み・テストデータの混入等があった場合は：

1. `isDeprecated: true` / `deprecatedAt` / `deprecatedBy` / `deprecatedReason` をセット
2. 論理削除フラグを読み取り側で除外するクエリに切り替え
3. アーカイブ時（§3.8）に物理削除ではなく BigQuery / GCS へ移送

### §3.7 admin への通知（notifyAdmin）

#### 目的

監査ログに記録されたイベントのうち、**即時の admin 判断が必要なもの** を人が気付ける形で届ける。

#### severity 階層

| severity | 意味 | 通知手段 | 例 |
|---|---|---|---|
| `info` | 参考情報。即対応不要 | Firestore `adminNotifications` コレクションのみ | バッチ正常終了 |
| `warning` | 要注意。24 時間以内の確認推奨 | 上記 + メール（admin のみ） | 部分成功（failed 1 件） |
| `critical` | 緊急。即時対応必須 | 上記 + 即時メール + SMS（将来）| Stage3 失敗・二重送信検知・pending 残留 |

#### notifyAdmin 関数の契約

```javascript
/**
 * admin への通知。Cloud Functions 内からのみ呼び出し可能。
 * @param {object} params
 * @param {'info'|'warning'|'critical'} params.severity
 * @param {string} params.title  - 100 文字以内
 * @param {string} params.body   - 本文（10000 文字以内）
 * @param {object} [params.context] - 関連する kickbackId / runLogId 等
 * @returns {Promise<{notificationId: string}>}
 */
async function notifyAdmin({ severity, title, body, context })
```

#### adminNotifications コレクション

通知は **まず Firestore に記録し、そこから各手段に fan-out する**。通知手段の障害がログ欠損に繋がらない設計。

```javascript
// adminNotifications/{auto-id}
{
  severity: 'critical',
  title: '【緊急】Stage3 失敗',
  body: '...',
  context: { kickbackId: '...', sesMessageId: '...' },
  source: 'stage3_failure_detector',         // どの関数が発火したか
  createdAt: <Timestamp>,
  deliveryStatus: {
    firestore: { status: 'success', at: <Timestamp> },
    email: { status: 'pending' | 'success' | 'failed', at: <Timestamp>, error: null },
    sms: { status: 'not_configured' },       // 将来
  },
  readBy: [],                                // admin が既読にしたユーザー uid
  acknowledgedAt: null,                      // admin が対応完了で承認した時刻
  acknowledgedBy: null,
}
```

#### 通知の append-only 保証

`adminNotifications` も §3.6 の append-only 原則に従う。
例外的に update が許されるのは以下のみ：

- `deliveryStatus` の fan-out 結果記録（Cloud Functions から）
- `readBy[]` への arrayUnion（admin UI から）
- `acknowledgedAt` / `acknowledgedBy`（admin が対応完了時、UI から）

その他のフィールド（severity / title / body / context）は不変。

#### 通知の冪等性

同じ事象に対して重複通知しないよう、通知元関数は冪等キーを持つ。

```javascript
// 例: Stage3 失敗通知の冪等キー
const dedupeKey = `stage3_failure_${kickbackId}_${Date.now() % 86400000}`
// 24 時間以内の同一イベントは 1 通のみ
```

### §3.8 ログ保持期間・アーカイブ

#### Firestore 保持期間

| コレクション | Firestore 保持 | アーカイブ先 |
|---|---|---|
| settlementRunLogs | **5 年** | BigQuery（5 年経過分） |
| settlementEmailLogs | **7 年** | BigQuery（法的保存義務を考慮） |
| settlementDuplicateChecks | 2 年 | GCS（JSON Lines） |
| settlementInconsistencyChecks | 2 年 | GCS（JSON Lines） |
| settlementStalePendingLogs | 2 年 | GCS（JSON Lines） |
| adminNotifications | 3 年 | BigQuery |

#### 採用理由

- **settlementEmailLogs が 7 年**：税務関連の帳票送信履歴として最長保持
- **settlementRunLogs が 5 年**：経営監査・税務調査での実行履歴参照を想定
- **検知ログが 2 年**：事故発生から 2 年遡れれば十分（運用実績から調整可）
- **adminNotifications が 3 年**：対応履歴の参照需要

#### アーカイブ運用

```
毎月 1 日 05:00 JST に Cloud Scheduler 起動
  ↓
Cloud Functions: archiveOldSettlementLogs
  ↓
  各コレクションで保持期間を超えたドキュメントを取得
  ↓
  BigQuery または GCS に書き込み
  ↓
  書き込み成功後、Firestore 側に isArchived: true を付与（物理削除はしない）
  ↓
  isArchived: true のものは UI 検索対象から外す
```

#### 物理削除の例外

- 原則、**Firestore からの物理削除は行わない**（§3.6）
- ただし BigQuery / GCS にアーカイブ済みかつ Firestore の使用容量が課金上限に近づいた場合、
  **社長承認 + 二重確認** で物理削除を許可する
- 物理削除時は `settlementArchiveAudit` コレクションに削除記録を残す

### §3.9 監査クエリと集計

#### 事故調査時の必須クエリパターン

**ケース 1: 特定精算（kickbackId）で何が起きたか時系列で追う**

```javascript
// 1. 精算本体
const settlement = await db.collection('kickbacks').doc(kickbackId).get()

// 2. 送信ログ（attempt 履歴含む）
const emailLog = await db.collection('settlementEmailLogs').doc(kickbackId).get()

// 3. 該当月のバッチ実行履歴
const runLogsSnap = await db.collection('settlementRunLogs')
  .where('targetMonth', '==', settlement.data().month)
  .orderBy('runAt', 'desc')
  .get()

// 4. 検知ログで言及されているか
const inconsistencySnap = await db.collection('settlementInconsistencyChecks')
  .orderBy('runAt', 'desc')
  .limit(30)  // 直近 30 日
  .get()
// inconsistencies[] の中に kickbackId が含まれるものを抽出
```

**ケース 2: ある期間に発生した全事故を一覧化**

```javascript
const from = new Date('2026-04-01')
const to = new Date('2026-04-30')

// バッチ失敗
const runFailsSnap = await db.collection('settlementRunLogs')
  .where('runAt', '>=', from)
  .where('runAt', '<=', to)
  .where('status', 'in', ['failed', 'partial_success'])
  .get()

// 送信失敗
const emailFailsSnap = await db.collection('settlementEmailLogs')
  .where('updatedAt', '>=', from)
  .where('updatedAt', '<=', to)
  .where('status', '==', 'failed')
  .get()

// 二重・不整合・pending 残留
const detections = await Promise.all([
  db.collection('settlementDuplicateChecks').where('runAt', '>=', from).where('runAt', '<=', to).get(),
  db.collection('settlementInconsistencyChecks').where('runAt', '>=', from).where('runAt', '<=', to).get(),
  db.collection('settlementStalePendingLogs').where('runAt', '>=', from).where('runAt', '<=', to).get(),
])
```

#### 月次サマリ集計

```javascript
// 月次 KPI（admin ダッシュボード用）
async function getMonthlySummary(targetMonth) {
  const [runLogs, emailLogs] = await Promise.all([
    db.collection('settlementRunLogs')
      .where('targetMonth', '==', targetMonth).get(),
    db.collection('settlementEmailLogs')
      .where('month', '==', targetMonth).get(),
  ])

  return {
    targetMonth,
    batchRunCount: runLogs.size,
    totalCreated: runLogs.docs.reduce((s, d) => s + (d.data().createdCount || 0), 0),
    totalFailed: runLogs.docs.reduce((s, d) => s + (d.data().failedCount || 0), 0),
    totalSent: emailLogs.docs.filter(d => d.data().status === 'sent').length,
    totalPending: emailLogs.docs.filter(d => d.data().status === 'pending').length,
    totalEmailFailed: emailLogs.docs.filter(d => d.data().status === 'failed').length,
    totalResends: emailLogs.docs.reduce((s, d) => s + (d.data().attemptCount || 1) - 1, 0),
  }
}
```

### §3.10 PII / 機密情報の扱い

#### 記録する情報・しない情報

| 情報 | 記録 | 形式 |
|---|---|---|
| メール本文 | ✗ | 一切残さない |
| フル宛先メールアドレス（To） | ✅ | `toEmail` に平文（送信責任の明確化のため）|
| CC / BCC のフルアドレス | ✗ | ドメインのみ記録 |
| CC / BCC の件数 | ✅ | `ccCount` / `bccCount` |
| CC / BCC のドメイン | ✅ | `ccDomains` / `bccDomains`（重複排除） |
| 精算金額明細 | ✗ | settlementRunLogs には残さない |
| 精算合計金額 | △ | settlement 本体にのみ記録（ログには残さない） |
| dealerCode / dealerName | ✅ | 業務識別のため必須 |
| SendGrid messageId | ✅ | `sesMessageId` |
| 操作者 uid / email | ✅ | 責任追跡のため必須 |
| 操作理由（reason） | ✅ | 最大 500 文字（切り詰め） |

#### toEmail を平文で残す理由

送信責任の明確化のため、**どのアドレスに送ったか** は完全な形で残す必要がある。
ただし以下の制約：

- `toEmail` は `settlementEmailLogs` のみに記録
- 他のログ（runLogs / 検知ログ / adminNotifications）には含めない
- admin 以外は読めない（rules で制限）

#### 平文記録を最小化する工夫

CC / BCC のように「多対多」になりうる項目はドメインのみ記録。
フルアドレスが必要な障害調査は SendGrid ダッシュボード（外部システム）に委ねる。

#### 誤って記録してしまった場合の対応

ログに誤って PII / 機密情報が記録された場合：

1. 物理削除はしない（append-only 原則）
2. `redactedFields: [...]` に該当フィールド名を追記
3. 元フィールドは `'<REDACTED>'` に置換（update で上書き）
4. `adminNotifications` に `severity: warning` で記録
5. コード側に同種の記録が発生しないよう修正

### §3.11 §1〜§3 全体の整合性確認

#### §3 で決まったことと §1 / §2 の対応

| §3 の決定 | §1 / §2 の関連箇所 | 整合状態 |
|---|---|---|
| settlementRunLogs は addDoc | §1.8 | ✅ 一致 |
| settlementEmailLogs は kickbackId 固定 | §2.2 | ✅ 一致 |
| 5 検知コレクション | §1.10, §2.11 | ✅ 一致 |
| append-only + 書き込み境界 | §1.4, §2.6 | ✅ 一致 |
| notifyAdmin severity 階層 | §2.5, §2.11 | ✅ 一致（§3 で統一） |
| 保持期間 | （§1 / §2 で未規定） | ✅ §3 で新規定義 |
| PII 方針 | （§2 で一部明記） | ✅ §3 で統一 |

#### 参照関係の整合性

```
kickbacks / invoices (本体)
  ├─ lastSendLogId ⇔ settlementEmailLogs.docId
  └─ sentAt ⇔ settlementEmailLogs.sentAt（3条件AND判定）

settlementRunLogs
  └─ （精算本体への直接参照は持たない；targetMonth で集約）

settlementEmailLogs
  └─ kickbackId ⇔ settlement 本体 docId（両方向）

検知ログ 3 種
  └─ 対象 kickbackId / logId を配列で保持
```

#### 事故起因時の再現性

Phase 2 運用中に事故が起きた場合、以下の情報があれば **完全に時系列再構築可能**：

1. `kickbackId`（事故対象の精算 ID）
2. 発生推定時刻（±1 時間の幅）
3. admin の uid（操作履歴を追う場合）

これだけあれば §3.9 の必須クエリパターンで全経路が追跡できる。

#### ログで追えないこと

以下は本設計書のスコープ外。別ルートで確認する：

- メール本文の実内容 → SendGrid ダッシュボード
- 代理店の実受信状況 → 代理店への直接確認
- Cloud Functions の stdout/stderr → Cloud Logging
- Firestore の read/write 課金詳細 → Cloud Console Billing

これらは監査ログには含めず、必要時に外部ソースと突合する運用とする。

---

---

## §4 以降

（§1〜§3 のレビュー承認まで起草禁止）

---

## 変更履歴

| 日付 | 版 | 変更内容 | 担当 |
|---|---|---|---|
| 2026-04-18 | v0.0 | 初期章立て策定、Phase 2 着手条件確定 | 社長 + Claude |
| 2026-04-20 | v0.1 | §1 起草完了 | Claude |
| 2026-04-20 | v0.2 | §1 軽微修正（ChatGPT レビュー反映 9点）：type enum 固定 / dealerCode 正規化 / Admin SDK bypass 明文化 / runLogs docId addDoc 採用 / エラー率条件修正 / 部分成功シナリオ追加 / 再生成しない思想統一 / enabled 途中停止挙動 / 二重作成検知方法具体化 | Claude |
| 2026-04-20 | v0.3 | §2 起草完了：重複送信の防止機構。docId=kickbackId 固定 / pending-first 3段階 / SES成功だけでは sent判定しない / 自動再送禁止・手動再送のみ / admin 手動 resolve / 二重送信検知2系統 / 第2段階はテスト代理店1件で1か月検証 | Claude |
| 2026-04-20 | v0.4 | §2 本線レビュー反映 5点：(1) Stage3失敗を warning → 即停止+CRITICAL通知に変更 / (2) pending長期残留検知（10分毎 detectStalePending）追加 / (3) resendHistory.resentAt を serverTimestamp → ISO文字列に変更 / (4) sent整合性不一致検知（detectSentInconsistency）追加（パターンA/B/C）/ (5) manualResend 対象を failed + 長時間pending に拡張（SendGrid確認チェックボックス等の安全策付き）。停止条件は 5点 → 7点 に拡張。観測項目は 8点 → 10点 に拡張。 | Claude |
| 2026-04-20 | v0.5 | §2 本線レビュー反映 2点（整合性修正）：(1) §2.8 の旧「batch失敗時 warning を返す」文言を削除し、v0.4 方針（即停止+CRITICAL+HttpsError('data-loss')）に §2.5/§2.8/§2.10 全体で統一 / (2) stale pending からの manualResend の安全策強化：UI checkbox のみでは再送不可とし、経路A（resolveSettlementEmailLog で failed 経由）または経路B（admin 専用承認フラグ manualResendApprovedAt/By）のいずれかを必須化。クライアント側の checkbox はセキュリティ境界にならないため、Cloud Functions 側で Firestore 状態を見て判定する。承認フラグは10分有効・1回消費・専用 Function で厳密管理。 | Claude |
| 2026-04-20 | v0.6 | §3 起草完了：監査ログ仕様の集約。(1) 5つの監査コレクション責務マップ（runLogs/emailLogs/Duplicate/Inconsistency/StalePending）/ (2) settlementRunLogs 完全スキーマ + 代表クエリ4例 + 500件超のサブコレクション分割 / (3) settlementEmailLogs 完全スキーマ + 代表クエリ5例 + resendHistory 10件上限 / (4) 補助コレクション3種の共通構造 / (5) 書き込み境界と append-only 保証（2層防衛 + Cloud Functions 規約）/ (6) notifyAdmin 設計（severity 3階層 / adminNotifications fan-out / 冪等キー）/ (7) 保持期間（emailLogs 7年 / runLogs 5年 / 検知 2年）+ BigQuery/GCS アーカイブ / (8) 監査クエリと月次サマリ / (9) PII 方針（メール本文・CCフル不記録、ドメインのみ）/ (10) §1〜§3 整合性確認と事故再現性担保 | Claude |
