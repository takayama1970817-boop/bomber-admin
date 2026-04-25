// 請求書 PDF 生成（グループC代理店向け）
// html2canvas で DOM をキャンバス化し、jsPDF で A4 PDF にして保存する
// 構成: 1ページ目=表紙（合計+注文番号一覧）、2ページ目以降=注文ごとの明細（インボイス）

import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'

function fmtEn(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString() + '円'
}

function buildFileName(dealerCode, month) {
  return `請求書_${dealerCode}_${month.replace('-', '')}.pdf`
}

// 共通ヘッダー（宛先+発行者情報）
function buildHeaderHtml(invoice, ci, showIssuedDate) {
  const today = new Date()
  const issuedDate = `${today.getFullYear()} 年 ${String(today.getMonth() + 1).padStart(2, '0')} 月 ${String(today.getDate()).padStart(2, '0')} 日`

  const companyName = ci.companyName || 'ロイヤルトラスト株式会社'
  const zipCode = ci.zipCode || '〒150-0012'
  const address = ci.address || '東京都渋谷区広尾5-24-3'
  const tel = ci.tel || '03-3441-7839'
  const fax = ci.fax || '03-6332-9691'
  const email = ci.email || 'info@royaltrust.jp'
  const taxReg = ci.taxRegistration || 'T5120001125556'

  return `
    ${showIssuedDate ? `<div style="text-align:right;font-size:11px;color:#333;margin-bottom:16px;">
      ${invoice.invoiceNo ? `<div>請求番号 : ${invoice.invoiceNo}</div>` : ''}
      <div>発行日 : ${issuedDate}</div>
    </div>` : ''}
    <div style="display:flex;justify-content:space-between;margin-bottom:24px;">
      <div style="flex:1;">
        ${invoice.dealerZip ? `<div style="font-size:11px;color:#333;">${invoice.dealerZip}</div>` : ''}
        ${invoice.dealerAddress ? `<div style="font-size:11px;color:#333;margin-bottom:4px;">${invoice.dealerAddress}</div>` : ''}
        <div style="font-size:17px;font-weight:bold;margin-top:4px;">
          ${invoice.dealerName || invoice.dealerCode || ''} 御中
        </div>
      </div>
      <div style="text-align:right;font-size:11px;color:#444;line-height:1.8;position:relative;">
        <div style="font-size:13px;font-weight:bold;">${companyName}</div>
        <div>${zipCode}</div>
        <div>${address}</div>
        <div>TEL : ${tel}</div>
        <div>FAX : ${fax}</div>
        <div>email : ${email}</div>
        <div>登録番号 : ${taxReg}</div>
        ${invoice.stampDataUrl ? `<img src="${invoice.stampDataUrl}" style="position:absolute;right:0;top:0;width:70px;height:70px;object-fit:contain;opacity:0.85;" />` : ''}
      </div>
    </div>
  `
}

// === 表紙ページ ===
function buildCoverHtml(invoice) {
  const ci = invoice.companyInfo || {}
  const orderNumbers = (invoice.orderNumbers || []).join(', ')

  return `
    <div style="width:794px;min-height:1123px;padding:40px 60px;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic','Meiryo',sans-serif;color:#111;background:#fff;box-sizing:border-box;">

      ${buildHeaderHtml(invoice, ci, true)}

      <!-- タイトル -->
      <div style="text-align:center;margin-bottom:30px;">
        <h1 style="font-size:24px;font-weight:bold;letter-spacing:4px;margin:0;border-bottom:2px solid #111;display:inline-block;padding-bottom:4px;">請求書</h1>
      </div>

      <!-- ご挨拶 -->
      <div style="margin-bottom:24px;font-size:12px;">
        この度はご注文頂きありがとうございます。下記の通り請求させて頂きます。
      </div>

      <!-- ご請求金額ハイライト -->
      <div style="display:flex;align-items:center;margin-bottom:12px;border:2px solid #ccc;border-radius:4px;padding:16px 24px;">
        <div style="font-size:13px;color:#333;margin-right:24px;background:#f5f5f5;padding:8px 16px;border-radius:4px;">ご請求金額</div>
        <div style="font-size:28px;font-weight:bold;letter-spacing:2px;">${fmtEn(invoice.grandTotal)}（税込）</div>
      </div>

      <!-- 税額内訳 -->
      <div style="text-align:center;font-size:12px;color:#333;margin-bottom:30px;">
        10%対象 ${fmtEn(invoice.grandTotal)}（税抜 ${fmtEn(invoice.subtotal)}、消費税 ${fmtEn(invoice.tax)}）
      </div>

      <!-- 振込先 -->
      ${ci.bankName ? `
      <div style="margin-bottom:24px;border:1px solid #ccc;border-radius:4px;padding:16px 20px;">
        <div style="font-size:12px;font-weight:bold;margin-bottom:8px;">お振込先</div>
        <div style="font-size:12px;line-height:1.8;">
          <div>${ci.bankName}　${ci.bankBranch || ''}</div>
          <div>${ci.bankAccountType || '普通'}　${ci.bankAccountNumber || ''}</div>
          <div>口座名義 : ${ci.bankAccountHolder || ''}</div>
        </div>
      </div>
      ` : ''}

      <!-- ご注文番号 -->
      <div style="margin-bottom:8px;">
        <div style="font-size:12px;font-weight:bold;margin-bottom:6px;">ご注文番号 :</div>
        <div style="font-size:11px;line-height:1.8;word-break:break-all;">${orderNumbers}</div>
      </div>

      <div style="text-align:right;font-size:12px;margin-top:8px;">
        計 : ${invoice.orderCount || (invoice.orders || []).length}件
      </div>
    </div>
  `
}

