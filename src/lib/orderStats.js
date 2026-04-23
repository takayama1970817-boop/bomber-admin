/**
 * 受注統計の共通計算ロジック（唯一の真実の源）
 *
 * ## 集計ポリシー（社長承認・2026-04-23 確定）
 *
 *   `total` フィールドは Bカート `final_price` と完全一致する
 *   （= 商品小計 + 税 + 送料 + 代引手数料 − 利用ポイント）。
 *   売上・受注総額は `total` の合算を「正」とする。
 *
 *   ❌ 禁止: subtotal + shipping + tax で売上を再計算すること
 *           （COD_cost / use_point が抜けて Bカートとズレる）
 *
 * ## 用途別の扱い（本関数の戻り値）
 *
 *   - 受注総額(revenue)        : 全件合算（返品 = total<0 を含む純売上）
 *   - 受注件数(orderCount)     : 全件
 *   - 最低/最高/平均           : total > 0 のみ対象
 *   - 返品額/件数              : total < 0 を別指標として集計
 *   - 商品個数(totalItemsCount): items[] の qty 合計（取れる場合）
 *
 * ## 呼び出し側の前提
 *
 *   - 入力 orders は内部で filterValidOrders (isDeprecated 除外) を適用する
 *   - 個別画面で独自に sum(total) する代わりに、本関数の戻り値を使うこと
 *
 * @typedef {Object} OrderStats
 * @property {number} revenue              受注総額（返品含む合算）
 * @property {number} orderCount           受注件数（全件）
 * @property {number} positiveOrderCount   total > 0 の件数
 * @property {number|null} minPositiveTotal 最低受注額（total > 0 のみ）
 * @property {number|null} maxPositiveTotal 最高受注額（total > 0 のみ）
 * @property {number|null} avgPositiveTotal 平均受注額（total > 0 のみ・四捨五入）
 * @property {number} returnCount          返品件数（total < 0）
 * @property {number} returnAmount         返品額合計（絶対値）
 * @property {number} totalItemsCount      商品個数合計（items[].qty の和）
 */
import { filterValidOrders } from './ordersFilter.js'

/**
 * @param {Array} rawOrders Firestore orders の配列
 * @returns {OrderStats}
 */
export function computeOrderStats(rawOrders) {
  const orders = filterValidOrders(rawOrders)
  let revenue = 0
  let positiveSum = 0
  let positiveCount = 0
  let minPositive = null
  let maxPositive = null
  let returnCount = 0
  let returnAmount = 0
  let totalItemsCount = 0

  for (const o of orders) {
    const t = Number(o.total) || 0
    revenue += t
    if (t > 0) {
      positiveCount += 1
      positiveSum += t
      if (minPositive === null || t < minPositive) minPositive = t
      if (maxPositive === null || t > maxPositive) maxPositive = t
    } else if (t < 0) {
      returnCount += 1
      returnAmount += Math.abs(t)
    }
    if (Array.isArray(o.items)) {
      for (const it of o.items) {
        totalItemsCount += Number(it?.qty) || 0
      }
    }
  }

  const avgPositive = positiveCount > 0
    ? Math.round(positiveSum / positiveCount)
    : null

  return {
    revenue,
    orderCount: orders.length,
    positiveOrderCount: positiveCount,
    minPositiveTotal: minPositive,
    maxPositiveTotal: maxPositive,
    avgPositiveTotal: avgPositive,
    returnCount,
    returnAmount,
    totalItemsCount,
  }
}

/** UI 表示用: null 安全の円表記。 */
export function fmtYenSafe(n) {
  if (n == null) return '—'
  return '¥' + Number(n).toLocaleString()
}
