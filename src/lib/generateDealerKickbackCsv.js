/**
 * 代理店配布専用 CSV ジェネレータ（明細粒度版）
 *
 * docs/KICKBACK_REQUIREMENTS.md §5 + 2026-04-25 拡張要件
 *   - 内部メモ・管理者用フラグ・他代理店情報・集計過程の中間値は除外
 *   - 代理店が「どの商品がいくつ売れて、商品ごとにいくらキックバックが付いたか」を
 *     確認できる明細粒度
 *   - 返品・キャンセルはマイナス明細 / 備考列で識別可能
 *   - 税込/税抜の基準を明示する列を含む
 *   - UTF-8 BOM 付き（Excel で開きやすい）
 *
 * 入力データ構造（kb.entries[].orders[].items[]）:
 *   entries: [{
 *     salonName, salonCode?, orderTotal, kickbackAmount,
 *     orders: [{
 *       date, payment, total, kb,
 *       orderId?, orderCode?, orderStatus?, orderFinalPrice?,
 *       items: [{
 *         productName, setName, productCode?,
 *         unitPrice, quantity, subtotal, kb, kbRate?
 *       }]
 *     }]
 *   }]
 *
 * 古い保存データ（productCode / salonCode / orderCode を持たない）でも
 * 列としては出力し、値は空文字でフォールバックする。
 *
 * 出力列（22 列）:
 *   代理店コード / 代理店名 / 対象月 /
 *   サロンコード / サロン名 /
 *   注文番号 / 注文日 / 注文ステータス / 注文合計金額(税込目安) /
 *   商品コード / 商品名 / セット名 /
 *   数量 / 単価(税抜) / 商品別売上(税抜) /
 *   商品別KB率 / 商品別KB額 /
 *   注文別KB合計 / 月別KB合計 /
 *   税基準 / 種別 / 備考
 */

const escape = (v) => {
  const s = String(v ?? '')
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** 注文ステータスからキャンセル・返品判定 */
function isCancelOrRefund(orderStatus) {
  const s = String(orderStatus || '').toLowerCase()
  return s.includes('cancel') || s.includes('refund') || s === 'キャンセル' || s === '返品'
}

/** 単一明細行を CSV 配列に変換 */
function buildItemRow({
  dealerCode, dealerName, month,
  salonCode, salonName,
  order, item,
  monthlyKbTotal,
}) {
  const cancel = isCancelOrRefund(order.orderStatus)
  // キャンセル/返品はマイナス明細扱いで出力
  const sign = cancel ? -1 : 1
  const qty = sign * (Number(item.quantity) || 0)
  const subtotal = sign * Math.round(Number(item.subtotal) || 0)
  const itemKb = sign * Math.round(Number(item.kb) || 0)
  const orderKbTotal = sign * Math.round(Number(order.kb) || 0)
  const ratePct = item.kbRate != null
    ? `${(Number(item.kbRate) * 100).toFixed(1)}%`
    : (Math.abs(subtotal) > 0 && Math.abs(itemKb) > 0 ? `${((itemKb / subtotal) * 100).toFixed(1)}%` : '')

  return [
    dealerCode,
    dealerName,
    month,
    salonCode || '',
    salonName,
    order.orderCode || order.orderId || '',
    order.date || '',
    order.orderStatus || '',
    Math.round(Number(order.orderFinalPrice) || 0),
    item.productCode || '',
    item.productName || '',
    item.setName || '',
    qty,
    Math.round(Number(item.unitPrice) || 0),
    subtotal,
    ratePct,
    itemKb,
    orderKbTotal,
    monthlyKbTotal,
    '税抜（小計） / 税込（注文合計）',
    cancel ? 'キャンセル/返品' : '通常',
    cancel ? `元 status: ${order.orderStatus}` : '',
  ]
}

/**
 * @param {Object} kb kickbacks ドキュメント（entries 配列を含む）
 * @returns {string} CSV テキスト（先頭 BOM 付き、CRLF 区切り）
 */
export function generateDealerKickbackCsv(kb) {
  if (!kb) return '﻿'

  const dealerCode = kb.dealerCode || ''
  const dealerName = kb.dealerName || dealerCode || ''
  const month = String(kb.month || '')
  const monthlyKbTotal = Math.round(
    Number(kb.totalKickback ?? kb.grandTotal ?? 0) || 0,
  )

  const lines = []
  // ヘッダ行
  lines.push([
    '代理店コード', '代理店名', '対象月',
    'サロンコード', 'サロン名',
    '注文番号', '注文日', '注文ステータス', '注文合計金額',
    '商品コード', '商品名', 'セット名',
    '数量', '単価(税抜)', '商品別売上(税抜)',
    '商品別KB率', '商品別KB額',
    '注文別KB合計', '月別KB合計',
    '税基準', '種別', '備考',
  ].map(escape).join(','))

  const entries = Array.isArray(kb.entries) ? kb.entries : []
  for (const entry of entries) {
    const salonName = entry.salonName || entry.companyName || '（不明）'
    const salonCode = entry.salonCode || ''
    const orders = Array.isArray(entry.orders) ? entry.orders : []
    if (orders.length === 0) {
      // orders 構造が無い古いデータは集約のみ 1 行で出す（最低限）
      const fallbackKb = Math.round(Number(entry.kickbackAmount ?? entry.amount ?? 0) || 0)
      const fallbackSales = Math.round(Number(entry.orderTotal ?? entry.salesAmount ?? 0) || 0)
      lines.push([
        dealerCode, dealerName, month,
        salonCode, salonName,
        '', '', '',
        fallbackSales,
        '', '（明細なし・集約のみ）', '',
        '', '', fallbackSales,
        '', fallbackKb,
        fallbackKb, monthlyKbTotal,
        '税抜（小計） / 税込（注文合計）',
        '通常',
        '旧データ・明細不足',
      ].map(escape).join(','))
      continue
    }
    for (const order of orders) {
      const items = Array.isArray(order.items) ? order.items : []
      if (items.length === 0) continue
      for (const item of items) {
        lines.push(
          buildItemRow({
            dealerCode, dealerName, month,
            salonCode, salonName,
            order, item, monthlyKbTotal,
          }).map(escape).join(','),
        )
      }
    }
  }

  // 月合計行（参照用）
  const totalQty = entries.reduce((s, e) =>
    s + (Array.isArray(e.orders) ? e.orders.reduce((s2, o) =>
      s2 + (Array.isArray(o.items) ? o.items.reduce((s3, it) =>
        s3 + (isCancelOrRefund(o.orderStatus) ? -1 : 1) * (Number(it.quantity) || 0), 0) : 0), 0) : 0), 0)
  const totalSales = Math.round(
    Number(kb.totalSales ?? entries.reduce((s, e) => s + (Number(e.orderTotal) || 0), 0)) || 0,
  )
  lines.push([
    dealerCode, dealerName, month,
    '', '【月合計】',
    '', '', '', '',
    '', '', '',
    totalQty,
    '', totalSales,
    '', monthlyKbTotal,
    '', monthlyKbTotal,
    '税抜（小計） / 税込（注文合計）',
    '集計',
    '',
  ].map(escape).join(','))

  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** ファイル名（Storage / ローカル DL 共用） */
export function buildDealerCsvFileName(kb) {
  const month = String(kb?.month || '').replace('-', '')
  const code = kb?.dealerCode || 'unknown'
  return `kickback_${code}_${month}_dealer.csv`
}
