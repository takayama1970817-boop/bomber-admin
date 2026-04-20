# ERP データモデル v0.5（実装前 最終確定版）

bomber-admin を「受注 → 発注 → 製造 → 倉庫 → 出荷 → 請求 → 入金」の基幹業務システムへ再設計する。

**v0.5 の位置付け**: 実装着手前の最終確定版。ここで決めた構造は実装後に変えない前提。

**v0.4 → v0.5 の主な変更**（社長指示 2026-04-17）：
1. writeBatch 失敗時の**自動リトライ禁止**（手動再実行のみ、UI エラー明示）
2. Shipment 参照の**循環禁止・チェーン構造**バリデーション（A→B→A 禁止、A→B→C のみ許可）
3. AuditLog の**対象フィールド制限**（collection ごとホワイトリスト、機密/肥大フィールド除外）

**v0.3 → v0.4 の変更**：
1. AuditLog 必須記録化（writeBatch アトミック）
2. Shipment の履歴ベース修正方式（cancel / correction）
3. externalRaw を別コレクションに分離

---

## 0. 実装前に確定すべき4項目【着手ブロッカー】

| # | 項目 | 決定事項 | 現状 |
|---|---|---|---|
| ① | **cutoverDate** | `erp_orders` への切替日時（これ以降、新規 `orders` 書き込み禁止・既存 `orders` readOnly） | **未確定** ← 社長決定待ち |
| ② | **Shipment 構造** | shipmentId / orderId / shipmentDate / items（部分出荷） / shipmentStatus | v0.3 で確定（§3-9） |
| ③ | **external 連携フィールド** | `externalSource` / `externalOrderId` を `erp_orders` に統一 | v0.3 で確定（§3-3） |
| ④ | **論理名 / 物理名 分離** | `logicalName: "Order"` / `collectionName: "erp_orders"` をコードレベルで分離 | v0.3 で確定（§2） |

①のみ社長承認必要。②③④は本書を承認すれば確定。

---

## 1. エンティティ全体像

```
Project (案件) 【設計のみ】
  ├─ Quotation (見積) 【設計のみ】
  └─ Order (受注) 【Phase 1 実装】 ──────────────┐
        ├─ PurchaseOrder (発注) 【Phase 1 実装】 ── ProductionOrder (製造指示) 【設計のみ】
        │                                              └─ ProductionResult (ロット) 【設計のみ】
        │                                                    └─ StockIn (入庫) 【Phase 1 実装】
        │
        ├─ Inventory (在庫) 【Phase 1 実装】
        ├─ Shipment (出荷) 【Phase 1 実装】
        ├─ Invoice (請求) 【設計のみ】
        └─ Payment (入金) 【設計のみ】

+ AuditLog (監査ログ) 【Phase 1 実装、共通基盤】
```

**関係の前提**：
- 1 Order → N PurchaseOrder / N Shipment / N Invoice / N Payment（**分割・並行処理前提**）
- 1 Payment → N Invoice（複合消込）

---

## 2. 論理名と物理名の分離（重要）

将来の rename コスト削減のため、**コード内では論理名を基準とする設計**にする。

### 2-1. 対応表

| 論理名 (logicalName) | 物理名 (collectionName) | Phase 1 |
|---|---|---|
| `Order` | `erp_orders` | 実装 |
| `PurchaseOrder` | `erp_purchase_orders` | 実装 |
| `Inventory` | `erp_inventory` | 実装 |
| `StockIn` | `erp_stock_ins` | 実装 |
| `Shipment` | `erp_shipments` | 実装 |
| `ExternalRaw` | `erp_external_raw` | 実装（v0.4 追加） |
| `AuditLog` | `audit_logs` | 実装 |
| `Project` | `erp_projects` | 設計のみ |
| `Quotation` | `erp_quotations` | 設計のみ |
| `ProductionOrder` | `erp_production_orders` | 設計のみ |
| `ProductionResult` | `erp_production_results` | 設計のみ |
| `Invoice` | `erp_invoices` | 設計のみ |
| `Payment` | `erp_payments` | 設計のみ |

### 2-2. 実装規約

```js
// src/lib/erp/collections.js（Phase 1 実装時に新設）
export const ERP_COLLECTIONS = {
  Order: 'erp_orders',
  PurchaseOrder: 'erp_purchase_orders',
  Inventory: 'erp_inventory',
  StockIn: 'erp_stock_ins',
  Shipment: 'erp_shipments',
  AuditLog: 'audit_logs',
}
// 使用例: collection(db, ERP_COLLECTIONS.Order)
```

**画面・lib コードから直接 `'erp_orders'` 文字列参照禁止**。必ず `ERP_COLLECTIONS.Order` 経由。将来 collectionName を変更しても1箇所の書き換えで済む。

---

## 3. エンティティ詳細

### 共通フィールド（全 collection）

| field | type | required | 説明 |
|---|---|---|---|
| `id` | string | ✓ | Firestore docId |
| `createdAt` | Timestamp | ✓ | serverTimestamp |
| `createdBy` | string (uid) | ✓ | |
| `updatedAt` | Timestamp | ✓ | serverTimestamp |
| `updatedBy` | string (uid) | ✓ | |
| `deletedAt` | Timestamp \| null |  | 論理削除（物理削除禁止） |
| `deletedBy` | string (uid) \| null |  | |
| `company` | `'rt' \| 'rc'` | ✓ | 会社分離 |
| `version` | number | ✓ | 楽観ロック（update 時に +1） |

