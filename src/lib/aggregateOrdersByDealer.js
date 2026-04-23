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

const UNASSIGNED = '（未割当）'

function toDate(orderDate) {
  if (!orderDate) return null
  if (orderDate.toDate) return orderDate.toDate()
  const d = new Date(orderDate)
  return Number.isNaN(d.getTime()) ? null : d
}

export function aggregateOrdersByDealer(rawOrders, opts = {}) {
  const orders = filterValidOrders(rawOrders)
  const nameMap = opts.dealerNameByCode instanceof Map
    ? opts.dealerNameByCode
    : new Map()

  const map = new Map()
  for (const o of orders) {
    const code = String(o.dealerCode || '').trim() || UNASSIGNED
    if (!map.has(code)) {
      map.set(code, {
        dealerCode: code,
        count: 0,
        total: 0,
        lastOrderDate: null,
        salonNames: new Set(),
      })
    }
    const e = map.get(code)
    e.count += 1
    e.total += Number(o.total) || 0
    if (o.companyName) e.salonNames.add(o.companyName)
    const d = toDate(o.orderDate)
    if (d && (!e.lastOrderDate || d > e.lastOrderDate)) e.lastOrderDate = d
  }

  return [...map.values()].map((e) => ({
    dealerCode: e.dealerCode,
    dealerName: e.dealerCode === UNASSIGNED ? '' : (nameMap.get(e.dealerCode) || ''),
    count: e.count,
    total: e.total,
    salonCount: e.salonNames.size,
    lastOrderDate: e.lastOrderDate,
  }))
}

export const UNASSIGNED_DEALER_CODE = UNASSIGNED
