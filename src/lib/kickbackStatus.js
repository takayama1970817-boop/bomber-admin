/**
 * 清算書（キックバック）ステータスモデル
 *
 * docs/KICKBACK_REQUIREMENTS.md の確定仕様。
 * 5 値要件を内部 2 軸（phase + mailStatus）に分解する。
 *
 * - phase:      集計フェーズ（必ず 1 つ）
 * - mailStatus: メール状態（独立フラグ。ポータル表示・ダウンロード可否には影響しない）
 *
 * UI 表示時のラベル変換は deriveDisplayLabel() を参照。
 */

export const PHASE = Object.freeze({
  CALCULATING: 'calculating',  // 計算中（ポータル非表示）
  CALCULATED: 'calculated',    // 計算済み
  PDF_READY: 'pdf_ready',      // PDF / CSV 作成済み
})

export const MAIL_STATUS = Object.freeze({
  UNSENT: 'unsent',
  SENT: 'sent',
  FAILED: 'failed',
})

/**
 * 既存ドキュメントの phase 推定（バックフィル用ロジックと同じ）
 *   - phase が明示保存されていればそれを使う
 *   - pdfUrl があれば pdf_ready
 *   - 集計値（totalKickback / grandTotal / entries）があれば calculated
 *   - それ以外は calculating
 */
export function derivePhase(kb) {
  if (!kb) return PHASE.CALCULATING
  if (kb.phase) return kb.phase
  if (kb.pdfUrl) return PHASE.PDF_READY
  const total = Number(kb.totalKickback ?? kb.grandTotal ?? 0)
  const hasEntries = Array.isArray(kb.entries) && kb.entries.length > 0
  if (total > 0 || hasEntries) return PHASE.CALCULATED
  return PHASE.CALCULATING
}

/**
 * 既存ドキュメントの mailStatus 推定
 *   - mailStatus が明示保存されていればそれを使う
 *   - mailSentAt があるか旧 status='sent' なら sent
 *   - それ以外は unsent
 */
export function deriveMailStatus(kb) {
  if (!kb) return MAIL_STATUS.UNSENT
  if (kb.mailStatus) return kb.mailStatus
  if (kb.mailSentAt || kb.status === 'sent') return MAIL_STATUS.SENT
  return MAIL_STATUS.UNSENT
}

/**
 * UI 表示ラベル（社長指定の 5 パターン）
 */
export function deriveDisplayLabel(kb) {
  const phase = derivePhase(kb)
  const mail = deriveMailStatus(kb)
  if (phase === PHASE.CALCULATING) return '計算中'
  if (phase === PHASE.CALCULATED) return '計算済み'
  if (phase === PHASE.PDF_READY) {
    if (mail === MAIL_STATUS.SENT) return 'メール送信済み'
    if (mail === MAIL_STATUS.FAILED) return 'メール送信失敗'
    return 'PDF作成済み（メール未送信）'
  }
  return '—'
}

/** 5 パターンに応じたバッジ色（Tailwind） */
export function displayBadgeClass(kb) {
  const phase = derivePhase(kb)
  const mail = deriveMailStatus(kb)
  if (phase === PHASE.CALCULATING) return 'bg-gray-100 text-gray-700'
  if (phase === PHASE.CALCULATED) return 'bg-blue-100 text-blue-700'
  // pdf_ready
  if (mail === MAIL_STATUS.SENT) return 'bg-emerald-100 text-emerald-800'
  if (mail === MAIL_STATUS.FAILED) return 'bg-red-100 text-red-700'
  return 'bg-amber-100 text-amber-800'
}

/**
 * ポータル表示可否
 * calculating は dealer ポータルに出さない。calculated / pdf_ready は表示。
 */
export function isPortalVisible(kb) {
  return derivePhase(kb) !== PHASE.CALCULATING
}

/**
 * PDF ダウンロード可否
 * pdfUrl があれば常に可。mailStatus は問わない（要件: メール送信と分離）。
 */
export function canDownloadPdf(kb) {
  return !!kb?.pdfUrl
}

/**
 * CSV ダウンロード可否
 * csvUrl があれば常に可。mailStatus は問わない。
 */
export function canDownloadCsv(kb) {
  return !!kb?.csvUrl
}
