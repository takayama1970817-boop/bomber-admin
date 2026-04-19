import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import { fetchOrdersByMonth } from '../lib/bcartApi.js'

/**
 * 代理店向け 注文一覧（Bカート最新）。
 *
 * 役割の住み分け（2026-04-19 確定）:
 *   - /dealer                 : dealerMonthlySnapshots（13:00集計済み）
 *   - /dealer/dashboard-exec  : Bカート最新（画面表示時点）
 *   - /dealer/orders          : Bカート最新（画面表示時点）  ← 本ファイル
 *
 * 仕様:
 *   - データソースは Bカート受注API（fetchOrdersByMonth を月単位で集約）
 *   - customer_parent_id == dealerCode で絞り込み
 *   - Firestore orders は本画面では一切使わない
 *   - フィルタ・件数・合計は API取得結果に対してクライアント側で実施
 *   - localStorage で1日キャッシュ（同日中は即時表示、再取得ボタンで強制更新可）
 */

const FETCH_MONTHS = Number(import.meta.env?.VITE_DEALER_ORDERS_MONTHS) || 13
const CACHE_VERSION = 'v1'

const pad = (n) => String(n).padStart(2, '0')

function fmtTimestamp(d) {
  if (!d) return '—'
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtDate(d) {
  if (!d) return '—'
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

function toYearMonth(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

function fmtYen(n) {
  return '¥' + Math.round(Number(n) || 0).toLocaleString()
}

function generateRecentMonths(months) {
  const now = new Date()
  const out = []
  for (let i = 0; i < months; i += 1) {
    let y = now.getFullYear()
    let m = now.getMonth() - i
    while (m < 0) {
      m += 12
      y -= 1
    }
    out.push(`${y}-${pad(m + 1)}`)
  }
  return out
}

function parseBcartDate(raw) {
  if (!raw) return null
  const d = new Date(String(raw).replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d
}

export default function DealerOrders() {
  const { profile } = useAuth()
  const dealerCode = profile?.dealerCode || ''

  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState('')
  const [err, setErr] = useState(null)
  const [fetchedAt, setFetchedAt] = useState(null)
  const [now, setNow] = useState(() => new Date())
  const [monthFilter, setMonthFilter] = useState('all')
  const [salonFilter, setSalonFilter] = useState('')

  // 現在時刻（30秒粒度）
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30 * 1000)
    return () => clearInterval(id)
  }, [])

  const cacheKey = useMemo(
    () => (dealerCode ? `dealerOrdersBcart:${dealerCode}:${CACHE_VERSION}` : null),
    [dealerCode],
  )

  const fetchFromBcart = useCallback(async () => {
    if (!dealerCode) return
    setLoading(true)
    setErr(null)
    try {
      const months = generateRecentMonths(FETCH_MONTHS)
      const all = []
      for (let i = 0; i < months.length; i += 1) {
        const ym = months[i]
        setProgress(`Bカート 取得中: ${ym}（${i + 1}/${months.length}）`)
        try {
          const raw = await fetchOrdersByMonth(ym)
          for (const o of raw) {
            if (String(o.customer_parent_id ?? '') !== String(dealerCode)) continue
            all.push({
              id: String(o.id || o.code || ''),
              orderDate: parseBcartDate(o.ordered_at),
              companyName:
                (o.customer_comp_name || o.comp_name || o.customer_name || '').trim(),
              total: Number(o.final_price ?? o.total_price) || 0,
              orderNumber: o.order_no || o.order_number || o.code || '',
            })
          }
        } catch (e) {
          console.warn('Bカート取得スキップ', ym, e.message)
        }
      }
      all.sort((a, b) => (b.orderDate?.getTime() || 0) - (a.orderDate?.getTime() || 0))
      const fetchedAtNow = new Date()
      setOrders(all)
      setFetchedAt(fetchedAtNow)
      if (cacheKey) {
        try {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({
              date: new Date().toISOString().slice(0, 10),
              fetchedAt: fetchedAtNow.toISOString(),
              orders: all.map((o) => ({
                ...o,
                orderDate: o.orderDate ? o.orderDate.toISOString() : null,
              })),
            }),
          )
        } catch (e) { /* ignore quota */ }
      }
    } catch (e) {
      console.error('Bカート受注取得エラー:', e)
      setErr(e)
    } finally {
      setLoading(false)
      setProgress('')
    }
  }, [dealerCode, cacheKey])

  // 初回ロード: 同日キャッシュがあれば即表示、無ければ取得
  useEffect(() => {
    if (!dealerCode) {
      setLoading(false)
      return
    }
    let cached = null
    if (cacheKey) {
      try {
        const raw = localStorage.getItem(cacheKey)
        if (raw) {
          const parsed = JSON.parse(raw)
          const today = new Date().toISOString().slice(0, 10)
          if (parsed.date === today && Array.isArray(parsed.orders)) {
            cached = {
              orders: parsed.orders.map((o) => ({
                ...o,
                orderDate: o.orderDate ? new Date(o.orderDate) : null,
              })),
              fetchedAt: parsed.fetchedAt ? new Date(parsed.fetchedAt) : null,
            }
          }
        }
      } catch (e) { /* ignore */ }
    }
    if (cached) {
      setOrders(cached.orders)
      setFetchedAt(cached.fetchedAt)
      setLoading(false)
    } else {
      fetchFromBcart()
    }
  }, [dealerCode, cacheKey, fetchFromBcart])

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

  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, o) => {
          acc.amount += o.total
          acc.count += 1
          return acc
        },
        { amount: 0, count: 0 },
      ),
    [filtered],
  )

  if (!dealerCode) {
    return (
      <div className="rounded-2xl border-2 border-yellow-200 bg-yellow-50 p-8 text-center">
        <div className="text-lg font-bold text-yellow-800">代理店情報が未設定です</div>
        <p className="mt-2 text-sm text-yellow-600">管理者にお問い合わせください。</p>
      </div>
    )
  }

  const isInitialLoading = loading && orders.length === 0

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-wide text-gray-900">注文一覧</h1>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            自社（{profile?.companyName || dealerCode}）配下のサロン受注を Bカート最新で表示します。
          </p>
        </div>
        <div className="rounded-2xl border border-gray-100 bg-white px-4 py-2.5 text-right text-sm leading-relaxed text-gray-500 shadow-[0_1px_3px_rgba(17,24,39,0.04)]">
          <div className="text-gray-800">
            現在：<span className="font-medium tracking-wide">{fmtTimestamp(now)}</span>
          </div>
          <div className="mt-0.5 text-gray-600">
            最終更新：<span className="font-medium tracking-wide">{fmtTimestamp(fetchedAt)}</span>
          </div>
          <div className="mt-0.5 text-xs text-emerald-600">🔄 Bカート最新</div>
          <button
            onClick={fetchFromBcart}
            disabled={loading}
            className="mt-1.5 rounded-full border border-violet-200 bg-white px-3 py-0.5 text-[11px] font-medium text-violet-600 transition-colors hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? '取得中...' : '🔄 再取得'}
          </button>
        </div>
      </div>

      {loading && orders.length > 0 && progress && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-700">
          {progress}（前回取得結果を表示中）
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3 text-sm">
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

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(17,24,39,0.04)]">
          <div className="text-xs font-medium tracking-wide text-gray-500">表示件数</div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
            {totals.count.toLocaleString()}
            <span className="ml-1 text-sm font-medium text-gray-400">件</span>
          </div>
        </div>
        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(17,24,39,0.04)]">
          <div className="text-xs font-medium tracking-wide text-gray-500">表示合計（税込）</div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-gray-900">{fmtYen(totals.amount)}</div>
        </div>
      </div>

      {isInitialLoading ? (
        <div className="flex items-center justify-center py-20 text-sm text-gray-400">
          {progress || 'Bカートから受注を取得しています...'}
        </div>
      ) : err ? (
        <div className="rounded-2xl border-2 border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">
          Bカートからの取得に失敗しました：{err.message || String(err)}
          <div className="mt-3">
            <button
              onClick={fetchFromBcart}
              className="rounded border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
            >
              再試行
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          条件に一致する注文がありません
        </div>
      ) : (
        <div className="overflow-auto rounded-2xl border border-gray-100 bg-white shadow-[0_1px_3px_rgba(17,24,39,0.04)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-violet-50/40 text-left text-xs tracking-wide text-gray-500">
                <th className="px-4 py-3 font-semibold">注文日</th>
                <th className="px-4 py-3 font-semibold">サロン名</th>
                <th className="px-4 py-3 font-semibold">注文番号</th>
                <th className="px-4 py-3 text-right font-semibold">合計（税込）</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-gray-50 transition-colors hover:bg-violet-50/50"
                >
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
