/**
 * 外部システム生データ（erp_external_raw）の読み書きヘルパー
 *
 * 設計書: docs/04_ERP_DATA_MODEL.md §3-3b
 *
 * 方針:
 *   - Order 本体に生 JSON を持たせない（ドキュメント肥大化・PII対策）
 *   - externalRawId で参照、詳細画面のみ lazy load
 *   - 書き込みは writeBatch でアトミックに Order と同時保存
 *   - 削除禁止（物理）・payload 更新禁止（orderId のみ update 可）
 */
import { collection, doc, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase.js'
import { ERP_COLLECTIONS } from './collections.js'
import { validateExternalRaw } from './schema.js'

/**
 * writeBatch に ExternalRaw 新規保存を追加する。
 * Order と同じ batch に乗せて原子性を確保する。
 *
 * @param {WriteBatch} batch
 * @param {Object} rawData - { source, externalOrderId, payload, company }
 * @param {Object} profile - AuthContext.profile
 * @returns {string} 発行した externalRawId（Order.externalRawId に保存する）
 */
export function addExternalRawToBatch(batch, rawData, profile) {
  if (!batch) throw new Error('batch は必須')
  if (!profile?.uid) throw new Error('profile.uid は必須')

  const payload = {
    source: rawData.source,
    externalOrderId: rawData.externalOrderId,
    payload: rawData.payload,
    fetchedAt: rawData.fetchedAt || serverTimestamp(),
    orderId: rawData.orderId || null, // 後で update で紐付けることもあり
    company: rawData.company,
    version: 1,
    createdAt: serverTimestamp(),
    createdBy: profile.uid,
    updatedAt: serverTimestamp(),
    updatedBy: profile.uid,
  }

  // payload 等の必須フィールドをチェック（writeBatch に投入前）
  validateExternalRaw(payload, { isCreate: true })

  const ref = doc(collection(db, ERP_COLLECTIONS.ExternalRaw))
  batch.set(ref, payload)
  return ref.id
}

/**
 * externalRaw を取得（詳細画面等で必要な時のみ呼ぶ）
 * Order 一覧では呼ばない設計。
 */
export async function fetchExternalRaw(externalRawId) {
  if (!externalRawId) return null
  const ref = doc(db, ERP_COLLECTIONS.ExternalRaw, externalRawId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return null
  return { id: snap.id, ...snap.data() }
}

/**
 * ExternalRaw → Order 紐付けを後から update する専用関数。
 * Bカート取込など、先に ExternalRaw を保存してから Order 作成する時に使用。
 *
 * 更新許可は orderId のみ。payload 等の本体は update 不可（rules と同期）。
 */
export function addLinkToOrderToBatch(batch, externalRawId, orderId, profile) {
  if (!externalRawId || !orderId) throw new Error('externalRawId / orderId は必須')
  const ref = doc(db, ERP_COLLECTIONS.ExternalRaw, externalRawId)
  batch.update(ref, {
    orderId,
    updatedAt: serverTimestamp(),
    updatedBy: profile?.uid || 'system',
  })
}
