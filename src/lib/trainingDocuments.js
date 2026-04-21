/**
 * =======================================================================
 * 研修発行物（ディプロマ / 認定サロン賞）管理ライブラリ（PR-2 導入）
 * =======================================================================
 *
 * 対象コレクション:
 *   - trainingApplications/{appId}/documents         : 発行物本体（1案件×1documentType=1レコード）
 *   - trainingApplications/{appId}/documentHistory   : 発行・再印刷の追記型履歴
 *   - counters/trainingDocuments_{documentType}_{YYYY} : 年×発行物種別ごとの採番カウンタ
 *
 * 設計方針:
 *   - 純関数（条件チェック・対象判定・番号フォーマット）とトランザクション関数を分離
 *   - 採番は documentType × year で別ドキュメントに分けて書き込み競合を完全分離
 *   - 1回の発行操作（採番 + documents 作成 + documentHistory 追記）は単一 runTransaction で原子化
 *   - PR-2 はライブラリ実装まで。UI の「発行して印刷」ボタンは PR-3 で配線する
 *   - PDF は PR-2 では生成しない。PR-3 で生成後 attachPdf() で紐付ける
 * =======================================================================
 */

import {
  addDoc,
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { db } from './firebase.js'
import { DOCUMENT_TYPE, TRAINING_STATUS } from './trainingStatus.js'

// ====== 定数 ======

export const DOCUMENT_STATUS = {
  NOT_ISSUED: 'not_issued',
  ISSUED: 'issued',
  REISSUED: 'reissued',
}

export const DOCUMENT_HISTORY_ACTION = {
  ISSUE: 'issue',
  REISSUE: 'reissue',
  REPRINT: 'reprint',
  PDF_ATTACH: 'pdf_attach',
  PDF_FAIL: 'pdf_fail',
}

const PREFIX_BY_TYPE = {
  [DOCUMENT_TYPE.DIPLOMA]: 'D',
  [DOCUMENT_TYPE.CERTIFIED_SALON_AWARD]: 'CS',
}

// 案件ステータスのうち、発行可能なもの（training_completed_waiting_issue 以上）
const ISSUABLE_STATUSES = new Set([
  TRAINING_STATUS.TRAINING_COMPLETED_WAITING_ISSUE,
  TRAINING_STATUS.DOCUMENTS_ISSUED,
  TRAINING_STATUS.DOCUMENTS_SHIPPED,
  TRAINING_STATUS.RECEIVED_COMPLETED,
])

// ====== 採番フォーマット（純関数） ======

/**
 * 発行番号の整形。D-2026-0001 / CS-2026-0001 形式
 * @param {string} documentType
 * @param {number} year
 * @param {number} seq
 */
export function formatDocumentNumber(documentType, year, seq) {
  const prefix = PREFIX_BY_TYPE[documentType]
  if (!prefix) throw new Error(`未知の documentType: ${documentType}`)
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`
}

/**
 * counters の docId を組み立てる。
 * rules の正規表現制約 `^trainingDocuments_(diploma|certified_salon_award)_[0-9]{4}$` と整合させる。
 */
export function buildCounterDocId(documentType, year) {
  return `trainingDocuments_${documentType}_${year}`
}

// ====== 発行条件チェック（純関数） ======

/**
 * 案件単位の共通発行可否チェック。
 * 仕様書の「発行条件（共通）」＋「代理店案件の追加条件」をここで一元判定。
 * @param {object} app - trainingApplications ドキュメントデータ
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkCommonIssuable(app) {
  const reasons = []
  if (!app) return { ok: false, reasons: ['案件が存在しません'] }

  if (app.status === TRAINING_STATUS.CANCELLED) {
    reasons.push('キャンセル済みの案件は発行できません')
  }
  if (!app.trainingTypeId) reasons.push('研修種別が未設定です')
  if (!app.trainingName) reasons.push('研修名が未設定です')
  if (!app.trainingCompletedDate) reasons.push('研修実施日（修了日）が未設定です')
  if (!ISSUABLE_STATUSES.has(app.status)) {
    reasons.push('研修完了後でないと発行できません（ステータス: 研修完了・発行待ち 以上が必要）')
  }
  if (app.applicationType === 'dealer' && !app.dealerReportConfirmed) {
    reasons.push('代理店案件は実施報告の確認済みが必要です')
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * 発行物種別ごとの追加条件チェック。共通条件を内包するため、これ1つ呼べばOK。
 * @param {object} app
 * @param {string} documentType - 'diploma' | 'certified_salon_award'
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkDocumentIssuable(app, documentType) {
  const common = checkCommonIssuable(app)
  const reasons = [...common.reasons]

  if (documentType === DOCUMENT_TYPE.DIPLOMA) {
    if (!app?.attendeeName) reasons.push('ディプロマ発行には受講者名が必要です')
  } else if (documentType === DOCUMENT_TYPE.CERTIFIED_SALON_AWARD) {
    if (!app?.salonName) reasons.push('認定サロン賞発行にはサロン名が必要です')
    if (!app?.salonRepresentativeName) reasons.push('認定サロン賞発行には代表者名が必要です')
  } else {
    reasons.push(`未対応の発行物種別: ${documentType}`)
  }

  return { ok: reasons.length === 0, reasons }
}

/**
 * 対象発行物の列挙（研修種別の発行フラグ × 既発行状態）。
 * 初回発行で作るべき発行物だけを返す。既発行は除外。
 *
 * @param {object} trainingType - trainingTypes マスタのレコード
 * @param {Array<object>} existingDocs - 既存 documents サブコレクションの配列
 * @returns {string[]} documentType の配列
 */
export function getTargetDocumentTypes(trainingType, existingDocs = []) {
  const targets = []
  if (trainingType?.issueDiploma) targets.push(DOCUMENT_TYPE.DIPLOMA)
  if (trainingType?.issueCertifiedSalonAward) targets.push(DOCUMENT_TYPE.CERTIFIED_SALON_AWARD)

  const alreadyIssued = new Set(
    (existingDocs || [])
      .filter((d) => d.status === DOCUMENT_STATUS.ISSUED || d.status === DOCUMENT_STATUS.REISSUED)
      .map((d) => d.documentType),
  )
  return targets.filter((t) => !alreadyIssued.has(t))
}

/**
 * 研修種別が定義する全発行物種別（既発行の除外なし）。UI プレビュー用。
 */
export function getAllDocumentTypesForTraining(trainingType) {
  const all = []
  if (trainingType?.issueDiploma) all.push(DOCUMENT_TYPE.DIPLOMA)
  if (trainingType?.issueCertifiedSalonAward) all.push(DOCUMENT_TYPE.CERTIFIED_SALON_AWARD)
  return all
}

// ====== 発行トランザクション ======

/**
 * 発行物スナップショットを作る（案件情報 + 会社情報を発行時点で凍結）。
 * 案件が後から編集されても、発行された PDF の中身は変わらないよう保持する。
 */
function buildSnapshot(app, companySettings) {
  return {
    attendeeName: app.attendeeName || '',
    salonName: app.salonName || '',
    salonRepresentativeName: app.salonRepresentativeName || '',
    trainingName: app.trainingName || '',
    trainingCompletedDate: app.trainingCompletedDate || null,
    issuerName: companySettings?.issuerName || companySettings?.representativeName || '',
    issuerCompanyName: companySettings?.companyName || '',
    stampUrl: companySettings?.stampUrl || '',
  }
}

/**
 * 発行を実行する。
 *   1. counters/{docId} を transaction で read → +1 書き込み
 *   2. trainingApplications/{appId}/documents に新レコード作成（status='issued'、pdf は null）
 *   3. trainingApplications/{appId}/documentHistory に 'issue' を追記
 *
 * 案件ステータス（trainingApplications.status）の遷移はここでは行わない。
 * PR-3 の「発行して印刷」ボタン側で、対象発行物がすべて発行済みになったら
 * `documents_issued` へ遷移させる設計にする（一括操作の完了時に状態を動かす）。
 *
 * @param {object} params
 * @param {object} params.app - trainingApplications のレコード（id 必須）
 * @param {string} params.documentType - 'diploma' | 'certified_salon_award'
 * @param {object} params.profile - AuthContext の profile
 * @param {object} [params.trainingType] - 研修種別マスタ（templateId 決定に使う）
 * @param {object} [params.companySettings] - 発行者情報（snapshot 用）
 * @param {string} [params.templateId]
 * @param {number} [params.templateVersion=1]
 * @returns {Promise<{docId,documentNumber,snapshot,templateId,templateVersion,historyId}>}
 * @throws 発行条件を満たさない場合は throw
 */
export async function issueDocument({
  app,
  documentType,
  profile,
  trainingType,
  companySettings,
  templateId,
  templateVersion = 1,
  now = new Date(),
}) {
  if (!app?.id) throw new Error('app.id が必要です')
  const check = checkDocumentIssuable(app, documentType)
  if (!check.ok) {
    const err = new Error(`発行条件を満たしていません: ${check.reasons.join(' / ')}`)
    err.code = 'issue-conditions-unmet'
    err.reasons = check.reasons
    throw err
  }

  const year = now.getFullYear()
  const counterRef = doc(db, 'counters', buildCounterDocId(documentType, year))
  const docsCol = collection(db, 'trainingApplications', app.id, 'documents')
  const histCol = collection(db, 'trainingApplications', app.id, 'documentHistory')
  const newDocRef = doc(docsCol)
  const newHistRef = doc(histCol)

  const resolvedTemplateId = templateId || trainingType?.[`defaultTemplate_${documentType}`] || ''

  return await runTransaction(db, async (tx) => {
    const counterSnap = await tx.get(counterRef)
    const seq = (counterSnap.exists() ? counterSnap.data().seq || 0 : 0) + 1
    const documentNumber = formatDocumentNumber(documentType, year, seq)

    tx.set(counterRef, {
      seq,
      documentType,
      year,
      updatedAt: serverTimestamp(),
    }, { merge: true })

    const snapshot = buildSnapshot(app, companySettings)

    tx.set(newDocRef, {
      documentType,
      status: DOCUMENT_STATUS.ISSUED,
      documentNumber,
      numberPrefix: PREFIX_BY_TYPE[documentType],
      numberYear: year,
      numberSeq: seq,
      templateId: resolvedTemplateId,
      templateVersion,
      snapshot,
      issuedAt: serverTimestamp(),
      issuedBy: profile?.uid || null,
      issuedByName: profile?.name || profile?.email || '',
      printedAt: null,
      printCount: 0,
      lastPrintedBy: null,
      pdfUrl: null,
      pdfStoragePath: null,
      pdfGeneratedAt: null,
      version: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })

    tx.set(newHistRef, {
      action: DOCUMENT_HISTORY_ACTION.ISSUE,
      documentType,
      documentId: newDocRef.id,
      documentNumber,
      templateId: resolvedTemplateId,
      templateVersion,
      result: 'success',
      error: null,
      actorUid: profile?.uid || null,
      actorName: profile?.name || profile?.email || '',
      createdAt: serverTimestamp(),
    })

    return {
      docId: newDocRef.id,
      documentNumber,
      snapshot,
      templateId: resolvedTemplateId,
      templateVersion,
      historyId: newHistRef.id,
    }
  })
}

/**
 * PR-3 が PDF 生成後に呼ぶ。documents に pdfUrl を紐付け、履歴に記録する。
 * 採番系フィールドは触らない（rules 側でも不変チェック）。
 */
export async function attachPdf({ appId, docId, documentType, documentNumber, pdfUrl, pdfStoragePath, profile }) {
  const ref = doc(db, 'trainingApplications', appId, 'documents', docId)
  await updateDoc(ref, {
    pdfUrl,
    pdfStoragePath,
    pdfGeneratedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await addDoc(collection(db, 'trainingApplications', appId, 'documentHistory'), {
    action: DOCUMENT_HISTORY_ACTION.PDF_ATTACH,
    documentType: documentType || null,
    documentId: docId,
    documentNumber: documentNumber || null,
    result: 'success',
    error: null,
    actorUid: profile?.uid || null,
    actorName: profile?.name || profile?.email || '',
    createdAt: serverTimestamp(),
  })
}

/**
 * PDF 生成失敗時の履歴記録。documents レコード自体は残し、後日再生成できるようにしておく。
 */
export async function recordPdfFailure({ appId, docId, documentType, documentNumber, error, profile }) {
  await addDoc(collection(db, 'trainingApplications', appId, 'documentHistory'), {
    action: DOCUMENT_HISTORY_ACTION.PDF_FAIL,
    documentType: documentType || null,
    documentId: docId,
    documentNumber: documentNumber || null,
    result: 'failure',
    error: String(error?.message || error || 'unknown error').slice(0, 500),
    actorUid: profile?.uid || null,
    actorName: profile?.name || profile?.email || '',
    createdAt: serverTimestamp(),
  })
}

/**
 * 再印刷の記録。採番はせず、printCount を +1 して printedAt を更新。
 * documentHistory に 'reprint' を追記。
 */
export async function recordReprint({ appId, docId, profile }) {
  const ref = doc(db, 'trainingApplications', appId, 'documents', docId)
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('発行物が見つかりません')
    const data = snap.data()
    const next = (data.printCount || 0) + 1
    tx.update(ref, {
      printCount: next,
      printedAt: serverTimestamp(),
      lastPrintedBy: profile?.uid || null,
      updatedAt: serverTimestamp(),
    })
    const histRef = doc(collection(db, 'trainingApplications', appId, 'documentHistory'))
    tx.set(histRef, {
      action: DOCUMENT_HISTORY_ACTION.REPRINT,
      documentType: data.documentType,
      documentId: docId,
      documentNumber: data.documentNumber,
      result: 'success',
      error: null,
      actorUid: profile?.uid || null,
      actorName: profile?.name || profile?.email || '',
      createdAt: serverTimestamp(),
    })
    return { printCount: next }
  })
}
