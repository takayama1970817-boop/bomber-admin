import { useEffect, useMemo, useState } from 'react'
import { collection, getDocs, orderBy, query, where, Timestamp } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { filterValidOrders } from '../lib/ordersFilter.js'
import { computeOrderStats } from '../lib/orderStats.js'
import { normalizeCompanyName, pickDisplayName } from '../lib/nameNormalize.js'

/**
 * 代理店ダッシュボード用メトリクス Hook（Phase 3-1 v2）
 *
 * データソース: Firestore orders のみ
 * 過去 6ヶ月分を取得 → client で集計
 *
 * 状態判定（確定版）:
 *   green  : 前月比 +10% 以上
 *   yellow : 前月比 -10%〜+10%
 *   red    : 前月比 -10% 以下 / または 30日以上発注なし
 *
 * 返却:
 *   kpis, salons, top10FollowNeeded, alerts (sharpDeclines/inactive/firstOrderStopped),
 *   newStartups, monthlyTrend, productsRanking, statusDistribution
 */
export default function useDealerDashboard(user) {
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

    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    sixMonthsAgo.setHours(0, 0, 0, 0)

    const q = query(
      collection(db, 'orders'),
      where('dealerCode', '==', user.dealerCode),
      where('orderDate', '>=', Timestamp.fromDate(sixMonthsAgo)),
      orderBy('orderDate', 'desc'),
    )

    getDocs(q)
      .then((snap) => {
        if (cancelled) return
        // 旧データ（isDeprecated === true）はメトリクス計算から除外する。
        // 最終発注日・売上・件数すべてここから派生するため必須。
        setOrders(filterValidOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() }))))
      })
      .catch((e) => {
        console.error('useDealerDashboard fetch error:', e)
        if (!cancelled) setError(e?.message || '取得に失敗しました')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [user?.dealerCode])

  const metrics = useMemo(() => computeMetrics(orders), [orders])
  // 共通 stats（売上・最低/最高/平均・返品など）。最終的な KPI は metrics.kpis を使うが、
  // 集計の正本は orderStats に寄せて、両者がズレないようにする。
  const summary = useMemo(() => computeOrderStats(orders), [orders])

  return { loading, error, ...metrics, ordersCount: orders.length, summary }
}

// =====================================================
// Helpers
// =====================================================

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function orderDateToDate(ts) {
  if (!ts) return null
  if (ts.toDate) return ts.toDate()
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d
}

