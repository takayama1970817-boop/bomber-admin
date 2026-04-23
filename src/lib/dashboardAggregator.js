/**
 * 経営ダッシュボード集計ロジック（クライアント側集計）
 * Phase 1: orders コレクション単体から算出（原価・粗利は未対応）
 */
import { collection, getDocs, query, orderBy, where, Timestamp } from 'firebase/firestore'
import { db } from './firebase.js'
import { fetchOrdersByMonth, fetchOrderProductsBatch, fetchAllCustomers } from './bcartApi.js'
import { filterValidOrders } from './ordersFilter.js'

const CAMPAIGN_BUCKETS = ['ミカエル', 'エンジェル', '単品販売', '6+1']

/**
 * 指定期間の orders を取得
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<Array>}
 */
async function fetchOrders(start, end) {
  const q = query(
    collection(db, 'orders'),
    where('orderDate', '>=', Timestamp.fromDate(start)),
    where('orderDate', '<', Timestamp.fromDate(end)),
    orderBy('orderDate', 'desc'),
  )
  const snap = await getDocs(q)
  // 旧データ（isDeprecated === true）は集計対象から除外する。
  // 月次売上 / 前月比 / 推移すべてここから派生するため必須。
  return filterValidOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
}

/**
 * 月初日を取得
 */
function startOfMonth(year, month) {
  return new Date(year, month, 1, 0, 0, 0)
}

/**
 * 月次集計の中身
 */
function aggregate(orders) {
  let revenue = 0
  let subtotal = 0
  let count = 0
  const bySalon = {}
  const byCampaign = { ミカエル: 0, エンジェル: 0, 単品販売: 0, '6+1': 0, その他: 0 }
  const byPayment = {}

  for (const o of orders) {
    const total = Number(o.total) || 0
    const sub = Number(o.subtotal) || 0
    if (o.isReturn) {
      // 返品はマイナス
      revenue -= Number(o.returnAmount) || total
      continue
    }
    revenue += total
    subtotal += sub
    count += 1

    // サロン別
    const salonKey = o.companyName || o.salonId || '（不明）'
    bySalon[salonKey] = (bySalon[salonKey] || 0) + total

    // キャンペーン別
    const camp = o.campaign || ''
    const bucket = CAMPAIGN_BUCKETS.includes(camp) ? camp : 'その他'
    byCampaign[bucket] = (byCampaign[bucket] || 0) + total

    // 決済別
    const pay = o.paymentMethod || '不明'
    byPayment[pay] = (byPayment[pay] || 0) + total
  }

  const avgOrderValue = count > 0 ? Math.round(revenue / count) : 0

  // ランキング配列化
  const salonRanking = Object.entries(bySalon)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount)

  return {
    revenue,
    subtotal,
    count,
    avgOrderValue,
    byCampaign,
    byPayment,
    salonRanking,
  }
}

/**
 * メイン：指定年月の集計 + 前月比 + 直近 6 ヶ月推移
 * @param {number} year
 * @param {number} month 0-11
 */
export async function fetchMonthlyDashboard(year, month) {
  // 当月
  const curStart = startOfMonth(year, month)
  const curEnd = startOfMonth(year, month + 1)
  const curOrders = await fetchOrders(curStart, curEnd)
  const current = aggregate(curOrders)

  // 前月
  const prevStart = startOfMonth(year, month - 1)
  const prevEnd = curStart
  const prevOrders = await fetchOrders(prevStart, prevEnd)
  const previous = aggregate(prevOrders)

  // 直近 6 ヶ月推移
  const trend = []
  for (let i = 5; i >= 0; i -= 1) {
    const s = startOfMonth(year, month - i)
    const e = startOfMonth(year, month - i + 1)
    const os = await fetchOrders(s, e)
    const a = aggregate(os)
    trend.push({
      label: `${s.getFullYear()}/${String(s.getMonth() + 1).padStart(2, '0')}`,
      revenue: a.revenue,
      count: a.count,
    })
  }

  const diff = current.revenue - previous.revenue
  const diffRate = previous.revenue > 0
    ? Math.round((diff / previous.revenue) * 1000) / 10
    : null

  return {
    period: `${year}/${String(month + 1).padStart(2, '0')}`,
    current,
    previous,
    diff,
    diffRate, // 小数第1位まで
    trend,
  }
}

/**
 * 代理店の配下サロン（companyName 一覧）を取得
 * @param {string} dealerCode
 * @returns {Promise<Set<string>>}
 */
