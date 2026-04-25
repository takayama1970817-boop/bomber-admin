import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  collection, query, orderBy, limit, getDocs, where,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase.js'

const STATUS_BADGE = {
  queued:      { label: '送信中', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  in_progress: { label: '送信中', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  completed:   { label: '完了',   cls: 'bg-green-100 text-green-700 border-green-200' },
  failed:      { label: '失敗',   cls: 'bg-red-100 text-red-700 border-red-200' },
  unknown:     { label: '不明',   cls: 'bg-gray-100 text-gray-700 border-gray-200' },
}

const PURPOSE_OPTIONS = [
  { value: 'all', label: '全て' },
  { value: 'shipping_instruction', label: '発送指示書' },
  { value: 'partner_contact', label: '取引先連絡' },
  { value: 'warehouse_contact', label: '倉庫向け連絡' },
  { value: 'business_doc', label: '業務帳票' },
  { value: 'project_doc', label: '案件帳票' },
  { value: 'other', label: 'その他' },
]

const STATUS_OPTIONS = [
  { value: 'all', label: '全て' },
  { value: 'queued', label: '送信中' },
  { value: 'completed', label: '完了' },
  { value: 'failed', label: '失敗' },
]

const fmtDateTime = (t) => {
  if (!t) return '—'
  const d = t.toDate ? t.toDate() : new Date(t)
  return d.toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function FaxHistory() {
  const [jobs, setJobs] = useState([])
  const [logsByJob, setLogsByJob] = useState({})
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterPurpose, setFilterPurpose] = useState('all')
  const [searchText, setSearchText] = useState('')
  const [busyJobId, setBusyJobId] = useState('')
  const [expanded, setExpanded] = useState({})

  const load = async () => {
    setLoading(true)
    try {
      const snap = await getDocs(
        query(collection(db, 'faxJobs'), orderBy('createdAt', 'desc'), limit(200))
      )
      setJobs(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error('FAX履歴読み込みエラー:', e)
      alert('履歴の取得に失敗しました: ' + (e?.message || e?.code || ''))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    let list = jobs
    if (filterStatus !== 'all') list = list.filter((j) => j.status === filterStatus)
    if (filterPurpose !== 'all') list = list.filter((j) => j.purpose === filterPurpose)
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      list = list.filter((j) =>
        (j.fileName || '').toLowerCase().includes(q) ||
        (j.toNumber || '').toLowerCase().includes(q) ||
        (j.toNumberOriginal || '').toLowerCase().includes(q) ||
        (j.subject || '').toLowerCase().includes(q) ||
        (j.createdByEmail || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [jobs, filterStatus, filterPurpose, searchText])

  const loadLogs = async (jobId) => {
    if (logsByJob[jobId]) return
    try {
      const snap = await getDocs(
        query(
          collection(db, 'faxLogs'),
          where('jobId', '==', jobId),
          orderBy('attemptNo', 'desc'),
        )
      )
      setLogsByJob((prev) => ({
        ...prev,
        [jobId]: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
      }))
    } catch (e) {
      console.error('faxLogs取得失敗:', e)
    }
  }

  const toggleExpand = async (jobId) => {
    const next = !expanded[jobId]
    setExpanded((prev) => ({ ...prev, [jobId]: next }))
    if (next) await loadLogs(jobId)
  }

  const handleResend = async (job) => {
    const newTo = prompt(
      '送信先を変更する場合は新しいFAX番号を入力してください（同じ番号で再送する場合は空のままOK）',
      job.toNumberOriginal || ''
    )
    if (newTo === null) return // キャンセル
    if (!confirm(`「${job.fileName}」を ${newTo || job.toNumber} に再送します。よろしいですか？`)) return

    setBusyJobId(job.id)
    try {
      const fn = httpsCallable(functions, 'resendFax')
      const res = await fn({ jobId: job.id, ...(newTo ? { toNumber: newTo } : {}) })
      alert(`再送を受付けました（試行 ${res.data.attemptNo} 回目 / FAX ID: ${res.data.faxId}）`)
      await load()
      delete logsByJob[job.id]
      setLogsByJob({ ...logsByJob })
    } catch (e) {
      console.error('再送エラー:', e)
      alert('再送に失敗しました: ' + (e?.message || e?.code || ''))
    } finally {
      setBusyJobId('')
    }
  }

  const handleCheckStatus = async (job) => {
    if (!job.lastFaxId) {
      alert('FAX IDが未取得です（直近の送信が失敗している可能性があります）')
      return
    }
    setBusyJobId(job.id)
    try {
      const fn = httpsCallable(functions, 'checkFaxStatus')
      const res = await fn({
        faxId: job.lastFaxId,
        logId: job.lastLogId || null,
        jobId: job.id,
      })
      alert(`InterFAX ステータス: ${res.data.status} (code: ${res.data.data?.status ?? '-'})`)
      await load()
      delete logsByJob[job.id]
      setLogsByJob({ ...logsByJob })
    } catch (e) {
      console.error('ステータス取得エラー:', e)
      alert('ステータス取得に失敗しました: ' + (e?.message || e?.code || ''))
    } finally {
      setBusyJobId('')
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">📠 FAX送信履歴</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            🔄 更新
          </button>
          <Link
            to="/admin/fax/send"
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            + 新規送信
          </Link>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <div>
          <label className="mr-2 text-xs text-gray-600">状態</label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
          >
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="mr-2 text-xs text-gray-600">用途</label>
          <select
            value={filterPurpose}
            onChange={(e) => setFilterPurpose(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
          >
            {PURPOSE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-[180px]">
          <input
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="ファイル名・番号・件名・送信者で検索"
            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          読み込み中...
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          該当する送信履歴はありません
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">送信日時</th>
                <th className="px-3 py-2 text-left">用途</th>
                <th className="px-3 py-2 text-left">宛先</th>
                <th className="px-3 py-2 text-left">ファイル</th>
                <th className="px-3 py-2 text-center">試行</th>
                <th className="px-3 py-2 text-center">状態</th>
                <th className="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((j) => {
                const badge = STATUS_BADGE[j.status] || STATUS_BADGE.unknown
                const isOpen = !!expanded[j.id]
                const logs = logsByJob[j.id] || []
                return (
                  <Fragment key={j.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                        {fmtDateTime(j.createdAt)}
                      </td>
                      <td className="px-3 py-2 text-gray-700">{j.purposeLabel || j.purpose || '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                        {j.toNumberOriginal || j.toNumber}
                      </td>
                      <td className="px-3 py-2 text-gray-700">
                        <div className="font-medium">{j.fileName}</div>
                        {j.subject && <div className="text-xs text-gray-500">{j.subject}</div>}
                      </td>
                      <td className="px-3 py-2 text-center text-gray-700">{j.attemptCount || 0}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => toggleExpand(j.id)}
                            className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                          >
                            {isOpen ? '閉じる' : '詳細'}
                          </button>
                          <button
                            disabled={busyJobId === j.id || !j.lastFaxId}
                            onClick={() => handleCheckStatus(j)}
                            className="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100 disabled:opacity-40"
                          >
                            状態確認
                          </button>
                          <button
                            disabled={busyJobId === j.id}
                            onClick={() => handleResend(j)}
                            className="rounded border border-orange-300 bg-orange-50 px-2 py-1 text-xs text-orange-700 hover:bg-orange-100 disabled:opacity-40"
                          >
                            再送
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-gray-50">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="mb-2 grid grid-cols-2 gap-2 text-xs text-gray-700 md:grid-cols-4">
                            <div>送信者: {j.createdByEmail || '—'}</div>
                            <div>サイズ: {j.pdfSize ? (j.pdfSize / 1024).toFixed(1) + ' KB' : '—'}</div>
                            <div>最終FAX ID: {j.lastFaxId || '—'}</div>
                            <div>最終試行: {fmtDateTime(j.lastAttemptAt)}</div>
                          </div>
                          {j.notes && (
                            <div className="mb-2 rounded border border-gray-200 bg-white p-2 text-xs text-gray-600">
                              メモ: {j.notes}
                            </div>
                          )}
                          {j.lastError && (
                            <div className="mb-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                              直近エラー: {j.lastError}
                            </div>
                          )}
                          <div className="rounded border border-gray-200 bg-white">
                            <div className="border-b bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-600">
                              試行ログ
                            </div>
                            {logs.length === 0 ? (
                              <div className="px-3 py-2 text-xs text-gray-500">読み込み中...</div>
                            ) : (
                              <ul className="divide-y divide-gray-100">
                                {logs.map((l) => {
                                  const lb = STATUS_BADGE[l.status] || STATUS_BADGE.unknown
                                  return (
                                    <li key={l.id} className="px-3 py-2 text-xs">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-mono">#{l.attemptNo}</span>
                                        <span>{fmtDateTime(l.createdAt)}</span>
                                        <span className={`inline-block rounded-full border px-2 py-0.5 ${lb.cls}`}>
                                          {lb.label}
                                        </span>
                                        {l.interfaxFaxId && <span>FAX ID: {l.interfaxFaxId}</span>}
                                        {l.httpStatus && <span>HTTP {l.httpStatus}</span>}
                                        {l.isResend && <span className="text-orange-600">再送</span>}
                                      </div>
                                      {l.error && (
                                        <div className="mt-1 text-red-700">エラー: {l.error}</div>
                                      )}
                                      {l.responseBody && (
                                        <details className="mt-1">
                                          <summary className="cursor-pointer text-gray-500">レスポンス本文</summary>
                                          <pre className="mt-1 max-h-40 overflow-auto rounded bg-gray-100 p-2 text-[11px]">{l.responseBody}</pre>
                                        </details>
                                      )}
                                    </li>
                                  )
                                })}
                              </ul>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
