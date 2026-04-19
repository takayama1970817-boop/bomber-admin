/**
 * ERP エンティティ スキーマ定義・バリデーション
 *
 * 設計書: docs/04_ERP_DATA_MODEL.md §3
 *
 * 純粋関数ベース。throw で NG を返す。
 * 画面側・保存処理から呼び出し、writeBatch 発火前の事前チェックに使う。
 */

/** 共通バリデーション（全 collection 共通） */
export function validateCommonFields(data, { isCreate = false } = {}) {
  if (!data || typeof data !== 'object') {
    throw new Error('データが不正です（object ではない）')
  }
  if (isCreate) {
    if (!data.company) throw new Error('company は必須です')
    if (data.company !== 'rt' && data.company !== 'rc') {
      throw new Error("company は 'rt' or 'rc'")
    }
    if (data.version === undefined || data.version === null) {
      throw new Error('version は必須です（楽観ロック用、初回は 1）')
    }
  }
}

/** 正数チェック */
function assertPositiveNumber(v, name, { allowZero = false } = {}) {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new Error(`${name} は数値必須`)
  }
  if (allowZero ? v < 0 : v <= 0) {
    throw new Error(`${name} は${allowZero ? '0 以上' : '正の数'}必須`)
  }
}

/** 非空文字列チェック */
function assertNonEmptyString(v, name) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${name} は非空文字列必須`)
  }
}

// =====================================================================
// Order
// =====================================================================
export function validateOrder(data, opts = {}) {
  validateCommonFields(data, opts)
  const { isCreate = false } = opts

  if (isCreate) {
    assertNonEmptyString(data.orderCode, 'orderCode')
    assertNonEmptyString(data.clientId, 'clientId')
    if (!['salon', 'dealer', 'direct'].includes(data.customerType)) {
      throw new Error("customerType は 'salon'|'dealer'|'direct'")
    }
    if (!data.orderDate) throw new Error('orderDate は必須')
    if (!Array.isArray(data.items) || data.items.length === 0) {
      throw new Error('items は 1 件以上必須')
    }
    data.items.forEach((it, i) => validateOrderItem(it, i))
    assertPositiveNumber(data.total, 'total', { allowZero: true })
  }

  // externalRaw は本体に持たせない（v0.4 以降）
  if (data.externalRaw !== undefined) {
    throw new Error('externalRaw を本体に持たせるのは禁止。erp_external_raw に分離し externalRawId で参照')
  }
}

function validateOrderItem(item, idx) {
  if (typeof item.lineNo !== 'number') throw new Error(`items[${idx}].lineNo は数値必須`)
  assertNonEmptyString(item.productId, `items[${idx}].productId`)
  assertNonEmptyString(item.productName, `items[${idx}].productName`)
  assertPositiveNumber(item.qty, `items[${idx}].qty`)
  assertPositiveNumber(item.unitPrice, `items[${idx}].unitPrice`, { allowZero: true })
}

// =====================================================================
// PurchaseOrder
// =====================================================================
export function validatePurchaseOrder(data, opts = {}) {
  validateCommonFields(data, opts)
  const { isCreate = false } = opts

  if (isCreate) {
    assertNonEmptyString(data.poCode, 'poCode')
    assertNonEmptyString(data.orderId, 'orderId')
    assertNonEmptyString(data.supplierId, 'supplierId')
    if (!Array.isArray(data.items) || data.items.length === 0) {
      throw new Error('items は 1 件以上必須')
    }
  }
}

// =====================================================================
// StockIn
// =====================================================================
export function validateStockIn(data, opts = {}) {
  validateCommonFields(data, opts)
  const { isCreate = false } = opts

  if (isCreate) {
    assertNonEmptyString(data.stockInCode, 'stockInCode')
    assertNonEmptyString(data.productId, 'productId')
    assertNonEmptyString(data.warehouseId, 'warehouseId')
    assertPositiveNumber(data.plannedQty, 'plannedQty')
  }
}

// =====================================================================
// Inventory
// =====================================================================
export function validateInventory(data, opts = {}) {
  validateCommonFields(data, opts)
  const { isCreate = false } = opts

  if (isCreate) {
    assertNonEmptyString(data.productId, 'productId')
    assertNonEmptyString(data.warehouseId, 'warehouseId')
    assertPositiveNumber(data.qty, 'qty', { allowZero: true })
    assertPositiveNumber(data.reservedQty, 'reservedQty', { allowZero: true })
  }
}

/** Inventory docId 生成 */
export function inventoryDocId(productId, lotNumber, warehouseId) {
  if (!productId || !warehouseId) {
    throw new Error('productId / warehouseId は必須')
  }
  const lot = lotNumber || 'nolot'
  return `${productId}_${lot}_${warehouseId}`
}

// =====================================================================
// Shipment
// =====================================================================
export function validateShipment(data, opts = {}) {
  validateCommonFields(data, opts)
  const { isCreate = false } = opts

  if (isCreate) {
    assertNonEmptyString(data.shipmentCode, 'shipmentCode')
    assertNonEmptyString(data.orderId, 'orderId')
    assertNonEmptyString(data.destinationId, 'destinationId')
    assertNonEmptyString(data.warehouseId, 'warehouseId')
    if (!data.shipmentDate) throw new Error('shipmentDate は必須')
    if (!Array.isArray(data.items) || data.items.length === 0) {
      throw new Error('items は 1 件以上必須')
    }
    data.items.forEach((it, i) => {
      assertNonEmptyString(it.productId, `items[${i}].productId`)
      assertPositiveNumber(it.qty, `items[${i}].qty`)
    })
  }
}

/** Shipment cancel 時のバリデーション */
export function validateShipmentCancel(data) {
  assertNonEmptyString(data.cancelReason, 'cancelReason（cancel 時は必須）')
}

// =====================================================================
// ExternalRaw
// =====================================================================
export function validateExternalRaw(data, opts = {}) {
  validateCommonFields(data, opts)
  const { isCreate = false } = opts

  if (isCreate) {
    assertNonEmptyString(data.source, 'source')
    assertNonEmptyString(data.externalOrderId, 'externalOrderId')
    if (!data.fetchedAt) throw new Error('fetchedAt は必須')
    if (!data.payload || typeof data.payload !== 'object') {
      throw new Error('payload は object 必須')
    }
  }
}
