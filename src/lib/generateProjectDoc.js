// src/lib/generateProjectDoc.js
// 案件管理用の帳票生成（PDF準拠レイアウト）
// 対応帳票: 見積書, 注文請負書, 発注書, 納品書, 請求書, 領収書

import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'
import { calcTax, getTaxRateInfo } from './taxCalc.js'

/** 日付フォーマット */
function fmtDocDate(d) {
  if (!d) d = new Date()
  const date = d.toDate ? d.toDate() : new Date(d)
  return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日`
}

/** 金額フォーマット（円表記） */
function fmtYen(n) {
  return (n || 0).toLocaleString('ja-JP') + '円'
}

/** 共通CSS */
function sharedCSS() {
  return `
    @page { size: A4; margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Yu Gothic', 'Meiryo', sans-serif;
      font-size: 10pt; color: #222; line-height: 1.6;
      background: #e0e0e0;
      display: flex; justify-content: center; padding: 20px 0;
    }
    .a4-page {
      width: 210mm; min-height: 297mm;
      background: #fff;
      padding: 15mm 18mm 18mm 18mm;
      box-shadow: 0 2px 12px rgba(0,0,0,0.15);
    }
    @media print {
      body { background: #fff; padding: 0; }
      .a4-page { box-shadow: none; padding: 15mm 18mm 18mm 18mm; width: 100%; min-height: auto; }
    }
    table { border-collapse: collapse; }
  `
}

/**
 * 帳票の種類ごとの設定
 */
const DOC_TYPES = {
  quote: {
    title: '見 積 書',
    greeting: '下記の通りお見積り申し上げます。',
    amountLabel: 'お見積金額',
    docNoLabel: '見積番号',
    showBank: false,
    showDeliveryDate: true,
  },
  acceptance: {
    title: '注文請負書',
    greeting: 'ご注文を承りました。下記の通り請け負わせて頂きます。',
    amountLabel: 'ご注文金額',
    docNoLabel: '受注番号',
    showBank: false,
    showDeliveryDate: true,
  },
  purchase: {
    title: '発 注 書',
    greeting: '下記の通り発注致します。',
    amountLabel: '発注金額',
    docNoLabel: '発注番号',
    showBank: false,
    showDeliveryDate: true,
    customerIsFactory: true,
  },
  delivery: {
    title: '納 品 書',
    greeting: '下記の通り納品致しました。ご査収の程お願い申し上げます。',
    amountLabel: '納品金額',
    docNoLabel: '納品番号',
    showBank: false,
    showDeliveryDate: false,
  },
  invoice: {
    title: '請 求 書',
    greeting: 'この度はご注文頂きありがとうございます。下記の通り請求させて頂きます。',
    amountLabel: 'ご請求金額',
    docNoLabel: '請求番号',
    showBank: true,
    showDeliveryDate: false,
  },
  receipt: {
    title: '領 収 書',
    greeting: '下記の通り領収致しました。',
    amountLabel: '領収金額',
    docNoLabel: '領収番号',
    showBank: false,
    showDeliveryDate: false,
  },
}

/**
 * メイン: 帳票HTMLを生成
 */
export function buildProjectDocHtml(opts) {
  const {
    docType = 'invoice',
    project = {},
    company = {},
    taxSettings = {},
    stampDataUrl,
    docNo,
    date,
  } = opts

  const cfg = DOC_TYPES[docType] || DOC_TYPES.invoice
  const issuedDate = fmtDocDate(date || new Date())

  // 宛先
  const customerName = cfg.customerIsFactory
    ? (project.factoryName || project.clientName || '')
    : (project.clientName || '')
  const customerPerson = cfg.customerIsFactory
    ? (project.factoryPerson || '')
    : (project.clientPerson || '')
  const customerAddress = cfg.customerIsFactory
    ? ''
    : (project.clientAddress || '')

  // 金額
  const subtotal = project.subtotal || 0
  const tax = calcTax(subtotal, taxSettings)
  const total = subtotal + tax
  const rateInfo = getTaxRateInfo(taxSettings.taxRate || '10')

  // 会社情報
  const compName = company.companyName || 'ロイヤルトラスト株式会社'
  const compZip = company.zipCode || ''
  const compAddr = company.address || ''
  const compTel = company.tel || ''
  const compFax = company.fax || ''
  const compEmail = company.email || ''
  const compTaxReg = company.taxRegistration || ''

  // 印影（会社情報エリアに重ねて表示）
  const stampHtml = stampDataUrl
    ? `<div style="position:absolute;top:-8px;right:-10px;width:80px;height:80px;">
        <img src="${stampDataUrl}" style="width:80px;height:80px;object-fit:contain;opacity:0.9;" />
      </div>`
    : ''

  // 明細テーブル行
  const itemRows = (project.items || []).map((it, i) => {
    const qty = it.qty || it.quantity || 0
    const price = it.unitPrice || it.price || 0
    const amount = it.amount || (qty * price)
    return `
      <tr>
        <td style="border:1px solid #aaa;padding:5px 8px;font-size:9pt;">${it.name || ''}</td>
        <td style="border:1px solid #aaa;padding:5px 8px;font-size:9pt;text-align:center;">${it.code || ''}</td>
        <td style="border:1px solid #aaa;padding:5px 8px;text-align:right;font-size:9pt;">${fmtYen(price)}</td>
        <td style="border:1px solid #aaa;padding:5px 8px;text-align:center;font-size:9pt;">${qty}</td>
        <td style="border:1px solid #aaa;padding:5px 8px;text-align:right;font-size:9pt;">${fmtYen(amount)}</td>
      </tr>`
  }).join('')

  // 空行で明細を最低5行にする
  const emptyCount = Math.max(0, 5 - (project.items || []).length)
  const emptyRowsHtml = Array.from({ length: emptyCount }, () => `
    <tr>
      <td style="border:1px solid #aaa;padding:5px 8px;height:26px;">&nbsp;</td>
      <td style="border:1px solid #aaa;padding:5px 8px;">&nbsp;</td>
      <td style="border:1px solid #aaa;padding:5px 8px;">&nbsp;</td>
      <td style="border:1px solid #aaa;padding:5px 8px;">&nbsp;</td>
      <td style="border:1px solid #aaa;padding:5px 8px;">&nbsp;</td>
    </tr>`).join('')

  // 振込先
  const bankHtml = cfg.showBank && company.bankName ? `
    <div style="margin:18px 0;">
      <div style="font-size:9.5pt;font-weight:bold;margin-bottom:6px;">お振込先</div>
      <div style="font-size:9.5pt;line-height:1.9;padding-left:16px;">
        <div>${company.bankName}　${company.bankBranch || ''}</div>
        <div>${company.bankAccountType || '普通'}　${company.bankAccountNumber || ''}</div>
        <div>口座名義 : ${company.bankAccountHolder || ''}</div>
      </div>
    </div>
  ` : ''

  // 納期表示
  const deliveryDateHtml = cfg.showDeliveryDate && project.deliveryDate
    ? `<div style="margin-top:14px;font-size:9.5pt;"><span style="color:#555;">納期 : </span><b>${project.deliveryDate}</b></div>`
    : ''

  // 件名表示
  const subjectHtml = project.subject
    ? `<div style="margin-top:14px;font-size:9.5pt;"><span style="color:#555;">件名 : </span><b>${project.subject}</b></div>`
    : ''

  // 納品先（発注書のみ表示）
  const destHtml = (docType === 'purchase' && project.destName) ? `
    <div style="margin-top:14px;border:1px solid #ccc;padding:10px 14px;font-size:9.5pt;line-height:1.8;">
      <div style="font-weight:bold;margin-bottom:2px;">納品先</div>
      <div>${project.destName}${project.destPerson ? '　' + project.destPerson + ' 様' : ''}</div>
      ${project.destAddress ? `<div>${project.destAddress}</div>` : ''}
      ${project.destTel ? `<div>TEL : ${project.destTel}</div>` : ''}
    </div>
  ` : ''

  // 備考
  const notesHtml = project.notes ? `
    <div style="margin-top:18px;">
      <div style="font-size:9pt;font-weight:bold;margin-bottom:4px;">備考</div>
      <div style="font-size:9pt;line-height:1.8;white-space:pre-wrap;color:#333;padding-left:8px;">${project.notes}</div>
    </div>
  ` : ''

  // === HTML組み立て（PDFレイアウト準拠） ===
  return `
    <!-- 1. 発行日 + 帳票番号（右寄せ） -->
    <div style="text-align:right;font-size:9pt;color:#333;margin-bottom:18px;">
      ${docNo ? `<div>${cfg.docNoLabel} : ${docNo}</div>` : ''}
      <div>発行日 : ${issuedDate}</div>
    </div>

    <!-- 2. ヘッダー: 宛先（左）+ 発行者情報（右） -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;">
      <!-- 宛先 -->
      <div style="max-width:50%;">
        ${customerAddress ? `<div style="font-size:9pt;color:#333;margin-bottom:2px;">${customerAddress}</div>` : ''}
        <div style="font-size:14pt;font-weight:bold;border-bottom:2px solid #111;padding-bottom:3px;display:inline-block;">
          ${customerName}　御中
        </div>
        ${customerPerson ? `<div style="font-size:9pt;color:#555;margin-top:4px;">ご担当 : ${customerPerson} 様</div>` : ''}
      </div>

      <!-- 発行者（右上に印影重ねる） -->
      <div style="text-align:right;font-size:9pt;color:#333;line-height:1.8;position:relative;padding-right:${stampDataUrl ? '70px' : '0'};">
        <div style="font-size:11pt;font-weight:bold;">${compName}</div>
        ${compAddr ? `<div>${compZip ? '〒' + compZip + ' ' : ''}${compAddr}</div>` : ''}
        ${compTel ? `<div>TEL : ${compTel}</div>` : ''}
        ${compFax ? `<div>FAX : ${compFax}</div>` : ''}
        ${compEmail ? `<div>email : ${compEmail}</div>` : ''}
        ${compTaxReg ? `<div>登録番号 : ${compTaxReg}</div>` : ''}
        ${stampHtml}
      </div>
    </div>

    <!-- 3. タイトル（中央） -->
    <div style="text-align:center;margin:0 0 24px;">
      <span style="font-size:20pt;font-weight:bold;letter-spacing:6px;border-bottom:2px solid #111;padding-bottom:4px;">
        ${cfg.title}
      </span>
    </div>

    <!-- 4. 挨拶文 -->
    <div style="margin-bottom:18px;font-size:9.5pt;">
      ${cfg.greeting}
    </div>

    <!-- 5. 金額ハイライト -->
    <div style="border:1.5px solid #333;padding:12px 24px;margin-bottom:4px;display:inline-block;">
      <span style="font-size:10pt;margin-right:16px;">${cfg.amountLabel}</span>
      <span style="font-size:18pt;font-weight:bold;letter-spacing:1px;">${fmtYen(total)}（税込）</span>
    </div>

    <!-- 6. 税額内訳（右寄せ） -->
    <div style="text-align:right;font-size:8.5pt;color:#555;margin-bottom:16px;">
      ${rateInfo.rate}%対象 ${fmtYen(total)}（税抜 ${fmtYen(subtotal)}、消費税 ${fmtYen(tax)}）
    </div>

    <!-- 7. 振込先 -->
    ${bankHtml}

    <!-- 8. 件名・納期・納品先 -->
    ${subjectHtml}
    ${deliveryDateHtml}
    ${destHtml}

    <!-- 9. 明細テーブル -->
    <table style="width:100%;margin-top:18px;">
      <thead>
        <tr style="background:#eee;">
          <th style="border:1px solid #aaa;padding:6px 8px;text-align:left;font-size:9pt;font-weight:bold;width:36%;">品名</th>
          <th style="border:1px solid #aaa;padding:6px 8px;text-align:center;font-size:9pt;font-weight:bold;width:12%;">品番</th>
          <th style="border:1px solid #aaa;padding:6px 8px;text-align:right;font-size:9pt;font-weight:bold;width:16%;">単価</th>
          <th style="border:1px solid #aaa;padding:6px 8px;text-align:center;font-size:9pt;font-weight:bold;width:10%;">数量</th>
          <th style="border:1px solid #aaa;padding:6px 8px;text-align:right;font-size:9pt;font-weight:bold;width:20%;">金額（税抜）</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
        ${emptyRowsHtml}
      </tbody>
    </table>

    <!-- 10. 合計欄（右寄せ独立テーブル） -->
    <table style="margin-left:auto;margin-top:0;width:38%;">
      <tr>
        <td style="border:1px solid #aaa;padding:5px 10px;font-size:9pt;font-weight:bold;text-align:right;background:#f5f5f5;">小計（税抜）</td>
        <td style="border:1px solid #aaa;padding:5px 10px;font-size:9pt;text-align:right;width:42%;">${fmtYen(subtotal)}</td>
      </tr>
      <tr>
        <td style="border:1px solid #aaa;padding:4px 10px;font-size:8.5pt;text-align:right;background:#f5f5f5;color:#555;">消費税（${rateInfo.rate}%）</td>
        <td style="border:1px solid #aaa;padding:4px 10px;font-size:8.5pt;text-align:right;">${fmtYen(tax)}</td>
      </tr>
      <tr>
        <td style="border:1.5px solid #333;padding:6px 10px;font-size:10pt;font-weight:bold;text-align:right;background:#eee;">合計（税込）</td>
        <td style="border:1.5px solid #333;padding:6px 10px;font-size:11pt;font-weight:bold;text-align:right;">${fmtYen(total)}</td>
      </tr>
    </table>

    <!-- 11. 備考 -->
    ${notesHtml}
  `
}

/**
 * 新しいウィンドウで印刷プレビューを開く
 */
export function openProjectDocPreview(opts) {
  const innerHtml = buildProjectDocHtml(opts)
  const cfg = DOC_TYPES[opts.docType] || DOC_TYPES.invoice
  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${cfg.title}</title>
<style>${sharedCSS()}</style>
</head><body><div class="a4-page">${innerHtml}</div></body></html>`

  const win = window.open('', '_blank')
  if (win) {
    win.document.write(html)
    win.document.close()
  }
}

/**
 * 帳票PDFをjsPDFインスタンスとして生成（内部共通処理）
 */
async function buildProjectDocPdfInstance(opts) {
  const innerHtml = buildProjectDocHtml(opts)

  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-9999px'
  container.style.top = '0'
  container.style.width = '794px'
  container.innerHTML = `
    <div style="width:794px;min-height:1123px;background:#fff;padding:57px 68px 68px 68px;
                font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic','Meiryo',sans-serif;
                font-size:10pt;color:#222;line-height:1.6;box-sizing:border-box;">
      ${innerHtml}
    </div>
  `
  document.body.appendChild(container)
  const target = container.firstElementChild

  try {
    const canvas = await html2canvas(target, {
      scale: 2,
      width: 794,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
    })

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()
    const margin = 5
    const printableWidth = pageWidth - margin * 2
    const printableHeight = pageHeight - margin * 2

    const imgHeight = (canvas.height * printableWidth) / canvas.width

    if (imgHeight <= printableHeight) {
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin, margin, printableWidth, imgHeight)
    } else {
      const pxPerPage = Math.floor((printableHeight / imgHeight) * canvas.height)
      let srcY = 0
      let page = 0
      while (srcY < canvas.height - 1) {
        if (page > 0) pdf.addPage()
        const sliceHeight = Math.min(pxPerPage, canvas.height - srcY)
        const pageCanvas = document.createElement('canvas')
        pageCanvas.width = canvas.width
        pageCanvas.height = sliceHeight
        const ctx = pageCanvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, sliceHeight)
        ctx.drawImage(canvas, 0, srcY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)
        const sliceImgHeight = (sliceHeight * printableWidth) / canvas.width
        pdf.addImage(pageCanvas.toDataURL('image/png'), 'PNG', margin, margin, printableWidth, sliceImgHeight)
        srcY += sliceHeight
        page++
      }
    }
    return pdf
  } finally {
    document.body.removeChild(container)
  }
}