> 全 collection で rules は `allow delete: if false`。論理削除のみ。監査要件のため。

---

### 3-1. `Project` → `erp_projects`【設計のみ】
```
projectCode: "P-2026-0001"
name: string
clientId: string (ref: bp_clients)
assignedUid: string
status: 'open'|'closed'|'cancelled'
notes: string
...common
```

### 3-2. `Quotation` → `erp_quotations`【設計のみ】
```
quotationCode: "Q-2026-0001"
projectId: string
clientId: string
items: [{productId, name, qty, unitPrice, amount}]
subtotal, tax, total: number
validUntil: Timestamp
status: 'draft'|'sent'|'accepted'|'rejected'|'expired'
acceptedAt: Timestamp
...common
```

### 3-3. **`Order` → `erp_orders`【Phase 1 実装・ERP 中核】**

```
orderCode: "O-2026-0001"     // 連番、一意
projectId: string|null        // 案件紐付（任意、Bカート直受注は null 可）
quotationId: string|null
clientId: string              // 得意先
customerType: 'salon'|'dealer'|'direct'
orderDate: Timestamp
requestedDeliveryDate: Timestamp|null

items: [OrderItem]
subtotal, tax, total: number

// === 外部連携（汎用化）===
externalSource: 'manual'|'bcart'|'shopify'|'api'|null
externalOrderId: string|null     // Bカート注文番号等（既存 bcartOrderNumber は移行）
externalSyncedAt: Timestamp|null
externalRawId: string|null       // erp_external_raw への参照ID（v0.4 で別コレクションに分離）
// externalRaw は Order 本体に持たせない（ドキュメントサイズ肥大化回避）
// 最小限メタだけ↓を持つ（検索・突合用）
externalMeta: {                  // 生データのメタ情報だけ
  customerName: string|null,     // 外部システム上の会社名
  orderedAt: Timestamp|null,     // 外部システム上の注文日時
  total: number|null,            // 外部システム上の合計額（突合検証用）
}|null

// === ステータス独立管理 ===
orderStatus: OrderStatus         // §4-1
shipmentStatus: ShipmentStatus   // §4-5 の集約値（派生）
billingStatus: BillingStatus     // §4-6 の集約値（派生）

// 承認
approvedAt: Timestamp|null
approvedBy: string|null

...common
```

**OrderItem**:
```
{
  lineNo: number,              // 1,2,3...
  productId: string,
  productName: string,         // 受注時点のスナップショット（後の商品名変更に左右されない）
  qty: number,
  unitPrice: number,
  amount: number,
  allocatedQty: number,        // 発注 or 在庫引当済
  shippedQty: number,          // 出荷済（Shipment 側から集計）
}
```

> **note**: `externalSource` を汎用化することで、Bカート以外のEC（Shopify等）が追加された時も同じ `erp_orders` に流し込める。

### 3-3b. `ExternalRaw` → `erp_external_raw`【Phase 1 実装】

外部システム（Bカート等）の生レスポンス JSON を Order 本体から分離して保持。肥大化を防ぎ、参照頻度の低い生データを別コレクションで低コスト管理する。

```
// docId = 自動生成（Order からは externalRawId で参照）
source: 'bcart'|'shopify'|'api'
externalOrderId: string         // 外部システム上のID
fetchedAt: Timestamp            // 取得時刻
payload: map                    // 生 JSON（そのまま保存）
orderId: string|null            // 対応する erp_orders の id（突合後に更新）
...common（ただし delete: false、update は orderId 更新のみ許可）
```

**運用ルール**:
- Order 新規作成時に externalRaw を同時に保存（writeBatch）
- Order 表示時は基本的に externalRaw を読まない（必要時のみ detail 画面で lazy load）
- 生データ保管期間は 3 年（社長判断で延長可）

---

### 3-4. **`PurchaseOrder` → `erp_purchase_orders`【Phase 1 実装】**
```
poCode: "PO-2026-0001"
orderId: string               // 親受注（1 Order → N PO）
supplierId: string
items: [PurchaseOrderItem]
subtotal, tax, total: number
orderedAt: Timestamp|null
expectedDeliveryDate: Timestamp|null
purchaseStatus: PurchaseStatus
approvedAt, approvedBy: ...
...common

PurchaseOrderItem:
{
  lineNo, orderItemLineNo, productId, qty, unitCost,
  receivedQty: number  // 入庫済（分納対応）
}
```

### 3-5. `ProductionOrder` → `erp_production_orders`【設計のみ】
```
prodCode: "MO-2026-0001"
purchaseOrderId, factoryId, productId, plannedQty, instructions,
plannedStartDate, plannedEndDate, productionStatus
...common
```

### 3-6. `ProductionResult` → `erp_production_results`【設計のみ・**物理削除禁止・上書き禁止**】
```
lotNumber: "RT-20260416-BC001"  // 一意
productionOrderId: string
productId: string
actualQty, defectQty: number
manufactureDate: Timestamp       // 必須
expiryDate: Timestamp            // 必須（化粧品・薬機法）
factoryUid, approvedAt, approvedBy
...common（ただし update も原則禁止、訂正は別レコード追加 + auditLog）
```

> ⚠️ **薬機法**: 5年保管義務。rules で delete/update を完全禁止。訂正は**補正レコード追加方式**で記録。

