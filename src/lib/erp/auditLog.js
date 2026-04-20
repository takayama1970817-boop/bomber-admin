/**
 * AuditLog 記録ヘルパー（writeBatch 原子性・フィールド制限・リトライ禁止）
 *
 * 設計書: docs/04_ERP_DATA_MODEL.md §3-12
 *
 * 原則:
 *   1. 本処理と AuditLog は同一 writeBatch でコミット（原子性保証、失敗時ロールバック）
 *   2. before/after は collection ごとホワイトリストで制限（肥大化・PII対策）
 *   3. writeBatch 失敗時の自動リトライは禁止。ユーザーに明示通知 → 手動再実行
 */
import { collection, doc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase.js'
import { ERP_COLLECTIONS } from './collections.js'

// =====================================================================
// 監査対象フィールド ホワイトリスト
// =====================================================================
// collection 名（物理名）→ 記録する field のキー配列
// items のような配列は要約のみ（summarizeItems で圧縮）
// externalRaw / bankInfo / 個人情報は記録対象外
export const AUDITABLE_FIELDS = {
  [ERP_COLLECTIONS.Order]: [
    'orderCode', 'orderStatus', 'shipmentStatus', 'billingStatus',
    'clientId', 'customerType', 'total', 'subtotal', 'tax',
    'orderDate', 'requestedDeliveryDate',
    'approvedAt', 'approvedBy', 'deletedAt', 'deletedBy',
    'externalSource', 'externalOrderId',
    'projectId', 'quotationId',
    'company', 'version',
  ],
  [ERP_COLLECTIONS.PurchaseOrder]: [
    'poCode', 'purchaseStatus', 'supplierId', 'orderId',
    'total', 'subtotal', 'tax',
    'orderedAt', 'expectedDeliveryDate',
    'approvedAt', 'approvedBy', 'deletedAt', 'deletedBy',
    'company', 'version',
  ],
  [ERP_COLLECTIONS.Shipment]: [
    'shipmentCode', 'shipmentStatus', 'orderId',
    'destinationId', 'warehouseId',
    'shipmentDate', 'plannedShipDate', 'shippedAt', 'shippedBy',
    'trackingNumber', 'approvedAt', 'approvedBy',
    'cancelledAt', 'cancelledBy', 'cancelReason',
    'correctionOf', 'supersededBy',
    'company', 'version',
  ],
  [ERP_COLLECTIONS.StockIn]: [
    'stockInCode', 'warehouseStatus', 'warehouseId', 'productId',
    'purchaseOrderId', 'productionResultId', 'lotNumber',
    'plannedQty', 'actualQty', 'inspectionResult',
    'receivedAt', 'receivedBy',
    'company', 'version',
  ],
  [ERP_COLLECTIONS.Inventory]: [
    'productId', 'lotNumber', 'warehouseId',
    'qty', 'reservedQty', 'availableQty', 'lastMovementAt',
    'company', 'version',
  ],
}

/**
 * items 配列を要約する（全詳細は保存しない）
 */
export function summarizeItems(items) {
  if (!Array.isArray(items)) return null
  return {
    count: items.length,
    totalQty: items.reduce((sum, i) => sum + (Number(i.qty) || 0), 0),
    productIds: [...new Set(items.map((i) => i.productId).filter(Boolean))],
  }
}

/**
 * before / after を制限版（ホワイトリスト＋items要約）に変換
 * collectionName が定義されていない場合は空オブジェクトを返す（安全側）
 */
export function extractAuditable(data, collectionName) {
  if (!data) return null
  const allowedKeys = AUDITABLE_FIELDS[collectionName] || []
  const result = {}
  for (const key of allowedKeys) {
    if (data[key] !== undefined) result[key] = data[key]
  }
  if (data.items) result.itemsSummary = summarizeItems(data.items)
  return result
}

/**
 * 現在の writeBatch に AuditLog 1件を追加
 *
 * @param {WriteBatch} batch
 * @param {Object} params
 * @param {string} params.collection - ERP_COLLECTIONS.Order 等（物理名）
 * @param {string} params.docId - 対象ドキュメント ID
 * @param {'create'|'update'|'delete'|'status_change'|'cancel'|'correction'} params.action
 * @param {Object|null} params.before - 変更前データ（create 時は null）
 * @param {Object|null} params.after - 変更後データ（delete 時は null）
 * @param {Object} params.profile - AuthContext.profile
 * @param {string} [params.reason] - 変更理由（cancel 時は必須）
 * @returns {string} 発行した auditLog の docId
 */
export function addAuditToBatch(batch, params) {
  const {
    collection: colName,
    docId,
    action,
    before,
    after,
    profile,
    reason,
  } = params

  if (!batch) throw new Error('batch は必須')
  if (!colName) throw new Error('collection は必須')
  if (!docId) throw new Error('docId は必須')
  if (!action) throw new Error('action は必須')
  if (!profile?.uid) throw new Error('profile.uid は必須（認証情報）')

  // cancel 時は reason 必須
  if (action === 'cancel' && !reason) {
    throw new Error('cancel 操作時は reason（キャンセル理由）必須')
  }

  const logRef = doc(collection(db, ERP_COLLECTIONS.AuditLog))
  batch.set(logRef, {
    collection: colName,
    docId,
    action,
    before: extractAuditable(before, colName),
    after: extractAuditable(after, colName),
    actor: profile.uid,
    actorRole: profile.role || null,
    actorSubRole: profile.subRole || null,
    reason: reason || null,
    createdAt: serverTimestamp(),
  })
  return logRef.id
}

/**
 * writeBatch 失敗時のユーザー向けメッセージ（リトライ禁止を明示）
 *
 * 使用例:
 *   try {
 *     await batch.commit()
 *   } catch (e) {
 *     console.error(e)
 *     alert(buildRetryBlockedMessage(e))
 *     // 自動再送しない。ユーザーがボタンを再度押すまで待つ
 *   }
 */
export function buildRetryBlockedMessage(err) {
  const base = '保存に失敗しました。再度「保存」ボタンを押してください。\n\n自動的な再送は行いません（二重書き込み防止のため）。'
  if (!err) return base
  const hint = err?.code || err?.message || String(err)
  return `${base}\n\n詳細: ${hint}`
}

/**
 * ロール/サブロールによる操作区分ラベル（UI 表示補助）
 */
export function describeActor(profile) {
  if (!profile) return 'unknown'
  const role = profile.role || 'unknown'
  const sub = profile.subRole ? `:${profile.subRole}` : ''
  return `${role}${sub}`
}