export async function fetchDealerCompanyNames(dealerCode) {
  if (!dealerCode) return new Set()
  const snap = await getDocs(
    query(collection(db, 'dealerSalons'), where('dealerCode', '==', dealerCode)),
  )
  const names = snap.docs
    .map((d) => d.data().companyName)
    .filter(Boolean)
  return new Set(names)
}

/**
 * Bカートから代理店の所属サロン名を取得
 * 主：会員一覧 API（fetchAllCustomers）から parent_id === dealerCode の会員全件
 * 副：受注データの customer_parent_id から派生（会員APIが取れない場合のフォールバック）
 * localStorage で 1 日 1 回キャッシュ
 *
 * @param {string} dealerCode
 * @param {Object} [options]
 * @param {number} [options.fallbackMonths=6] 受注派生用の遡り月数
 * @param {boolean} [options.forceRefresh=false] キャッシュ無視
 * @param {Function} [options.onProgress] 進捗コールバック
 * @returns {Promise<Set<string>>}
 */
export async function fetchDealerSalonNamesFromBcart(dealerCode, options = {}) {
  if (!dealerCode) return new Set()
  const fallbackMonths = options.fallbackMonths ?? 6
  const forceRefresh = options.forceRefresh ?? false
  const onProgress = options.onProgress

  const cacheKey = `dealerSalonNames:${dealerCode}:v3`
  const today = new Date().toISOString().slice(0, 10)

  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(cacheKey)
      if (raw) {
        const cached = JSON.parse(raw)
        if (cached.date === today && Array.isArray(cached.names)) {
          const s = new Set(cached.names)
          s.rawCount = cached.rawCount ?? cached.names.length
          return s
        }
      }
    } catch (e) { /* ignore */ }
  }

  const names = new Set()
  let customerCount = 0 // 生の会員件数（同名を別カウント）

  // ① 会員一覧 API（最優先：発注未経験のサロンも捕捉できる）
  try {
    if (onProgress) onProgress('Bカート 会員一覧取得中...')
    const customers = await fetchAllCustomers((loaded, total) => {
      if (onProgress) onProgress(`Bカート 会員: ${loaded}/${total}件`)
    })
    const dealerCodeStr = String(dealerCode).trim()
    for (const c of customers) {
      // 親会員ID（仕様揺れに対応、数値/文字列/前後空白を吸収）
      const parentRaw = c.parent_id ?? c.customer_parent_id ?? c.parent_member_id ?? ''
      const parent = String(parentRaw).trim()
      if (parent && parent === dealerCodeStr) {
        customerCount += 1
        const n = (c.comp_name || c.customer_comp_name || c.name || c.customer_name || '').trim()
        if (n) names.add(n)
      }
    }
  } catch (e) {
    console.warn('Bカート会員API失敗、受注データから派生:', e.message)
  }

  // ② 受注データから派生（会員API取れなくても最近発注しているサロンは拾う）
  const now = new Date()
  for (let i = 0; i < fallbackMonths; i += 1) {
    let ty = now.getFullYear()
    let tm = now.getMonth() - i
    while (tm < 0) { tm += 12; ty -= 1 }
    const ymStr = `${ty}-${String(tm + 1).padStart(2, '0')}`
    try {
      if (onProgress) onProgress(`Bカート 受注派生 ${ymStr} ...`)
      const raw = await fetchOrdersByMonth(ymStr)
      raw
        .filter((o) => String(o.customer_parent_id || '') === String(dealerCode))
        .forEach((o) => {
          const n = o.customer_comp_name || o.comp_name || o.customer_name
          if (n) names.add(n)
        })
    } catch (e) {
      console.warn('bcart fetch skipped for', ymStr, e.message)
    }
  }

  // 受注派生分を加算（会員APIが取れた場合は customerCount が主、取れない場合は 0 のまま）
  // 受注派生で拾ったもののうち、既に names にない分は新規なのでカウント増やす
  const rawCount = customerCount > 0 ? customerCount : names.size

  try {
    localStorage.setItem(cacheKey, JSON.stringify({
      date: today,
      names: Array.from(names),
      rawCount,
    }))
  } catch (e) { /* ignore */ }

  // Set に rawCount プロパティを付与して返す（後方互換）
  const result = new Set(names)
  result.rawCount = rawCount
  return result
}

/**
 * companyName の Set でフィルタした月次ダッシュボード
 * 代理店画面から呼ばれる想定。ただし companyNames が空の場合は空結果を返す。
 * @param {number} year
 * @param {number} month 0-11
 * @param {Set<string>} companyNames
 */