### 3-7. **`StockIn` → `erp_stock_ins`【Phase 1 実装・物理削除禁止】**
```
stockInCode: "SI-2026-0001"
purchaseOrderId: string|null
productionResultId: string|null   // Phase 1 では null（ロット運用は Phase 2）
productId: string
lotNumber: string|null             // Phase 1 optional、Phase 2 で必須化
warehouseId: string
plannedQty: number
actualQty: number|null
inspectionResult: 'ok'|'partial'|'reject'|null
receivedAt: Timestamp|null
receivedBy: string|null
warehouseStatus: WarehouseStatus
...common
```

### 3-8. **`Inventory` → `erp_inventory`【Phase 1 実装】**
```
// docId = "{productId}_{lotNumber|'nolot'}_{warehouseId}"
productId: string
lotNumber: string|null            // Phase 1 許容、Phase 2 必須
warehouseId: string
qty: number
reservedQty: number               // 出荷引当済
availableQty: number              // qty - reservedQty（算出）
lastMovementAt: Timestamp
...common（version で楽観ロック必須）
```

### 3-9. **`Shipment` → `erp_shipments`【Phase 1 実装・物理削除禁止・履歴ベース修正】**

社長指示「出荷は ERP の中核」により、必須フィールドを厳密化。  
v0.4 で不変性を撤廃し、**履歴ベースの cancel / correction 方式**に変更。

```
// === 必須 ===
shipmentCode: "SH-2026-0001"     // 連番一意
orderId: string                   // 親受注（1 Order → N Shipment の分納前提）
shipmentDate: Timestamp           // 出荷日（計画 or 実績はstatusで判別）
shipmentStatus: ShipmentStatus    // §4-5

// === 数量・明細（部分出荷対応）===
items: [ShipmentItem]

// === 配送先・倉庫 ===
destinationId: string             // bp_destinations 参照
warehouseId: string               // 出荷元倉庫

// === 実績 ===
plannedShipDate: Timestamp|null
shippedAt: Timestamp|null         // 実出荷日時（確定時のみ）
shippedBy: string|null
trackingNumber: string|null
approvedAt: Timestamp|null
approvedBy: string|null

// === 履歴ベース修正（v0.4 追加） ===
cancelledAt: Timestamp|null       // cancel した日時
cancelledBy: string|null
cancelReason: string|null         // cancel 理由（必須入力）
correctionOf: string|null         // 補正元の shipmentId（correction レコードのみ）
supersededBy: string|null         // この shipment を補正した新 shipmentId（cancelled レコードのみ）

...common

ShipmentItem:
{
  lineNo: number,
  orderItemLineNo: number,        // 親受注の item lineNo 参照
  productId: string,
  lotNumber: string|null,         // Phase 1 任意、Phase 2 必須
  qty: number,                    // 出荷数量（部分出荷可）
}
```

#### v0.4 履歴ベース修正方式（不変性撤廃）

**禁止**: 既存 shipment ドキュメントの items/qty/orderId を直接 update する  
**推奨**: 修正は「**元を cancel + 新 shipment を correction として作成**」の 2 ステップ

**修正フロー**:
```
1. 元 Shipment A（SH-0001）
   → cancel 操作
   → A.shipmentStatus = 'cancelled'
   → A.cancelledAt / cancelledBy / cancelReason を設定
   → A.supersededBy = 新しい Shipment B の id

2. 補正 Shipment B（SH-0002）を新規作成
   → B.correctionOf = A の id
   → B.items に修正後の値
   → B.shipmentStatus は draft から開始、通常の承認フロー

3. 両レコードは監査可能、在庫は Shipment B 側の数量で再計算
4. AuditLog に cancel（A）・create（B）の 2 件が記録される
```

**update が許可される fields（極小セット）**:
- `shipmentStatus`（ステータス遷移のみ、§4-5 に準拠）
- `cancelledAt` / `cancelledBy` / `cancelReason` / `supersededBy`（cancel 時のみ）
- `shippedAt` / `shippedBy` / `trackingNumber` / `approvedAt` / `approvedBy`（業務進捗）

**update が禁止される fields**:
- `shipmentCode` / `orderId` / `items` / `destinationId` / `warehouseId` / `correctionOf`

rules で `request.resource.data.diff(resource.data).affectedKeys().hasOnly([...])` で制約。

#### 循環禁止・チェーン構造のみ許可（v0.5 追加）

`correctionOf` / `supersededBy` の参照関係は **単方向チェーンのみ** とし、循環禁止。

**許可される形**（片方向チェーン）:
```
A (cancelled, supersededBy=B) ← B (correctionOf=A, shipped)
B (cancelled, supersededBy=C) ← C (correctionOf=B, shipped)
```
→ A → B → C の一直線のみ

**禁止される形**（循環）:
```
❌ A.supersededBy = B かつ B.supersededBy = A
❌ A → B → C → A のようなループ
```

**バリデーションルール（実装必須）**:
1. **作成時**：新しい Shipment B の `correctionOf = A` を設定する時、A から辿って B にたどり着かないことを確認
2. **update 時**：`supersededBy` を設定する前に、対象レコードが既に他の supersededBy 連鎖の一部でないことを確認
3. **1 レコード = 1 correction のみ**：A を複数回 correction することは禁止（A → B と A → B' のような分岐）
4. **correctionOf は一度設定したら変更禁止**（上記の update 禁止 fields に追加済）

