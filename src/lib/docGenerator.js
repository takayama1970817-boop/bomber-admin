// src/lib/docGenerator.js
// Misoca風の統一書類レイアウトHTML生成ユーティリティ
// 請求書・見積書・発注書・納品書を同じフォーマットで生成

import { calcTax, taxRowLabel, taxNoteText, getTaxRateInfo } from './taxCalc.js'

/**
 * 日付フォーマット（YYYY年MM月DD日）
 */
function formatDocDate(d) {
  if (!d) return ''
  const date = d.toDate ? d.toDate() : new Date(d)
  return `${date.getFullYear()}年${date.getMonth()+1}月${date.getDate()}日`
}

/**
 * 金額フォーマット
 */
function fmtYen(n) {
  return '¥' + (n || 0).toLocaleString('ja-JP')
}

/**
 * 共通CSS
 */
function docSharedCSS() {
  return `
    @page { size: A4; margin: 15mm 15mm 20mm 15mm; }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: 'Hiragino Kaku Gothic ProN','Meiryo','sans-serif'; font-size:10pt; color:#222; line-height:1.6; padding:15mm; }
    .doc-date-no { text-align:right; font-size:10pt; line-height:2.2; }
    .doc-title { text-align:center; font-size:22pt; font-weight:bold; margin:14px 0 20px; letter-spacing:4px; }
    .doc-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; }
    .doc-left { flex:1; max-width:52%; }
    .doc-right { flex:1; max-width:45%; text-align:right; font-size:9pt; line-height:1.8; }
    .doc-customer { font-size:14pt; font-weight:bold; border-bottom:2px solid #111; padding-bottom:4px; margin-bottom:6px; }
    .doc-customer-sub { font-size:9pt; color:#555; }
    .doc-subject { margin:10px 0 6px; font-size:10pt; }
    .doc-total-box { display:inline-block; border:2px solid #111; padding:6px 28px; font-size:16pt; font-weight:bold; margin:10px 0; letter-spacing:2px; }
    .doc-table { width:100%; border-collapse:collapse; margin-top:16px; font-size:9pt; }
    .doc-table th { background:#f0f0f0; border:1px solid #bbb; padding:6px 8px; text-align:center; font-weight:bold; }
    .doc-table td { border:1px solid #bbb; padding:5px 8px; }
    .doc-table td.num { text-align:right; font-family:monospace; }
    .doc-table td.noborder { border:none; }
    .doc-table .summary-label { text-align:right; font-weight:bold; padding-right:12px; }
    .doc-table .summary-value { text-align:right; font-family:monospace; font-weight:bold; }
    .doc-notes { margin-top:20px; font-size:9pt; line-height:1.8; }
    .doc-notes h4 { font-size:10pt; margin-bottom:4px; }
    .doc-bank { margin-top:16px; font-size:9pt; line-height:1.8; background:#f9f9f9; padding:10px; border-radius:4px; }
    .doc-stamp { width:70px; height:70px; border:2px solid #c33; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#c33; font-size:9pt; text-align:center; margin-left:auto; }
    .doc-stamp img { width:60px; height:60px; object-fit:contain; }
    @media print { body { padding:0; } }
  `
}

/**
 * 共通レイアウトビルダー
 * @param {object} opts
 * @param {string} opts.title - 書類タイトル（例: '請 求 書'）
 * @param {string} opts.docNoLabel - 番号ラベル（例: '請求書番号'）
 * @param {string} opts.docNo - 番号
 * @param {string|Date} opts.date - 日付
 * @param {string} opts.customerName - 取引先名
 * @param {string} opts.customerPerson - 担当者名
 * @param {string} opts.customerAddress - 住所
 * @param {string} opts.subject - 件名
 * @param {string} opts.greeting - 挨拶文
 * @param {string} opts.totalLabel - 合計欄ラベル
 * @param {number} opts.subtotal - 小計
 * @param {object} opts.taxSettings - 税設定
 * @param {object} opts.company - 会社情報
 * @param {string} opts.stampDataUrl - 印影画像URL
 * @param {string[]} opts.colHeaders - テーブルヘッダー
 * @param {string[][]} opts.itemRows - 明細行（HTML文字列の配列の配列）
 * @param {string} opts.noteText - 備考
 * @param {string} opts.bankText - 振込先情報HTML
 * @param {string} opts.extraInfoHtml - 追加情報HTML
 * @returns {string} HTML string
 */
