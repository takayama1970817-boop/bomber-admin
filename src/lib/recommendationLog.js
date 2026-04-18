/**
 * レコメンド成約ログ（Phase 1）
 *
 * 目的:
 *   customers/{customerId}/recommendations/{recoId} サブコレクションに
 *   「提案した結果が売れたか断られたか」を記録する。
 *
 * 設計原則（Phase 1 仕様書準拠）:
 *   - 画面を開いただけではログを作らない
 *   - [売れた]/[断られた] ボタン押下、または来店登録連動でのみ記録
 *   - 重複防止: 同一 customerId × 同一 productId × status='suggested' の
 *     未解決レコードがあれば更新。なければ新規作成。
 *   - 既に 'sold'/'declined' の過去ログは触らず、新しい提案イベントとして
 *     別レコードで扱う（履歴として残す）
 *
 * データ構造:
 *   customers/{customerId}/recommendations/{autoId}
 *     customerId: string
 *     productId: string
 *     productName: string?
 *     status: 'suggested' | 'sold' | 'declined'
 *     source: 'manual' | 'visit_auto'
 *     staffUid: string
 *     staffName: string?
 *     visitId: string?            // source='visit_auto' か手動で sold した際の来店ID
 *     createdAt: Timestamp
 *     updatedAt: Timestamp
 *     resolvedAt: Timestamp?      // sold / declined になった時刻
 */
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from './firebase.js'

const STATUS = Object.freeze({
  SUGGESTED: 'suggested',
  SOLD: 'sold',
  DECLINED: 'declined',
})

const SOURCE = Object.freeze({
  MANUAL: 'manual',
  VISIT_AUTO: 'visit_auto',
})

/**
 * 同一 customerId × productId で status='suggested' の未解決レコードを1件取得。
 * なければ null を返す。
 *
 * @param {string} customerId
 * @param {string} productId
 * @returns {Promise<{id: string, ref: DocumentReference, data: object} | null>}
 */
async function findOpenSuggestion(customerId, productId) {
  if (!customerId || !productId) return null
  try {
    const snap = await getDocs(
      query(
        collection(db, 'customers', customerId, 'recommendations'),
        where('productId', '==', productId),
        where('status', '==', STATUS.SUGGESTED),
      ),
    )
    if (snap.empty) return null
    // 仕様上 1件のみだが保険で最初のを使う
    const d = snap.docs[0]
    return { id: d.id, ref: d.ref, data: d.data() }
  } catch (e) {
    console.error('[recommendationLog] findOpenSuggestion 失敗:', e)
    return null
  }
}

/**
 * レコメンド結果を upsert する。
 * - 既存の未解決 'suggested' があれば更新（status + resolvedAt + visitId など）
 * - なければ新規作成（指定の status で直接登録）
 *
 * ボタン押下時・来店登録連動の両方から使える汎用 API。
 *
 * @param {Object} params
 * @param {string} params.customerId
 * @param {string} params.productId
 * @param {string} [params.productName]
 * @param {'sold'|'declined'|'suggested'} params.status
 * @param {'manual'|'visit_auto'} params.source
 * @param {string} params.staffUid
 * @param {string} [params.staffName]
 * @param {string} [params.visitId]
 * @returns {Promise<{mode: 'updated'|'created', id: string}>}
 */
export async function upsertRecommendationLog({
  customerId,
  productId,
  productName,
  status,
  source,
  staffUid,
  staffName,
  visitId,
}) {
  if (!customerId || !productId) {
    throw new Error('customerId と productId は必須です')
  }
  if (status !== STATUS.SOLD && status !== STATUS.DECLINED && status !== STATUS.SUGGESTED) {
    throw new Error(`不正な status: ${status}`)
  }
  if (source !== SOURCE.MANUAL && source !== SOURCE.VISIT_AUTO) {
    throw new Error(`不正な source: ${source}`)
  }

  const existing = await findOpenSuggestion(customerId, productId)

  // resolvedAt は status が sold / declined のときのみ設定
  const resolvedPatch = (status === STATUS.SOLD || status === STATUS.DECLINED)
    ? { resolvedAt: serverTimestamp() }
    : {}

  if (existing) {
    // 既存の suggested を確定させる（履歴保全のため createdAt は触らない）
    const patch = {
      status,
      source,
      updatedAt: serverTimestamp(),
      ...resolvedPatch,
      ...(visitId ? { visitId } : {}),
      ...(productName ? { productName } : {}),
      ...(staffName ? { staffName } : {}),
    }
    await updateDoc(existing.ref, patch)
    return { mode: 'updated', id: existing.id }
  }

  // 未解決レコードがなければ新規作成
  const newData = {
    customerId,
    productId,
    ...(productName ? { productName } : {}),
    status,
    source,
    staffUid: staffUid || null,
    ...(staffName ? { staffName } : {}),
    ...(visitId ? { visitId } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...resolvedPatch,
  }
  const ref = await addDoc(
    collection(db, 'customers', customerId, 'recommendations'),
    newData,
  )
  return { mode: 'created', id: ref.id }
}

/**
 * 来店登録から呼び出す。productsSold にある各商品について sold を記録する。
 * ログ失敗は来店登録自体を失敗させず、console.error のみ残す（UX 優先）。
 *
 * @param {Object} params
 * @param {string} params.customerId
 * @param {Array<{productId: string, productName?: string}>} params.productsSold
 * @param {string} params.visitId
 * @param {string} params.staffUid
 * @param {string} [params.staffName]
 */
export async function logRecommendationFromVisit({
  customerId,
  productsSold,
  visitId,
  staffUid,
  staffName,
}) {
  if (!customerId || !Array.isArray(productsSold) || productsSold.length === 0) return
  for (const p of productsSold) {
    if (!p?.productId) continue
    try {
      await upsertRecommendationLog({
        customerId,
        productId: p.productId,
        productName: p.productName,
        status: STATUS.SOLD,
        source: SOURCE.VISIT_AUTO,
        staffUid,
        staffName,
        visitId,
      })
    } catch (e) {
      console.error('[recommendationLog] 来店連動ログ失敗 productId=', p.productId, e)
    }
  }
}

export const RECOMMENDATION_STATUS = STATUS
export const RECOMMENDATION_SOURCE = SOURCE