export async function fetchMonthlyDashboardScoped(year, month, companyNames) {
  const allow = companyNames || new Set()
  const filter = (orders) => orders.filter((o) => allow.has(o.companyName))

  // 当月
  const curStart = startOfMonth(year, month)
  const curEnd = startOfMonth(year, month + 1)
  const curOrders = filter(await fetchOrders(curStart, curEnd))
  const current = aggregate(curOrders)

  // 前月
  const prevStart = startOfMonth(year, month - 1)
  const prevEnd = curStart
  const prevOrders = filter(await fetchOrders(prevStart, prevEnd))
  const previous = aggregate(prevOrders)

  // 直近 6 ヶ月推移
  const trend = []
  for (let i = 5; i >= 0; i -= 1) {
    const s = startOfMonth(year, month - i)
    const e = startOfMonth(year, month - i + 1)
    const os = filter(await fetchOrders(s, e))
    const a = aggregate(os)
    trend.push({
      label: `${s.getFullYear()}/${String(s.getMonth() + 1).padStart(2, '0')}`,
      revenue: a.revenue,
      count: a.count,
    })
  }

  const diff = current.revenue - previous.revenue
  const diffRate = previous.revenue > 0
    ? Math.round((diff / previous.revenue) * 1000) / 10
    : null

  return {
    period: `${year}/${String(month + 1).padStart(2, '0')}`,
    current,
    previous,
    diff,
    diffRate,
    trend,
    scope: 'dealer',
    companyNames: Array.from(allow),
  }
}

/**
 * Bカート直接取得: 当月と前月をAPIから取得して集計
 * @param {number} year
 * @param {number} month 0-11
 * @param {Function} onProgress
 */
