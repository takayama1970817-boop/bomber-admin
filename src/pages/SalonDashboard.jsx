import { useEffect, useMemo, useState } from 'react'
import { collection, collectionGroup, getDocs, orderBy, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function fmtYen(n) {
  if (n == null) return '—'
  return '¥' + Number(n).toLocaleString()
}

export default function SalonDashboard() {
  const { profile } = useAuth()
  const [orders, setOrders] = useState([])
  const [customers, setCustomers] = useState([])
  const [visits, setVisits] = useState([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(new Date())
  const [expandedOrder, setExpandedOrder] = useState(null)

  const companyName = profile?.companyName || ''
  const salonName = profile?.salonName || companyName

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!companyName) { setLoading(false); return }
    ;(async () => {
      try {
        const snap = await getDocs(
          query(
            collection(db, 'orders'),
            where('companyName', '==', companyName),
            orderBy('orderDate', 'desc'),
          ),
        )
        setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      } catch (e) {
        console.error('注文データ取得エラー:', e)
      }
      // 顧客一覧
      try {
        const snap = await getDocs(
          query(collection(db, 'customers'), where('salonCompanyName', '==', companyName)),
        )
        const cs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        setCustomers(cs)
        // 各顧客の visits を集約取得
        const allVisits = []
        for (const c of cs) {
          try {
            const vs = await getDocs(collection(db, 'customers', c.id, 'visits'))
            vs.docs.forEach((v) => allVisits.push({ id: v.id, customerId: c.id, ...v.data() }))
          } catch (_) { /* ignore */ }
        }
        setVisits(allVisits)
      } catch (e) {
        console.error('顧客/来店データ取得エラー:', e)
      } finally {
        setLoading(false)
      }
    })()
  }, [companyName])

  // === ④ 経営KPI 集計 ===
  const kpi = useMemo(() => {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)

    const visitsThisMonth = visits.filter((v) => {
      const d = v.visitDate?.toDate ? v.visitDate.toDate() : null
      return d && d >= monthStart
    })
    const visitsLastMonth = visits.filter((v) => {
      const d = v.visitDate?.toDate ? v.visitDate.toDate() : null
      return d && d >= lastMonthStart && d < monthStart
    })

    const sumTotal = (arr) => arr.reduce((s, v) => s + (Number(v.totalAmount) || 0), 0)
    const sumProductsSold = (arr) => arr.reduce((s, v) => {
      return s + (v.productsSold || []).reduce((ss, p) => ss + (Number(p.price) || 0) * (Number(p.quantity) || 0), 0)
    }, 0)

    const monthSales = sumTotal(visitsThisMonth)
    const lastMonthSales = sumTotal(visitsLastMonth)
    const monthVisitCount = visitsThisMonth.length
    const avgPerVisit = monthVisitCount > 0 ? Math.round(monthSales / monthVisitCount) : 0

    const productSalesThisMonth = sumProductsSold(visitsThisMonth)
    const productRatio = monthSales > 0 ? Math.round((productSalesThisMonth / monthSales) * 100) : 0

    // リピート率: 今月来店した顧客のうち、過去にも来店があった顧客の割合
    const customerVisitMap = {}
    visits.forEach((v) => {
      if (!customerVisitMap[v.customerId]) customerVisitMap[v.customerId] = []
      customerVisitMap[v.customerId].push(v.visitDate?.toDate ? v.visitDate.toDate() : null)
    })
    const monthCustomerIds = new Set(visitsThisMonth.map((v) => v.customerId))
    let repeatCount = 0
    monthCustomerIds.forEach((cid) => {
      const dates = (customerVisitMap[cid] || []).filter(Boolean)
      const hasPast = dates.some((d) => d < monthStart)
      if (hasPast) repeatCount++
    })
    const repeatRate = monthCustomerIds.size > 0 ? Math.round((repeatCount / monthCustomerIds.size) * 100) : 0

    // 月商前月比
    const momRate = lastMonthSales > 0
      ? Math.round(((monthSales - lastMonthSales) / lastMonthSales) * 100)
      : null

    return {
      monthSales,
      lastMonthSales,
      momRate,
      monthVisitCount,
      avgPerVisit,
      productSalesThisMonth,
      productRatio,
      repeatRate,
      uniqueCustomersThisMonth: monthCustomerIds.size,
    }
  }, [visits, now])

  // アラート: 45日以上未来店の顧客数
  const needFollowCount = useMemo(() => {
    return customers.filter((c) => {
      if (!c.lastVisit) return false
      const d = c.lastVisit.toDate ? c.lastVisit.toDate() : new Date(c.lastVisit)
      const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24))
      return days >= 45
    }).length
  }, [customers])

  // 集計
  const totalSales = orders.reduce((s, o) => s + (Number(o.total) || 0), 0)
  const totalCount = orders.length

  // 今月
  const thisMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`
  const thisMonthOrders = orders.filter((o) => {
    const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
    if (!d) return false
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}` === thisMonth
  })
  const thisMonthSales = thisMonthOrders.reduce((s, o) => s + (Number(o.total) || 0), 0)

  // 月別集計
  const monthly = {}
  for (const o of orders) {
    const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
    if (!d) continue
    const key = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!monthly[key]) monthly[key] = { count: 0, total: 0 }
    monthly[key].count++
    monthly[key].total += Number(o.total) || 0
  }
  const monthlyKeys = Object.keys(monthly).sort().reverse()

  const dayNames = ['日', '月', '火', '水', '木', '金', '土']
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${dayNames[now.getDay()]}）`
  const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-gray-50 text-gray-400">読み込み中...</div>
  }

  return (
    <div>
      {/* 日時表示 */}
      <div className="mb-6 text-right text-sm text-gray-500">
        {dateStr} {timeStr}
      </div>

      {!companyName ? (
        <div className="rounded-2xl border-2 border-yellow-200 bg-yellow-50 p-8 text-center">
          <div className="text-lg font-bold text-yellow-800">サロン情報が未設定です</div>
          <p className="mt-2 text-sm text-yellow-600">管理者にお問い合わせください。</p>
        </div>
      ) : (
        <>
          {/* === ④ 経営KPI （売れるサロン化システム） === */}
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-bold text-gray-900">📊 今月の経営KPI</h2>
            {kpi.momRate != null && (
              <div className="text-xs text-gray-500">
                前月比: <span className={kpi.momRate >= 0 ? 'text-pink-600 font-bold' : 'text-blue-600 font-bold'}>
                  {kpi.momRate >= 0 ? '+' : ''}{kpi.momRate}%
                </span>
              </div>
            )}
          </div>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-pink-200 bg-pink-50 p-4">
              <div className="text-[10px] text-pink-700">月商</div>
              <div className="mt-1 text-2xl font-bold text-pink-700">{fmtYen(kpi.monthSales)}</div>
              <div className="text-[10px] text-pink-500">{kpi.monthVisitCount}回来店</div>
            </div>
            <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4">
              <div className="text-[10px] text-yellow-700">客単価</div>
              <div className="mt-1 text-2xl font-bold text-yellow-700">{fmtYen(kpi.avgPerVisit)}</div>
              <div className="text-[10px] text-yellow-600">/来店1回あたり</div>
            </div>
            <div className="rounded-xl border border-purple-200 bg-purple-50 p-4">
              <div className="text-[10px] text-purple-700">リピート率</div>
              <div className="mt-1 text-2xl font-bold text-purple-700">{kpi.repeatRate}%</div>
              <div className="text-[10px] text-purple-600">{kpi.uniqueCustomersThisMonth}名中</div>
            </div>
            <div className="rounded-xl border border-green-200 bg-green-50 p-4">
              <div className="text-[10px] text-green-700">店販比率</div>
              <div className="mt-1 text-2xl font-bold text-green-700">{kpi.productRatio}%</div>
              <div className="text-[10px] text-green-600">{fmtYen(kpi.productSalesThisMonth)}</div>
            </div>
          </div>

          {/* アラート */}
          {needFollowCount > 0 && (
            <div className="mb-6 rounded-xl border-2 border-pink-300 bg-pink-50 p-4">
              <div className="flex items-center gap-2">
                <span className="text-2xl">⚠️</span>
                <div>
                  <div className="text-sm font-bold text-pink-700">
                    {needFollowCount}名のお客様が45日以上未来店です
                  </div>
                  <div className="text-xs text-pink-600">
                    顧客管理 → 「フォロー必要」フィルタから一覧確認できます
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 仕入れサマリーカード（既存：本社からの注文） */}
          <h2 className="mb-2 text-base font-bold text-gray-900">📦 本社からの仕入れ</h2>
          <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-6">
              <div className="text-xs text-gray-500">累計注文数</div>
              <div className="mt-2 text-3xl font-bold text-gray-900">{totalCount}件</div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-6">
              <div className="text-xs text-gray-500">累計お買い上げ金額</div>
              <div className="mt-2 text-3xl font-bold text-gray-900">{fmtYen(totalSales)}</div>
            </div>
            <div className="rounded-2xl border border-pink-200 bg-pink-50 p-6">
              <div className="text-xs text-pink-600">今月のお買い上げ</div>
              <div className="mt-2 text-3xl font-bold text-pink-700">{fmtYen(thisMonthSales)}</div>
              <div className="mt-1 text-xs text-pink-400">{thisMonthOrders.length}件</div>
            </div>
          </div>

          {/* 月別売上 */}
          <div className="mb-8">
            <h2 className="mb-4 text-sm font-bold text-gray-700">月別お買い上げ推移</h2>
            <div className="flex flex-wrap gap-3">
              {monthlyKeys.length === 0 ? (
                <span className="text-sm text-gray-400">データなし</span>
              ) : (
                monthlyKeys.map((k) => (
                  <div key={k} className="rounded-xl border border-gray-200 bg-white px-5 py-3 text-center">
                    <div className="text-xs text-gray-500">{k}</div>
                    <div className="mt-1 text-lg font-bold text-gray-900">{fmtYen(monthly[k].total)}</div>
                    <div className="text-xs text-gray-400">{monthly[k].count}件</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 注文一覧 */}
          <h2 className="mb-4 text-sm font-bold text-gray-700">注文履歴</h2>
          <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
            {orders.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                注文データがありません
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                    <th className="px-4 py-3">注文番号</th>
                    <th className="px-4 py-3">注文日</th>
                    <th className="px-4 py-3 text-right">小計</th>
                    <th className="px-4 py-3 text-right">送料</th>
                    <th className="px-4 py-3 text-right">税</th>
                    <th className="px-4 py-3 text-right">合計</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <>
                      <tr
                        key={o.id}
                        onClick={() => setExpandedOrder(expandedOrder === o.id ? null : o.id)}
                        className="cursor-pointer border-b border-gray-50 hover:bg-gray-50"
                      >
                        <td className="px-4 py-3 font-mono text-xs">{o.orderNumber || '—'}</td>
                        <td className="px-4 py-3">{fmtDate(o.orderDate)}</td>
                        <td className="px-4 py-3 text-right">{fmtYen(o.subtotal)}</td>
                        <td className="px-4 py-3 text-right">{fmtYen(o.shipping)}</td>
                        <td className="px-4 py-3 text-right">{fmtYen(o.tax)}</td>
                        <td className="px-4 py-3 text-right font-bold">{fmtYen(o.total)}</td>
                      </tr>
                      {expandedOrder === o.id && o.items?.length > 0 && (
                        <tr key={`${o.id}-detail`}>
                          <td colSpan={6} className="bg-gray-50 px-6 py-3">
                            <div className="text-xs text-gray-500 mb-2">注文明細</div>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-gray-400">
                                  <th className="pb-1">商品名</th>
                                  <th className="pb-1 text-right">数量</th>
                                  <th className="pb-1 text-right">単価</th>
                                  <th className="pb-1 text-right">小計</th>
                                </tr>
                              </thead>
                              <tbody>
                                {o.items.map((item, i) => (
                                  <tr key={i} className="border-t border-gray-100">
                                    <td className="py-1">{item.name || item.productCode}</td>
                                    <td className="py-1 text-right">{item.qty}</td>
                                    <td className="py-1 text-right">{fmtYen(item.price)}</td>
                                    <td className="py-1 text-right">{fmtYen((item.qty || 0) * (item.price || 0))}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