**実装ヘルパー（Phase 1 実装時）**:
```js
// src/lib/erp/shipmentChain.js（v0.5 設計）
export async function assertNoCycle(shipmentA_id, shipmentB_id, db) {
  // A の correction チェーンをたどり、B が既に含まれていないかチェック
  let current = shipmentA_id
  const visited = new Set()
  while (current) {
    if (visited.has(current)) throw new Error('既存のチェーンに循環があります')
    if (current === shipmentB_id) {
      throw new Error(`循環参照禁止: ${shipmentB_id} は既にチェーンに含まれます`)
    }
    visited.add(current)
    const doc = await getDoc(doc(db, ERP_COLLECTIONS.Shipment, current))
    current = doc.data()?.correctionOf || null
    if (visited.size > 20) throw new Error('チェーン深度が 20 を超えました（異常）')
  }
}

export async function assertNotAlreadySuperseded(shipmentA_id, db) {
  // A が既に supersededBy を持っていたら新しい correction を拒否
  const doc = await getDoc(doc(db, ERP_COLLECTIONS.Shipment, shipmentA_id))
  if (doc.data()?.supersededBy) {
    throw new Error(`${shipmentA_id} は既に ${doc.data().supersededBy} で修正済みです`)
  }
}
```

**rules での防御（実装時）**:
```
match /erp_shipments/{id} {
  allow update: if ...
    // correctionOf は一度設定したら不変
    && (resource.data.correctionOf == null || resource.data.correctionOf == request.resource.data.correctionOf)
    // supersededBy の変更は現在 null の時のみ許可（一度設定したら変えられない）
    && (resource.data.supersededBy == null
        || resource.data.supersededBy == request.resource.data.supersededBy);
}
```
（循環検出自体はクライアント側の assertNoCycle で担保、rules はトランジション制約のみ）

### 3-10. `Invoice` → `erp_invoices`【設計のみ】
```
invoiceCode, orderId, shipmentIds: [string], clientId,
items, subtotal, tax, total, invoiceDate, dueDate, paidAmount,
billingStatus
...common
```

### 3-11. `Payment` → `erp_payments`【設計のみ】
```
paymentCode, invoiceIds: [string], clientId, amount, paidAt,
method: 'bank'|'credit'|'cash'|'other', bankInfo
...common
```

### 3-12. **`AuditLog` → `audit_logs`【Phase 1 実装・append only・原子性保証】**
```
collection: string                // 'erp_orders' 等
docId: string                     // 対象ドキュメントID
action: 'create'|'update'|'delete'|'status_change'|'cancel'|'correction'
before: map|null
after: map|null
actor: string (uid)
actorRole: string
actorSubRole: string|null
reason: string|null               // ユーザー入力（ステータス変更理由等、cancel時は必須）
createdAt: Timestamp
// update/delete 禁止（rules で厳格）
```

#### 原子性保証（v0.4 必須化）

**原則**: AuditLog への書き込みは**必須**。本処理と AuditLog を**同一 writeBatch**で書き、失敗時は**全体ロールバック**。

**実装パターン**:
```js
// src/lib/erp/auditLog.js（Phase 1 実装）
import { writeBatch, doc, collection, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase.js'
import { ERP_COLLECTIONS } from './collections.js'

// 本処理と AuditLog を同一 batch で書く
// batch.commit() が失敗すれば両方ロールバック
export function addAuditToBatch(batch, {
  collection: col, docId, action, before, after, actor, actorRole, actorSubRole, reason,
}) {
  const logRef = doc(collection(db, ERP_COLLECTIONS.AuditLog))
  batch.set(logRef, {
    collection: col,
    docId,
    action,
    before: before || null,
    after: after || null,
    actor,
    actorRole,
    actorSubRole: actorSubRole || null,
    reason: reason || null,
    createdAt: serverTimestamp(),
  })
  return logRef.id
}

// 使用例
export async function createOrderWithAudit(orderData, profile) {
  const batch = writeBatch(db)
  const orderRef = doc(collection(db, ERP_COLLECTIONS.Order))
  batch.set(orderRef, { ...orderData, createdAt: serverTimestamp() })
  addAuditToBatch(batch, {
    collection: ERP_COLLECTIONS.Order,
    docId: orderRef.id,
    action: 'create',
    before: null,
    after: orderData,
    actor: profile.uid,
    actorRole: profile.role,
    actorSubRole: profile.subRole,
  })
  await batch.commit()   // 失敗時は両方ロールバック
  return orderRef.id
}
```

**禁止事項**:
- AuditLog を本処理の後に「別途 try/catch で書く」（監査欠落リスク）
- AuditLog 書き込み失敗を握り潰す（rules や network エラーが隠蔽される）
- **writeBatch 失敗時の自動リトライ**（v0.5 追加）
  - 二重書き込みリスク（非冪等操作）・監査の二重記録を防ぐため
  - 失敗時は**ユーザーに明示的にエラー通知**し、手動再実行を促す
  - 実装例：`catch` で `alert('保存に失敗しました。再度「保存」ボタンを押してください。自動的な再送は行いません。')`
  - 再実行は **必ずユーザー操作起点**（ボタンクリック）でのみ許可

#### AuditLog の監査対象フィールド制限（v0.5 追加）

**目的**:
- before/after に全ドキュメントを丸ごと保存すると肥大化（items 配列など）
- 機密データ（個人情報 PII、生 JSON 等）を監査ログに残さない
- ドキュメントサイズ上限（1MB）超過の防止

