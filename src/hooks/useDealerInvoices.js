import { useEffect, useState } from 'react'
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'

/**
 * dealer 自身の請求書を Firestore から取得する Hook。
 *
 * 設計方針:
 *   - Firestore のみ使用（BカートAPIは使わない）
 *   - 月次集計なので orderBy('month', 'desc') で新しい月から並べる
 *   - ステータスフィルタは client 側で適用
 *   - limit(50) 固定、pagination なし
 *
 * @param {Object} user  - profile（dealerCode を含む）
 * @param {Object} filters - { status: 'all' | 'draft' | 'sent' | 'awaiting' | 'paid' }
 */
export default function useDealerInvoices(user, filters) {
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!user?.dealerCode) {
      setInvoices([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    const q = query(
      collection(db, 'invoices'),
      where('dealerCode', '==', user.dealerCode),
      orderBy('month', 'desc'),
      limit(50),
    )

    getDocs(q)
      .then((snap) => {
        if (cancelled) return
        setInvoices(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      })
      .catch((e) => {
        console.error('useDealerInvoices fetch error:', e)
        if (!cancelled) setError(e?.message || '取得に失敗しました')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [user?.dealerCode])

  // client 側でステータスフィルタ
  const filtered = (() => {
    const status = filters?.status || 'all'
    if (status === 'all') return invoices
    return invoices.filter((inv) => (inv.status || 'draft') === status)
  })()

  return { invoices: filtered, allInvoices: invoices, loading, error }
}

export const INVOICE_STATUS_LABELS = {
  draft: '作成済',
  sent: '送付済',
  awaiting: '入金待ち',
  paid: '入金済',
}

export const INVOICE_STATUS_BADGE = {
  draft: 'bg-gray-100 text-gray-700',
  sent: 'bg-blue-100 text-blue-700',
  awaiting: 'bg-amber-100 text-amber-800',
  paid: 'bg-emerald-100 text-emerald-800',
}
