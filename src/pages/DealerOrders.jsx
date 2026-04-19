import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import { fetchOrdersByMonth, fetchOrderProducts } from '../lib/bcartApi.js'
import DateTimeWithDow from '../components/DateTimeWithDow.jsx'

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

function fmtDateTime(d) {
  if (!d) return '—'
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function OrderRow({ order, isOpen, items, isLoadingItems, itemsError, onToggle, onRetry }) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-gray-50 transition-colors ${
          isOpen ? 'bg-violet-50/40' : 'hover:bg-violet-50/50'
        }`}
      >
        <td className="w-8 px-3 py-3 text-center text-violet-400">
          <span
            className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}
            aria-hidden="true"
          >
            ▶
          </span>
        </td>
        <td className="px-4 py-3 text-gray-700">{fmtDate(order.orderDate)}</td>
        <td className="px-4 py-3 font-medium text-gray-900">{order.companyName || '—'}</td>
        <td className="px-4 py-3 font-mono text-xs text-gray-500">{order.orderNumber || '—'}</td>
        <td className="px-4 py-3 text-right font-bold text-gray-900">{fmtYen(order.total)}</td>
      </tr>
      {isOpen && (
        <tr className="border-b border-violet-100 bg-violet-50/20">
          <td colSpan={5} className="px-6 py-5">
            <OrderDetail
              order={order}
              items={items}
              isLoadingItems={isLoadingItems}
              itemsError={itemsError}
              onRetry={onRetry}
            />
          </td>
        </tr>
      )}
    </>
  )
}

function OrderDetail({ order, items, isLoadingItems, itemsError, onRetry }) {
  // 紙袋・送料等は明細から除外
  const displayItems = Array.isArray(items)
    ? items.filter((p) => !/紙袋|送料|手数料/.test(p.product_name || ''))
    : null

  const subtotalFromItems = Array.isArray(displayItems)
    ? displayItems.reduce(
        (s, p) => s + (Number(p.unit_price) || 0) * (Number(p.order_pro_count) || 0),
        0,
      )
    : 0

  const hasTax = order.total > order.subtotal
  const tax = hasTax ? order.total - order.subtotal : Math.round(order.subtotal * 0.1)

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_auto]">
      {/* 明細 */}
      <div>
        <div className="mb-2 text-xs font-semibold tracking-wide text-gray-500">商品明細</div>
        {isLoadingItems ? (
          <div className="py-4 text-xs text-gray-400">Bカートから明細を取得中...</div>
        ) : itemsError ? (
          <div className="flex items-center gap-2 text-xs text-[#D35A5A]">
            <span>明細取得失敗: {itemsError}</span>
            <button
              onClick={onRetry}
              className="rounded border border-violet-200 bg-white px-2 py-0.5 font-medium text-violet-600 hover:bg-violet-50"
            >
              再試行
            </button>
          </div>
        ) : !displayItems || displayItems.length === 0 ? (
          <div className="py-2 text-xs text-gray-400">明細なし</div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-100 bg-white">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 bg-violet-50/30 text-left text-[11px] text-gray-500">
                  <th className="px-3 py-2 font-semibold">商品名</th>
                  <th className="w-16 px-3 py-2 text-right font-semibold">数量</th>
                  <th className="w-24 px-3 py-2 text-right font-semibold">単価</th>
                  <th className="w-28 px-3 py-2 text-right font-semibold">小計</th>
                </tr>
              </thead>
              <tbody>
                {displayItems.map((p, i) => {
                  const qty = Number(p.order_pro_count) || 0
                  const unit = Number(p.unit_price) || 0
                  return (
                    <tr key={i} className="border-b border-gray-50 last:border-0">
                      <td className="px-3 py-2 text-gray-700">
                        {p.product_name || '（不明）'}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">{qty}</td>
                      <td className="px-3 py-2 text-right text-gray-700">{fmtYen(unit)}</td>
                      <td className="px-3 py-2 text-right font-medium text-gray-900">
                        {fmtYen(unit * qty)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-violet-50/40">
                  <td className="px-3 py-2 text-right text-gray-500" colSpan={3}>
                    明細小計
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-800">
                    {fmtYen(subtotalFromItems)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* サマリ */}
      <div className="min-w-[220px] rounded-xl border border-gray-100 bg-white p-4">
        <dl className="space-y-2 text-xs">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-gray-500">注文日時</dt>
            <dd className="text-right text-gray-800">{fmtDateTime(order.orderDate)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-gray-500">注文番号</dt>
            <dd className="text-right font-mono text-gray-800">{order.orderNumber || '—'}</dd>
          </div>
          {order.customerName && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-gray-500">担当者</dt>
              <dd className="text-right text-gray-800">{order.customerName}</dd>
            </div>
          )}
          {order.setName && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-gray-500">セット</dt>
              <dd className="text-right text-gray-800">{order.setName}</dd>
            </div>
          )}
          {order.paymentMethod && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-gray-500">支払方法</dt>
              <dd className="text-right text-gray-800">{order.paymentMethod}</dd>
            </div>
          )}
          <div className="my-2 border-t border-gray-100" />
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-gray-500">小計（税抜）</dt>
            <dd className="text-right text-gray-800">{fmtYen(order.subtotal || order.total)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-gray-500">消費税</dt>
            <dd className="text-right text-gray-800">{fmtYen(tax)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 pt-1">
            <dt className="font-semibold text-gray-700">合計（税込）</dt>
            <dd className="text-right text-base font-bold text-gray-900">{fmtYen(order.total)}</dd>
          </div>
        </dl>
      </div>
    </div>
  )
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

  // 詳細展開状態
  const [expandedId, setExpandedId] = useState(null)
  const [productsById, setProductsById] = useState({})       // { [orderId]: [items] }
  const [productsLoadingById, setProductsLoadingById] = useState({}) // { [orderId]: bool }
  const [productsErrorById, setProductsErrorById] = useState({})     // { [orderId]: string }

  const toggleExpand = useCallback(
    (orderId) => {
      setExpandedId((prev) => {
        if (prev === orderId) return null
        return orderId
      })
      // 初回のみ Bカートから明細取得
      setProductsById((prev) => {
        if (prev[orderId] !== undefined) return prev
        setProductsLoadingById((m) => ({ ...m, [orderId]: true }))
        fetchOrderProducts(orderId)
          .then((items) => {
            setProductsById((m) => ({ ...m, [orderId]: items || [] }))
            setProductsErrorById((m) => ({ ...m, [orderId]: null }))
          })
          .catch((e) => {
            console.warn('order_products 取得失敗', orderId, e)
            setProductsErrorById((m) => ({ ...m, [orderId]: e.message || '取得失敗' }))
          })
          .finally(() => {
            setProductsLoadingById((m) => ({ ...m, [orderId]: false }))
          })
        return prev
      })
    },
    [],
  )

  const retryProducts = useCallback(
    (orderId) => {
      setProductsErrorById((m) => ({ ...m, [orderId]: null }))
      setProductsLoadingById((m) => ({ ...m, [orderId]: true }))
      fetchOrderProducts(orderId)
        .then((items) => {
          setProductsById((m) => ({ ...m, [orderId]: items || [] }))
        })
        .catch((e) => {
          setProductsErrorById((m) => ({ ...m, [orderId]: e.message || '取得失敗' }))
        })
        .finally(() => {
          setProductsLoadingById((m) => ({ ...m, [orderId]: false }))
        })
    },
    [],
  )

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
              subtotal: Number(o.total_price ?? o.final_price) || 0,
              orderNumber: o.order_no || o.order_number || o.code || '',
              paymentMethod: o.payment || o.payment_method || o.payment_name || '',
              setName: o.set_name || o.campaign || '',
              customerName: (o.customer_name || '').trim(),
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
        <div className="rounded-2xl border border-gray-100 bg-white px-5 py-3 text-right text-gray-500 shadow-[0_1px_3px_rgba(17,24,39,0.04)]">
          <div className="flex items-baseline justify-end gap-2">
            <span className="text-[11px] font-medium tracking-wider text-gray-400">現在</span>
            <span className="text-xl font-bold tracking-wide text-gray-900">
              <DateTimeWithDow value={now} />
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-end gap-2">
            <span className="text-[11px] font-medium tracking-wider text-gray-400">最終更新</span>
            <span className="text-lg font-semibold tracking-wide text-gray-700">
              <DateTimeWithDow value={fetchedAt} />
            </span>
          </div>
          <div className="mt-1 text-xs text-emerald-600">🔄 Bカート最新</div>
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
                <th className="w-8 px-3 py-3"></th>
                <th className="px-4 py-3 font-semibold">注文日</th>
                <th className="px-4 py-3 font-semibold">サロン名</th>
                <th className="px-4 py-3 font-semibold">注文番号</th>
                <th className="px-4 py-3 text-right font-semibold">合計（税込）</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => {
                const isOpen = expandedId === o.id
                const items = productsById[o.id]
                const isLoadingItems = productsLoadingById[o.id]
                const itemsError = productsErrorById[o.id]
                return (
                  <OrderRow
                    key={o.id}
                    order={o}
                    isOpen={isOpen}
                    items={items}
                    isLoadingItems={isLoadingItems}
                    itemsError={itemsError}
                    onToggle={() => toggleExpand(o.id)}
                    onRetry={() => retryProducts(o.id)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
