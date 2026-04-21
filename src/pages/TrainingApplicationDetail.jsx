import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { assertCan, canManageTraining } from '../lib/permissions.js'
import {
  APPLICATION_TYPE_LABEL,
  DOCUMENT_TYPE_LABEL,
  TRAINING_STATUS,
  TRAINING_STATUS_LABEL,
  TRAINING_STATUS_COLOR,
  canTransition,
  getPr1Transitions,
} from '../lib/trainingStatus.js'
import {
  DOCUMENT_STATUS,
  DOCUMENT_HISTORY_ACTION,
  checkDocumentIssuable,
  getAllDocumentTypesForTraining,
} from '../lib/trainingDocuments.js'

/**
 * 研修案件 詳細（PR-1 骨組み）
 * - 基本情報の表示・編集
 * - ステータス遷移ボタン（発行・発送系は除外、PR-2/PR-4 で別導線化）
 * - キャンセル / キャンセル解除
 * - 代理店案件の実施報告確認フラグ
 * - 履歴ログ表示（history サブコレクション）
 * - 発行物・発送・受取 欄は PR-2/PR-4 実装予定のプレースホルダ
 */

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function fmtDateTime(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  const Y = d.getFullYear()
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const D = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${Y}/${M}/${D} ${hh}:${mm}`
}

function toInputDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  const Y = d.getFullYear()
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const D = String(d.getDate()).padStart(2, '0')
  return `${Y}-${M}-${D}`
}

export default function TrainingApplicationDetail() {
  const { id } = useParams()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [history, setHistory] = useState([])
  const [documents, setDocuments] = useState([])
  const [docHistory, setDocHistory] = useState([])
  const [types, setTypes] = useState([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState(null)

  const canEdit = canManageTraining(profile)

  async function load() {
    setLoading(true)
    try {
      const ref = doc(db, 'trainingApplications', id)
      const snap = await getDoc(ref)
      if (!snap.exists()) {
        setMessage('案件が見つかりません')
        setData(null)
        return
      }
      const d = { id: snap.id, ...snap.data() }
      setData(d)
      setEdit({
        attendeeName: d.attendeeName || '',
        attendeeContact: d.attendeeContact || '',
        attendeeAffiliation: d.attendeeAffiliation || '',
        salonName: d.salonName || '',
        salonRepresentativeName: d.salonRepresentativeName || '',
        dealerCode: d.dealerCode || '',
        dealerName: d.dealerName || '',
        dealerPersonName: d.dealerPersonName || '',
        trainingTypeId: d.trainingTypeId || '',
        trainingScheduledDate: toInputDate(d.trainingScheduledDate),
        trainingCompletedDate: toInputDate(d.trainingCompletedDate),
        note: d.note || '',
      })

      const [histSnap, typesSnap, docsSnap, docHistSnap] = await Promise.all([
        getDocs(query(
          collection(db, 'trainingApplications', id, 'history'),
          orderBy('createdAt', 'desc'),
        )),
        getDocs(query(collection(db, 'trainingTypes'), orderBy('sortOrder', 'asc'))),
        getDocs(collection(db, 'trainingApplications', id, 'documents')),
        getDocs(query(
          collection(db, 'trainingApplications', id, 'documentHistory'),
          orderBy('createdAt', 'desc'),
        )),
      ])
      setHistory(histSnap.docs.map((h) => ({ id: h.id, ...h.data() })))
      setTypes(typesSnap.docs.map((t) => ({ id: t.id, ...t.data() })))
      setDocuments(docsSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setDocHistory(docHistSnap.docs.map((h) => ({ id: h.id, ...h.data() })))
    } catch (e) {
      console.error(e)
      setMessage(`読み込みエラー: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  const selectedType = useMemo(
    () => types.find((t) => t.id === (edit?.trainingTypeId || data?.trainingTypeId)),
    [types, edit?.trainingTypeId, data?.trainingTypeId],
  )

  async function saveEdit() {
    try {
      assertCan(canManageTraining, profile)
      if (!edit.attendeeName.trim()) {
        setMessage('受講者名は必須です')
        return
      }
      setBusy(true)
      const nextType = types.find((t) => t.id === edit.trainingTypeId)
      const payload = {
        attendeeName: edit.attendeeName.trim(),
        attendeeContact: edit.attendeeContact,
        attendeeAffiliation: edit.attendeeAffiliation,
        salonName: edit.salonName,
        salonRepresentativeName: edit.salonRepresentativeName,
        dealerCode: data.applicationType === 'dealer' ? edit.dealerCode : '',
        dealerName: data.applicationType === 'dealer' ? edit.dealerName : '',
        dealerPersonName: data.applicationType === 'dealer' ? edit.dealerPersonName : '',
        trainingTypeId: edit.trainingTypeId,
        trainingTypeCode: nextType?.code || '',
        trainingName: nextType?.name || data.trainingName || '',
        trainingScheduledDate: edit.trainingScheduledDate
          ? new Date(edit.trainingScheduledDate) : null,
        trainingCompletedDate: edit.trainingCompletedDate
          ? new Date(edit.trainingCompletedDate) : null,
        note: edit.note || '',
        updatedAt: serverTimestamp(),
        updatedBy: profile?.uid || null,
      }
      await updateDoc(doc(db, 'trainingApplications', id), payload)
      setMessage('更新しました')
      await load()
    } catch (e) {
      console.error(e)
      setMessage(`保存エラー: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function changeStatus(nextStatus, comment) {
    try {
      assertCan(canManageTraining, profile)
      if (!canTransition(data.status, nextStatus)) {
        setMessage(`この遷移は許可されていません: ${data.status} → ${nextStatus}`)
        return
      }
      // 代理店案件 & 発行系遷移のチェックは PR-2 で追加。PR-1 はステータス変更のみ。
      setBusy(true)
      const update = {
        status: nextStatus,
        updatedAt: serverTimestamp(),
        updatedBy: profile?.uid || null,
      }
      // 完了遷移の場合、完了日が空なら今日を自動セット
      if (nextStatus === TRAINING_STATUS.TRAINING_COMPLETED_WAITING_ISSUE
          && !data.trainingCompletedDate) {
        update.trainingCompletedDate = new Date()
      }
      await updateDoc(doc(db, 'trainingApplications', id), update)
      await addDoc(collection(db, 'trainingApplications', id, 'history'), {
        from: data.status,
        to: nextStatus,
        actorUid: profile?.uid || null,
        actorName: profile?.name || profile?.email || '',
        comment: comment || '',
        createdAt: serverTimestamp(),
      })
      setMessage(`ステータスを「${TRAINING_STATUS_LABEL[nextStatus]}」に変更しました`)
      await load()
    } catch (e) {
      console.error(e)
      setMessage(`遷移エラー: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function toggleDealerReportConfirmed() {
    try {
      assertCan(canManageTraining, profile)
      const next = !data.dealerReportConfirmed
      setBusy(true)
      await updateDoc(doc(db, 'trainingApplications', id), {
        dealerReportConfirmed: next,
        dealerReportConfirmedAt: next ? serverTimestamp() : null,
        updatedAt: serverTimestamp(),
        updatedBy: profile?.uid || null,
      })
      await addDoc(collection(db, 'trainingApplications', id, 'history'), {
        from: data.status,
        to: data.status,
        actorUid: profile?.uid || null,
        actorName: profile?.name || profile?.email || '',
        comment: next ? '代理店実施報告を確認済みに変更' : '代理店実施報告の確認を取り消し',
        createdAt: serverTimestamp(),
      })
      await load()
    } catch (e) {
      console.error(e)
      setMessage(`更新エラー: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function cancelOrRestore() {
    const toCancel = data.status !== 'cancelled'
    const next = toCancel ? 'cancelled' : 'application_received'
    const label = toCancel ? 'キャンセル' : 'キャンセル解除'
    if (!confirm(`この案件を${label}します。よろしいですか？`)) return
    const comment = toCancel ? '案件をキャンセル' : 'キャンセルを解除'
    await changeStatus(next, comment)
  }

  if (!canEdit) {
    return <div className="p-6 text-sm text-red-600">この画面の閲覧権限がありません。</div>
  }
  if (loading) return <div className="p-6 text-gray-400">読み込み中...</div>
  if (!data) {
    return (
      <div className="space-y-3 p-6">
        <div className="text-red-600">{message || '案件が見つかりません'}</div>
        <Link to="/admin/training-applications" className="text-sm text-indigo-600 hover:underline">
          ← 一覧に戻る
        </Link>
      </div>
    )
  }

  const transitions = getPr1Transitions(data.status)
  const isCancelled = data.status === 'cancelled'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/admin/training-applications" className="text-xs text-indigo-600 hover:underline">
            ← 研修案件一覧
          </Link>
          <h1 className="mt-1 text-2xl font-bold">
            {data.applicationNumber || id.slice(0, 8)}
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-gray-500">
            <span>{APPLICATION_TYPE_LABEL[data.applicationType] || '—'}</span>
            <span>/</span>
            <span>{data.trainingName || '—'}</span>
            <span>/</span>
            <span className={`rounded px-2 py-0.5 text-xs ${TRAINING_STATUS_COLOR[data.status] || 'bg-gray-100 text-gray-600'}`}>
              {TRAINING_STATUS_LABEL[data.status] || data.status}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {transitions.map((next) => (
            <button
              key={next}
              onClick={() => changeStatus(next)}
              disabled={busy}
              className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              → {TRAINING_STATUS_LABEL[next]}
            </button>
          ))}
          <button
            onClick={cancelOrRestore}
            disabled={busy}
            className={`rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 ${
              isCancelled
                ? 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                : 'border border-red-300 bg-white text-red-600 hover:bg-red-50'
            }`}
          >
            {isCancelled ? 'キャンセル解除' : 'キャンセル'}
          </button>
        </div>
      </div>

      {message && (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-bold text-gray-700">基本情報</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-xs text-gray-500">受講者名（必須）</span>
                <input
                  type="text"
                  value={edit.attendeeName}
                  onChange={(e) => setEdit({ ...edit, attendeeName: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-xs text-gray-500">連絡先</span>
                <input
                  type="text"
                  value={edit.attendeeContact}
                  onChange={(e) => setEdit({ ...edit, attendeeContact: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
              <label className="col-span-2 block text-sm">
                <span className="text-xs text-gray-500">所属</span>
                <input
                  type="text"
                  value={edit.attendeeAffiliation}
                  onChange={(e) => setEdit({ ...edit, attendeeAffiliation: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-xs text-gray-500">サロン名</span>
                <input
                  type="text"
                  value={edit.salonName}
                  onChange={(e) => setEdit({ ...edit, salonName: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-xs text-gray-500">代表者名</span>
                <input
                  type="text"
                  value={edit.salonRepresentativeName}
                  onChange={(e) => setEdit({ ...edit, salonRepresentativeName: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-bold text-gray-700">研修情報</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-xs text-gray-500">研修種別</span>
                <select
                  value={edit.trainingTypeId}
                  onChange={(e) => setEdit({ ...edit, trainingTypeId: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                >
                  <option value="">選択</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
              <div className="block text-sm">
                <span className="text-xs text-gray-500">発行対象</span>
                <div className="mt-1 rounded border border-gray-200 bg-gray-50 px-2 py-2 text-xs">
                  {selectedType ? (
                    <>
                      {selectedType.issueDiploma && <span className="mr-2 rounded bg-purple-100 px-2 py-0.5 text-purple-700">ディプロマ</span>}
                      {selectedType.issueCertifiedSalonAward && <span className="mr-2 rounded bg-amber-100 px-2 py-0.5 text-amber-700">認定サロン賞</span>}
                      {!selectedType.issueDiploma && !selectedType.issueCertifiedSalonAward && <span className="text-gray-400">—</span>}
                    </>
                  ) : <span className="text-gray-400">—</span>}
                </div>
              </div>
              <label className="block text-sm">
                <span className="text-xs text-gray-500">研修予定日</span>
                <input
                  type="date"
                  value={edit.trainingScheduledDate}
                  onChange={(e) => setEdit({ ...edit, trainingScheduledDate: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-xs text-gray-500">研修実施日</span>
                <input
                  type="date"
                  value={edit.trainingCompletedDate}
                  onChange={(e) => setEdit({ ...edit, trainingCompletedDate: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
              <label className="col-span-2 block text-sm">
                <span className="text-xs text-gray-500">備考</span>
                <textarea
                  value={edit.note}
                  onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                  rows={2}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
            </div>
          </section>

          {data.applicationType === 'dealer' && (
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-bold text-gray-700">代理店情報</h2>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="text-xs text-gray-500">代理店コード</span>
                  <input
                    type="text"
                    value={edit.dealerCode}
                    onChange={(e) => setEdit({ ...edit, dealerCode: e.target.value })}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-2 font-mono text-sm"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-xs text-gray-500">代理店名</span>
                  <input
                    type="text"
                    value={edit.dealerName}
                    onChange={(e) => setEdit({ ...edit, dealerName: e.target.value })}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                  />
                </label>
                <label className="col-span-2 block text-sm">
                  <span className="text-xs text-gray-500">代理店担当者名</span>
                  <input
                    type="text"
                    value={edit.dealerPersonName}
                    onChange={(e) => setEdit({ ...edit, dealerPersonName: e.target.value })}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                  />
                </label>
              </div>
              <div className="mt-3 flex items-center justify-between rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                <div>
                  <div className="font-semibold text-amber-800">代理店 実施報告の確認</div>
                  <div className="text-xs text-amber-700">
                    {data.dealerReportConfirmed
                      ? `確認済み（${fmtDateTime(data.dealerReportConfirmedAt)}）`
                      : '未確認（発行前に必ず確認してください）'}
                  </div>
                </div>
                <button
                  onClick={toggleDealerReportConfirmed}
                  disabled={busy}
                  className="rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {data.dealerReportConfirmed ? '未確認に戻す' : '確認済みにする'}
                </button>
              </div>
            </section>
          )}

          <div className="flex justify-end">
            <button
              onClick={saveEdit}
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              基本情報・研修情報を保存
            </button>
          </div>
        </div>

        <div className="space-y-4">
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-700">発行物</h2>
              <span className="text-[10px] text-gray-400">発行ボタンは PR-3 で実装予定</span>
            </div>
            {!selectedType && (
              <p className="mt-2 text-xs text-gray-400">研修種別が未選択です。</p>
            )}
            {selectedType && getAllDocumentTypesForTraining(selectedType).length === 0 && (
              <p className="mt-2 text-xs text-gray-400">この研修種別には発行対象がありません。</p>
            )}
            {selectedType && getAllDocumentTypesForTraining(selectedType).length > 0 && (
              <div className="mt-3 space-y-3">
                {getAllDocumentTypesForTraining(selectedType).map((docType) => {
                  const existing = documents.find((d) => d.documentType === docType)
                  const isIssued = existing?.status === DOCUMENT_STATUS.ISSUED || existing?.status === DOCUMENT_STATUS.REISSUED
                  const check = checkDocumentIssuable(data, docType)
                  return (
                    <div key={docType} className="rounded border border-gray-200 bg-gray-50 p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold text-gray-700">
                          {DOCUMENT_TYPE_LABEL[docType] || docType}
                        </div>
                        {isIssued ? (
                          <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-700">発行済み</span>
                        ) : (
                          <span className={`rounded px-2 py-0.5 text-[11px] ${check.ok ? 'bg-indigo-100 text-indigo-700' : 'bg-red-100 text-red-700'}`}>
                            {check.ok ? '発行準備OK' : '条件未充足'}
                          </span>
                        )}
                      </div>

                      {isIssued && (
                        <dl className="mt-2 space-y-1 text-xs text-gray-600">
                          <div className="flex justify-between">
                            <dt>発行番号</dt>
                            <dd className="font-mono text-gray-800">{existing.documentNumber || '—'}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>発行日時</dt>
                            <dd>{fmtDateTime(existing.issuedAt)}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>印刷回数</dt>
                            <dd>{existing.printCount ?? 0} 回</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>PDF</dt>
                            <dd>
                              {existing.pdfUrl ? (
                                <a href={existing.pdfUrl} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">開く</a>
                              ) : (
                                <span className="text-amber-600">未生成（PR-3 で生成）</span>
                              )}
                            </dd>
                          </div>
                        </dl>
                      )}

                      {!isIssued && !check.ok && (
                        <ul className="mt-2 list-disc pl-5 text-xs text-red-600">
                          {check.reasons.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      )}

                      {!isIssued && check.ok && (
                        <p className="mt-2 text-xs text-gray-600">
                          発行ボタン（PR-3 で配線）を押すと、番号が採番されて発行物レコードが作成されます。
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-bold text-gray-700">発行・再印刷履歴</h2>
            {docHistory.length === 0 ? (
              <div className="text-xs text-gray-400">発行・再印刷の履歴はまだありません。</div>
            ) : (
              <ul className="space-y-2">
                {docHistory.map((h) => (
                  <li key={h.id} className="border-l-2 border-purple-200 pl-2 text-xs text-gray-600">
                    <div className="text-gray-500">{fmtDateTime(h.createdAt)}</div>
                    <div>
                      <span className="font-semibold">
                        {h.action === DOCUMENT_HISTORY_ACTION.ISSUE && '発行'}
                        {h.action === DOCUMENT_HISTORY_ACTION.REISSUE && '再発行'}
                        {h.action === DOCUMENT_HISTORY_ACTION.REPRINT && '再印刷'}
                        {h.action === DOCUMENT_HISTORY_ACTION.PDF_ATTACH && 'PDF添付'}
                        {h.action === DOCUMENT_HISTORY_ACTION.PDF_FAIL && 'PDF失敗'}
                      </span>
                      {h.documentType && <span className="ml-1">{DOCUMENT_TYPE_LABEL[h.documentType] || h.documentType}</span>}
                      {h.documentNumber && <span className="ml-1 font-mono">{h.documentNumber}</span>}
                    </div>
                    {h.error && <div className="text-red-500">エラー: {h.error}</div>}
                    {h.actorName && <div className="text-[10px] text-gray-400">by {h.actorName}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-dashed border-gray-300 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-700">発送・受取</h2>
            <p className="mt-2 text-xs text-gray-500">
              PR-4 で実装予定。発送日 / 発送方法 / 追跡番号 / 受取確認日 を管理します。
            </p>
            <div className="mt-3 space-y-1 text-xs text-gray-600">
              <div>発送日: {fmtDateTime(data.shippedAt)}</div>
              <div>発送方法: {data.shippedMethod || '—'}</div>
              <div>追跡番号: {data.trackingNumber || '—'}</div>
              <div>受取日: {fmtDateTime(data.receivedAt)}</div>
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-bold text-gray-700">履歴ログ</h2>
            {history.length === 0 ? (
              <div className="text-xs text-gray-400">履歴はまだありません。</div>
            ) : (
              <ul className="space-y-2">
                {history.map((h) => (
                  <li key={h.id} className="border-l-2 border-indigo-200 pl-2 text-xs text-gray-600">
                    <div className="text-gray-500">{fmtDateTime(h.createdAt)}</div>
                    <div>
                      {h.from ? `${TRAINING_STATUS_LABEL[h.from] || h.from} → ` : ''}
                      <span className="font-semibold">
                        {TRAINING_STATUS_LABEL[h.to] || h.to || '—'}
                      </span>
                    </div>
                    {h.comment && <div className="text-gray-500">{h.comment}</div>}
                    {h.actorName && <div className="text-[10px] text-gray-400">by {h.actorName}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-bold text-gray-700">メタ情報</h2>
            <dl className="space-y-1 text-xs text-gray-600">
              <div className="flex justify-between"><dt>申込日</dt><dd>{fmtDate(data.applicationDate)}</dd></div>
              <div className="flex justify-between"><dt>作成</dt><dd>{fmtDateTime(data.createdAt)}</dd></div>
              <div className="flex justify-between"><dt>更新</dt><dd>{fmtDateTime(data.updatedAt)}</dd></div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  )
}
