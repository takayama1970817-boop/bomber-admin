/**
 * 顧客分析（サロン単位）ロジック
 * - LTV（累計売上）
 * - リピート頻度・平均単価
 * - 離脱リスク判定
 * - 次の一手レコメンド
 *
 * データ元：salons + orders（既存コレクション、Phase 1 のみで動作）
 */
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { fetchOrdersByMonth } from './bcartApi.js'
import { fetchCustomerParentMap, isOrderForDealer } from './bcartResolver.js'

const MS_PER_DAY = 1000 * 60 * 60 * 24

/**
 * Firestore Timestamp / Date / 文字列 いずれも Date に正規化
 */
function toDate(v) {
  if (!v) return null
  if (v.toDate) return v.toDate()
  if (v instanceof Date) return v
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function daysBetween(a, b) {
  if (!a || !b) return null
  return Math.floor((b.getTime() - a.getTime()) / MS_PER_DAY)
}

/**
 * 離脱リスクを 4 段階で判定
 * - safe:   最終発注 ～ 30日（問題なし）
 * - watch:  30 〜 60 日（LINE などでフォロー推奨）
 * - warn:   60 〜 90 日（担当者フォロー推奨）
 * - lost:   90 日超 or 未発注（訪問・連絡必須）
 */
export function classifyChurnRisk(daysSinceLastOrder) {
  if (daysSinceLastOrder === null || daysSinceLastOrder === undefined) return 'lost'
  if (daysSinceLastOrder < 30) return 'safe'
  if (daysSinceLastOrder < 60) return 'watch'
  if (daysSinceLastOrder < 90) return 'warn'
  return 'lost'
}

/**
 * 次の一手レコメンド（社内スタッフ向け）
 */
export function nextAction(risk, totalOrders) {
  if (totalOrders === 0) return 'まだ発注なし — 初回アプローチ'
  switch (risk) {
    case 'safe': return '継続フォロー（特別対応不要）'
    case 'watch': return 'LINE/メルマガで軽くタッチ'
    case 'warn': return '担当営業から電話確認'
    case 'lost':
    default:     return '訪問 or 緊急連絡（離脱濃厚）'
  }
}

/**
 * 全サロン × 全受注を読み込み、サロン別に集計
 * @param {Object} [opts]
 * @param {Set<string>} [opts.companyNames] 指定があればこの会社名の salon/orders のみに絞る（代理店スコープ用）
 * @returns {Promise<Array>} サロン分析配列
 */
export async function fetchSalonAnalytics(opts = {}) {
  const companyNames = opts.companyNames || null

  const [salonsSnap, ordersSnap] = await Promise.all([
    getDocs(collection(db, 'salons')),
    getDocs(collection(db, 'orders')),
  ])

  let salons = salonsSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  let orders = ordersSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((o) => !o.isReturn) // 返品は除外

  if (companyNames) {
    salons = salons.filter((s) => companyNames.has(s.name))
    orders = orders.filter((o) => companyNames.has(o.companyName))
  }

  // salonId/companyName 両対応で orders を突合
  const ordersBySalon = new Map()
  const salonByName = new Map(salons.map((s) => [s.name, s]))

  for (const o of orders) {
    // 優先: salonId。なければ companyName で salons を検索
    let key = o.salonId
    if (!key && o.companyName) {
      const matched = salonByName.get(o.companyName)
      if (matched) key = matched.id
      else key = `name:${o.companyName}` // サロン未登録でも集計できるよう仮キー
    }
    if (!key) continue
    if (!ordersBySalon.has(key)) ordersBySalon.set(key, [])
    ordersBySalon.get(key).push(o)
  }

  // 未登録会社名も「疑似サロン」として扱う
  const pseudoSalons = []
  for (const key of ordersBySalon.keys()) {
    if (key.startsWith('name:') && !salons.find((s) => `name:${s.name}` === key)) {
      const name = key.slice(5)
      if (!salons.some((s) => s.name === name)) {
        pseudoSalons.push({
          id: key,
          name,
          _pseudo: true,
        })
      }
    }
  }

  const allSalons = [...salons, ...pseudoSalons]
  const now = new Date()

  const list = allSalons.map((s) => {
    const sOrders = (ordersBySalon.get(s.id) || []).slice().sort((a, b) => {
      const ad = toDate(a.orderDate)?.getTime() || 0
      const bd = toDate(b.orderDate)?.getTime() || 0
      return ad - bd
    })

    const totalOrders = sOrders.length
    const totalRevenue = sOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0)
    const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0

    const firstOrderDate = totalOrders > 0 ? toDate(sOrders[0].orderDate) : null
    const lastOrderDate  = totalOrders > 0 ? toDate(sOrders[totalOrders - 1].orderDate) : null
    const daysSinceLast  = lastOrderDate ? daysBetween(lastOrderDate, now) : null
    const daysSinceFirst = firstOrderDate ? daysBetween(firstOrderDate, now) : null

    // 発注頻度（平均日数）
    let avgDaysBetween = null
    if (totalOrders >= 2) {
      const span = daysBetween(firstOrderDate, lastOrderDate)
      avgDaysBetween = span !== null ? Math.round(span / (totalOrders - 1)) : null
    }

    // 直近 90 日 vs 過去 90 日の推移
    const d90 = new Date(now.getTime() - 90 * MS_PER_DAY)
    const d180 = new Date(now.getTime() - 180 * MS_PER_DAY)
    const recent90 = sOrders
      .filter((o) => {
        const d = toDate(o.orderDate)
        return d && d >= d90
      })
      .reduce((sum, o) => sum + (Number(o.total) || 0), 0)
    const prev90 = sOrders
      .filter((o) => {
        const d = toDate(o.orderDate)
        return d && d >= d180 && d < d90
      })
      .reduce((sum, o) => sum + (Number(o.total) || 0), 0)
    const trend = prev90 === 0
      ? (recent90 > 0 ? 'up' : 'flat')
      : recent90 > prev90 * 1.1 ? 'up'
      : recent90 < prev90 * 0.9 ? 'down'
      : 'flat'

    const risk = classifyChurnRisk(daysSinceLast)

    // 新規判定：初回発注から 90 日以内
    const isNew = daysSinceFirst !== null && daysSinceFirst <= 90 && totalOrders <= 3

    return {
      id: s.id,
      name: s.name || '(名称未設定)',
      companyName: s.name,
      assignedUid: s.assignedUid || null,
      isPseudo: !!s._pseudo,
      totalOrders,
      totalRevenue,
      avgOrderValue,
      firstOrderDate,
      lastOrderDate,
      daysSinceLastOrder: daysSinceLast,
      avgDaysBetween,
      recent90,
      prev90,
      trend,
      risk,
      isNew,
      nextAction: nextAction(risk, totalOrders),
    }
  })

  return list
}

