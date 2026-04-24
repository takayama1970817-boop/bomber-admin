/**
 * 代理店別 orders 集計（共通ロジック）
 *
 * 用途:
 *   - RT Dashboard.jsx の「代理店別サマリ」セクション
 *   - RT Dealers.jsx の代理店一覧
 *   集計の正しさをそろえるため、両画面が必ずこの関数を呼ぶこと。
 *
 * 仕様:
 *   - 入力 orders は内部で `filterValidOrders` (isDeprecated 除外) を適用する
 *   - グルーピングキーは `o.dealerCode`（trim 済み）
 *   - dealerCode が空文字 / undefined のレコードは『（未割当）』にまとめる
 *   - 配下サロン数 = distinct `o.companyName`
 *   - 最終発注日 = orders 内の最大 orderDate
 *   - 売上 = sum of Number(o.total)
 *   - 件数 = orders.length（dealerCode 単位）
 *
 * オプション:
 *   - dealerNameByCode: Map<dealerCode, dealerName>
 *     与えると `dealerName` フィールドに会社名を併記する。
 *     未指定または該当なしのときは空文字。
 */
import { filterValidOrders } from './ordersFilter.js'
import { computeOrderStats } from './orderStats.js'
import { normalizeCompanyName } from './nameNormalize.js'

const UNASSIGNED = '（未割当）'

function toDate(orderDate) {
  if (!orderDate) return null
  if (orderDate.toDate) return orderDate.toDate()
  const d = new Date(orderDate)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * 代理店別 orders 集計。dealerCode 単位でグルーピングし、
 * 各グループに対して computeOrderStats を適用する。
 *
 * 戻り値は後方互換のため従来フィールド (count / total / salonCount / lastOrderDate)
 * を維持しつつ、orderStats 由来のフィールドを additive に追加する。
 *
 * 各エントリの主要フィールド:
 *   dealerCode, dealerName,
 *   count            : 受注件数（全件 = orderStats.orderCount）
 *   total            : 受注総額（返品含む = orderStats.revenue）
 *   salonCount       : 配下サロン数 (distinct companyName)
 *   lastOrderDate    : 最終発注日
 *   stats            : computeOrderStats の戻り値（min/max/avg/return 等を含む）
 */
export function aggregateOrdersByDealer(rawOrders, opts = {}) {
  const orders = filterValidOrders(rawOrders)
  const nameMap = opts.dealerNameByCode instanceof Map
    ? opts.dealerNameByCode
    : new Map()

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
    // 配下サロン数は表記揺れを吸収して distinct 化する
    // （"Salon'de  A" と "salon'de  A" を同一サロンとしてカウント）
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
    return {
      dealerCode: code,
      dealerName: code === UNASSIGNED ? '' : (nameMap.get(code) || ''),
      count: stats.orderCount,
      total: stats.revenue,
      salonCount: m.salonNames.size,
      lastOrderDate: m.lastOrderDate,
      stats,
    }
  })
}

export const UNASSIGNED_DEALER_CODE = UNASSIGNED
