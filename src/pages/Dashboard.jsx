import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, getDocs, query, where, orderBy } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useChatUnread } from '../hooks/useChatUnread.js'
import { filterValidOrders } from '../lib/ordersFilter.js'
import { aggregateOrdersByDealer } from '../lib/aggregateOrdersByDealer.js'

function fmtYen(n) {
  if (n == null) return '—'
  return '¥' + Number(n).toLocaleString()
}

function fmtDate(d) {
  if (!d) return '—'
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

const CALENDAR_ID = 'lurbkjiegacljh0v92ubc4h8sk@group.calendar.google.com'
const API_KEY = import.meta.env.VITE_FIREBASE_API_KEY

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-2 text-3xl font-bold text-gray-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-400">{hint}</div>}
    </div>
  )
}

function fmtEventDate(dateStr) {
  const d = new Date(dateStr)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const isTomorrow = d.toDateString() === tomorrow.toDateString()

  const dayNames = ['日', '月', '火', '水', '木', '金', '土']
  const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })

  if (isToday) return { date: '今日', time, isToday: true, isTomorrow: false }
  if (isTomorrow) return { date: '明日', time, isToday: false, isTomorrow: true }
  return {
    date: `${d.getMonth() + 1}/${d.getDate()}（${dayNames[d.getDay()]}）`,
    time,
    isToday: false,
    isTomorrow: false,
  }
}

function stripHtml(html) {
  if (!html) return ''
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return tmp.textContent || tmp.innerText || ''
}

function fmtAllDay(startDate) {
  const d = new Date(startDate + 'T00:00:00')
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const isTomorrow = d.toDateString() === tomorrow.toDateString()
  const dayNames = ['日', '月', '火', '水', '木', '金', '土']

  if (isToday) return { date: '今日', time: '終日', isToday: true, isTomorrow: false }
  if (isTomorrow) return { date: '明日', time: '終日', isToday: false, isTomorrow: true }
  return {
    date: `${d.getMonth() + 1}/${d.getDate()}（${dayNames[d.getDay()]}）`,
    time: '終日',
    isToday: false,
    isTomorrow: false,
  }
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) {
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
}