// === 注文別明細ページ ===
function buildOrderDetailHtml(invoice, order) {
  const ci = invoice.companyInfo || {}

  const itemRows = (order.items || [])
    .map((item, i) => `
        <tr data-row style="border-bottom:1px solid #ddd;${i % 2 === 1 ? 'background:#fafafa;' : ''}vertical-align:top;">
          <td style="padding:8px 6px;font-size:10px;width:120px;">
            ${order.orderedAt || ''}<br>
            <span style="color:#666;">（${order.orderNumber}）</span>
          </td>
          <td style="padding:8px 6px;font-size:10px;">
            ${item.productName || ''}
            ${item.sku ? `<br><span style="color:#888;font-size:9px;">商品管理番号 : ${item.sku}</span>` : ''}
          </td>
          <td style="padding:8px 6px;font-size:10px;text-align:right;white-space:nowrap;">
            ${fmtEn(item.unitPrice)}<br>
            <span style="color:#888;font-size:9px;">（${fmtEn(item.unitPrice)} × ${item.inputCount || 1}）</span>
          </td>
          <td style="padding:8px 6px;font-size:10px;text-align:right;">${item.quantity}</td>
          <td style="padding:8px 6px;font-size:10px;text-align:right;">${item.totalQuantity || item.quantity}</td>
          <td style="padding:8px 6px;font-size:10px;text-align:right;white-space:nowrap;">${fmtEn(item.subtotal)}</td>
        </tr>`)
    .join('')

  // 配送先
  const delivery = []
  if (order.deliveryZip) delivery.push(`〒${order.deliveryZip.replace(/^〒/, '')}`)
  if (order.deliveryAddress) delivery.push(order.deliveryAddress)
  if (order.deliveryTel) delivery.push(`TEL : ${order.deliveryTel}`)
  if (order.deliveryName) delivery.push(`${order.deliveryName} 様`)

  return `
    <div style="width:794px;min-height:1123px;padding:40px 60px;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic','Meiryo',sans-serif;color:#111;background:#fff;box-sizing:border-box;">

      <!-- タイトル -->
      <div style="text-align:center;margin-bottom:20px;">
        <h1 style="font-size:20px;font-weight:bold;letter-spacing:2px;margin:0;">請求明細書（インボイス）</h1>
      </div>

      ${buildHeaderHtml(invoice, ci, false)}

      <!-- 注文情報 + 配送先 -->
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;">
        <div style="font-size:11px;line-height:1.8;">
          <div>注文番号 : ${order.orderNumber}</div>
          <div>注文日時 : ${order.orderedAt}</div>
          <div>決済方法 : ${order.payment || ''}</div>
          ${order.deliveryDate ? `<div>配送希望日 : ${order.deliveryDate}</div>` : ''}
          ${order.shippedAt ? `<div>発送日 : ${order.shippedAt}</div>` : ''}
        </div>
        ${delivery.length > 0 ? `
        <div style="font-size:11px;line-height:1.8;text-align:left;">
          <div>配送先 :</div>
          ${delivery.map((l) => `<div style="padding-left:8px;">${l}</div>`).join('')}
        </div>` : ''}
      </div>

      <!-- 注文数・金額 -->
      <div style="text-align:right;margin-bottom:4px;">
        <span style="font-size:12px;margin-right:16px;">注文数　${order.itemCount || order.items?.length || 0}</span>
        <span style="font-size:11px;">金額　</span>
        <span style="font-size:20px;font-weight:bold;">${fmtEn(order.total)}（税込）</span>
      </div>
      <div style="text-align:right;font-size:11px;color:#333;margin-bottom:16px;">
        10%対象 ${fmtEn(order.total)}（税抜 ${fmtEn(order.subtotal)}、消費税 ${fmtEn(order.tax)}）
      </div>

      <!-- 明細テーブル -->
      <table style="width:100%;border-collapse:collapse;border:1px solid #999;">
        <thead>
          <tr style="background:#f0f0f0;border-bottom:2px solid #999;">
            <th style="padding:6px;font-size:10px;text-align:left;border-right:1px solid #ddd;">注文日時<br>（注文番号）</th>
            <th style="padding:6px;font-size:10px;text-align:left;border-right:1px solid #ddd;">品名</th>
            <th style="padding:6px;font-size:10px;text-align:right;border-right:1px solid #ddd;white-space:nowrap;">販売価格<br>（単価 × 入数）</th>
            <th style="padding:6px;font-size:10px;text-align:right;border-right:1px solid #ddd;">注文数</th>
            <th style="padding:6px;font-size:10px;text-align:right;border-right:1px solid #ddd;">合計数</th>
            <th style="padding:6px;font-size:10px;text-align:right;">金額（税抜）</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows}
        </tbody>
      </table>
    </div>
  `
}