**原則**: collection ごとに「監査対象フィールドのホワイトリスト」を定義し、before/after はそのキーだけ記録。

```js
// src/lib/erp/auditLog.js（v0.5 設計）
export const AUDITABLE_FIELDS = {
  [ERP_COLLECTIONS.Order]: [
    'orderCode', 'orderStatus', 'shipmentStatus', 'billingStatus',
    'clientId', 'total', 'approvedAt', 'approvedBy', 'deletedAt',
    'externalSource', 'externalOrderId',
    // items は要約のみ（全明細は記録しない）
    // externalRawId / externalMeta / externalRaw は記録対象外（肥大化・PII）
  ],
  [ERP_COLLECTIONS.PurchaseOrder]: [
    'poCode', 'purchaseStatus', 'supplierId', 'total',
    'approvedAt', 'approvedBy', 'deletedAt',
  ],
  [ERP_COLLECTIONS.Shipment]: [
    'shipmentCode', 'shipmentStatus', 'orderId', 'destinationId', 'warehouseId',
    'shippedAt', 'shippedBy', 'approvedAt', 'approvedBy',
    'cancelledAt', 'cancelledBy', 'cancelReason',
    'correctionOf', 'supersededBy',
  ],
  [ERP_COLLECTIONS.StockIn]: [
    'stockInCode', 'warehouseStatus', 'warehouseId', 'productId',
    'plannedQty', 'actualQty', 'inspectionResult', 'receivedAt', 'receivedBy',
  ],
  [ERP_COLLECTIONS.Inventory]: [
    'productId', 'lotNumber', 'warehouseId', 'qty', 'reservedQty', 'availableQty',
  ],
}

// items のような配列は要約だけ記録
export function summarizeItems(items) {
  if (!Array.isArray(items)) return null
  return {
    count: items.length,
    totalQty: items.reduce((sum, i) => sum + (Number(i.qty) || 0), 0),
    productIds: [...new Set(items.map((i) => i.productId).filter(Boolean))],
  }
}

// before/after を制限版に変換
export function extractAuditable(data, collectionName) {
  if (!data) return null
  const allowedKeys = AUDITABLE_FIELDS[collectionName] || []
  const result = {}
  for (const key of allowedKeys) {
    if (data[key] !== undefined) result[key] = data[key]
  }
  // items は要約のみ
  if (data.items) result.itemsSummary = summarizeItems(data.items)
  return result
}
```

**除外対象**:
- `items` 配列の全詳細（要約 `{count, totalQty, productIds}` のみ）
- `externalRaw` / `externalRawId` / `externalMeta`
- `bankInfo`（payments）
- 顧客の個人情報（氏名・電話・住所は記録しない、customerId のみ）

**Phase 2 以降**:
- Cloud Functions（Firestore trigger）で before/after を自動記録する方式に移行検討
- その場合はクライアント側の addAuditToBatch は廃止可能
- フィールド制限は Functions 側で実装

---

## 4. ステータス定義（独立管理・単一ステータス禁止）

### 4-1. `OrderStatus`【Phase 1 実装】
```
draft → confirmed → partially_allocated → fully_allocated
      → partially_shipped → shipped → completed
      → returned
cancelled（任意地点から）
```

### 4-2. `PurchaseStatus`【Phase 1 実装】
```
draft → approved → sent → accepted → in_production
      → partially_received → received → closed
      ↘ rejected
cancelled
```

### 4-3. `ProductionStatus`【設計のみ】
```
pending → scheduled → in_progress → completed → approved
        ↘ on_hold → in_progress
cancelled
```

### 4-4. `WarehouseStatus`（StockIn）【Phase 1 実装】
```
pending → arrived → inspecting → accepted → stocked
                               ↘ partial_accepted → stocked
                               ↘ rejected
```

### 4-5. `ShipmentStatus`【Phase 1 実装】
```
pending → allocated → picked → packed → shipped → delivered
                                       ↘ partial_delivered
cancelled（任意地点から、cancelReason 必須）
correction（補正レコードとして新規作成、通常の pending から開始）
```

**補足**（v0.4）:
- `cancelled`: shipmentStatus に推移させたレコードは以後 items/qty 等を update 不可（rules で拒否）
- `correction` は Shipment レコードの `correctionOf` field に元 id を持つことで識別（status 名としては通常の pending〜shipped〜delivered を辿る）

### 4-6. `BillingStatus`【設計のみ】
```
pending → invoiced → partial_paid → paid
                   ↘ overdue
voided
```

---

## 5. 承認フロー（ドメインごとに独立）

| ドメイン | 承認対象 | 承認者 | 権限関数 | Phase 1 |
|---|---|---|---|---|
| 受注 | `OrderStatus: draft → confirmed` | admin | `canApproveOrder` | 実装 |
| 発注 | `PurchaseStatus: draft → approved` | admin | `canApprovePurchaseOrder` | 実装 |
| 製造完了 | `ProductionStatus: completed → approved` | admin | `canApproveProduction` | 設計のみ |
| 出荷 | `ShipmentStatus: packed → shipped` | admin / internal | `canApproveShipment` | 実装 |
| 請求 | `BillingStatus: pending → invoiced` | admin | `canApproveInvoice` | 設計のみ |

---

## 6. 権限・ロール設計

### 6-1. Phase 1 で ERP 画面上**有効**なロール

| role | 用途 |
|---|---|
| `admin` | 管理者（既存 `master` + `admin` を包含） |
| `internal` | 社内スタッフ（**既存 `staff` を ERP 文脈でこう呼ぶ**、実体は同一） |

