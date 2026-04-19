import { useEffect, useState } from 'react'
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'

/**
 * dealer 自身の注文を Firestore から取得する Hook。
 *
 * 設計方針:
 *   - Firestore のみを使用（Bカート API は使わない）
 *   - 取得は server query で dealerCode 一致のみ（rules と整合）
 *   - ステータスフィルタは client 側で適用
 *   - limit(50) 固定。今フェーズで pagination は入れない
 *
 * @param {Object} user - profile（dealerCode を含む）
 * @param {Object} filters - { status: 'all' | <具体的status値> }
 */
export default function useDealerOrders(user, filters) {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!user?.dealerCode) {
      setOrders([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    const q = query(
      collection(db, 'orders'),
      where('dealerCode', '==', user.dealerCode),
      orderBy('orderDate', 'desc'),
      limit(50),
    )

    getDocs(q)
      .then((snap) => {
        if (cancelled) return
        setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      })
      .catch((e) => {
        console.error('useDealerOrders fetch error:', e)
        if (!cancelled) setError(e?.message || '取得に失敗しました')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [user?.dealerCode])

  // client 側でステータスフィルタを適用
  const filtered = (() => {
    const status = filters?.status || 'all'
    if (status === 'all') return orders
    return orders.filter((o) => normalizeStatus(o.status) === status)
  })()

  return { orders: filtered, allOrders: orders, loading, error }
}

/**
 * status 値のゆらぎを吸収して UI ラベル用のキーに正規化。
 *   'new', 'processing' → 'processing'
 *   'shipped'           → 'shipped'
 *   'cancelled'         → 'cancelled'
 *   それ以外            → 'processing'（デフォルト）
 */
export function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase()
  if (s === 'shipped' || s === 'delivered' || s === '出荷済み') return 'shipped'
  if (s === 'cancelled' || s === 'canceled' || s === 'キャンセル') return 'cancelled'
  return 'processing' // 'new', 'processing', 未設定, その他
}

export const STATUS_LABELS = {
  processing: '処理中',
  shipped: '出荷済み',
  cancelled: 'キャンセル',
}