// 1ページ分のHTMLをキャンバスに変換
async function renderPageToCanvas(html) {
  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-9999px'
  container.style.top = '0'
  container.innerHTML = html
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
    return canvas
  } finally {
    document.body.removeChild(container)
  }
}

// 請求書PDFを構築（保存せずに jsPDF インスタンスを返す）。
// generateInvoicePdf（ダウンロード）と generateInvoicePdfBase64（メール添付）の
// 共通ロジック。
async function buildInvoicePdf(invoice) {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 5
  const printableWidth = pageWidth - margin * 2
  const printableHeight = pageHeight - margin * 2

  // 表紙を生成
  const coverCanvas = await renderPageToCanvas(buildCoverHtml(invoice))
  const coverImgHeight = (coverCanvas.height * printableWidth) / coverCanvas.width
  pdf.addImage(
    coverCanvas.toDataURL('image/png'), 'PNG',
    margin, margin, printableWidth, Math.min(coverImgHeight, printableHeight)
  )

  // 注文ごとの明細ページ
  const orders = invoice.orders || []
  for (let i = 0; i < orders.length; i++) {
    pdf.addPage()
    const canvas = await renderPageToCanvas(buildOrderDetailHtml(invoice, orders[i]))
    const imgHeight = (canvas.height * printableWidth) / canvas.width

    if (imgHeight <= printableHeight) {
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin, margin, printableWidth, imgHeight)
    } else {
      // 長い明細はページ分割
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
  }

  return pdf
}

/**
 * 請求書PDFを生成してダウンロード
 * 1ページ目: 表紙（合計+注文番号一覧）
 * 2ページ目以降: 注文ごとの明細（インボイス）
 */
export async function generateInvoicePdf(invoice) {
  const pdf = await buildInvoicePdf(invoice)
  const fileName = buildFileName(invoice.dealerCode, invoice.month)
  pdf.save(fileName)
  return fileName
}

/**
 * 請求書PDFを生成して base64 文字列で返す（SendGrid 添付用）。
 * dataURI のプレフィックスは除去し、純粋な base64 のみ返す。
 */
export async function generateInvoicePdfBase64(invoice) {
  const pdf = await buildInvoicePdf(invoice)
  const dataUri = pdf.output('datauristring')
  const base64 = dataUri.split('base64,')[1] || ''
  const fileName = buildFileName(invoice.dealerCode, invoice.month)
  return { base64, fileName }
}
