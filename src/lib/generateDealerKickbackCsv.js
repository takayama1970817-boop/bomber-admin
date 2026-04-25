/**
 * 代理店配布専用 CSV ジェネレータ
 *
 * docs/KICKBACK_REQUIREMENTS.md §5
 *   - 内部メモ・管理者用フラグ・他代理店情報・集計過程の中間値は除外
 *   - 代理店が確認に必要な明細のみ
 *
 * 出力列:
 *   対象月 / サロン名 / 注文件数 / 対象売上(税抜) / 料率 / キックバック額
 *
 * Excel 互換のため UTF-8 BOM 付き。
 */

const escape = (v) => {
  const s = String(v ?? '')
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * @param {Object} kb kickbacks ドキュメント（entries 配列を含む）
 * @returns {string} CSV テキスト（先頭 BOM 付き）
 */
export function generateDealerKickbackCsv(kb) {
  if (!kb) return '﻿'

  const month = String(kb.month || '')
  const lines = []
  lines.push(['対象月', 'サロン名', '注文件数', '対象売上(税抜)', '料率', 'キックバック額'].map(escape).join(','))

  const entries = Array.isArray(kb.entries) ? kb.entries : []
  // entries は明細粒度（注文単位）の場合があるので、サロン単位に集約
  const bySalon = new Map()
  for (const e of entries) {
    const name = e.salonName || e.companyName || '（不明）'
    if (!bySalon.has(name)) {
      bySalon.set(name, { orderCount: 0, sales: 0, kickback: 0, rate: null })
    }
    const b = bySalon.get(name)
    b.orderCount += Number(e.orderCount ?? 1) || 0
    b.sales += Number(e.salesAmount ?? e.targetSales ?? e.subtotal ?? 0) || 0
    b.kickback += Number(e.kickbackAmount ?? e.kbAmount ?? e.amount ?? 0) || 0
    if (b.rate == null && e.rate != null) b.rate = Number(e.rate)
  }

  for (const [name, b] of bySalon) {
    const ratePct = b.rate != null
      ? `${(b.rate * 100).toFixed(1)}%`
      : (b.sales > 0 && b.kickback > 0 ? `${((b.kickback / b.sales) * 100).toFixed(1)}%` : '')
    lines.push([
      month,
      name,
      b.orderCount,
      Math.round(b.sales),
      ratePct,
      Math.round(b.kickback),
    ].map(escape).join(','))
  }

  // 合計行
  const totalOrders = [...bySalon.values()].reduce((s, b) => s + b.orderCount, 0)
  const totalSales = [...bySalon.values()].reduce((s, b) => s + b.sales, 0)
  const totalKb = Number(kb.totalKickback ?? kb.grandTotal ?? [...bySalon.values()].reduce((s, b) => s + b.kickback, 0)) || 0
  lines.push([month, '【合計】', totalOrders, Math.round(totalSales), '', Math.round(totalKb)].map(escape).join(','))

  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** ファイル名（Storage / ローカル DL 共用） */
export function buildDealerCsvFileName(kb) {
  const month = String(kb?.month || '').replace('-', '')
  const code = kb?.dealerCode || 'unknown'
  return `kickback_${code}_${month}_dealer.csv`
}