> **既存 `staff` ロールは ERP 画面では `internal` と呼称**。data model の `role` field は `'staff'` のまま保持（破壊的変更を避ける）。`permissions.js` に `isInternal(p)` エイリアスを追加して両方扱う。

### 6-2. Phase 1 で**無効**なロール（定義のみ、UI・招待ともに不可）

| role | 状態 |
|---|---|
| `factory` | 定義のみ。Phase 1 で AuthContext には追加しない。招待 UI も表示しない |
| `supplier` | 同上 |
| `warehouse` | **既存 `WarehousePortal`（在庫・入出庫）は稼働継続**。ただし ERP 画面（`/admin/erp/*`）には**アクセス不可** |
| `dealer` | ERP 画面には**アクセス不可**（既存 `/dealer` は稼働継続） |
| `salon` | 同上 |

### 6-3. `permissions.js` 追加関数（Phase 1）

```js
// 基本判定
export function isInternal(p) { return p?.role === 'staff' }  // 既存staffをinternal扱い
export function isErpUser(p) { return isAdmin(p) || isInternal(p) }

// 受注
canCreateOrder(p)                 → isErpUser
canEditOrder(p)                   → isErpUser
canApproveOrder(p)                → isAdmin
canCancelOrder(p)                 → isAdmin

// 発注
canCreatePurchaseOrder(p)         → isErpUser
canApprovePurchaseOrder(p)        → isAdmin
canSendPurchaseOrder(p)           → isErpUser

// 在庫・入庫・出荷（Phase 1 は admin/internal のみ、warehouse は後日）
canViewInventory(p)               → isErpUser
canAdjustInventory(p)             → isAdmin
canInputStockIn(p)                → isErpUser
canApproveStockIn(p)              → isAdmin
canCreateShipment(p)              → isErpUser
canApproveShipment(p)             → isAdmin
```

### 6-4. Firestore rules（Phase 1）

```
// 共通ヘルパー
function isErpUser() {
  return isSignedIn() && (isAdmin() || userDoc().role == 'staff');
}

// Phase 1 の erp_ collection は admin/internal のみ
match /erp_orders/{id} {
  allow read, create, update: if isErpUser();
  allow delete: if false;
}
// erp_purchase_orders / erp_inventory / erp_stock_ins / erp_shipments も同様

// audit_logs は append-only
match /audit_logs/{id} {
  allow read:   if isAdmin();
  allow create: if isErpUser();
  allow update, delete: if false;
}
```

**Phase 1 では factory / supplier / warehouse / dealer / salon は ERP collection に一切アクセスできない**（read も不可）。

---

## 7. cutover 設計（社長確認 必須）

### 7-1. cutover の目的
`orders` と `erp_orders` の**並行運用を禁止**し、明確な切替日を設ける。

### 7-2. cutover のルール

| 項目 | ルール |
|---|---|
| `cutoverDate` | 社長が決定（未確定、Phase 1 実装完了時点で設定） |
| cutoverDate 前 | 既存 `orders` に引き続き書き込み（Bカート取込含む）。`erp_orders` は空 |
| cutoverDate 当日 | **全 Bカート取込を一時停止**。既存 `orders` に `isDeprecated: true` を一括付与 |
| cutoverDate 以降 | - Bカート取込は `erp_orders` へ書き込み<br>- 既存 `orders` は **readOnly**（rules で write 禁止）<br>- UI 側で旧データは「取消不可・編集不可」表示 |

### 7-3. 既存 `orders` への対応（cutoverDate 後）
```
// 既存 orders に追加するフィールド
isDeprecated: true             // cutover 時に一括付与
deprecatedAt: Timestamp         // cutoverDate
migratedToErpOrderId: string|null  // 新 erp_orders に対応ID がある場合（任意、遡及移行用）
```

### 7-4. rules
```
match /orders/{id} {
  allow read: if isSignedIn() && ...（既存ルール）;
  // cutoverDate 後: update は isDeprecated 関連以外は禁止
  allow update: if isAdmin()
                 && request.resource.data.keys().hasOnly(['isDeprecated', 'deprecatedAt', 'migratedToErpOrderId']);
  allow create: if false;  // cutoverDate 以降は新規作成禁止
  allow delete: if false;
}
```

### 7-5. UI 側
- 既存 `orders` を表示する画面（Dashboard / BcartImport / KickbackManage 等）で、`isDeprecated === true` のレコードは以下の表示：
  - 「📦 旧受注（参照のみ）」バッジ
  - 編集・削除ボタン非表示
  - 対応する `erp_orders` がある場合、リンク表示

---

## 8. イベント駆動ルール（Phase 2 で自動化、Phase 1 は手動）

| トリガー | 自動処理 | Phase 1 | Phase 2 |
|---|---|---|---|
| `Order.confirmed` | PurchaseOrder draft 自動生成 | 手動ボタン | CF 自動 |
| `PurchaseOrder.approved` | PO PDF 生成 + supplier 通知 | 手動 | CF 自動 |
| `ProductionResult.approved` | StockIn plannedQty 計上 | - | CF 自動 |
| `StockIn.actualQty 確定` | Inventory.qty 加算 | 手動ボタン | CF 自動 |
| `Shipment.shipped` | Inventory.qty 減算 + 納品書 PDF | 手動ボタン | CF 自動 |
| `Shipment.delivered` | Invoice draft 生成 | - | CF 自動 |
| `Payment 記録` | Invoice.paidAmount 加算 | - | CF 自動 |

