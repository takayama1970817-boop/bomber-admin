/**
 * =======================================================================
 * 研修申込 ステータス定義・遷移ロジック
 * =======================================================================
 * 設計方針:
 *   - ステータスは trainingApplications.status の単一 string フィールド
 *   - 代理店の実施報告確認は status ではなく dealerReportConfirmed フラグで持つ
 *     （status とは軸が違うため混ぜない）
 *   - 遷移は canTransition(from, to) で一元化
 *   - UI のボタン表示は getNextTransitions(current) で列挙
 *   - PR-1 では「発行」「発送」は UI 上の遷移ボタンとしては未実装。
 *     PR-2 以降で対応する。定義だけ先に用意しておく。
 * =======================================================================
 */

export const TRAINING_STATUS = {
  APPLICATION_RECEIVED: 'application_received',
  TRAINING_SCHEDULED: 'training_scheduled',
  TRAINING_COMPLETED_WAITING_ISSUE: 'training_completed_waiting_issue',
  DOCUMENTS_ISSUED: 'documents_issued',
  DOCUMENTS_SHIPPED: 'documents_shipped',
  RECEIVED_COMPLETED: 'received_completed',
  CANCELLED: 'cancelled',
}

export const TRAINING_STATUS_LABEL = {
  application_received: '申込受付',
  training_scheduled: '研修日確定',
  training_completed_waiting_issue: '研修完了・発行待ち',
  documents_issued: '発行物発行済み',
  documents_shipped: '発行物発送済み',
  received_completed: '受取完了',
  cancelled: 'キャンセル',
}

export const TRAINING_STATUS_COLOR = {
  application_received: 'bg-gray-100 text-gray-700',
  training_scheduled: 'bg-blue-100 text-blue-700',
  training_completed_waiting_issue: 'bg-amber-100 text-amber-700',
  documents_issued: 'bg-purple-100 text-purple-700',
  documents_shipped: 'bg-indigo-100 text-indigo-700',
  received_completed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-600',
}

export const APPLICATION_TYPE = {
  HEAD_OFFICE_DIRECT: 'head_office_direct',
  DEALER: 'dealer',
}

export const APPLICATION_TYPE_LABEL = {
  head_office_direct: '本社直',
  dealer: '代理店経由',
}

export const TRAINER_TYPE = {
  HEAD_OFFICE: 'head_office',
  DEALER: 'dealer',
}

export const TRAINER_TYPE_LABEL = {
  head_office: '本社',
  dealer: '代理店',
}

export const DOCUMENT_TYPE = {
  DIPLOMA: 'diploma',
  CERTIFIED_SALON_AWARD: 'certified_salon_award',
}

export const DOCUMENT_TYPE_LABEL = {
  diploma: 'ディプロマ',
  certified_salon_award: '認定サロン賞',
}

/**
 * 許可される遷移マップ。
 * from: [...to]
 *
 * キャンセルは received_completed 以外のどこからでも行ける。
 */
const TRANSITIONS = {
  application_received: [
    'training_scheduled',
    'training_completed_waiting_issue',
    'cancelled',
  ],
  training_scheduled: [
    'training_completed_waiting_issue',
    'application_received',
    'cancelled',
  ],
  training_completed_waiting_issue: [
    'documents_issued',
    'training_scheduled',
    'cancelled',
  ],
  documents_issued: [
    'documents_shipped',
    'cancelled',
  ],
  documents_shipped: [
    'received_completed',
    'cancelled',
  ],
  received_completed: [],
  cancelled: [
    'application_received',
  ],
}

/**
 * from → to の遷移が許可されているか。
 */
export function canTransition(from, to) {
  if (!from || !to) return false
  if (from === to) return false
  const allowed = TRANSITIONS[from] || []
  return allowed.includes(to)
}

/**
 * 現在ステータスから次に遷移可能なステータス一覧。
 * UI の遷移ボタン列挙に使う。
 */
export function getNextTransitions(current) {
  return TRANSITIONS[current] || []
}

/**
 * PR-1 の UI で押せる遷移ボタン。
 * 発行(documents_issued) と 発送(documents_shipped) / 受取(received_completed)
 * は PR-2 / PR-4 で専用UIに分離するので、ここからは除外する。
 *
 * cancelled への遷移はいつでも「キャンセル」ボタンとして別扱い。
 */
export function getPr1Transitions(current) {
  const skip = new Set([
    'documents_issued',
    'documents_shipped',
    'received_completed',
    'cancelled',
  ])
  return getNextTransitions(current).filter((s) => !skip.has(s))
}

/**
 * 申込番号を生成する（PR-1 最小実装）。
 * フォーマット: TR-YYYYMMDD-HHmmss-XXX
 *   - 末尾 XXX は 0-999 の乱数（同秒内の重複を実用レベルで回避）
 *   - 厳密なシーケンス番号が必要になったら Phase 2 で counter doc + transaction に切り替え
 */
export function generateApplicationNumber(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const rnd = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
  return `TR-${y}${m}${d}-${hh}${mm}${ss}-${rnd}`
}
