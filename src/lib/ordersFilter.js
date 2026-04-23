/**
 * orders 共通フィルタ
 *
 * 旧データには cutover-orders.mjs によって `isDeprecated === true` が付与されている。
 * 表示・集計はすべて「有効な orders」だけを対象にしたいため、本ヘルパー1か所で
 * 判定を集約する。
 *
 * - false / undefined / 未設定 はすべて「有効」として通す（後方互換）
 * - 真偽値 true のみ除外
 */

/** 有効な order か判定する。 */
export function isValidOrder(o) {
  return o?.isDeprecated !== true
}

/** 配列から isDeprecated === true を除外する。配列でなければ [] を返す。 */
export function filterValidOrders(orders) {
  return Array.isArray(orders) ? orders.filter(isValidOrder) : []
}
