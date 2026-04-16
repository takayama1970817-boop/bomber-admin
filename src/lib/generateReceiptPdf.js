// 領収書 PDF 生成
// html2canvas で DOM をキャンバス化し、jsPDF で A4 1ページの PDF にして保存する

import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'

// 注文番号と日付からファイル名を作る
function buildFileName(parsed) {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const no = parsed?.order?.orderNumber || 'noorder'
  return `receipt_${ymd}_${no}.pdf`
}

// element: ReceiptPrintable の DOM 要素（ref.current）
// parsed: パース済み注文データ
export async function generateReceiptPdf(element, parsed) {
  if (!element) throw new Error('領収書テンプレートが準備できていません')

  // 高解像度でキャンバス化（A4サイズに固定）
  const canvas = await html2canvas(element, {
    scale: 2,
    width: 794,
    height: 1123,
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
  })

  const imgData = canvas.toDataURL('image/png')

  // A4 縦（mm）
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  })

  const pageWidth = pdf.internal.pageSize.getWidth() // 210mm
  const pageHeight = pdf.internal.pageSize.getHeight() // 297mm

  // 常にA4 1ページに収める（幅合わせ、高さはページ内に制限）
  const imgWidth = pageWidth
  const imgHeight = Math.min(
    (canvas.height * imgWidth) / canvas.width,
    pageHeight,
  )
  pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight)

  const fileName = buildFileName(parsed)
  pdf.save(fileName)
  return fileName
}