export function buildDocLayout(opts) {
  const {
    title, docNoLabel, docNo, date, customerName, customerPerson,
    customerAddress, subject, greeting, totalLabel, subtotal,
    taxSettings = {}, company = {}, stampDataUrl,
    colHeaders = ['品名', '数量', '単価', '金額'],
    itemRows = [], noteText, bankText, extraInfoHtml
  } = opts

  const tax = calcTax(subtotal || 0, taxSettings)
  const total = (subtotal || 0) + tax
  const taxLabel = taxRowLabel(taxSettings)
  const taxNote = taxNoteText(taxSettings)
  const colCount = colHeaders.length

  // 印影部分
  const stampHtml = stampDataUrl
    ? `<div class="doc-stamp"><img src="${stampDataUrl}" alt="印影" /></div>`
    : `<div class="doc-stamp">${(company.companyName || '').substring(0, 4)}</div>`

  // 発行者情報
  const issuerHtml = `
    <div class="doc-right">
      <div style="font-weight:bold;font-size:11pt">${company.companyName || ''}</div>
      <div>${company.zipCode || ''} ${company.address || ''}</div>
      <div>TEL: ${company.tel || ''}</div>
      ${company.taxRegistration ? `<div>登録番号: ${company.taxRegistration}</div>` : ''}
      ${stampHtml}
    </div>
  `

  // 明細テーブル
  const headerCells = colHeaders.map(h => `<th>${h}</th>`).join('')

  const bodyRows = itemRows.map(cols => {
    return '<tr>' + cols.map((c, i) => {
      const cls = i >= colHeaders.length - 3 ? 'num' : ''
      return `<td class="${cls}">${c}</td>`
    }).join('') + '</tr>'
  }).join('')

  // サマリー行
  const spacerCols = Math.max(0, colCount - 2)
  const spacer = `<td class="noborder" colspan="${spacerCols}"></td>`

  const summaryRows = `
    <tr>${spacer}<td class="summary-label">小計</td><td class="summary-value">${fmtYen(subtotal)}</td></tr>
    <tr>${spacer}<td class="summary-label">${taxLabel}</td><td class="summary-value">${fmtYen(tax)}</td></tr>
    <tr>${spacer}<td class="summary-label" style="font-size:11pt">合計</td><td class="summary-value" style="font-size:11pt">${fmtYen(total)}</td></tr>
  `

  return `
    <div class="doc-date-no">
      ${docNoLabel}: ${docNo || '—'}<br>
      ${formatDocDate(date)}
    </div>
    <div class="doc-title">${title}</div>
    <div class="doc-header">
      <div class="doc-left">
        <div class="doc-customer">${customerName || ''} 御中</div>
        ${customerPerson ? `<div class="doc-customer-sub">ご担当: ${customerPerson} 様</div>` : ''}
        ${customerAddress ? `<div class="doc-customer-sub">${customerAddress}</div>` : ''}
        ${subject ? `<div class="doc-subject">件名: ${subject}</div>` : ''}
        ${greeting ? `<div style="margin-top:8px;font-size:9pt">${greeting}</div>` : ''}
        <div class="doc-total-box">${totalLabel || '合計金額'} ${fmtYen(total)}</div>
      </div>
      ${issuerHtml}
    </div>
    ${extraInfoHtml || ''}
    <table class="doc-table">
      <thead><tr>${headerCells}</tr></thead>
      <tbody>
        ${bodyRows}
        ${summaryRows}
      </tbody>
    </table>
    ${taxNote ? `<div style="margin-top:8px;font-size:8pt;color:#666">${taxNote}</div>` : ''}
    ${noteText ? `<div class="doc-notes"><h4>備考</h4><div>${noteText}</div></div>` : ''}
    ${bankText ? `<div class="doc-bank"><h4>お振込先</h4>${bankText}</div>` : ''}
  `
}

/**
 * スタンドアロンHTML（新しいウインドウで開いてprint可能）
 */
export function buildStandaloneHtml(title, innerHtml) {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${title}</title>
<style>${docSharedCSS()}</style>
</head><body>${innerHtml}</body></html>`
}

/**
 * 新しいウインドウで印刷プレビューを開く
 */
export function openPrintPreview(title, innerHtml) {
  const html = buildStandaloneHtml(title, innerHtml)
  const win = window.open('', '_blank')
  if (win) {
    win.document.write(html)
    win.document.close()
  }
}

// エクスポートまとめ
export { formatDocDate, fmtYen, docSharedCSS }
