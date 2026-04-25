import React, { useEffect, useState } from 'react'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import InvoiceSendModal from '../components/InvoiceSendModal.jsx'

// 請求書メール送信履歴。invoiceEmailLogs を一覧表示し、
// failed エントリは「再送」ボタンから InvoiceSendModal を開いて再送できる。

function fmtDateTime(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  if (isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtYen(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString() + '円'
}

const STATUS_BADGE = {
  success: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
}

const STATUS_LABEL = {
  success: '成功',
  failed: '失敗',
}

export default function InvoiceEmailHistory() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all') // all | success | failed
  const [retryTarget, setRetryTarget] = useState(null) // { invoice, log }
  const [retryLoading, setRetryLoading] = useState(false)
  const [retryError, setRetryError] = useState('')

  const loadLogs = async () => {
    setLoading(true)
    try {
      const constraints = [orderBy('sentAt', 'desc'), limit(200)]
      if (filter !== 'all') {
        constraints.unshift(where('status', '==', filter))
      }
      const snap = await getDocs(query(collection(db, 'invoiceEmailLogs'), ...constraints))
      setLogs(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error('履歴取得失敗:', e)
      alert('送信履歴の取得に失敗: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadLogs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  const handleRetry = async (log) => {
    setRetryError('')
    setRetryLoading(true)
    try {
      const invSnap = await getDoc(doc(db, 'invoices', log.invoiceId))
      if (!invSnap.exists()) {
        setRetryError(`元の請求書 invoices/${log.invoiceId} が見つかりません（削除された可能性）`)
        setRetryLoading(false)
        return
      }
      setRetryTarget({
        invoice: { id: invSnap.id, ...invSnap.data() },
        log,
      })
    } catch (e) {
      console.error('再送準備失敗:', e)
      setRetryError('再送準備に失敗: ' + e.message)
    } finally {
      setRetryLoading(false)
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">請求書メール送信履歴</h1>
          <p className="mt-1 text-sm text-gray-500">SendGrid 経由の送信記録（最新200件）</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="all">すべて</option>
            <option value="success">成功のみ</option>
            <option value="failed">失敗のみ</option>
          </select>
          <button
            onClick={loadLogs}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            再読込
          </button>
        </div>
      </div>

      {retryError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {retryError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">読み込み中…</div>
      ) : logs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          {filter === 'all'
            ? 'まだ送信履歴がありません'
            : `${STATUS_LABEL[filter] || filter} の履歴がありません`}
        </div>
      ) : (
        <div className="space-y-3">
          {logs.map((log) => (
            <div key={log.id} className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-3">
                    <span className={`rounded-full px-3 py-0.5 text-xs font-medium ${STATUS_BADGE[log.status] || 'bg-gray-100 text-gray-600'}`}>
                      {STATUS_LABEL[log.status] || log.status}
                    </span>
                    <span className="text-sm font-bold text-gray-900">
                      {log.month?.replace('-', '年') + '月'}
                    </span>
                    <span className="text-sm text-gray-600">
                      {log.dealerName || log.dealerCode}
                    </span>
                    {log.retryOfLogId && (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700">再送</span>
                    )}
                  </div>

                  <div className="text-xs text-gray-500">
                    送信日時: {fmtDateTime(log.sentAt)}
                    宛先: <span className="font-mono">{log.to}</span>
                    {log.cc && <> ／ Cc: <span className="font-mono">{log.cc}</span></>}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    送信者: {log.sentByEmail || log.sentBy}
                    請求金額: {fmtYen(log.grandTotal)}
                    添付: {log.pdfFileName}
                  </div>

                  <div className="mt-2 truncate text-xs text-gray-700">
                    件名: <span className="font-medium">{log.subject}</span>
                  </div>

                  {log.status === 'failed' && log.error && (
                    <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
                      エラー: {log.error}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  {log.status === 'failed' && (
                    <button
                      onClick={() => handleRetry(log)}
                      disabled={retryLoading}
                      className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      {retryLoading ? '準備中…' : '再送'}
                    </button>
                  )}
                  {log.providerStatusCode && (
                    <span className="text-xs text-gray-400">HTTP {log.providerStatusCode}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {retryTarget && (
        <InvoiceSendModal
          invoice={retryTarget.invoice}
          retryFromLog={retryTarget.log}
          onClose={() => setRetryTarget(null)}
          onSent={() => {
            setRetryTarget(null)
            loadLogs()
          }}
        />
      )}
    </div>
  )
}
