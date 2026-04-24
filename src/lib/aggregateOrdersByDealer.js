/**
 * 代理店別 orders 集計（共通ロジック）
 *
 * 用途:
 *   - RT Dashboard.jsx の「代理店別サマリ」セクション（アコーディオン詳細含む）
 *   - RT Dealers.jsx の代理店一覧
 *   集計の正しさをそろえるため、両画面が必ずこの関数を呼ぶこと。
 *
 * 仕様:
 *   - 入力 orders は内部で `filterValidOrders` (isDeprecated 除外) を適用する
 *   - グルーピングキーは `o.dealerCode`（trim 済み）
 *   - dealerCode が空文字 / undefined のレコードは『（未割当）』にまとめる
 *   - 配下サロンは normalizeCompanyName で表記揺れを吸収して distinct 化
 *   - 売上 = sum of Number(o.total) （Bカート final_price と一致する正本）
 *
 * オプション:
 *   - dealerNameByCode: Map<dealerCode, dealerName>
 *     与えると `dealerName` フィールドに会社名を併記する。
 *   - now: Date
 *     休眠判定・当月/前月判定の基準時刻。テスト容易性のため差し込み可能。
 *     未指定時は new Date()。
 */
import { filterValidOrders } from './ordersFilter.js'
import { computeOrderStats } from './orderStats.js'
import { normalizeCompanyName, pickDisplayName } from './nameNormalize.js'

const UNASSIGNED = '（未割当）'
const DORMANT_DAYS = 30 // useDealerDashboard と同基準

function toDate(orderDate) {
  if (!orderDate) return null
  if (orderDate.toDate) return orderDate.toDate()
  const d = new Date(orderDate)
  return Number.isNaN(d.getTime()) ? null : d
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 1 代理店分の orders からサロン別内訳 + 月別 + 休眠/未発注を計算する。
 * 返り値は aggregateOrdersByDealer の各 entry の追加フィールドとして組み込む。
 *
 * @param {Array} list   代理店配下の orders
 * @param {Date}  now    判定基準時刻
 */
function computeDealerDetail(list, now) {
  const curMonth = monthKey(now)
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevMonth = monthKey(prevDate)

  // normalizeCompanyName をキーにサロン別集計
  const salonMap = new Map() // normKey -> { nameCounts, orders[], lastOrderDate }
  let currentMonthSales = 0
  let prevMonthSales = 0

  for (const o of list) {
    const d = toDate(o.orderDate)
    const total = Number(o.total) || 0
    const rawName = o.companyName || ''
    const normKey = normalizeCompanyName(rawName) || '__unknown__'

    if (!salonMap.has(normKey)) {
      salonMap.set(normKey, {
        nameCounts: new Map(),
        orders: [],
        lastOrderDate: null,
      })
    }
    const s = salonMap.get(normKey)
    s.orders.push(o)
    const display = rawName || '（不明）'
    s.nameCounts.set(display, (s.nameCounts.get(display) || 0) + 1)
    if (d && (!s.lastOrderDate || d > s.lastOrderDate)) s.lastOrderDate = d

    if (d) {
      const mk = monthKey(d)
      if (mk === curMonth) currentMonthSales += total
      else if (mk === prevMonth) prevMonthSales += total
    }
  }

  const salons = [...salonMap.values()].map((s) => {
    const stats = computeOrderStats(s.orders)
    const daysSinceLast = s.lastOrderDate
      ? Math.floor((now.getTime() - s.lastOrderDate.getTime()) / 86400000)
      : Infinity
    // サロン別の当月売上も算出（未発注判定用）
    let salonCurSales = 0
    for (const o of s.orders) {
      const d = toDate(o.orderDate)
      if (d && monthKey(d) === curMonth) salonCurSales += Number(o.total) || 0
    }
    return {
      companyName: pickDisplayName(s.nameCounts.entries()),
      count: stats.orderCount,
      total: stats.revenue,
      lastOrderDate: s.lastOrderDate,
      daysSinceLast,
      isDormant: daysSinceLast >= DORMANT_DAYS,
      currentMonthSales: salonCurSales,
    }
  })

  // 売上降順でソート（表示用）
  salons.sort((a, b) => b.total - a.total)

  const dormantCount = salons.filter((s) => s.isDormant).length
  const noOrderThisMonthCount = salons.filter((s) => s.currentMonthSales === 0).length
  const diffRate = prevMonthSales > 0
    ? (currentMonthSales - prevMonthSales) / prevMonthSales
    : null

  return {
    salons,
    dormantCount,
    noOrderThisMonthCount,
    currentMonthSales,
    prevMonthSales,
    diffRate,
  }
}

export function aggregateOrdersByDealer(rawOrders, opts = {}) {
  const orders = filterValidOrders(rawOrders)
  const nameMap = opts.dealerNameByCode instanceof Map
    ? opts.dealerNameByCode
    : new Map()
  const now = opts.now instanceof Date ? opts.now : new Date()

  // dealerCode → orders[] のグループ化
  const groups = new Map()
  // 並行して dealerCode → 補助情報 (lastOrderDate / salonNames) を構築
  const meta = new Map()

  for (const o of orders) {
    const code = String(o.dealerCode || '').trim() || UNASSIGNED
    if (!groups.has(code)) {
      groups.set(code, [])
      meta.set(code, { lastOrderDate: null, salonNames: new Set() })
    }
    groups.get(code).push(o)
    const m = meta.get(code)
    if (o.companyName) {
      const k = normalizeCompanyName(o.companyName)
      if (k) m.salonNames.add(k)
    }
    const d = toDate(o.orderDate)
    if (d && (!m.lastOrderDate || d > m.lastOrderDate)) m.lastOrderDate = d
  }

  return [...groups.entries()].map(([code, list]) => {
    const stats = computeOrderStats(list)
    const m = meta.get(code)
    const detail = computeDealerDetail(list, now)
    return {
      // 既存（後方互換）
      dealerCode: code,
      dealerName: code === UNASSIGNED ? '' : (nameMap.get(code) || ''),
      count: stats.orderCount,
      total: stats.revenue,
      salonCount: m.salonNames.size,
      lastOrderDate: m.lastOrderDate,
      stats,
      // 追加（アコーディオン展開用）
      salons: detail.salons,                         // サロン別内訳（売上降順）
      dormantCount: detail.dormantCount,             // 休眠サロン数（30日以上未発注）
      noOrderThisMonthCount: detail.noOrderThisMonthCount, // 当月未発注サロン数
      currentMonthSales: detail.currentMonthSales,   // 当月売上
      prevMonthSales: detail.prevMonthSales,         // 前月売上
      diffRate: detail.diffRate,                     // 前月比（null 可）
    }
  })
}

export const UNASSIGNED_DEALER_CODE = UNASSIGNED
