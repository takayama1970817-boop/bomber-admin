import { useEffect, useMemo, useState } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'

function fmtYen(n) {
  return '¥' + Math.round(Number(n) || 0).toLocaleString()
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function toDate(ts) {
  if (!ts) return null
  if (ts.toDate) return ts.toDate()
  return new Date(ts)
}

function toYearMonth(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function DealerOrders() {
  const { profile } = useAuth()
  const dealerCode = profile?.dealerCode || ''

  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [monthFilter, setMonthFilter] = useState('all')
  const [salonFilter, setSalonFilter] = useState('')

  useEffect(() => {
    if (!dealerCode) {
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDocs(
          query(collection(db, 'orders'), where('dealerCode', '==', dealerCode)),
        )
        if (cancelled) return
        const list = snap.docs.map((d) => {
          const data = d.data()
          return {
            id: d.id,
            companyName: data.companyName || '',
            total: Number(data.total) || 0,
            orderDate: toDate(data.orderDate),
            orderNumber: data.bcartOrderNumber || data.orderNumber || '',
            source: data.source || '',
          }
        })
        list.sort((a, b) => (b.orderDate?.getTime() || 0) - (a.orderDate?.getTime() || 0))
        setOrders(list)
      } catch (e) {
        if (cancelled) return
        console.error('orders 取得エラー:', e)
        setErr(e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dealerCode])

  const months = useMemo(() => {
    const set = new Set()
    for (const o of orders) {
      if (o.orderDate) set.add(toYearMonth(o.orderDate))
    }
    return Array.from(set).sort().reverse()
  }, [orders])

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (monthFilter !== 'all') {
        if (!o.orderDate || toYearMonth(o.orderDate) !== monthFilter) return false
      }
      if (salonFilter && !o.companyName.includes(salonFilter)) return false
      return true
    })
  }, [orders, monthFilter, salonFilter])

  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, o) => {
        acc.amount += o.total
        acc.count += 1
        return acc
      },
      { amount: 0, count: 0 },
    )
  }, [filtered])

  if (!dealerCode) {
    return (
      <div className="rounded-2xl border-2 border-yellow-200 bg-yellow-50 p-8 text-center">
        <div className="text-lg font-bold text-yellow-800">代理店情報が未設定です</div>
        <p className="mt-2 text-sm text-yellow-600">管理者にお問い合わせください。</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">注文一覧</h1>
          <p className="mt-1 text-xs text-gray-500">
            自社（{profile?.companyName || dealerCode}）配下のサロン受注をまとめて確認できます。
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col">
            <span className="text-[11px] text-gray-500">月で絞り込み</span>
            <select
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="all">すべて</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-[11px] text-gray-500">サロン名で検索</span>
            <input
              type="text"
              value={salonFilter}
              onChange={(e) => setSalonFilter(e.target.value)}
              placeholder="サロン名"
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm"
            />
          </label>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">表示件数</div>
          <div className="mt-1 text-xl font-bold text-gray-900">{totals.count}件</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">表示合計</div>
          <div className="mt-1 text-xl font-bold text-gray-900">{fmtYen(totals.amount)}</div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">読み込み中...</div>
      ) : err ? (
        <div className="rounded-2xl border-2 border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">
          注文データの取得に失敗しました：{err.message || String(err)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          条件に一致する注文がありません
        </div>
      ) : (
        <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-4 py-3">注文日</th>
                <th className="px-4 py-3">サロン名</th>
                <th className="px-4 py-3">注文番号</th>
                <th className="px-4 py-3 text-right">合計（税込）</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={o.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700">{fmtDate(o.orderDate)}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{o.companyName || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{o.orderNumber || '—'}</td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">{fmtYen(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