/**
 * 集計した配列からサマリを作る
 */
/**
 * 代理店の配下サロン（companyName Set）を取得するヘルパー
 */
export async function fetchDealerCompanyNamesForAnalytics(dealerCode) {
  if (!dealerCode) return new Set()
  const snap = await getDocs(
    query(collection(db, 'dealerSalons'), where('dealerCode', '==', dealerCode)),
  )
  return new Set(snap.docs.map((d) => d.data().companyName).filter(Boolean))
}

/**
 * 代理店スコープ版（便宜関数）
 */
export async function fetchSalonAnalyticsForDealer(dealerCode) {
  const names = await fetchDealerCompanyNamesForAnalytics(dealerCode)
  if (names.size === 0) return []
  return fetchSalonAnalytics({ companyNames: names })
}

const MS_PER_DAY_BC = 1000 * 60 * 60 * 24

/**
 * Bカート（Live）から本社（RT）全体のサロン分析
 * 代理店フィルタなし。全 orders をサロン名で集約
 * localStorage で1日1回キャッシュ
 */
export async function fetchAllSalonAnalyticsFromBcart(options = {}) {
  const months = options.months ?? 12
  const onProgress = options.onProgress
  const forceRefresh = options.forceRefresh ?? false

  const cacheKey = `salonAnalyticsBcart:ALL:${months}m`
  const today = new Date().toISOString().slice(0, 10)

  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(cacheKey)
      if (raw) {
        const cached = JSON.parse(raw)
        if (cached.date === today && Array.isArray(cached.list)) {
          return {
            list: cached.list.map((s) => ({
              ...s,
              firstOrderDate: s.firstOrderDate ? new Date(s.firstOrderDate) : null,
              lastOrderDate: s.lastOrderDate ? new Date(s.lastOrderDate) : null,
            })),
            fetchedAt: cached.fetchedAt || today,
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Bカートから12ヶ月分の orders を取得（customer_parent_id フィルタなし）
  const allOrders = []
  const now = new Date()
  for (let i = 0; i < months; i += 1) {
    let ty = now.getFullYear()
    let tm = now.getMonth() - i
    while (tm < 0) { tm += 12; ty -= 1 }
    const ymStr = `${ty}-${String(tm + 1).padStart(2, '0')}`
    try {
      if (onProgress) onProgress(`Bカート ${ymStr} 取得中...`)
      const raw = await fetchOrdersByMonth(ymStr, (loaded, total) => {
        if (onProgress) onProgress(`Bカート ${ymStr}: ${loaded}/${total}件`)
      })
      allOrders.push(...raw)
    } catch (e) {
      console.warn('bcart fetch skipped for', ymStr, e.message)
    }
  }

  // サロン名でグルーピング
  const bySalon = new Map()
  for (const o of allOrders) {
    const name = (o.customer_comp_name || o.comp_name || o.customer_name || '').trim()
    if (!name) continue
    if (!bySalon.has(name)) bySalon.set(name, [])
    const orderedAt = o.ordered_at ? new Date(o.ordered_at.replace(' ', 'T')) : null
    bySalon.get(name).push({
      total: Number(o.final_price ?? o.total_price) || 0,
      date: orderedAt,
    })
  }

  const list = []
  for (const [name, orders] of bySalon.entries()) {
    orders.sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0))
    const totalOrders = orders.length
    const totalRevenue = orders.reduce((s, o) => s + o.total, 0)
    const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0
    const firstOrderDate = orders[0]?.date || null
    const lastOrderDate = orders[totalOrders - 1]?.date || null
    const daysSinceLastOrder = lastOrderDate
      ? Math.floor((Date.now() - lastOrderDate.getTime()) / MS_PER_DAY_BC)
      : null
    const daysSinceFirst = firstOrderDate
      ? Math.floor((Date.now() - firstOrderDate.getTime()) / MS_PER_DAY_BC)
      : null

    let avgDaysBetween = null
    if (totalOrders >= 2 && firstOrderDate && lastOrderDate) {
      const span = Math.floor((lastOrderDate.getTime() - firstOrderDate.getTime()) / MS_PER_DAY_BC)
      avgDaysBetween = Math.round(span / (totalOrders - 1))
    }

    const d90 = new Date(Date.now() - 90 * MS_PER_DAY_BC)
    const d180 = new Date(Date.now() - 180 * MS_PER_DAY_BC)
    const recent90 = orders.filter((o) => o.date && o.date >= d90).reduce((s, o) => s + o.total, 0)
    const prev90 = orders.filter((o) => o.date && o.date >= d180 && o.date < d90).reduce((s, o) => s + o.total, 0)
    const trend = prev90 === 0
      ? (recent90 > 0 ? 'up' : 'flat')
      : recent90 > prev90 * 1.1 ? 'up'
      : recent90 < prev90 * 0.9 ? 'down'
      : 'flat'

    const risk = classifyChurnRisk(daysSinceLastOrder)
    const isNew = daysSinceFirst !== null && daysSinceFirst <= 90 && totalOrders <= 3

    list.push({
      id: `bcart:${name}`,
      name,
      companyName: name,
      assignedUid: null,
      isPseudo: false,
      totalOrders,
      totalRevenue,
      avgOrderValue,
      firstOrderDate,
      lastOrderDate,
      daysSinceLastOrder,
      avgDaysBetween,
      recent90,
      prev90,
      trend,
      risk,
      isNew,
      nextAction: nextAction(risk, totalOrders),
    })
  }

  // 累計売上降順ソート
  list.sort((a, b) => b.totalRevenue - a.totalRevenue)

  const fetchedAt = new Date().toLocaleString('ja-JP')
  try {
    const serializable = list.map((s) => ({
      ...s,
      firstOrderDate: s.firstOrderDate ? s.firstOrderDate.toISOString() : null,
      lastOrderDate: s.lastOrderDate ? s.lastOrderDate.toISOString() : null,
    }))
    localStorage.setItem(cacheKey, JSON.stringify({ date: today, fetchedAt, list: serializable }))
  } catch (e) { /* ignore */ }

  return { list, fetchedAt }
}

/**
 * Bカート（Live）から直接サロン分析を作る — Firestore 同期遅れの影響を受けない
 * @param {string} dealerCode
 * @param {Object} [options]
 * @param {number} [options.months=12] 遡る月数
 * @param {Function} [options.onProgress]
 * @param {boolean} [options.forceRefresh=false]
 */
export async function fetchSalonAnalyticsFromBcart(dealerCode, options = {}) {
  if (!dealerCode) return []
  const months = options.months ?? 12
  const onProgress = options.onProgress
  const forceRefresh = options.forceRefresh ?? false

  const cacheKey = `salonAnalyticsBcart:${dealerCode}:${months}m`
  const today = new Date().toISOString().slice(0, 10)

  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(cacheKey)
      if (raw) {
        const cached = JSON.parse(raw)
        if (cached.date === today && Array.isArray(cached.list)) {
          // ISO 文字列を Date に復元
          return cached.list.map((s) => ({
            ...s,
            firstOrderDate: s.firstOrderDate ? new Date(s.firstOrderDate) : null,
            lastOrderDate: s.lastOrderDate ? new Date(s.lastOrderDate) : null,
          }))
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 会員マスタ経由で帰属解決（V→J コード変更後も正しく拾う）
  if (onProgress) onProgress('Bカート 会員マスタ取得中...')
  const parentMap = await fetchCustomerParentMap({ onProgress })

  // 月次でBカート受注を取得 → dealerCode フィルタ（resolved parent_id 基準）
  const matched = []
  const now = new Date()
  for (let i = 0; i < months; i += 1) {
    let ty = now.getFullYear()
    let tm = now.getMonth() - i
    while (tm < 0) { tm += 12; ty -= 1 }
    const ymStr = `${ty}-${String(tm + 1).padStart(2, '0')}`
    try {
      if (onProgress) onProgress(`Bカート分析 ${ymStr} ...`)
      const raw = await fetchOrdersByMonth(ymStr)
      const filtered = raw.filter((o) => isOrderForDealer(o, dealerCode, parentMap))
      matched.push(...filtered)
    } catch (e) {
      console.warn('bcart analytics fetch skipped for', ymStr, e.message)
    }
  }

  // サロン名でグルーピング
  const bySalon = new Map()
  for (const o of matched) {
    const name = (o.customer_comp_name || o.comp_name || o.customer_name || '').trim()
    if (!name) continue
    if (!bySalon.has(name)) bySalon.set(name, [])
    // ordered_at: "YYYY-MM-DD HH:MM:SS"
    const orderedAt = o.ordered_at ? new Date(o.ordered_at.replace(' ', 'T')) : null
    bySalon.get(name).push({
      total: Number(o.final_price ?? o.total_price) || 0,
      date: orderedAt,
    })
  }

  const list = []
  for (const [name, orders] of bySalon.entries()) {
    orders.sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0))
    const totalOrders = orders.length
    const totalRevenue = orders.reduce((s, o) => s + o.total, 0)
    const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0
    const firstOrderDate = orders[0]?.date || null
    const lastOrderDate = orders[totalOrders - 1]?.date || null
    const daysSinceLastOrder = lastOrderDate
      ? Math.floor((Date.now() - lastOrderDate.getTime()) / MS_PER_DAY_BC)
      : null
    const daysSinceFirst = firstOrderDate
      ? Math.floor((Date.now() - firstOrderDate.getTime()) / MS_PER_DAY_BC)
      : null

    let avgDaysBetween = null
    if (totalOrders >= 2 && firstOrderDate && lastOrderDate) {
      const span = Math.floor((lastOrderDate.getTime() - firstOrderDate.getTime()) / MS_PER_DAY_BC)
      avgDaysBetween = Math.round(span / (totalOrders - 1))
    }

    // 90日 vs 90日前
    const d90 = new Date(Date.now() - 90 * MS_PER_DAY_BC)
    const d180 = new Date(Date.now() - 180 * MS_PER_DAY_BC)
    const recent90 = orders.filter((o) => o.date && o.date >= d90)
      .reduce((s, o) => s + o.total, 0)
    const prev90 = orders.filter((o) => o.date && o.date >= d180 && o.date < d90)
      .reduce((s, o) => s + o.total, 0)
    const trend = prev90 === 0
      ? (recent90 > 0 ? 'up' : 'flat')
      : recent90 > prev90 * 1.1 ? 'up'
      : recent90 < prev90 * 0.9 ? 'down'
      : 'flat'

    const risk = classifyChurnRisk(daysSinceLastOrder)
    const isNew = daysSinceFirst !== null && daysSinceFirst <= 90 && totalOrders <= 3

    list.push({
      id: `bcart:${name}`,
      name,
      companyName: name,
      assignedUid: null,
      isPseudo: false,
      totalOrders,
      totalRevenue,
      avgOrderValue,
      firstOrderDate,
      lastOrderDate,
      daysSinceLastOrder,
      avgDaysBetween,
      recent90,
      prev90,
      trend,
      risk,
      isNew,
      nextAction: nextAction(risk, totalOrders),
    })
  }

  // キャッシュ保存（Date は ISO 文字列で）
  try {
    const serializable = list.map((s) => ({
      ...s,
      firstOrderDate: s.firstOrderDate ? s.firstOrderDate.toISOString() : null,
      lastOrderDate: s.lastOrderDate ? s.lastOrderDate.toISOString() : null,
    }))
    localStorage.setItem(cacheKey, JSON.stringify({ date: today, list: serializable }))
  } catch (e) { /* ignore */ }

  return list
}

export function summarizeAnalytics(list) {
  const counts = { safe: 0, watch: 0, warn: 0, lost: 0 }
  let totalLtv = 0
  let newCount = 0
  let repeatCount = 0 // 2回以上発注したサロン

  for (const s of list) {
    counts[s.risk] = (counts[s.risk] || 0) + 1
    totalLtv += s.totalRevenue
    if (s.isNew) newCount += 1
    if (s.totalOrders >= 2) repeatCount += 1
  }

  const active = list.filter((s) => s.totalOrders > 0)
  const repeatRate = active.length > 0
    ? Math.round((repeatCount / active.length) * 1000) / 10
    : 0

  const avgLtv = active.length > 0 ? Math.round(totalLtv / active.length) : 0

  return {
    total: list.length,
    activeCount: active.length,
    newCount,
    repeatCount,
    repeatRate,       // %（小数第1位）
    totalLtv,
    avgLtv,
    counts,           // { safe, watch, warn, lost }
    followNeededCount: counts.watch + counts.warn + counts.lost,
  }
}