---

## 9. 履歴保持・物理削除禁止

### 9-1. 物理削除禁止 collection（rules で `allow delete: if false`）
- `erp_production_results`（薬機法 5年保管、update も完全禁止）
- `erp_stock_ins`
- `erp_shipments`（update は許可fieldのみ。v0.4 履歴ベース修正方式）
- `erp_invoices`
- `erp_payments`
- `erp_external_raw`（v0.4 追加、外部生データは保全）
- `audit_logs`（append only）

### 9-2. 論理削除可能 collection（`deletedAt` セットのみ）
- `erp_orders` / `erp_purchase_orders` / `erp_projects` / `erp_quotations`

### 9-3. 上書き更新ルール
| collection | 更新可否 | 方式 |
|---|---|---|
| `erp_production_results` | **完全禁止** | 訂正は補正レコード追加 |
| `erp_shipments` | **極小セットのみ可** | items/qty/orderId は不可、訂正は cancel + correction レコード（v0.4） |
| `erp_external_raw` | **orderId のみ可** | 生データ部分（payload）は上書き禁止 |
| `audit_logs` | **完全禁止** | append only |
| その他 | 通常 update 可 | AuditLog 必須記録（原子性保証）|

### 9-4. AuditLog 必須記録対象
Phase 1 で以下は AuditLog に必ず記録：
- `erp_orders` / `erp_purchase_orders` / `erp_stock_ins` / `erp_shipments` / `erp_inventory`
- action: create / update / delete（論理） / status_change

---

## 10. テスト環境ポリシー

### 10-1. 本番 DB
- 削除禁止ルール維持
- ルール緩和は**禁止**

### 10-2. テスト環境
- **別 Firebase プロジェクト**で運用（既に `bomber-admin-test` 分離済み）
- テスト用データは別 DB
- 「本番 DB でテスト → 削除できないから困る」という事態を禁止

### 10-3. 開発時
- 必要ならテスト環境で rules を一時緩和可（ただし本番には反映禁止）
- 物理削除が必要なテストは Firestore Emulator を使う

---

## 11. Phase 1 実装順（次回以降の作業）

### Step 1: 土台（コード化）
- `src/lib/erp/collections.js`（論理名 ↔ 物理名マップ）
- `src/lib/erp/schema.js`（型定義・バリデーション）
- `src/lib/erp/statusMachine.js`（ステータス遷移）
- `src/lib/erp/auditLog.js`（AuditLog 記録ヘルパー）
- `src/lib/permissions.js` に ERP 権限関数追加
- Firestore rules（erp_ + audit_logs）

### Step 2: 受注画面（RT）
- `/admin/erp/orders`（一覧・詳細・作成・編集・承認）
- 既存 Dashboard との導線

### Step 3: 発注画面（RT）
- `/admin/erp/purchase-orders`

### Step 4: 在庫・入庫・出荷画面（RT）
- `/admin/erp/inventory`
- `/admin/erp/stock-ins`
- `/admin/erp/shipments`

### Step 5: cutover（2026-04-18 土台実装完了、実行は社長判断）

#### 状態
- ✅ cutover 実行スクリプト `scripts/cutover-orders.mjs` 完成（DRY RUN + 監査ログ対応）
- ✅ `firestore.rules` で `/orders/{id}` の update を cutover 後制限（admin のみ・isDeprecated 関連フィールドのみ）
- ⏳ **cutoverDate 決定**（社長判断、Phase 1 Step 4 動作確認完了後）
- ⏳ **BcartImport を `erp_orders` 対応化**（次スプリント、cutover 実行前に必須）

#### 実行手順（社長が cutoverDate 到達時に行う）

##### Step 5-A: 準備（cutover 当日の朝まで）
1. BcartImport（`src/pages/BcartImport.jsx`）を `erp_orders` + `erp_external_raw` に書き込む版に更新・デプロイ（※ 次スプリント）
2. 関係者に「本日 HH:MM 以降は /admin/erp/orders が正】と通知

##### Step 5-B: cutover 実行（cutoverDate 当日）
1. **Bカート自動取込（Cloud Scheduler 等）があれば一時停止**
2. DRY RUN で対象件数を確認：
   ```powershell
   node scripts/cutover-orders.mjs
   ```
3. 結果を目視確認（想定件数・サンプル）
4. 本番実行：
   ```powershell
   $env:DRY_RUN = "false"
   $env:OPERATOR = "社長 ボンバー"
   node scripts/cutover-orders.mjs
   ```
5. 成功ログと検証結果（「未設定 0件」）を確認
6. Firestore コンソールで `cutoverLogs` の監査ログを確認

##### Step 5-C: 検証
1. 旧 UI（Dashboard / KickbackManage 等）で旧 orders が引き続き**閲覧できる**こと
2. 旧 UI からの編集操作が**拒否**されること（rules が isDeprecated=true を見て弾く）
3. 新 UI `/admin/erp/orders` で新規受注を作成できること
4. BcartImport を再開し、`erp_orders` に書き込まれることを確認

##### ロールバック（緊急時）
- Firestore コンソールで `isDeprecated: false` に戻す（admin 権限で可能）
- または rules を先にデプロイ前に戻す（hosting から `firebase-debug.log` で直前版を確認）
- 既存データは物理削除されていないため常に復旧可能

