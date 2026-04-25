import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { Link } from 'react-router-dom'
import { functions } from '../lib/firebase.js'

const PURPOSE_OPTIONS = [
  { value: 'shipping_instruction', label: '発送指示書' },
  { value: 'partner_contact', label: '取引先連絡' },
  { value: 'warehouse_contact', label: '倉庫向け連絡' },
  { value: 'business_doc', label: '業務帳票' },
  { value: 'other', label: 'その他' },
]

const MAX_PDF_SIZE = 20 * 1024 * 1024 // 20MB

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result || ''
      const base64 = String(result).split(',').pop() || ''
      resolve(base64)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export default function FaxSend() {
  const [pdfFile, setPdfFile] = useState(null)
  const [toNumber, setToNumber] = useState('')
  const [purpose, setPurpose] = useState('shipping_instruction')
  const [subject, setSubject] = useState('')
  const [notes, setNotes] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const onPickFile = (e) => {
    const f = e.target.files?.[0]
    setError('')
    setResult(null)
    if (!f) {
      setPdfFile(null)
      return
    }
    if (f.type !== 'application/pdf') {
      setError('PDFファイルのみ送信できます')
      e.target.value = ''
      setPdfFile(null)
      return
    }
    if (f.size > MAX_PDF_SIZE) {
      setError('PDFサイズは20MBまでです')
      e.target.value = ''
      setPdfFile(null)
      return
    }
    setPdfFile(f)
  }

  const handleSend = async () => {
    setError('')
    setResult(null)
    if (!pdfFile) { setError('PDFを選択してください'); return }
    if (!toNumber.trim()) { setError('送信先FAX番号を入力してください'); return }

    setSending(true)
    try {
      const base64 = await readFileAsBase64(pdfFile)
      const fn = httpsCallable(functions, 'sendFax')
      const res = await fn({
        pdfBase64: base64,
        fileName: pdfFile.name,
        toNumber: toNumber.trim(),
        purpose,
        subject: subject.trim(),
        notes: notes.trim(),
      })
      setResult(res.data)
      setPdfFile(null)
      setSubject('')
      setNotes('')
      const fileInput = document.getElementById('fax-pdf-input')
      if (fileInput) fileInput.value = ''
    } catch (e) {
      console.error('FAX送信エラー:', e)
      setError(e?.message || e?.code || 'FAX送信に失敗しました')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">📠 FAX送信</h1>
        <Link
          to="/admin/fax/history"
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          送信履歴 →
        </Link>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            送信先FAX番号 <span className="text-red-500">*</span>
          </label>
          <input
            type="tel"
            value={toNumber}
            onChange={(e) => setToNumber(e.target.value)}
            placeholder="例: 03-6332-9691"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            国内番号は自動で +81 形式に変換されます
          </p>
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            用途
          </label>
          <select
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {PURPOSE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            件名（任意）
          </label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="例: 4月分発送指示書"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            メモ（任意）
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="社内メモ。FAX本文には含まれません。"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="mb-6">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            PDFファイル <span className="text-red-500">*</span>
          </label>
          <input
            id="fax-pdf-input"
            type="file"
            accept="application/pdf"
            onChange={onPickFile}
            className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
          />
          {pdfFile && (
            <p className="mt-2 text-xs text-gray-600">
              {pdfFile.name}（{(pdfFile.size / 1024).toFixed(1)} KB）
            </p>
          )}
          <p className="mt-1 text-xs text-gray-500">
            PDFのみ・20MBまで
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {result && (
          <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            送信を受付けました（FAX ID: {result.faxId} / Job: {result.jobId}）。
            <Link to="/admin/fax/history" className="ml-2 underline">履歴で状況確認</Link>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={handleSend}
            disabled={sending || !pdfFile || !toNumber.trim()}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {sending ? '送信中...' : '📠 FAX送信'}
          </button>
        </div>
      </div>

      <div className="mt-6 rounded-lg bg-yellow-50 p-4 text-xs text-yellow-800">
        InterFAX 経由でFAX送信されます。送信単価はInterFAX契約に従います。
      </div>
    </div>
  )
}
