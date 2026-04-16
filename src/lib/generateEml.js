// メール下書き作成ユーティリティ（Gmail compose 起動 + PDF同時ダウンロード方式）
// .eml 方式から Gmail Web 方式へ全面変更（社長環境はGmailメイン、メーラー不在のため）

/**
 * Gmail 作成画面を新しいタブで開き、宛先・CC・件名・本文を自動入力する。
 * 同時に PDF をブラウザでダウンロードし、ユーザーは Gmail 画面に
 * ドラッグ＆ドロップで添付して「送信」を押すだけ。
 *
 * @param {Object} opts
 * @param {string} opts.to            宛先
 * @param {string} [opts.cc]          CC
 * @param {string} opts.subject       件名
 * @param {string} opts.body          本文
 * @param {string} [opts.pdfBase64]   添付PDFの Base64
 * @param {string} [opts.pdfFileName] PDFファイル名
 */
export function downloadEml({ to, cc, subject, body, pdfBase64, pdfFileName }) {
  // 1) PDFをローカルダウンロード
  if (pdfBase64 && pdfFileName) {
    const cleanB64 = pdfBase64.replace(/^data:.*;base64,/, '')
    const bin = atob(cleanB64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const blob = new Blob([bytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = pdfFileName
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  // 2) Gmail 作成画面を新タブで開く（宛先・CC・件名・本文すべて入力済み）
  const params = new URLSearchParams()
  params.set('view', 'cm')
  params.set('fs', '1')
  if (to) params.set('to', to)
  if (cc) params.set('cc', cc)
  if (subject) params.set('su', subject)
  if (body) params.set('body', body)
  const gmailUrl = 'https://mail.google.com/mail/?' + params.toString()

  // ポップアップブロック対策: ボタンクリック直後の同期実行で window.open
  window.open(gmailUrl, '_blank', 'noopener')
}