export async function fetchMonthlyDashboardLive(year, month, onProgress, companyNames = null, dealerCode = null) {
  const ymToStr = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`
  // Set が渡された時点でフィルタ有効（size=0 なら全て除外＝0件表示が正しい挙動）
  const shouldFilterByNames = companyNames instanceof Set
  const shouldFilterByDealer = !!dealerCode

  // Bカート生データ段階でフィルタ（customer_parent_id=dealerCode が代理店配下サロンの指標）
  // キックバック清算画面と同じロジック
  const filterRaw = (bcartOrders) => {
    if (shouldFilterByDealer) {
      return bcartOrders.filter((o) => String(o.customer_parent_id || '') === String(dealerCode))
    }
    return bcartOrders
  }

  const normalize = (bcartOrders) => {
    const mapped = filterRaw(bcartOrders).map((o) => ({
      _id: o.id, // 商品明細取得用
      total: Number(o.final_price ?? o.total_price) || 0,
      subtotal: Number(o.total_price ?? o.final_price) || 0,
      isReturn: false,
      companyName: o.customer_comp_name || o.comp_name || o.customer_name || '（不明）',
      salonId: '',
      campaign: o.set_name || o.campaign || '',
      paymentMethod: o.payment || o.payment_method || o.payment_name || '不明',
    }))
    return shouldFilterByNames
      ? mapped.filter((o) => companyNames.has(o.companyName))
      : mapped
  }

  // 当月 + 対象日（当月を表示中なら「今日」まで、過去月なら月末日）
  const today = new Date()
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month
  const cutoffDay = isCurrentMonth
    ? today.getDate()
    : new Date(year, month + 1, 0).getDate()

  if (onProgress) onProgress('Bカート 当月データ取得中...')
  const curMonthStr = ymToStr(year, month)
  const curRaw = await fetchOrdersByMonth(curMonthStr, (loaded, total) => {
    if (onProgress) onProgress(`Bカート 当月: ${loaded}/${total}件`)
  })
  const curNormalized = normalize(curRaw)
  const current = aggregate(curNormalized)

  // 当月の商品別売上は受注明細(product_name)から集計
  if (curNormalized.length > 0) {
    if (onProgress) onProgress('Bカート 当月明細取得中...')
    try {
      const orderIds = curNormalized.map((o) => o._id).filter(Boolean)
      const products = await fetchOrderProductsBatch(orderIds, (done, total) => {
        if (onProgress) onProgress(`Bカート 当月明細: ${done}/${total}件`)
      })
      const byProductMap = {}
      let productCountTotal = 0
      for (const p of products) {
        const name = (p.product_name || '（不明）').trim()
        // 紙袋・送料等は除外
        if (/紙袋|送料|手数料/.test(name)) continue
        const qty = Number(p.order_pro_count) || 0
        const sub = (Number(p.unit_price) || 0) * qty
        if (!byProductMap[name]) byProductMap[name] = { amount: 0, count: 0 }
        byProductMap[name].amount += sub
        byProductMap[name].count += qty
        productCountTotal += qty
      }
      current.byProduct = Object.entries(byProductMap)
        .map(([name, v]) => ({ name, amount: v.amount, count: v.count }))
        .sort((a, b) => b.amount - a.amount)
      current.productCountTotal = productCountTotal
    } catch (e) {
      console.warn('product aggregation skipped:', e)
    }
  }

  // 前月（年跨ぎ対応）
  let prevYear = year
  let prevMonth = month - 1
  if (prevMonth < 0) { prevMonth = 11; prevYear = year - 1 }
  const prevMonthStr = ymToStr(prevYear, prevMonth)
  if (onProgress) onProgress('Bカート 前月データ取得中...')
  const prevRaw = await fetchOrdersByMonth(prevMonthStr, (loaded, total) => {
    if (onProgress) onProgress(`Bカート 前月: ${loaded}/${total}件`)
  })
  const previous = aggregate(normalize(prevRaw))

  // 前年同月同日：同日までに絞って集計
  const lastYearMonthStr = ymToStr(year - 1, month)
  if (onProgress) onProgress('Bカート 前年同月データ取得中...')
  let lastYear = null
  let currentToDate = null // 当月の同日までの集計（比較用）
  try {
    const lyRaw = await fetchOrdersByMonth(lastYearMonthStr, (loaded, total) => {
      if (onProgress) onProgress(`Bカート 前年同月: ${loaded}/${total}件`)
    })
    // cutoffDay 以前のみフィルタ（ordered_at は "YYYY-MM-DD HH:MM:SS" 形式）
    const filterByDay = (orders, y, m) => {
      const cutoffStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(cutoffDay).padStart(2, '0')} 23:59:59`
      return orders.filter((o) => {
        const t = o.ordered_at || ''
        return t && t <= cutoffStr
      })
    }
    const lyFiltered = filterByDay(lyRaw, year - 1, month)
    lastYear = aggregate(normalize(lyFiltered))
    lastYear.cutoffDay = cutoffDay

    // 当月の同日以前（今月ならすでに cutoff まで、過去月なら全件 = current と同じ）
    const curFiltered = isCurrentMonth ? filterByDay(curRaw, year, month) : curRaw
    currentToDate = aggregate(normalize(curFiltered))
    currentToDate.cutoffDay = cutoffDay
  } catch (e) {
    console.warn('前年同月データ取得失敗:', e)
  }

  // 直近6ヶ月推移：すべてBカートから取得
  const trend = []
  for (let i = 5; i >= 0; i -= 1) {
    let ty = year, tm = month - i
    while (tm < 0) { tm += 12; ty -= 1 }
    const label = `${ty}/${String(tm + 1).padStart(2, '0')}`
    if (i === 0) {
      trend.push({ label, revenue: current.revenue, count: current.count })
    } else if (i === 1) {
      trend.push({ label, revenue: previous.revenue, count: previous.count })
    } else {
      const monthStr = ymToStr(ty, tm)
      if (onProgress) onProgress(`Bカート ${label} 取得中...`)
      const raw = await fetchOrdersByMonth(monthStr, (loaded, total) => {
        if (onProgress) onProgress(`Bカート ${label}: ${loaded}/${total}件`)
      })
      const a = aggregate(normalize(raw))
      trend.push({ label, revenue: a.revenue, count: a.count })
    }
  }

  const diff = current.revenue - previous.revenue
  const diffRate = previous.revenue > 0
    ? Math.round((diff / previous.revenue) * 1000) / 10
    : null

  // 前年同月同日比（currentToDate vs lastYear）
  const yoyDiff = (lastYear && currentToDate) ? currentToDate.revenue - lastYear.revenue : null
  const yoyDiffRate = (lastYear && currentToDate && lastYear.revenue > 0)
    ? Math.round(((currentToDate.revenue - lastYear.revenue) / lastYear.revenue) * 1000) / 10
    : null

  // 代理店スコープ時：当月 + 前月の受注から派生した配下サロン名
  const derivedCompanyNames = shouldFilterByDealer
    ? Array.from(new Set([
        ...curNormalized.map((o) => o.companyName),
        ...normalize(prevRaw).map((o) => o.companyName),
      ])).filter(Boolean)
    : null

  return {
    period: `${year}/${String(month + 1).padStart(2, '0')}`,
    cutoffDay,
    isCurrentMonth,
    current,
    currentToDate,
    previous,
    lastYear,
    diff,
    diffRate,
    yoyDiff,
    yoyDiffRate,
    trend,
    derivedCompanyNames,
    source: 'bcart-live',
  }
}
