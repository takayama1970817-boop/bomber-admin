/**
 * Shipment 履歴ベース修正（cancel + correction）のチェーン検証
 *
 * 設計書: docs/04_ERP_DATA_MODEL.md §3-9
 *
 * ルール:
 *   - correctionOf / supersededBy は単方向チェーンのみ許可
 *   - 循環禁止: A → B → A はNG
 *   - 1 レコード = 1 correction のみ（A → B と A → B' の分岐禁止）
 *   - correctionOf は一度設定したら変更禁止（rules 側でも制約）
 *   - チェーン深度上限 20（異常系検出）
 */
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase.js'
import { ERP_COLLECTIONS } from './collections.js'

const MAX_CHAIN_DEPTH = 20

async function getShipment(id) {
  if (!id) return null
  const ref = doc(db, ERP_COLLECTIONS.Shipment, id)
  const snap = await getDoc(ref)
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

/**
 * A の correction チェーンを correctionOf 方向にたどり、
 * B がそのチェーンに含まれていないか検査。含まれていれば循環になるので throw。
 *
 * @param {string} shipmentA_id 既存 shipment（cancel する対象）
 * @param {string} shipmentB_id 新規補正 shipment
 */
export async function assertNoCycle(shipmentA_id, shipmentB_id) {
  if (!shipmentA_id || !shipmentB_id) {
    throw new Error('assertNoCycle: shipmentA_id / shipmentB_id は必須')
  }
  if (shipmentA_id === shipmentB_id) {
    throw new Error('循環禁止: 自分自身を correction にはできません')
  }

  const visited = new Set()
  let current = shipmentA_id
  let depth = 0
  while (current) {
    if (visited.has(current)) {
      throw new Error(`既存チェーンに循環があります（起点 ${shipmentA_id}）`)
    }
    visited.add(current)
    if (current === shipmentB_id) {
      throw new Error(`循環参照禁止: ${shipmentB_id} は既にチェーンに含まれます`)
    }
    depth += 1
    if (depth > MAX_CHAIN_DEPTH) {
      throw new Error(`チェーン深度が ${MAX_CHAIN_DEPTH} を超えました（異常）`)
    }
    const s = await getShipment(current)
    current = s?.correctionOf || null
  }
}

/**
 * A が既に supersededBy を持っている（＝既に別の補正で置き換えられている）なら
 * 新規 correction は禁止。1 レコード = 1 correction のルール担保。
 */
export async function assertNotAlreadySuperseded(shipmentA_id) {
  if (!shipmentA_id) throw new Error('assertNotAlreadySuperseded: shipmentA_id は必須')
  const s = await getShipment(shipmentA_id)
  if (!s) throw new Error(`shipment ${shipmentA_id} が存在しません`)
  if (s.supersededBy) {
    throw new Error(`${shipmentA_id} は既に ${s.supersededBy} で修正済みです`)
  }
}

/**
 * チェーンの先頭（最古の元ID）を取得。履歴表示の起点に使う。
 */
export async function findChainRoot(shipmentId) {
  if (!shipmentId) return null
  const visited = new Set()
  let current = shipmentId
  let depth = 0
  while (current) {
    if (visited.has(current)) {
      throw new Error(`findChainRoot: 循環検出（${shipmentId}）`)
    }
    visited.add(current)
    depth += 1
    if (depth > MAX_CHAIN_DEPTH) {
      throw new Error(`findChainRoot: 深度 ${MAX_CHAIN_DEPTH} 超過`)
    }
    const s = await getShipment(current)
    if (!s) return current
    if (!s.correctionOf) return current
    current = s.correctionOf
  }
  return null
}
