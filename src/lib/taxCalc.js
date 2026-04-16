// src/lib/taxCalc.js
// Firestoreのsettings/companyドキュメントから読み込む税設定に基づく計算ヘルパー

/**
 * 税率情報を返す
 * @param {string} code - '10', '8r'(軽減8%), '8', '5'
 * @returns {{ rate: number, label: string, code: string }}
 */
export function getTaxRateInfo(code) {
  switch (String(code)) {
    case '8r': return { rate: 8, label: '軽減8%', code: '8r' }
    case '8':  return { rate: 8, label: '8%', code: '8' }
    case '5':  return { rate: 5, label: '5%', code: '5' }
    default:   return { rate: 10, label: '10%', code: '10' }
  }
}

/**
 * 消費税計算
 * @param {number} subtotal - 税抜き小計
 * @param {object} settings - { taxRate: '10', taxRounding: 'floor'|'ceil'|'round', taxDisplayMode: 'exclusive'|'inclusive'|'exempt' }
 * @returns {number} 消費税額
 */
export function calcTax(subtotal, settings = {}) {
  if (settings.taxDisplayMode === 'exempt') return 0
  const info = getTaxRateInfo(settings.taxRate || '10')
  const raw = subtotal * info.rate / 100
  switch (settings.taxRounding || 'round') {
    case 'floor': return Math.floor(raw)
    case 'ceil':  return Math.ceil(raw)
    default:      return Math.round(raw)
  }
}

/**
 * 税行ラベル（例：「消費税（10%）」）
 */
export function taxRowLabel(settings = {}) {
  if (settings.taxDisplayMode === 'exempt') return '消費税（免税）'
  const info = getTaxRateInfo(settings.taxRate || '10')
  return `消費税（${info.label}）`
}

/**
 * 書類下部に表示する税区分注記
 */
export function taxNoteText(settings = {}) {
  if (settings.taxDisplayMode === 'exempt') return '※ 免税事業者のため消費税は含まれておりません'
  const mode = settings.taxDisplayMode || 'exclusive'
  if (mode === 'inclusive') return '※ 上記金額は税込表示です'
  return ''  // 税別の場合は注記不要
}

/**
 * デフォルト税設定
 */
export const DEFAULT_TAX_SETTINGS = {
  taxRate: '10',
  taxRounding: 'floor',
  taxDisplayMode: 'exclusive',
  withholdingTax: false,
}
