/**
 * 表示フォーマッタ統一モジュール
 *
 * 各画面でばらばらに定義されていた fmtYen / fmtDate / fmtPct を集約。
 * 横展開 Phase 0（PR後続で各画面 import に置換）。
 *
 * ルール:
 *   - 金額: ¥1,234,567（カンマ区切り、小数なし）
 *   - 日付: 2026/04/25（年月日スラッシュ）
 *   - 日時: 2026/04/25 14:30
 *   - 前年比: +12.3% / -8.4% / —（小数1位、ゼロ除算は em-dash）
 *   - 件数: 1,234 件
 */

const pad2 = (n) => String(n).padStart(2, '0')

/** Firestore Timestamp / Date / number / string を Date に統一 */
function toDate(ts) {
  if (ts == null) return null
  if (ts instanceof Date) return ts
  if (typeof ts?.toDate === 'function') return ts.toDate()
  if (typeof ts === 'object') {
    const sec = ts._seconds ?? ts.seconds
    if (typeof sec === 'number') return new Date(sec * 1000)
  }
  if (typeof ts === 'number' || typeof ts === 'string') {
    const d = new Date(ts)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

/** 円表示（¥1,234,567）。null/undefined/NaN は em-dash */
export function fmtYen(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return '¥' + Number(n).toLocaleString('ja-JP')
}

/** コンパクト円表示（KPI タイル用：¥1.2万 / ¥3.4億）。1万円未満はそのまま */
export function fmtYenCompact(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const v = Number(n)
  if (Math.abs(v) >= 1e8) return '¥' + (v / 1e8).toFixed(1) + '億'
  if (Math.abs(v) >= 1e4) return '¥' + (v / 1e4).toFixed(1) + '万'
  return '¥' + v.toLocaleString('ja-JP')
}

/** 日付（2026/04/25）。null は em-dash */
export function fmtDate(ts) {
  const d = toDate(ts)
  if (!d) return '—'
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`
}

/** 日時（2026/04/25 14:30） */
export function fmtDateTime(ts) {
  const d = toDate(ts)
  if (!d) return '—'
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * 割合表示（12.3% / —）。稼働率など符号なし用途。
 * @param {number|null|undefined} ratio 0.123 のような小数 or null
 * @param {number} digits 小数点以下桁数（既定1）
 */
export function fmtPct(ratio, digits = 1) {
  if (ratio == null || Number.isNaN(Number(ratio))) return '—'
  return `${(Number(ratio) * 100).toFixed(digits)}%`
}

/**
 * 前年比 / 前月比など符号付き割合表示（+12.3% / -8.4% / —）
 * 0% は無符号の "0.0%"。
 */
export function fmtPctSigned(ratio, digits = 1) {
  if (ratio == null || Number.isNaN(Number(ratio))) return '—'
  const v = Number(ratio) * 100
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(digits)}%`
}

/** 前年比に応じた Tailwind 色クラス（emerald-600 / red-600 / gray-400） */
export function pctColorClass(ratio) {
  if (ratio == null || Number.isNaN(Number(ratio))) return 'text-gray-400'
  const v = Number(ratio)
  if (v > 0) return 'text-emerald-600'
  if (v < 0) return 'text-red-600'
  return 'text-gray-500'
}

/** 件数（1,234 件）。null/undefined は em-dash */
export function fmtCount(n, unit = '件') {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return `${Number(n).toLocaleString('ja-JP')} ${unit}`
}

/** 経過時間（X時間前 / X分前 / 今） */
export function fmtRelative(ts) {
  const d = toDate(ts)
  if (!d) return '—'
  const diffMs = Date.now() - d.getTime()
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return '今'
  if (min < 60) return `${min} 分前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 時間前`
  const day = Math.floor(hr / 24)
  return `${day} 日前`
}