export default function Dashboard() {
  const { user, profile, isAdmin } = useAuth()
  const isStaff = profile?.role === 'staff'
  const showInventory = isAdmin || isStaff
  const { totalUnread, rooms } = useChatUnread(user?.uid)
  const navigate = useNavigate()
  const [now, setNow] = useState(new Date())
  const [inventoryStats, setInventoryStats] = useState({ total: 0, totalStock: 0, zeroStock: 0, lowStock: 0 })
  const [calEvents, setCalEvents] = useState([])
  const [calLoading, setCalLoading] = useState(true)
  const [monthlySales, setMonthlySales] = useState([])
  const [salesLoading, setSalesLoading] = useState(true)
  const [newOrderCount, setNewOrderCount] = useState(0)
  // 代理店別サマリ（共通ヘルパー aggregateOrdersByDealer 由来）
  const [dealerSummary, setDealerSummary] = useState([])
  // アコーディオン展開状態（dealerCode の Set）。初期は全て閉じ。
  const [openDealers, setOpenDealers] = useState(() => new Set())
  const toggleDealer = (code) => {
    setOpenDealers((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(id)
  }, [])

  // Googleカレンダー予定読み込み（直近1週間）
  useEffect(() => {
    const loadEvents = async () => {
      try {
        const timeMin = new Date()
        timeMin.setHours(0, 0, 0, 0)
        const timeMax = new Date(timeMin)
        timeMax.setDate(timeMax.getDate() + 7)
        timeMax.setHours(23, 59, 59, 999)

        const params = new URLSearchParams({
          key: API_KEY,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '10',
        })
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`
        )
        if (res.ok) {
          const data = await res.json()
          setCalEvents(data.items || [])
        }
      } catch (e) { console.error('カレンダー読込エラー:', e) }
      finally { setCalLoading(false) }
    }
    loadEvents()
  }, [])

  // 月別売上読み込み（admin のみ）
  useEffect(() => {
    if (!isAdmin) { setSalesLoading(false); return }
    const loadSales = async () => {
      try {
        // orders + 代理店アカウント（dealerCode → 会社名のマップ用）を並列取得
        const [snap, emailSnap] = await Promise.all([
          getDocs(collection(db, 'orders')),
          getDocs(collection(db, 'allowedEmails')),
        ])

        // 旧データ（isDeprecated === true）は集計対象から除外する
        const validOrders = filterValidOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })))

        const monthMap = {}
        let pendingCount = 0
        // 未処理件数の判定は全 orders（deprecated 含む）で行うと過剰カウントになるため、
        // 月別売上と同じく validOrders に対してカウントする。
        for (const data of validOrders) {
          if (!data.status || data.status === 'new') pendingCount++
          const orderDate = data.orderDate?.toDate?.() || (data.orderDate ? new Date(data.orderDate) : null)
          if (!orderDate) continue
          const key = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}`
          if (!monthMap[key]) monthMap[key] = { month: key, count: 0, total: 0 }
          monthMap[key].count++
          monthMap[key].total += (data.total || 0)
        }
        setNewOrderCount(pendingCount)
        const sortedSales = Object.values(monthMap).sort((a, b) => b.month.localeCompare(a.month))
        setMonthlySales(sortedSales)

        // 代理店別サマリ（dealerCode 単位 / 共通ヘルパー由来）
        const dealerNameByCode = new Map()
        for (const ed of emailSnap.docs) {
          const d = ed.data()
          if (d.role === 'dealer' && d.dealerCode && !dealerNameByCode.has(d.dealerCode)) {
            dealerNameByCode.set(d.dealerCode, d.companyName || '')
          }
        }
        const summary = aggregateOrdersByDealer(validOrders, { dealerNameByCode })
        // 初期ソート: 売上降順
        summary.sort((a, b) => b.total - a.total)
        setDealerSummary(summary)
      } catch (e) { console.error('売上読込エラー:', e) }
      finally { setSalesLoading(false) }
    }
    loadSales()
  }, [isAdmin])

  // 在庫サマリー読み込み
  useEffect(() => {
    if (!showInventory) return
    const loadInventory = async () => {
      try {
        const snap = await getDocs(collection(db, 'products'))
        const prods = snap.docs.map((d) => d.data())
        const totalStock = prods.reduce((s, p) => s + (p.stock || 0), 0)
        const zeroStock = prods.filter((p) => p.stock === 0).length
        const lowStock = prods.filter((p) => p.stock > 0 && p.stock <= (p.alertThreshold || 10)).length
        setInventoryStats({ total: prods.length, totalStock, zeroStock, lowStock })
      } catch (e) { console.error('在庫読込エラー:', e) }
    }
    loadInventory()
  }, [showInventory])

  const dayNames = ['日', '月', '火', '水', '木', '金', '土']
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${dayNames[now.getDay()]}）`
  const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })

  const unreadRooms = rooms.filter((r) => r.unread)

  return (
    <div>
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="mb-1 text-xl font-bold text-gray-900 sm:text-2xl">ダッシュボード</h1>
          <p className="text-sm text-gray-500">
            こんにちは、{profile?.name || profile?.email} さん
          </p>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium text-gray-600">{dateStr}</div>
          <div className="text-2xl font-bold tabular-nums text-gray-900 sm:text-3xl">{timeStr}</div>
        </div>
      </div>

      {/* 未読チャット通知 */}
      {unreadRooms.length > 0 && (
        <div
          onClick={() => navigate('/chat')}
          className="mb-6 cursor-pointer rounded-2xl border-2 border-red-200 bg-red-50 p-5 transition-colors hover:bg-red-100"
        >
          <div className="mb-3 flex items-center gap-2">
            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-bold text-white">
              {totalUnread}
            </span>
            <span className="text-sm font-bold text-red-800">
              未読メッセージがあります
            </span>
          </div>
          <div className="space-y-2">
            {unreadRooms.map((r) => (
              <div
                key={r.roomId}
                className="flex items-center justify-between rounded-lg bg-white px-4 py-2 text-sm"
              >
                <div>
                  <span className="font-semibold text-gray-900">
                    {r.roomName === 'general' ? '📢 全体チャット' : r.roomName}
                  </span>
                  <span className="ml-3 text-gray-500">
                    {r.lastMessageBy}：{r.lastMessage.length > 30 ? r.lastMessage.slice(0, 30) + '...' : r.lastMessage}
                  </span>
                </div>
                <span className="text-xs text-gray-400">
                  {fmtTime(r.lastMessageAt)}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-xs text-red-600">
            クリックしてチャットを開く →
          </div>
        </div>
      )}

      {/* 未処理受注通知 */}
      {isAdmin && newOrderCount > 0 && (
        <div
          onClick={() => navigate('/admin/orders')}
          className="mb-6 cursor-pointer rounded-2xl border-2 border-orange-200 bg-orange-50 p-5 transition-colors hover:bg-orange-100"
        >
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-orange-500 px-1.5 text-xs font-bold text-white">
              {newOrderCount}
            </span>
            <span className="text-sm font-bold text-orange-800">
              未処理の受注があります
            </span>
          </div>
          <div className="mt-2 text-xs text-orange-600">
            クリックして受注管理を開く →
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat label="フォロー必要サロン" value="—" hint="30日以上未接触" />
        <Stat label="今月の勤務時間" value="—" hint="休憩除く" />
        <Stat label="今月の出勤日数" value="—" hint="" />
      </div>

      {/* 在庫サマリー（admin / staff のみ表示） */}
      {showInventory && (
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-gray-700">在庫状況</h2>
            <button onClick={() => navigate('/admin/inventory')}
              className="text-xs text-indigo-600 hover:underline">在庫管理を開く →</button>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
              <div className="text-xs text-indigo-500">総在庫数</div>
              <div className="mt-2 text-3xl font-bold text-indigo-700">{inventoryStats.totalStock.toLocaleString()}</div>
              <div className="mt-1 text-xs text-indigo-400">{inventoryStats.total}商品</div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="text-xs text-gray-500">全商品数</div>
              <div className="mt-2 text-3xl font-bold text-gray-900">{inventoryStats.total}</div>
            </div>
            <div className="rounded-2xl border border-red-200 bg-red-50 p-5 cursor-pointer" onClick={() => navigate('/admin/inventory')}>
              <div className="text-xs text-red-500">在庫切れ</div>
              <div className="mt-2 text-3xl font-bold text-red-600">{inventoryStats.zeroStock}</div>
              {inventoryStats.zeroStock > 0 && <div className="mt-1 text-xs text-red-400">要対応</div>}
            </div>
            <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-5 cursor-pointer" onClick={() => navigate('/admin/inventory')}>
              <div className="text-xs text-yellow-600">残りわずか</div>
              <div className="mt-2 text-3xl font-bold text-yellow-600">{inventoryStats.lowStock}</div>
              {inventoryStats.lowStock > 0 && <div className="mt-1 text-xs text-yellow-500">確認推奨</div>}
            </div>
          </div>
        </div>
      )}

      {/* 月別売上（admin のみ） */}
      {isAdmin && (
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-gray-700">📊 月別売上</h2>
            <button onClick={() => navigate('/admin/orders')}
              className="text-xs text-indigo-600 hover:underline">注文一覧を開く →</button>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
            {salesLoading ? (
              <div className="px-6 py-8 text-center text-sm text-gray-400">読み込み中...</div>
            ) : monthlySales.length === 0 ? (
              <div className="px-6 py-8 text-center text-sm text-gray-400">売上データがありません</div>
            ) : (
              <>
                {/* 今年の合計 */}
                {(() => {
                  const thisYear = String(now.getFullYear())
                  const yearData = monthlySales.filter((m) => m.month.startsWith(thisYear))
                  const yearTotal = yearData.reduce((s, m) => s + m.total, 0)
                  const yearCount = yearData.reduce((s, m) => s + m.count, 0)
                  const maxTotal = Math.max(...yearData.map((m) => m.total), 1)
                  return (
                    <div>
                      <div className="flex items-center justify-between bg-indigo-50 px-4 py-3 sm:px-5">
                        <div className="text-sm font-bold text-indigo-800">
                          {thisYear}年 合計
                        </div>
                        <div className="text-right">
                          <span className="text-lg font-bold text-indigo-700 sm:text-xl">
                            ¥{yearTotal.toLocaleString()}
                          </span>
                          <span className="ml-2 text-xs text-indigo-500">{yearCount}件</span>
                        </div>
                      </div>
                      <div className="divide-y divide-gray-50">
                        {yearData.map((m) => {
                          const [y, mo] = m.month.split('-')
                          const barWidth = Math.max((m.total / maxTotal) * 100, 2)
                          const isCurrent =
                            m.month === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
                          return (
                            <div key={m.month} className={`px-4 py-2.5 sm:px-5 ${isCurrent ? 'bg-yellow-50' : ''}`}>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className={`w-10 text-sm font-bold ${isCurrent ? 'text-yellow-700' : 'text-gray-700'}`}>
                                    {parseInt(mo)}月
                                  </span>
                                  {isCurrent && (
                                    <span className="rounded bg-yellow-200 px-1.5 py-0.5 text-[10px] font-bold text-yellow-800">
                                      当月
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-3">
                                  <span className="text-xs text-gray-400">{m.count}件</span>
                                  <span className={`text-sm font-bold tabular-nums ${isCurrent ? 'text-yellow-700' : 'text-gray-900'}`}>
                                    ¥{m.total.toLocaleString()}
                                  </span>
                                </div>
                              </div>
                              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                                <div
                                  className={`h-full rounded-full transition-all ${isCurrent ? 'bg-yellow-400' : 'bg-indigo-400'}`}
                                  style={{ width: `${barWidth}%` }}
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
                {/* 前年データがあれば表示 */}
                {(() => {
                  const lastYear = String(now.getFullYear() - 1)
                  const lastYearData = monthlySales.filter((m) => m.month.startsWith(lastYear))
                  if (lastYearData.length === 0) return null
                  const lastYearTotal = lastYearData.reduce((s, m) => s + m.total, 0)
                  const lastYearCount = lastYearData.reduce((s, m) => s + m.count, 0)
                  return (
                    <div className="border-t border-gray-200">
                      <div className="flex items-center justify-between bg-gray-50 px-4 py-3 sm:px-5">
                        <div className="text-sm font-bold text-gray-600">
                          {lastYear}年 合計
                        </div>
                        <div className="text-right">
                          <span className="text-lg font-bold text-gray-600">
                            ¥{lastYearTotal.toLocaleString()}
                          </span>
                          <span className="ml-2 text-xs text-gray-400">{lastYearCount}件</span>
                        </div>
                      </div>
                      <div className="divide-y divide-gray-50">
                        {lastYearData.map((m) => {
                          const [y, mo] = m.month.split('-')
                          return (
                            <div key={m.month} className="flex items-center justify-between px-4 py-2 sm:px-5">
                              <span className="w-10 text-sm text-gray-500">{parseInt(mo)}月</span>
                              <div className="flex items-center gap-3">
                                <span className="text-xs text-gray-400">{m.count}件</span>
                                <span className="text-sm tabular-nums text-gray-600">¥{m.total.toLocaleString()}</span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        </div>
      )}

      {/* 代理店別サマリ（admin のみ・売上降順・行クリックで詳細展開） */}
      {isAdmin && (
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-gray-700">🏢 代理店別サマリ</h2>
            <button onClick={() => navigate('/admin/dealers')}
              className="text-xs text-indigo-600 hover:underline">代理店管理を開く →</button>
          </div>
          <div className="overflow-auto rounded-2xl border border-gray-200 bg-white">
            {salesLoading ? (
              <div className="px-6 py-8 text-center text-sm text-gray-400">読み込み中...</div>
            ) : dealerSummary.length === 0 ? (
              <div className="px-6 py-8 text-center text-sm text-gray-400">代理店別データがありません</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                    <th className="px-2 py-3 w-6"></th>
                    <th className="px-4 py-3">代理店コード</th>
                    <th className="px-4 py-3">代理店名</th>
                    <th className="px-4 py-3 text-right">売上</th>
                    <th className="px-4 py-3 text-right">件数</th>
                    <th className="px-4 py-3 text-right">配下サロン数</th>
                    <th className="px-4 py-3 text-right">休眠サロン数</th>
                    <th className="px-4 py-3">最終発注日</th>
                  </tr>
                </thead>
                <tbody>
                  {dealerSummary.map((d) => {
                    const isOpen = openDealers.has(d.dealerCode)
                    // 前月比の色分け: +10%以上 green / -10%以下 red / それ以外 yellow
                    let diffBadge = null
                    if (d.diffRate != null) {
                      const pct = (d.diffRate * 100).toFixed(1)
                      const sign = d.diffRate >= 0 ? '+' : ''
                      const cls = d.diffRate >= 0.1
                        ? 'bg-emerald-100 text-emerald-800'
                        : d.diffRate <= -0.1
                          ? 'bg-red-100 text-red-800'
                          : 'bg-amber-100 text-amber-800'
                      diffBadge = (
                        <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${cls}`}>
                          {sign}{pct}%
                        </span>
                      )
                    }
                    const salonsShown = d.salons.slice(0, 20)
                    const salonsTotal = d.salons.length
                    return (
                      <React.Fragment key={d.dealerCode}>
                        <tr
                          onClick={() => toggleDealer(d.dealerCode)}
                          className="cursor-pointer border-b border-gray-50 hover:bg-indigo-50"
                        >
                          <td className="px-2 py-3 text-gray-400">{isOpen ? '▾' : '▸'}</td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-900">{d.dealerCode}</td>
                          <td className="px-4 py-3 text-gray-900">{d.dealerName || '—'}</td>
                          <td className="px-4 py-3 text-right font-bold text-gray-900">{fmtYen(d.total)}</td>
                          <td className="px-4 py-3 text-right">{d.count}件</td>
                          <td className="px-4 py-3 text-right">{d.salonCount}社</td>
                          <td className={`px-4 py-3 text-right ${d.dormantCount > 0 ? 'font-bold text-red-600' : 'text-gray-500'}`}>
                            {d.dormantCount}社
                          </td>
                          <td className="px-4 py-3 text-gray-500">{fmtDate(d.lastOrderDate)}</td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-gray-100 bg-indigo-50/30">
                            <td className="px-2 py-4"></td>
                            <td className="px-4 py-4" colSpan={7}>
                              {/* KPI ブロック */}
                              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                                <div className="rounded-lg border border-gray-200 bg-white p-3">
                                  <div className="text-[10px] text-gray-500">平均受注額</div>
                                  <div className="mt-1 text-base font-bold text-gray-900">
                                    {fmtYen(d.stats.avgPositiveTotal)}
                                  </div>
                                </div>
                                <div className="rounded-lg border border-gray-200 bg-white p-3">
                                  <div className="text-[10px] text-gray-500">返品件数</div>
                                  <div className="mt-1 text-base font-bold text-gray-900">
                                    {d.stats.returnCount}件
                                  </div>
                                </div>
                                <div className="rounded-lg border border-gray-200 bg-white p-3">
                                  <div className="text-[10px] text-gray-500">返品額</div>
                                  <div className="mt-1 text-base font-bold text-gray-900">
                                    {fmtYen(d.stats.returnAmount)}
                                  </div>
                                </div>
                                <div className="rounded-lg border border-gray-200 bg-white p-3">
                                  <div className="text-[10px] text-gray-500">当月未発注サロン</div>
                                  <div className={`mt-1 text-base font-bold ${d.noOrderThisMonthCount > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
                                    {d.noOrderThisMonthCount}社
                                  </div>
                                </div>
                                <div className="rounded-lg border border-gray-200 bg-white p-3">
                                  <div className="text-[10px] text-gray-500">前月比</div>
                                  <div className="mt-1">
                                    {diffBadge || <span className="text-sm text-gray-400">—</span>}
                                  </div>
                                  <div className="mt-1 text-[10px] text-gray-400">
                                    {fmtYen(d.currentMonthSales)} / 前月 {fmtYen(d.prevMonthSales)}
                                  </div>
                                </div>
                              </div>

                              {/* サロン別内訳（売上降順・最大20件） */}
                              <div className="overflow-auto rounded-lg border border-gray-200 bg-white">
                                <div className="border-b border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
                                  サロン別内訳（売上降順・上位{salonsShown.length}件
                                  {salonsTotal > 20 ? ` / 全${salonsTotal}件中` : ''}）
                                </div>
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="border-b border-gray-100 bg-gray-50 text-left text-[10px] text-gray-500">
                                      <th className="px-3 py-2">サロン名</th>
                                      <th className="px-3 py-2 text-right">件数</th>
                                      <th className="px-3 py-2 text-right">売上</th>
                                      <th className="px-3 py-2">最終発注日</th>
                                      <th className="px-3 py-2 text-right">経過日数</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {salonsShown.map((s) => (
                                      <tr key={s.companyName} className="border-b border-gray-50">
                                        <td className="px-3 py-1.5 text-gray-900">
                                          {s.companyName}
                                          {s.isDormant && (
                                            <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[9px] font-bold text-red-700">休眠</span>
                                          )}
                                        </td>
                                        <td className="px-3 py-1.5 text-right">{s.count}件</td>
                                        <td className="px-3 py-1.5 text-right font-bold text-gray-900">{fmtYen(s.total)}</td>
                                        <td className="px-3 py-1.5 text-gray-500">{fmtDate(s.lastOrderDate)}</td>
                                        <td className={`px-3 py-1.5 text-right ${s.isDormant ? 'font-bold text-red-600' : 'text-gray-500'}`}>
                                          {Number.isFinite(s.daysSinceLast) ? `${s.daysSinceLast}日` : '—'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* 直近1週間の予定 */}
      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-700">直近1週間の予定</h2>
          <button onClick={() => navigate('/admin/calendar')}
            className="text-xs text-indigo-600 hover:underline">カレンダーを開く →</button>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white">
          {calLoading ? (
            <div className="px-6 py-8 text-center text-sm text-gray-400">読み込み中...</div>
          ) : calEvents.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-gray-400">今後1週間の予定はありません</div>
          ) : (
            <div className="divide-y divide-gray-50">
              {calEvents.map((ev) => {
                const isAllDay = !!ev.start?.date
                const info = isAllDay
                  ? fmtAllDay(ev.start.date)
                  : fmtEventDate(ev.start.dateTime)
                const endInfo = !isAllDay && ev.end?.dateTime
                  ? new Date(ev.end.dateTime).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
                  : null
                return (
                  <div key={ev.id} className="px-4 py-3 sm:px-5 sm:py-3.5">
                    <div className="flex items-start gap-3 sm:items-center sm:gap-4">
                      <div className={`w-16 shrink-0 text-center rounded-lg py-1.5 text-xs font-bold sm:w-20 ${
                        info.isToday
                          ? 'bg-indigo-600 text-white'
                          : info.isTomorrow
                            ? 'bg-indigo-100 text-indigo-700'
                            : 'bg-gray-100 text-gray-600'
                      }`}>
                        {info.date}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                          <div className="truncate text-sm font-medium text-gray-900">{ev.summary || '（タイトルなし）'}</div>
                          <div className="shrink-0 text-xs text-gray-500">
                            {info.time === '終日' ? (
                              <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-600 font-medium">終日</span>
                            ) : (
                              <span>{info.time}{endInfo ? ` - ${endInfo}` : ''}</span>
                            )}
                          </div>
                        </div>
                        {ev.description && (
                          <div className="mt-0.5 truncate text-xs text-gray-500">{stripHtml(ev.description)}</div>
                        )}
                        {ev.location && (
                          <div className="mt-0.5 truncate text-xs text-gray-400">📍 {ev.location}</div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
