/**
 * =======================================================================
 * 研修発行物 PDF 生成ライブラリ（PR-3 導入）
 * =======================================================================
 *
 * ディプロマ / 認定サロン賞 の HTML を組み立て、html2canvas + jsPDF で
 * クライアント側 PDF を生成し、Firebase Storage にアップロードする。
 *
 * 社長方針:
 *   - PDFテンプレートは関数分離（buildDiplomaHtml / buildCertifiedSalonHtml）
 *   - ブランド感を強めた文面:
 *       ディプロマ:        「上記の者は 〈研修名〉 の全課程を修了したことを証する」
 *       認定サロン賞: 「〈サロン名〉 は VAVITTE の理念と技術基準を満たした認定サロンであることをここに証する」
 *   - A4 横向きで生成（賞状レイアウト）
 *   - 印影は snapshot.stampUrl（dataURL or HTTPS URL）で受け取る
 *
 * Storage 構造:
 *   training-documents/{appId}/{documentType}-{documentNumber}.pdf
 * =======================================================================
 */

import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { storage } from './firebase.js'
import { DOCUMENT_TYPE } from './trainingStatus.js'

// ====== HTML テンプレート（関数分離） ======

/**
 * 日付整形（YYYY年M月D日）
 */
function fmtJpDate(d) {
  if (!d) return ''
  const date = d?.toDate ? d.toDate() : new Date(d)
  if (isNaN(date.getTime())) return ''
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

/**
 * 発行物共通 CSS（A4 横 = 297mm × 210mm / 96dpi 換算で 1123 × 794 px）
 */
function sharedCss() {
  return `
    @page { size: A4 landscape; margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { margin: 0; }
    .doc {
      width: 1123px;
      height: 794px;
      padding: 60px 80px;
      background: #ffffff;
      border: 10px double #9b7a3f;
      font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'MS Mincho', serif;
      color: #1a1a1a;
      position: relative;
    }
    .doc-inner {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
    }
    .title-group { text-align: center; margin-top: 10px; }
    .title-main { font-size: 48pt; font-weight: bold; letter-spacing: 12px; color: #9b7a3f; }
    .title-sub { font-size: 14pt; letter-spacing: 6px; color: #6b5633; margin-top: 6px; }

    .recipient { font-size: 26pt; text-align: center; margin-top: 30px; padding-bottom: 8px; border-bottom: 1px solid #9b7a3f; width: 70%; margin-left: auto; margin-right: auto; }
    .recipient-sub { font-size: 12pt; text-align: center; color: #555; margin-top: 6px; }

    .body-text { font-size: 16pt; text-align: center; line-height: 2.2; margin-top: 28px; padding: 0 60px; }

    .training-name { font-weight: bold; color: #9b7a3f; }

    .meta { display: flex; justify-content: space-between; align-items: flex-end; width: 100%; margin-top: 10px; font-size: 11pt; }
    .meta .left { text-align: left; line-height: 1.9; }
    .meta .right { text-align: right; line-height: 1.9; }

    .doc-number { font-family: monospace; font-size: 11pt; color: #555; }
    .issue-date { font-size: 11pt; color: #555; }

    .issuer-block { text-align: right; line-height: 1.9; }
    .issuer-company { font-size: 13pt; font-weight: bold; }
    .issuer-name { font-size: 12pt; }
    .stamp { margin-top: 4px; height: 70px; }
    .stamp img { height: 70px; object-fit: contain; }
    .stamp-placeholder {
      display: inline-flex;
      width: 70px; height: 70px;
      border: 2px solid #c33; border-radius: 50%;
      color: #c33; font-size: 10pt;
      align-items: center; justify-content: center;
      text-align: center;
    }

    .vavitte-mark {
      position: absolute;
      top: 24px; left: 50%; transform: translateX(-50%);
      font-size: 9pt; letter-spacing: 6px; color: #9b7a3f;
    }

    /* PR-B: 認定インストラクター名ブロック（ディプロマ用） */
    .instructor-block {
      margin-top: 18px;
      text-align: center;
      font-size: 12pt;
      letter-spacing: 2px;
      color: #3b2d5c;
    }
    .instructor-label {
      display: inline-block;
      padding: 2px 10px;
      margin-right: 10px;
      border: 1px solid #9b7a3f;
      border-radius: 4px;
      font-size: 10pt;
      color: #9b7a3f;
      letter-spacing: 3px;
    }
    .instructor-name {
      font-weight: bold;
    }
  `
}

/**
 * HTML ラッパー
 */
function wrapHtml(innerHtml) {
  return `<div class="doc"><style>${sharedCss()}</style><div class="vavitte-mark">VAVITTE</div><div class="doc-inner">${innerHtml}</div></div>`
}

/**
 * 印影ブロック
 */
function stampBlock(stampUrl) {
  if (stampUrl) {
    return `<div class="stamp"><img src="${stampUrl}" alt="印影" /></div>`
  }
  return `<div class="stamp"><span class="stamp-placeholder">発行者印</span></div>`
}

/**
 * PR-B: 認定インストラクター名ブロック（ディプロマ用・関数分離）
 * 後からデザイン変更できるよう切り出し。snapshot.instructorName が空なら何も描画しない。
 * HTML 構造は "講師：〈氏名〉" を明朝で強調し、発行番号行の横か下に配置できる汎用出力。
 */
function diplomaInstructorBlock(instructorName) {
  if (!instructorName) return ''
  return `
    <div class="instructor-block">
      <span class="instructor-label">講師</span>
      <span class="instructor-name">${escapeHtml(instructorName)}</span>
    </div>
  `
}

/**
 * ディプロマ HTML 組立
 * @param {object} data - { documentNumber, snapshot, issuedAt }
 *   snapshot: { attendeeName, trainingName, trainingCompletedDate, issuerName, issuerCompanyName, stampUrl }
 */
export function buildDiplomaHtml(data) {
  const s = data.snapshot || {}
  const inner = `
    <div class="title-group">
      <div class="title-main">Diploma</div>
      <div class="title-sub">of Completion ／ 修了証書</div>
    </div>
    <div>
      <div class="recipient">${escapeHtml(s.attendeeName || '')}<span style="font-size:14pt;margin-left:10px;">様</span></div>
      <div class="recipient-sub">受講者</div>
      <div class="body-text">
        上記の者は <span class="training-name">${escapeHtml(s.trainingName || '')}</span> の<br/>
        全課程を修了したことを証する
      </div>
      ${diplomaInstructorBlock(s.instructorName)}
    </div>
    <div class="meta">
      <div class="left">
        <div class="doc-number">発行番号: ${escapeHtml(data.documentNumber || '')}</div>
        <div class="issue-date">修了日: ${fmtJpDate(s.trainingCompletedDate)}</div>
        <div class="issue-date">発行日: ${fmtJpDate(data.issuedAt || new Date())}</div>
      </div>
      <div class="right issuer-block">
        <div class="issuer-company">${escapeHtml(s.issuerCompanyName || '')}</div>
        <div class="issuer-name">${escapeHtml(s.issuerName || '')}</div>
        ${stampBlock(s.stampUrl)}
      </div>
    </div>
  `
  return wrapHtml(inner)
}

/**
 * 認定サロン賞 HTML 組立
 * @param {object} data - { documentNumber, snapshot, issuedAt }
 *   snapshot: { salonName, salonRepresentativeName, trainingCompletedDate, issuerName, issuerCompanyName, stampUrl }
 */
export function buildCertifiedSalonHtml(data) {
  const s = data.snapshot || {}
  const inner = `
    <div class="title-group">
      <div class="title-main">認定サロン賞</div>
      <div class="title-sub">Certified Salon</div>
    </div>
    <div>
      <div class="recipient">${escapeHtml(s.salonName || '')}</div>
      <div class="recipient-sub">${escapeHtml(s.salonRepresentativeName ? `代表 ${s.salonRepresentativeName} 様` : '')}</div>
      <div class="body-text">
        <span class="training-name">${escapeHtml(s.salonName || '')}</span> は<br/>
        VAVITTE の理念と技術基準を満たした認定サロンであることをここに証する
      </div>
    </div>
    <div class="meta">
      <div class="left">
        <div class="doc-number">認定番号: ${escapeHtml(data.documentNumber || '')}</div>
        <div class="issue-date">認定日: ${fmtJpDate(s.trainingCompletedDate)}</div>
        <div class="issue-date">発行日: ${fmtJpDate(data.issuedAt || new Date())}</div>
      </div>
      <div class="right issuer-block">
        <div class="issuer-company">${escapeHtml(s.issuerCompanyName || '')}</div>
        <div class="issuer-name">${escapeHtml(s.issuerName || '')}</div>
        ${stampBlock(s.stampUrl)}
      </div>
    </div>
  `
  return wrapHtml(inner)
}

/**
 * 最低限の HTML エスケープ（差し込み値の注入対策）。
 * 本用途は自社業務画面だが、念のため属性展開外のテキスト用に用意。
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ====== HTML → Canvas → PDF 変換 ======

/**
 * HTML 文字列を一時 DOM にレンダリングし、html2canvas で canvas 化する。
 * A4 横サイズ（1123 × 794 px）を前提。
 */
async function renderHtmlToCanvas(html) {
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
      width: 1123,
      height: 794,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
    })
    return canvas
  } finally {
    document.body.removeChild(container)
  }
}