function buildPdfFileName(opts) {
  const cfg = DOC_TYPES[opts.docType] || DOC_TYPES.invoice
  const title = (cfg.title || '帳票').replace(/\s/g, '')
  const projectNo = opts.project?.projectNo || opts.docNo || ''
  const clientName = (opts.project?.clientName || '').replace(/[\\/:*?"<>|]/g, '')
  const today = new Date()
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  return [title, clientName, projectNo, dateStr].filter(Boolean).join('_') + '.pdf'
}

/**
 * 帳票PDFをbase64で取得（FAX送信用）
 */
export async function buildProjectDocPdfBase64(opts) {
  const pdf = await buildProjectDocPdfInstance(opts)
  // datauristring = "data:application/pdf;base64,XXXX"
  const dataUri = pdf.output('datauristring')
  const base64 = dataUri.split(',')[1] || ''
  return { base64, fileName: buildPdfFileName(opts) }
}

/**
 * 帳票PDFを生成してダウンロード
 * html2canvas + jsPDF でA4 PDFとして保存
 */
export async function downloadProjectDocPdf(opts) {
  const pdf = await buildProjectDocPdfInstance(opts)
  const fileName = buildPdfFileName(opts)
  pdf.save(fileName)
  return fileName
}

export { DOC_TYPES, fmtDocDate, fmtYen }