function daysSince(date, from = new Date()) {
  if (!date) return Infinity
  return Math.floor((from.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
}

/**
 * 状態判定（確定版）
 * - 30日以上発注なし → red
 * - 前月比 -10% 以下 → red
 * - 前月比 -10%〜+10% → yellow
 * - 前月比 +10% 以上 → green
 */
function judgeStatus(diffRate, daysSinceLast) {
  if (daysSinceLast >= 30) return 'red'
  if (diffRate != null && diffRate <= -0.1) return 'red'
  if (diffRate != null && diffRate >= 0.1) return 'green'
  return 'yellow' // -10%〜+10% もしくは前月データなし
}

// =====================================================
// Aggregation
// =====================================================

function computeMetrics(orders) {
  const now = new Date()
  const curMonth = monthKey(now)
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevMonth = monthKey(prevDate)
  const curMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  // サロン別 × 月別 集計
  // 表記揺れを吸収するため、グルーピングキーは normalizeCompanyName で正規化する。
  // 表示名は同一キーに集まったバリアントのうち件数最大のものを採用（pickDisplayName）。
  // 正規化が空文字（companyName 欠損）になる行は『（不明）』にまとめる。
  const salonMap = new Map() // key: normalized
  const productMap = new Map() // 商品別
  const monthlyRevenue = new Map() // 月次推移
  const UNKNOWN_KEY = '__unknown__'
  // 商品明細カバレッジ計測（当月分・items 配列が 1 件以上ある doc 数 / 当月 doc 総数）
  // bcart-sync の --skip-products や、外部経路で書き込まれた items 欠損 doc が
  // どの程度あるかを UI に表示するため。
  let productCoverageWithItems = 0
  let productCoverageTotal = 0

  for (const o of orders) {
    const d = orderDateToDate(o.orderDate)
    if (!d) continue
    const m = monthKey(d)
    const total = Number(o.total) || 0
    const rawName = o.companyName || ''
    const normKey = normalizeCompanyName(rawName) || UNKNOWN_KEY

    // サロン
    if (!salonMap.has(normKey)) {
      salonMap.set(normKey, {
        byMonth: {},
        lastOrderDate: d,
        firstOrderDate: d,
        orderCount: 0,
        // 表示名選定用に raw バリアント別件数を持つ
        nameCounts: new Map(),
      })
    }
    const s = salonMap.get(normKey)
    s.byMonth[m] = (s.byMonth[m] || 0) + total
    s.orderCount += 1
    if (d > s.lastOrderDate) s.lastOrderDate = d
    if (d < s.firstOrderDate) s.firstOrderDate = d
    const displayCandidate = rawName || '（不明）'
    s.nameCounts.set(displayCandidate, (s.nameCounts.get(displayCandidate) || 0) + 1)

    // 月次推移（全サロン合算）
    monthlyRevenue.set(m, (monthlyRevenue.get(m) || 0) + total)

    // 商品別（当月のみ）+ 当月の items カバレッジ計測
    if (m === curMonth) {
      productCoverageTotal += 1
      if (Array.isArray(o.items) && o.items.length > 0) {
        productCoverageWithItems += 1
        for (const it of o.items) {
          const pn = (it.name || it.productName || '（不明）').trim()
          if (!pn || /紙袋|送料|手数料/.test(pn)) continue
          const qty = Number(it.qty) || 0
          const price = Number(it.price) || 0
          const sub = qty * price
          if (!productMap.has(pn)) productMap.set(pn, { amount: 0, count: 0 })
          const p = productMap.get(pn)
          p.amount += sub
          p.count += qty
        }
      }
    }
  }

  // サロン別メトリクス
  const salons = []
  let currentSales = 0
  let prevSales = 0
  let activeCount = 0
  let newSalonCount = 0

  for (const [, s] of salonMap.entries()) {
    const cur = s.byMonth[curMonth] || 0
    const prev = s.byMonth[prevMonth] || 0
    currentSales += cur
    prevSales += prev

    if (cur > 0) activeCount += 1
    if (s.firstOrderDate >= curMonthStart) newSalonCount += 1

    const diffRate = prev > 0 ? (cur - prev) / prev : (cur > 0 ? null : null)
    const daysSinceLast = daysSince(s.lastOrderDate, now)
    const status = judgeStatus(diffRate, daysSinceLast)
    const displayName = pickDisplayName(s.nameCounts.entries())

    salons.push({
      companyName: displayName,
      currentSales: cur,
      prevSales: prev,
      diff: cur - prev,
      diffRate,
      lastOrderDate: s.lastOrderDate,
      firstOrderDate: s.firstOrderDate,
      daysSinceLast,
      orderCount: s.orderCount,
      status,
    })
  }

  salons.sort((a, b) => b.currentSales - a.currentSales)

  // ============================================
  // アクションセンター用アグリゲート
  // ============================================

  // フォロー優先（red > yellow、同ランク内は LTV 大きい順）
  const statusOrder = { red: 0, yellow: 1, green: 2 }
  const followNeeded = salons
    .filter((s) => s.status !== 'green')
    .sort((a, b) => {
      const d = statusOrder[a.status] - statusOrder[b.status]
      if (d !== 0) return d
      return b.prevSales - a.prevSales
    })
  const top10FollowNeeded = followNeeded.slice(0, 10)

  // 売上急落：前月比 -30% 以下 & 前月が ¥10,000 以上
  const sharpDeclines = salons
    .filter((s) => s.prevSales >= 10000 && s.diffRate != null && s.diffRate <= -0.3)
    .sort((a, b) => a.diffRate - b.diffRate)

  // 発注停止：30日以上発注なし
  const inactiveSalons = salons
    .filter((s) => s.daysSinceLast >= 30)
    .sort((a, b) => b.daysSinceLast - a.daysSinceLast)

  // 初回後停止：初発注1回のみ + 現在は発注なし（30日以上）
  const firstOrderStopped = salons
    .filter((s) => s.orderCount === 1 && s.daysSinceLast >= 30)

  // 新規立ち上げ：今月初発注
  const newStartups = salons.filter((s) => s.firstOrderDate >= curMonthStart)

  // 7日以上発注なし
  const noOrderIn7DaysCount = salons.filter((s) => s.daysSinceLast >= 7).length

  // ============================================
  // 月次推移（過去6ヶ月分）
  // ============================================
  const monthlyTrend = []
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const m = monthKey(d)
    monthlyTrend.push({
      month: m,
      label: `${d.getMonth() + 1}月`,
      revenue: monthlyRevenue.get(m) || 0,
    })
  }

  // ============================================
  // 商品別ランキング Top 10
  // ============================================
  const productsRanking = Array.from(productMap.entries())
    .map(([name, v]) => ({ name, amount: v.amount, count: v.count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)

  // ============================================
  // 状態分布
  // ============================================
  const statusDistribution = {
    green: salons.filter((s) => s.status === 'green').length,
    yellow: salons.filter((s) => s.status === 'yellow').length,
    red: salons.filter((s) => s.status === 'red').length,
  }

  // ============================================
  // KPI
  // ============================================
  const totalSalonCount = salons.length
  const activeRate = totalSalonCount > 0 ? activeCount / totalSalonCount : 0
  const diff = currentSales - prevSales
  const diffRate = prevSales > 0 ? diff / prevSales : null

  const kpis = {
    // 経営ダッシュボード用
    currentSales,
    prevSales,
    diff,
    diffRate,
    activeCount,
    totalSalonCount,
    activeRate,
    curMonth,
    prevMonth,

    // アクションセンター用
    needAttentionCount: statusDistribution.red + statusDistribution.yellow,
    sharpDeclineCount: sharpDeclines.length,
    noOrderIn7DaysCount,
    newStartupCount: newStartups.length,
  }

  return {
    kpis,
    salons,
    followNeeded,
    top10FollowNeeded,
    sharpDeclines,
    inactiveSalons,
    firstOrderStopped,
    newStartups,
    monthlyTrend,
    productsRanking,
    statusDistribution,
    productCoverage: {
      withItems: productCoverageWithItems,
      total: productCoverageTotal,
    },
  }
}

// =====================================================
// UI ヘルパー
// =====================================================

export function activeRateColor(rate) {
  if (rate >= 0.8) return 'text-emerald-600'
  if (rate >= 0.5) return 'text-amber-600'
  return 'text-red-600'
}

export const STATUS_BADGE = {
  green: { label: '健全', cls: 'bg-emerald-100 text-emerald-800' },
  yellow: { label: '要注意', cls: 'bg-amber-100 text-amber-800' },
  red: { label: '警告', cls: 'bg-red-100 text-red-800' },
}