/**
 * documentType / snapshot / documentNumber / issuedAt から PDF Blob を生成
 * @returns {Promise<Blob>}
 */
export async function generateTrainingDocumentBlob({ documentType, documentNumber, snapshot, issuedAt }) {
  const html = buildDocumentHtml({ documentType, documentNumber, snapshot, issuedAt })
  const canvas = await renderHtmlToCanvas(html)

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, pageHeight)
  return pdf.output('blob')
}

/**
 * documentType に応じた HTML を返す（buildDiplomaHtml / buildCertifiedSalonHtml のディスパッチ）
 */
export function buildDocumentHtml({ documentType, documentNumber, snapshot, issuedAt }) {
  const data = { documentNumber, snapshot, issuedAt }
  if (documentType === DOCUMENT_TYPE.DIPLOMA) return buildDiplomaHtml(data)
  if (documentType === DOCUMENT_TYPE.CERTIFIED_SALON_AWARD) return buildCertifiedSalonHtml(data)
  throw new Error(`未対応の documentType: ${documentType}`)
}

// ====== Firebase Storage アップロード ======

export function buildStoragePath(appId, documentType, documentNumber) {
  // documentNumber に含まれるハイフンはそのまま使える
  return `training-documents/${appId}/${documentType}-${documentNumber}.pdf`
}

