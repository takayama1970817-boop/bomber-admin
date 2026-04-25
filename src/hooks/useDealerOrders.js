import { useEffect, useState } from 'react'
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { filterValidOrders } from '../lib/ordersFilter.js'

/**
 * dealer 自身の注文を Firestore から取得する Hook。
 *
 * 設計方針:
 *   - Firestore のみを使用（Bカート API は使わない）
 *   - 取得は server query で dealerCode 一致のみ（rules と整合）
 *   - ステータスフィルタは client 側で適用
 *   - limit(50) 固定。今フェーズで pagination は入れない
 *
 * 横展開 Phase 2（2026-04-25）追加:
 *   - options.cacheKey 指定時、当日 localStorage キャッシュを読み書き
 *   - reload 関数を返却（reloadCounter で再 fetch トリガ）
 *   - 0 件取得時は既存 orders を保持（fullSync 横展開要件）
 *
 * @param {Object} user - profile（dealerCode を含む）
 * @param {Object} filters - { status: 'all' | <具体的status値> }
 * @param {Object} options - { cacheKey?: string }
 */
export default function useDealerOrders(user, filters, options = {}) {
  const cacheKey = options?.cacheKey || null
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reloadCounter, setReloadCounter] = useState(0)
  const reload = () => setReloadCounter((c) => c + 1)

  useEffect(() => {
    if (!user?.dealerCode) {
      setOrders([])
      setLoading(false)
      return
    }

    let cancelled = false

    // キャッシュ読み込み（reloadCounter==0 のみ。再読込時はバイパス）
    const today = new Date().toISOString().slice(0, 10)
    if (cacheKey && reloadCounter === 0) {
      try {
        const raw = localStorage.getItem(cacheKey)
        if (raw) {
          const cached = JSON.parse(raw)
          if (cached.date === today && Array.isArray(cached.orders) && cached.orders.length > 0) {
            const restored = cached.orders.map((o) => ({
              ...o,
              orderDate: o.orderDate ? new Date(o.orderDate) : null,
              syncedAt: o.syncedAt ? new Date(o.syncedAt) : null,
            }))
            setOrders(restored)
            setLoading(false)
            setError(null)
            return () => { cancelled = true }
          }
        }
      } catch (e) { console.warn('useDealerOrders cache read failed:', e) }
    }

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
        // 旧データ（isDeprecated === true）は表示・件数から除外する
        const filtered = filterValidOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
        // 0件取得で既存データを上書きしない（fullSync 横展開要件）
        if (filtered.length === 0 && orders.length > 0) {
          console.warn('[useDealerOrders] 0 件取得のため既存 orders を保持')
          return
        }
        setOrders(filtered)
        // キャッシュ保存（Date / Timestamp は ISO 化）
        if (cacheKey) {
          try {
            const serialised = filtered.map((o) => {
              const ts = o.syncedAt
              const sec = ts?._seconds ?? ts?.seconds
              const syncedISO = sec ? new Date(sec * 1000).toISOString()
                : ts instanceof Date ? ts.toISOString()
                : null
              const od = o.orderDate
              const odSec = od?._seconds ?? od?.seconds
              const orderISO = odSec ? new Date(odSec * 1000).toISOString()
                : od?.toDate ? od.toDate().toISOString()
                : od instanceof Date ? od.toISOString()
                : null
              return { ...o, syncedAt: syncedISO, orderDate: orderISO }
            })
            localStorage.setItem(cacheKey, JSON.stringify({ date: today, orders: serialised }))
          } catch (e) { console.warn('useDealerOrders cache write failed:', e) }
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.dealerCode, reloadCounter])

  // client 側でステータスフィルタを適用
  const filtered = (() => {
    const status = filters?.status || 'all'
    if (status === 'all') return orders
    return orders.filter((o) => normalizeStatus(o.status) === status)
  })()

  return { orders: filtered, allOrders: orders, loading, error, reload }
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