#### 監視ポイント
- `cutoverLogs` コレクションに実行記録が残る
- `orders` の `isDeprecated` フィールドを集計すれば移行進捗が見える
- Bカート取込の先が `orders` / `erp_orders` のどちらかを BcartImport ログで確認

---

## 12. 未解決事項（社長決定が必要）

### 実装前確定（§0）
1. **cutoverDate**：未確定。Phase 1 Step 4 完了時点で決定推奨
2. Shipment 構造：**v0.3 で確定**（§3-9）
3. external フィールド：**v0.3 で確定**（§3-3）
4. 論理名分離：**v0.3 で確定**（§2）

### Phase 1 実装中に確定
5. **倉庫数**：`warehouseId` は何種類想定？（1つ or 複数）
6. **OHC 既存在庫**：`stockHistory` から `erp_inventory` への import スクリプトが必要か？
7. **ロット運用開始時期**：Phase 1 末 or Phase 2 初？

### Phase 2+ で決定
8. 在庫引当アルゴリズム（FIFO / 期限順 / 手動）
9. 部分出荷の自動/手動
10. 外部通知方式（メール / LINE / API）
11. ロット番号命名規則
12. 単位変換テーブル
13. 海外工場の為替
14. 監査ログの視覚化 UI

---

## 13. 変更履歴

### v0.4 → v0.5（社長指示 2026-04-17 深夜2回目）

| 項目 | v0.4 | v0.5 |
|---|---|---|
| writeBatch 失敗時 | リトライ方針なし | **自動リトライ禁止、手動再実行のみ、エラー明示** |
| Shipment 参照 | cancel/correction のみ定義 | **循環禁止・単方向チェーン構造のみ許可、バリデーションヘルパー追加** |
| AuditLog before/after | 全ドキュメント記録 | **collection ごとフィールドホワイトリスト、items は要約、PII 除外** |

### v0.3 → v0.4（社長指示 2026-04-17 深夜）

| 項目 | v0.3 | v0.4 |
|---|---|---|
| AuditLog | クライアント側で手動書き込み（失敗時の扱い曖昧） | **writeBatch で本処理とアトミック、失敗時全体ロールバック** |
| Shipment 不変性 | 確定後 update 禁止（訂正は新規作成のみ） | **履歴ベース修正方式（cancel + correction）を正式ルール化** |
| externalRaw | Order ドキュメント内に map で保持 | **`erp_external_raw` 別コレクションに分離、Order は externalRawId のみ** |
| externalMeta | なし | **Order 本体に検索用の最小メタだけ保持**（customerName / orderedAt / total） |

### v0.2 → v0.3

| 項目 | v0.2 | v0.3 |
|---|---|---|
| cutover | 並行稼働許容 | 禁止、cutoverDate で明確切替 |
| 命名 | `erp_` prefix | 論理名 / 物理名分離、コードは論理名基準 |
| Shipment | 項目列挙 | 必須フィールド厳密化、部分出荷・不変性明示 |
| 外部連携 | `source: 'bcart'` 保持 | `externalSource` / `externalOrderId` に汎用化 |
| ロール | 7〜8ロール有効 | Phase 1 は admin / internal のみ有効、他は定義のみ |
| テスト環境 | 言及なし | 本番 DB でルール緩和禁止、別環境必須を明記 |
| 物理削除 | 一部禁止 | 禁止範囲拡大、訂正は補正レコード方式 |

---

## 14. やってはいけないこと（社長指示・継続）

1. 既存案件管理構造をベースに延命すること
2. 1レコードに受注・発注・製造・請求を混在させること
3. 単一ステータスで全工程を管理すること
4. ロット情報を任意項目扱いにすること（Phase 2 必須化）
5. 履歴を残さず上書き更新すること
6. UI都合でデータ構造を歪めること
7. Phase 1 で全エンティティを一気に実装すること
8. 権限設計を後回しにすること
9. 帳票・通知を手動運用前提にすること（Phase 1 は手動だが、構造は自動化対応）
10. 将来の工場・倉庫連携を考慮しないこと
11. **cutover を曖昧にして並行運用すること（v0.3 で追加）**
12. **`'erp_orders'` 等の物理名をコードに直書きすること（v0.3 で追加）**
13. **本番 DB で削除禁止ルールを緩めること（v0.3 で追加）**
14. **AuditLog 書き込みを本処理と分離して try/catch で握りつぶすこと（v0.4 で追加、原子性違反）**
15. **Shipment の items / qty / orderId を直接 update で書き換えること（v0.4 で追加、履歴欠落）**
16. **externalRaw を Order 本体に保持すること（v0.4 で追加、ドキュメント肥大化）**
17. **writeBatch 失敗時に自動リトライすること（v0.5 で追加、二重書き込み・重複監査リスク）**
18. **Shipment の correctionOf / supersededBy で循環参照を作ること（v0.5 で追加）**
19. **AuditLog に items 全詳細・externalRaw・個人情報を記録すること（v0.5 で追加、肥大化・PII漏洩）**

---

**バージョン**: v0.5（実装前最終確定版 draft）  
**作成日**: 2026-04-17  
**次のアクション**: 社長承認 → Phase 1 実装 Step 1（土台コード化）着手  
**実装ブロッカー**: §0 の ①cutoverDate のみ（②③④は本書承認で確定、cutoverDate は Phase 1 Step 4 完了時に決定 = 社長承認済）