/**
 * PDF Blob を Firebase Storage にアップロードして URL を返す
 * @returns {Promise<{ pdfUrl, pdfStoragePath }>}
 */
export async function uploadTrainingPdf({ appId, documentType, documentNumber, blob }) {
  const path = buildStoragePath(appId, documentType, documentNumber)
  const r = ref(storage, path)
  await uploadBytes(r, blob, { contentType: 'application/pdf' })
  const pdfUrl = await getDownloadURL(r)
  return { pdfUrl, pdfStoragePath: path }
}

/**
 * PDF URL を新ウィンドウで開き、自動で印刷ダイアログを起動する。
 * 初回はポップアップブロックが発動する可能性があるため、呼び出し元でユーザー操作（クリック）に紐づけて呼ぶこと。
 *
 * @param {string} url - PDF の URL
 * @param {boolean} [autoPrint=true] - true の場合、onload で window.print() を呼ぶ
 */
export function openPdfWindow(url, { autoPrint = true } = {}) {
  const win = window.open(url, '_blank', 'noopener,noreferrer')
  if (!win) {
    // ポップアップブロックされた場合はフォールバックでリンクを返す
    return { ok: false, reason: 'popup-blocked' }
  }
  if (autoPrint) {
    // PDF ビューワー環境によっては onload が拾えないため、setTimeout で保険をかける
    try {
      win.addEventListener('load', () => {
        try { win.print() } catch (e) { /* noop */ }
      })
      setTimeout(() => {
        try { win.print() } catch (e) { /* noop */ }
      }, 1500)
    } catch (_) { /* noop */ }
  }
  return { ok: true }
}
