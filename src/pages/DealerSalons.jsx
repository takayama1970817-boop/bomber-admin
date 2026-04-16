import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { fetchDealerSalonNamesFromBcart } from '../lib/dashboardAggregator.js'
import { fetchOrdersByMonth } from '../lib/bcartApi.js'

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function fmtYen(n) {
  if (n == null) return '—'
  return '\u00a5' + Number(n).toLocaleString()
}

export default function DealerSalons() {
  const { profile } = useAuth()
  const dealerCode = profile?.dealerCode || ''

  const [salons, setSalons] = useState([])
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [rawCount, setRawCount] = useState(0)
  const [cachedAt, setCachedAt] = useState(null)
  const [progress, setProgress] = useState('')
  const [searchParams] = useSearchParams()
  const [selected, setSelected] = useState(searchParams.get('salon'))

  const loadData = async (forceRefresh = false) => {
    if (!dealerCode) { setLoading(false); return }

    const cacheKey = `dealerSalonsPage:${dealerCode}:v1`
    const today = new Date().toISOString().slice(0, 10)

    // キャッシュ確認
    if (!forceRefresh) {
      try {
        const raw = localStorage.getItem(cacheKey)
        if (raw) {
          const cached = JSON.parse(raw)
          if (cached.date === today && cached.salons && cached.orders) {
            setRawCount(cached.rawCount || cached.salons.length)
            setSalons(cached.salons)
            setOrders(cached.orders.map((o) => ({
              ...o,
              orderDate: o.orderDate ? new Date(o.orderDate) : null,
            })))
            setCachedAt(cached.fetchedAt || today)
            setLoading(false)
            return
          }
        }
      } catch (e) { console.warn('cache read failed:', e) }
    }

    setLoading(true)
    setProgress('Bカート 接続中...')
    try {
      // Bカートから所属サロン名を取得
      setProgress('Bカート 所属サロン取得中...')
      const bcartNames = await fetchDealerSalonNamesFromBcart(dealerCode, {
        fallbackMonths: 6,
        forceRefresh,
      })
      const computedRawCount = bcartNames.rawCount || bcartNames.size
      setRawCount(computedRawCount)

      // dealerSalons のメタ情報も取得（type: 'own' 等）
      const salonSnap = await getDocs(
        query(collection(db, 'dealerSalons'), where('dealerCode', '==', dealerCode))
      )
      const metaByName = new Map()
      for (const d of salonSnap.docs) {
        const data = d.data()
        if (data.companyName) metaByName.set(data.companyName, { id: d.id, ...data })
      }

      const combinedNameSet = new Set([...bcartNames, ...metaByName.keys()])
      const combinedSalons = Array.from(combinedNameSet).map((name) => {
        const meta = metaByName.get(name)
        if (meta) return meta
        return { id: `auto-${name}`, companyName: name, type: 'sub', auto: true }
      })
      setSalons(combinedSalons)

      // Bカートから直近12ヶ月の受注を取得
      const months = 12
      const nowDate = new Date()
      const allBcart = []
      for (let i = 0; i < months; i += 1) {
        let ty = nowDate.getFullYear()
        let tm = nowDate.getMonth() - i
        while (tm < 0) { tm += 12; ty -= 1 }
        const ymStr = `${ty}-${String(tm + 1).padStart(2, '0')}`
        setProgress(`Bカート 受注取得中 ${ymStr} (${i + 1}/${months})`)
        try {
          const raw = await fetchOrdersByMonth(ymStr)
          for (const o of raw) {
            if (String(o.customer_parent_id || '') !== String(dealerCode)) continue
            allBcart.push({
              id: o.id,
              companyName: (o.customer_comp_name || o.comp_name || o.customer_name || '').trim(),
              total: Number(o.final_price ?? o.total_price) || 0,
              subtotal: Number(o.total_price ?? o.final_price) || 0,
              orderDate: o.ordered_at ? new Date(o.ordered_at.replace(' ', 'T')) : null,
              orderNumber: o.order_no || o.order_number || '',
              bcartOrderNumber: o.order_no || o.order_number || '',
            })
          }
        } catch (e) {
          console.warn('bcart month skip', ymStr, e.message)
        }
      }
      setOrders(allBcart)

      // キャッシュ保存（Date は ISO 文字列に）
      const fetchedAt = new Date().toLocaleString('ja-JP')
      setCachedAt(fetchedAt)
      try {
        localStorage.setItem(cacheKey, JSON.stringify({
          date: today,
          fetchedAt,
          rawCount: computedRawCount,
          salons: combinedSalons,
          orders: allBcart.map((o) => ({
            ...o,
            orderDate: o.orderDate ? o.orderDate.toISOString() : null,
          })),
        }))
      } catch (e) { console.warn('cache write failed:', e) }
    } catch (e) {
      console.error('データ取得エラー:', e)
    } finally {
      setLoading(false)
      setProgress('')
    }
  }

  useEffect(() => {
    loadData(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealerCode])

  const now = new Date()
  const thisMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`

  // サロンごとの集計
  const salonStats = salons.map((salon) => {
    const salonOrders = orders.filter((o) => o.companyName === salon.companyName)
    const thisMonthOrders = salonOrders.filter((o) => {
      const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
      if (!d) return false
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}` === thisMonth
    })
    const lastOrderDate = salonOrders.length > 0
      ? salonOrders.reduce((latest, o) => {
          const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
          return d && (!latest || d > latest) ? d : latest
        }, null)
      : null

    return {
      ...salon,
      totalOrders: salonOrders.length,
      totalSales: salonOrders.reduce((s, o) => s + (Number(o.total) || 0), 0),
      thisMonthOrders: thisMonthOrders.length,
      thisMonthSales: thisMonthOrders.reduce((s, o) => s + (Number(o.total) || 0), 0),
      lastOrderDate,
      orders: salonOrders,
    }
  })

  // 売上順ソート
  const sortedStats = [...salonStats].sort((a, b) => b.totalSales - a.totalSales)

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-gray-400">読み込み中...</div>
  }

  // サロン詳細表示
  if (selected) {
    const salon = salonStats.find((s) => s.companyName === selected)
    if (!salon) { setSelected(null); return null }

    // 月別集計
    const monthly = {}
    for (const o of salon.orders) {
      const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
      if (!d) continue
      const key = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!monthly[key]) monthly[key] = { count: 0, total: 0 }
      monthly[key].count++
      monthly[key].total += Number(o.total) || 0
    }
    const monthlyKeys = Object.keys(monthly).sort().reverse()

    return (
      <div>
        <button
          onClick={() => setSelected(null)}
          className="mb-4 text-sm text-indigo-600 hover:underline"
        >
          ← サロン一覧に戻る
        </button>

        <div className="mb-2 flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${
            salon.type === 'own' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
          }`}>
            {salon.type === 'own' ? '自社' : 'サロン'}
          </span>
          <h1 className="text-2xl font-bold text-gray-900">{salon.companyName}</h1>
        </div>

        <div className="mb-6 flex gap-6 text-sm text-gray-500">
          <span>注文数：<strong className="text-gray-900">{salon.totalOrders}件</strong></span>
          <span>累計売上：<strong className="text-gray-900">{fmtYen(salon.totalSales)}</strong></span>
          <span>今月：<strong className="text-indigo-600">{fmtYen(salon.thisMonthSales)}</strong></span>
        </div>

        {/* 月別売上 */}
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-bold text-gray-700">月別売上</h2>
          <div className="flex flex-wrap gap-3">
            {monthlyKeys.length === 0 ? (
              <span className="text-sm text-gray-400">データなし</span>
            ) : (
              monthlyKeys.map((k) => (
                <div key={k} className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-center">
                  <div className="text-xs text-gray-500">{k}</div>
                  <div className="mt-1 text-lg font-bold text-gray-900">{fmtYen(monthly[k].total)}</div>
                  <div className="text-xs text-gray-400">{monthly[k].count}件</div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 注文一覧 */}
        <h2 className="mb-3 text-sm font-bold text-gray-700">注文履歴</h2>
        <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
          {salon.orders.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-400">注文データがありません</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                  <th className="px-4 py-3">注文番号</th>
                  <th className="px-4 py-3">注文日</th>
                  <th className="px-4 py-3 text-right">合計</th>
                </tr>
              </thead>
              <tbody>
                {salon.orders.map((o) => (
                  <tr key={o.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs">{o.orderNumber || o.bcartOrderNumber || '—'}</td>
                    <td className="px-4 py-3">{fmtDate(o.orderDate)}</td>
                    <td className="px-4 py-3 text-right font-bold">{fmtYen(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    )
  }

  // サロン一覧
  const totalSales = salonStats.reduce((s, salon) => s + salon.totalSales, 0)
  const totalOrders = salonStats.reduce((s, salon) => s + salon.totalOrders, 0)

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">所属サロン管理</h1>
        <button
          onClick={() => loadData(true)}
          disabled={loading}
          className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
          title="Bカートから最新データを再取得"
        >
          🔄 更新
        </button>
      </div>
      <p className="mb-1 text-sm text-gray-500">
        {(rawCount || salons.length).toLocaleString()} 社 ／ 累計注文 {totalOrders}件 ／ 累計売上 {fmtYen(totalSales)}
      </p>
      {cachedAt && !loading && (
        <p className="mb-6 text-xs text-gray-400">
          データ取得日時: {cachedAt}（Bカートデータは1日1回取得。最新にするには「🔄 更新」）
        </p>
      )}
      {loading && progress && (
        <div className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
          {progress}
        </div>
      )}

      {salons.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          所属サロンがまだ登録されていません
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {sortedStats.map((salon) => (
            <div
              key={salon.id}
              onClick={() => setSelected(salon.companyName)}
              className="cursor-pointer rounded-xl border border-gray-200 bg-white p-5 transition-shadow hover:shadow-md"
            >
              <div className="mb-3 flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                  salon.type === 'own' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                }`}>
                  {salon.type === 'own' ? '自社' : 'サロン'}
                </span>
                <span className="text-sm font-bold text-gray-900">{salon.companyName}</span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-[10px] text-gray-500">累計売上</div>
                  <div className="text-sm font-bold text-gray-900">{fmtYen(salon.totalSales)}</div>
                  <div className="text-[10px] text-gray-400">{salon.totalOrders}件</div>
                </div>
                <div>
                  <div className="text-[10px] text-indigo-500">今月</div>
                  <div className="text-sm font-bold text-indigo-600">{fmtYen(salon.thisMonthSales)}</div>
                  <div className="text-[10px] text-indigo-300">{salon.thisMonthOrders}件</div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-500">最終注文</div>
                  <div className="text-sm text-gray-700">
                    {salon.lastOrderDate
                      ? `${salon.lastOrderDate.getMonth() + 1}/${salon.lastOrderDate.getDate()}`
                      : '—'}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
