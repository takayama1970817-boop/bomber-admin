// キックバック清算書 PDF 生成
// html2canvas で DOM をキャンバス化し、jsPDF で A4 PDF にして保存する

import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'

function fmtYen(n) {
  if (n == null) return '—'
  return '¥' + Number(n).toLocaleString()
}

function buildFileName(dealerCode, month) {
  return `清算書_${dealerCode}_${month.replace('-', '')}.pdf`
}

// 清算書HTMLを動的に生成
function buildStatementHtml(stmt) {
  const today = new Date()
  const issuedDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`
  const [y, m] = (stmt.month || '').split('-')
  const periodLabel = y && m ? `${y}年${Number(m)}月` : stmt.month

  // 会社情報（設定から取得、なければデフォルト）
  const ci = stmt.companyInfo || {}
  const companyName = ci.companyName || 'ロイヤルトラスト株式会社'
  const zipCode = ci.zipCode || '〒150-0012'
  const address = ci.address || '東京都渋谷区広尾5-24-3 2F'
  const tel = ci.tel || '03-3441-7839'
  const taxReg = ci.taxRegistration || 'T5120001125556'

  // 調整項目
  const adjustments = (stmt.adjustments || []).filter((a) => a.label && a.amount !== 0)
  const adjTotal = stmt.adjustmentTotal || adjustments.reduce((s, a) => s + (a.amount || 0), 0)
  const hasAdjustments = adjustments.length > 0

  // メイン精算額（代理店注文がある場合は最終精算額、なければKB清算額）
  const hasDealerOrder = (stmt.dealerOrderTotal || 0) > 0
  const baseAmount = hasDealerOrder ? stmt.netSettlement : (stmt.grandTotal || stmt.totalKickback)
  const mainAmount = stmt.finalSettlement ?? (baseAmount + adjTotal)
  const mainLabel = (hasDealerOrder || hasAdjustments) ? '最終精算額（税込）' : '差引精算額（税込）'

  // サロン別明細の行を生成
  const entryRows = (stmt.entries || [])
    .map((e, i) => `
        <tr data-row style="border-bottom:1px solid #e5e7eb;${i % 2 === 1 ? 'background:#fafafa;' : ''}">
          <td style="padding:6px 10px;font-size:11px;color:#666;">${i + 1}</td>
          <td style="padding:6px 10px;font-size:11px;">${e.salonName || ''}</td>
          <td style="padding:6px 10px;text-align:right;font-size:11px;">${e.orderCount || 0}回</td>
          <td style="padding:6px 10px;text-align:right;font-size:11px;">${fmtYen(e.orderTotal)}</td>
          <td style="padding:6px 10px;text-align:right;font-size:11px;font-weight:bold;color:#4f46e5;">${fmtYen(e.kickbackAmount)}</td>
        </tr>`)
    .join('')

  // 代理店注文明細
  const dealerItemRows = (stmt.dealerOrderItems || [])
    .map((item, i) => `
        <tr data-row style="border-bottom:1px solid #fed7aa;${i % 2 === 1 ? 'background:#fff7ed;' : ''}">
          <td style="padding:5px 10px;font-size:11px;">${item.date || ''}</td>
          <td style="padding:5px 10px;font-size:11px;">${item.productName || ''}</td>
          <td style="padding:5px 10px;font-size:11px;">${item.setName || ''}</td>
          <td style="padding:5px 10px;text-align:right;font-size:11px;">${item.quantity}</td>
          <td style="padding:5px 10px;text-align:right;font-size:11px;">${fmtYen(item.unitPrice)}</td>
          <td style="padding:5px 10px;text-align:right;font-size:11px;">${fmtYen(item.subtotal)}</td>
        </tr>`)
    .join('')

  // KB内訳セクション
  const kbBreakdown = stmt.grandTotal ? `
      <div style="margin-bottom:20px;">
        <div style="font-size:13px;font-weight:bold;margin-bottom:8px;padding-left:4px;border-left:4px solid #4f46e5;">
          KB清算内訳
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;">
          <tbody>
            <tr style="border-bottom:1px solid #e5e7eb;">
              <td style="padding:8px 12px;font-size:12px;">KB金額合計</td>
              <td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:bold;">${fmtYen(stmt.totalKickback)}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;">
              <td style="padding:8px 12px;font-size:12px;">- システム利用料（${stmt.kbOrderCount || 0}件×¥300）</td>
              <td style="padding:8px 12px;text-align:right;font-size:12px;color:#dc2626;">-${fmtYen(stmt.systemFee)}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;">
              <td style="padding:8px 12px;font-size:12px;">- 決済手数料 3%（${stmt.creditCount || 0}件分）</td>
              <td style="padding:8px 12px;text-align:right;font-size:12px;color:#dc2626;">-${fmtYen(stmt.paymentFee)}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;background:#f0f0ff;">
              <td style="padding:8px 12px;font-size:12px;font-weight:bold;">小計</td>
              <td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:bold;">${fmtYen(stmt.subtotalAfterDeductions)}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;">
              <td style="padding:8px 12px;font-size:12px;">+ 消費税 10%</td>
              <td style="padding:8px 12px;text-align:right;font-size:12px;">${fmtYen(stmt.tax)}</td>
            </tr>
            <tr style="background:#4f46e5;color:#fff;">
              <td style="padding:10px 12px;font-size:13px;font-weight:bold;">KB清算額（税込）</td>
              <td style="padding:10px 12px;text-align:right;font-size:15px;font-weight:bold;">${fmtYen(stmt.grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>` : ''

  // 代理店注文セクション
  const dealerOrderSection = hasDealerOrder ? `
      <div style="margin-bottom:20px;">
        <div style="font-size:13px;font-weight:bold;margin-bottom:8px;padding-left:4px;border-left:4px solid #ea580c;">
          代理店自身の注文（${stmt.dealerOrderCount || 0}件）
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #fed7aa;">
          <thead>
            <tr style="background:#fff7ed;border-bottom:2px solid #fed7aa;">
              <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9a3412;">注文日</th>
              <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9a3412;">商品名</th>
              <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9a3412;">セット名</th>
              <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9a3412;">数量</th>
              <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9a3412;">単価</th>
              <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9a3412;">小計</th>
            </tr>
          </thead>
          <tbody>${dealerItemRows}</tbody>
          <tfoot>
            <tr style="border-top:2px solid #ea580c;background:#fff7ed;">
              <td colspan="5" style="padding:6px 10px;font-size:11px;font-weight:bold;color:#9a3412;">小計（税抜）</td>
              <td style="padding:6px 10px;text-align:right;font-size:11px;font-weight:bold;">${fmtYen(stmt.dealerOrderSubtotal)}</td>
            </tr>
            <tr style="background:#fff7ed;">
              <td colspan="5" style="padding:6px 10px;font-size:11px;color:#9a3412;">消費税 10%</td>
              <td style="padding:6px 10px;text-align:right;font-size:11px;">${fmtYen(stmt.dealerOrderTax)}</td>
            </tr>
            <tr style="background:#ea580c;color:#fff;">
              <td colspan="5" style="padding:8px 10px;font-size:12px;font-weight:bold;">代理店注文額（税込）</td>
              <td style="padding:8px 10px;text-align:right;font-size:13px;font-weight:bold;">${fmtYen(stmt.dealerOrderTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!-- 最終精算 -->
      <div style="background:#1e1b4b;color:#fff;border-radius:12px;padding:16px 24px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:6px 0;font-size:13px;">KB清算額（税込）</td>
            <td style="padding:6px 0;text-align:right;font-size:13px;">${fmtYen(stmt.grandTotal)}</td>
          </tr>
          <tr style="${hasAdjustments ? '' : 'border-bottom:1px solid rgba(255,255,255,0.3);'}">
            <td style="padding:6px 0;font-size:13px;">- 代理店注文額（税込）</td>
            <td style="padding:6px 0;text-align:right;font-size:13px;">-${fmtYen(stmt.dealerOrderTotal)}</td>
          </tr>
          ${adjustments.map((a, i) => `
          <tr style="${i === adjustments.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.3);' : ''}">
            <td style="padding:6px 0;font-size:13px;">${a.amount >= 0 ? '+' : ''} ${a.label}</td>
            <td style="padding:6px 0;text-align:right;font-size:13px;">${a.amount >= 0 ? '+' : ''}${fmtYen(a.amount)}</td>
          </tr>`).join('')}
          <tr>
            <td style="padding:10px 0;font-size:20px;font-weight:bold;">最終精算額</td>
            <td style="padding:10px 0;text-align:right;font-size:24px;font-weight:bold;">${fmtYen(mainAmount)}</td>
          </tr>
        </table>
      </div>` : ''

  // 代理店注文なし＋調整項目ありの場合の調整セクション
  const adjustmentOnlySection = (!hasDealerOrder && hasAdjustments) ? `
      <div style="background:#1e1b4b;color:#fff;border-radius:12px;padding:16px 24px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:6px 0;font-size:13px;">KB清算額（税込）</td>
            <td style="padding:6px 0;text-align:right;font-size:13px;">${fmtYen(stmt.grandTotal)}</td>
          </tr>
          ${adjustments.map((a, i) => `
          <tr style="${i === adjustments.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.3);' : ''}">
            <td style="padding:6px 0;font-size:13px;">${a.amount >= 0 ? '+' : ''} ${a.label}</td>
            <td style="padding:6px 0;text-align:right;font-size:13px;">${a.amount >= 0 ? '+' : ''}${fmtYen(a.amount)}</td>
          </tr>`).join('')}
          <tr>
            <td style="padding:10px 0;font-size:20px;font-weight:bold;">最終精算額</td>
            <td style="padding:10px 0;text-align:right;font-size:24px;font-weight:bold;">${fmtYen(mainAmount)}</td>
          </tr>
        </table>
      </div>` : ''

  return `
    <div style="width:794px;min-height:1123px;padding:38px 38px;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic','Meiryo',sans-serif;color:#111;background:#fff;box-sizing:border-box;">

      <!-- ヘッダー -->
      <div style="text-align:center;margin-bottom:24px;">
        <h1 style="font-size:26px;font-weight:bold;letter-spacing:6px;margin:0 0 6px;">清 算 書</h1>
        <div style="font-size:12px;color:#666;">対象期間：${periodLabel}</div>
      </div>

      <!-- 発行者・宛先 -->
      <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
        <div style="flex:1;">
          <div style="font-size:17px;font-weight:bold;border-bottom:2px solid #111;padding-bottom:4px;display:inline-block;">
            ${stmt.dealerName || stmt.dealerCode || ''} 御中
          </div>
          <div style="margin-top:4px;font-size:11px;color:#666;">
            代理店コード：${stmt.dealerCode || ''}
          </div>
        </div>
        <div style="text-align:right;font-size:11px;color:#444;line-height:1.8;position:relative;">
          <div style="font-size:13px;font-weight:bold;">${companyName}</div>
          <div>${zipCode} ${address}</div>
          <div>TEL: ${tel}</div>
          <div>登録番号: ${taxReg}</div>
          <div style="margin-top:2px;">発行日：${issuedDate}</div>
          ${stmt.stampDataUrl ? `<img src="${stmt.stampDataUrl}" style="position:absolute;right:0;top:-5px;width:70px;height:70px;object-fit:contain;opacity:0.85;" />` : ''}
        </div>
      </div>

      <!-- 精算額ハイライト -->
      <div style="background:#4f46e5;color:#fff;border-radius:12px;padding:16px 24px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:11px;opacity:0.8;">${mainLabel}</div>
          <div style="font-size:28px;font-weight:bold;margin-top:2px;">${fmtYen(mainAmount)}</div>
        </div>
        <div style="text-align:right;font-size:11px;opacity:0.8;line-height:1.8;">
          <div>サロン数：${(stmt.entries || []).length}社</div>
          <div>注文合計（税抜）：${fmtYen(stmt.totalSales)}</div>
        </div>
      </div>

      <!-- KB内訳 -->
      <div data-section>
      ${kbBreakdown}
      </div>

      <!-- 代理店注文 + 最終精算 -->
      <div data-section>
      ${dealerOrderSection}
      </div>

      <!-- 調整項目のみ（代理店注文なし） -->
      <div data-section>
      ${adjustmentOnlySection}
      </div>

      <!-- サロン別明細 -->
      <div data-section style="margin-bottom:16px;">
        <div style="font-size:13px;font-weight:bold;margin-bottom:8px;padding-left:4px;border-left:4px solid #4f46e5;">
          サロン別KB明細（${(stmt.entries || []).length}社）
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;">
          <thead>
            <tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;">
              <th style="padding:6px 10px;text-align:left;font-size:10px;color:#666;width:30px;">#</th>
              <th style="padding:6px 10px;text-align:left;font-size:10px;color:#666;">サロン名</th>
              <th style="padding:6px 10px;text-align:right;font-size:10px;color:#666;">注文回数</th>
              <th style="padding:6px 10px;text-align:right;font-size:10px;color:#666;">売上（税抜）</th>
              <th style="padding:6px 10px;text-align:right;font-size:10px;color:#666;">KB金額</th>
            </tr>
          </thead>
          <tbody>
            ${entryRows}
          </tbody>
          <tfoot>
            <tr style="background:#f0f0ff;border-top:2px solid #4f46e5;">
              <td colspan="3" style="padding:8px 10px;font-size:12px;font-weight:bold;">合計</td>
              <td style="padding:8px 10px;text-align:right;font-size:12px;font-weight:bold;">${fmtYen(stmt.totalSales)}</td>
              <td style="padding:8px 10px;text-align:right;font-size:13px;font-weight:bold;color:#4f46e5;">${fmtYen(stmt.totalKickback)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      </div>

      <!-- 振込先（代理店の口座） -->
      ${stmt.bankInfo ? `
      <div style="margin-top:20px;padding:12px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;font-size:11px;color:#444;">
        <div style="font-weight:bold;margin-bottom:4px;">お振込先</div>
        <div>${stmt.bankInfo.bankName || ''} ${stmt.bankInfo.branchName || ''} ${stmt.bankInfo.accountType || '普通'} ${stmt.bankInfo.accountNumber || ''}</div>
        <div>口座名義：${stmt.bankInfo.accountHolder || ''}</div>
      </div>` : ''}

      <!-- フッター -->
      <div style="margin-top:20px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:9px;color:#999;text-align:center;">
        本書は${companyName}が発行する清算書です。内容に相違がある場合は発行日より14日以内にご連絡ください。
      </div>
    </div>
  `
}

/**
 * キックバック清算書PDFを生成してダウンロード
 * @param {Object} stmt - calcResult + dealerCode, dealerName, month
 */
export async function generateKickbackPdf(stmt) {
  // 一時的なDOM要素を作成（absoluteで全高キャプチャ可能に）
  const container = document.createElement('div')
  container.style.position = 'absolute'
  container.style.left = '-9999px'
  container.style.top = '0'
  container.style.zIndex = '-1'
  container.innerHTML = buildStatementHtml(stmt)
  document.body.appendChild(container)

  const target = container.firstElementChild

  try {
    // 実際の描画高さを取得
    const fullHeight = target.scrollHeight || target.offsetHeight

    // html2canvasでキャンバス化（高さも明示指定）
    const canvas = await html2canvas(target, {
      scale: 2,
      width: 794,
      height: fullHeight,
      windowWidth: 794,
      windowHeight: fullHeight,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
    })

    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    })

    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()

    // 複数ページ対応
    const margin = 10 // mm
    const printableWidth = pageWidth - margin * 2
    const printableHeight = pageHeight - margin * 2
    const scaleRatio = 2 // html2canvas scale
    const scaledImgHeight = (canvas.height * printableWidth) / canvas.width

    if (scaledImgHeight <= printableHeight) {
      const imgData = canvas.toDataURL('image/png')
      pdf.addImage(imgData, 'PNG', margin, margin, printableWidth, scaledImgHeight)
    } else {
      // 全てのセクション境界を取得（テーブル行 + div直下要素）
      const containerTop = target.getBoundingClientRect().top
      const breakCandidates = target.querySelectorAll('[data-row], table, [data-section]')
      const breakSet = new Set([0, canvas.height])
      breakCandidates.forEach((el) => {
        const top = Math.round((el.getBoundingClientRect().top - containerTop) * scaleRatio)
        const bottom = Math.round((el.getBoundingClientRect().bottom - containerTop) * scaleRatio)
        if (top > 0) breakSet.add(top)
        if (bottom > 0) breakSet.add(bottom)
      })
      // 直下の子要素の境界も追加
      for (const child of target.children) {
        const top = Math.round((child.getBoundingClientRect().top - containerTop) * scaleRatio)
        const bottom = Math.round((child.getBoundingClientRect().bottom - containerTop) * scaleRatio)
        if (top > 0) breakSet.add(top)
        if (bottom > 0) breakSet.add(bottom)
      }
      const breakPoints = [...breakSet].sort((a, b) => a - b)

      // 各ページに収まる境界を探してスライス
      const pxPerPage = Math.floor((printableHeight / scaledImgHeight) * canvas.height)
      let srcY = 0
      let page = 0

      while (srcY < canvas.height - 1) {
        const maxY = srcY + pxPerPage
        // maxY以下で最も近い境界を探す
        let cutY = maxY
        for (let i = breakPoints.length - 1; i >= 0; i--) {
          if (breakPoints[i] <= maxY && breakPoints[i] > srcY + 10) {
            cutY = breakPoints[i]
            break
          }
        }
        if (cutY <= srcY) cutY = Math.min(maxY, canvas.height)
        const sliceHeight = Math.min(cutY - srcY, canvas.height - srcY)
        if (sliceHeight <= 0) break

        if (page > 0) pdf.addPage()

        const pageCanvas = document.createElement('canvas')
        pageCanvas.width = canvas.width
        pageCanvas.height = sliceHeight
        const ctx = pageCanvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, sliceHeight)
        ctx.drawImage(canvas, 0, srcY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)

        const pageImgData = pageCanvas.toDataURL('image/png')
        const sliceImgHeight = (sliceHeight * printableWidth) / canvas.width
        pdf.addImage(pageImgData, 'PNG', margin, margin, printableWidth, sliceImgHeight)

        srcY += sliceHeight
        page++
      }
    }

    const fileName = buildFileName(stmt.dealerCode, stmt.month)
    pdf.save(fileName)
    return fileName
  } finally {
    document.body.removeChild(container)
  }
}

/**
 * パスワード付き清算書PDFをbase64で返す（メール添付用）
 * パスワード = 代理店コード（例: J0015）
 * @param {Object} stmt
 * @returns {Promise<{base64: string, fileName: string, password: string}>}
 */
export async function generateKickbackPdfBase64(stmt) {
  const container = document.createElement('div')
  container.style.position = 'absolute'
  container.style.left = '-9999px'
  container.style.top = '0'
  container.style.zIndex = '-1'
  container.innerHTML = buildStatementHtml(stmt)
  document.body.appendChild(container)

  const target = container.firstElementChild
  const password = '' // パスワード保護なし
  const fullHeight = target.scrollHeight || target.offsetHeight

  try {
    const canvas = await html2canvas(target, {
      scale: 2,
      width: 794,
      height: fullHeight,
      windowWidth: 794,
      windowHeight: fullHeight,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
    })

    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    })

    const margin = 10
    const printableWidth = pdf.internal.pageSize.getWidth() - margin * 2
    const printableHeight = pdf.internal.pageSize.getHeight() - margin * 2
    const scaleRatio = 2
    const scaledImgHeight = (canvas.height * printableWidth) / canvas.width

    if (scaledImgHeight <= printableHeight) {
      const imgData = canvas.toDataURL('image/png')
      pdf.addImage(imgData, 'PNG', margin, margin, printableWidth, scaledImgHeight)
    } else {
      const containerTop = target.getBoundingClientRect().top
      const breakCandidates = target.querySelectorAll('[data-row], table, [data-section]')
      const breakSet = new Set([0, canvas.height])
      breakCandidates.forEach((el) => {
        const top = Math.round((el.getBoundingClientRect().top - containerTop) * scaleRatio)
        const bottom = Math.round((el.getBoundingClientRect().bottom - containerTop) * scaleRatio)
        if (top > 0) breakSet.add(top)
        if (bottom > 0) breakSet.add(bottom)
      })
      for (const child of target.children) {
        const top = Math.round((child.getBoundingClientRect().top - containerTop) * scaleRatio)
        const bottom = Math.round((child.getBoundingClientRect().bottom - containerTop) * scaleRatio)
        if (top > 0) breakSet.add(top)
        if (bottom > 0) breakSet.add(bottom)
      }
      const breakPoints = [...breakSet].sort((a, b) => a - b)

      const pxPerPage = Math.floor((printableHeight / scaledImgHeight) * canvas.height)
      let srcY = 0
      let page = 0

      while (srcY < canvas.height - 1) {
        const maxY = srcY + pxPerPage
        let cutY = maxY
        for (let i = breakPoints.length - 1; i >= 0; i--) {
          if (breakPoints[i] <= maxY && breakPoints[i] > srcY + 10) { cutY = breakPoints[i]; break }
        }
        if (cutY <= srcY) cutY = Math.min(maxY, canvas.height)
        const sliceHeight = Math.min(cutY - srcY, canvas.height - srcY)
        if (sliceHeight <= 0) break
        if (page > 0) pdf.addPage()

        const pageCanvas = document.createElement('canvas')
        pageCanvas.width = canvas.width
        pageCanvas.height = sliceHeight
        const ctx = pageCanvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, sliceHeight)
        ctx.drawImage(canvas, 0, srcY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)

        const pageImgData = pageCanvas.toDataURL('image/png')
        const sliceImgHeight = (sliceHeight * printableWidth) / canvas.width
        pdf.addImage(pageImgData, 'PNG', margin, margin, printableWidth, sliceImgHeight)

        srcY += sliceHeight
        page++
      }
    }

    const fileName = buildFileName(stmt.dealerCode, stmt.month)
    const base64 = pdf.output('datauristring').split(',')[1]
    return { base64, fileName, password }
  } finally {
    document.body.removeChild(container)
  }
}
