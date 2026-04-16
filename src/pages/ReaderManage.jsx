import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc,
  serverTimestamp, writeBatch,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { fetchAllCustomers } from '../lib/bcartApi.js'

function safeCsv(v) {
  const s = String(v ?? '').replace(/"/g, '""')
  return /^[+=\-@]/.test(s) ? `"'${s}"` : `"${s}"`
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return { headers: [], rows: [] }
  const parseRow = (line) => {
    const result = []; let current = ''; let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuote) { if (ch === '"' && line[i + 1] === '"') { current += '"'; i++ } else if (ch === '"') inQuote = false; else current += ch }
      else { if (ch === '"') inQuote = true; else if (ch === ',') { result.push(current.trim()); current = '' } else current += ch }
    }
    result.push(current.trim()); return result
  }
  return { headers: parseRow(lines[0]), rows: lines.slice(1).map(parseRow) }
}

const SEGMENT_OPTIONS = [
  { key: 'all', label: 'すべて' },
  { key: 'salon', label: 'サロン' },
  { key: 'dealer', label: '代理店' },
  { key: 'active', label: 'アクティブ' },
  { key: 'unsubscribed', label: '解除済み' },
  { key: 'blacklist', label: 'ブラックリスト' },
]

export default function ReaderManage() {
  const { isAdmin } = useAuth()
  const [readers, setReaders] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [segment, setSegment] = useState('all')
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [bcartFetching, setBcartFetching] = useState(false)
  const [bcartProgress, setBcartProgress] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const snap = await getDocs(collection(db, 'nl_readers'))
      setReaders(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setSelected(new Set())
    } catch (e) { console.error('読者データ読み込みエラー:', e) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    let list = readers
    if (segment === 'active') list = list.filter((r) => r.status === 'active')
    else if (segment === 'unsubscribed') list = list.filter((r) => r.status === 'unsubscribed')
    else if (segment === 'blacklist') list = list.filter((r) => r.status === 'blacklist')
    else if (segment === 'salon') list = list.filter((r) => r.type === 'salon')
    else if (segment === 'dealer') list = list.filter((r) => r.type === 'dealer')
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((r) =>
        (r.email || '').toLowerCase().includes(q) ||
        (r.name || '').toLowerCase().includes(q) ||
        (r.company || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [readers, segment, search])

  const counts = useMemo(() => ({
    all: readers.length,
    active: readers.filter((r) => r.status === 'active').length,
    salon: readers.filter((r) => r.type === 'salon').length,
    dealer: readers.filter((r) => r.type === 'dealer').length,
    unsubscribed: readers.filter((r) => r.status === 'unsubscribed').length,
    blacklist: readers.filter((r) => r.status === 'blacklist').length,
  }), [readers])

  // 選択トグル
  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set())
    else setSelected(new Set(filtered.map((r) => r.id)))
  }

  // 選択削除
  const handleDeleteSelected = async () => {
    if (selected.size === 0) return
    if (!confirm(`選択した ${selected.size}件 を削除しますか？\n\nこの操作は元に戻せません。`)) return
    setDeleting(true)
    try {
      const batch = writeBatch(db)
      selected.forEach((id) => batch.delete(doc(db, 'nl_readers', id)))
      await batch.commit()
      setReaders((prev) => prev.filter((r) => !selected.has(r.id)))
      setSelected(new Set())
    } catch (e) { alert('削除に失敗しました: ' + e.message) }
    finally { setDeleting(false) }
  }

  // 一括全削除
  const handleDeleteAll = async () => {
    if (readers.length === 0) return
    const input = prompt(`全 ${readers.length}件 を削除します。\n確認のため「全削除」と入力してください。`)
    if (input !== '全削除') { if (input !== null) alert('入力が一致しません'); return }
    setDeleting(true)
    try {
      // writeBatchは500件制限があるので分割
      for (let i = 0; i < readers.length; i += 400) {
        const batch = writeBatch(db)
        readers.slice(i, i + 400).forEach((r) => batch.delete(doc(db, 'nl_readers', r.id)))
        await batch.commit()
      }
      setReaders([])
      setSelected(new Set())
    } catch (e) { alert('一括削除に失敗しました: ' + e.message) }
    finally { setDeleting(false) }
  }

  // 単体削除
  const handleDelete = async (reader) => {
    if (!confirm(`「${reader.email}」を削除しますか？`)) return
    await deleteDoc(doc(db, 'nl_readers', reader.id))
    setReaders((prev) => prev.filter((r) => r.id !== reader.id))
    setSelected((prev) => { const next = new Set(prev); next.delete(reader.id); return next })
  }

  // BカートAPI取得
  const handleBcartFetch = async () => {
    setBcartFetching(true)
    setBcartProgress('会員データを取得中...')
    try {
      const customers = await fetchAllCustomers((fetched, total) => {
        setBcartProgress(`会員データ取得中... ${fetched}/${total}件`)
      })
      if (customers.length === 0) { alert('Bカートに会員データがありません'); return }

      console.log('Bカート会員サンプル:', JSON.stringify(customers[0], null, 2))

      const existingEmails = new Set(readers.map((r) => (r.email || '').toLowerCase()))
      let added = 0, skipped = 0

      // writeBatchは500件制限
      const chunks = []
      let currentBatch = []
      for (const c of customers) {
        const email = (c.email || c.customer_email || c.mail || '').trim().toLowerCase()
        if (!email || existingEmails.has(email)) { skipped++; continue }

        // Bカート APIフィールド名（実機確認済み）
        const lastName = c.tanto_last_name || c.name1 || c.customer_name1 || ''
        const firstName = c.tanto_first_name || c.name2 || c.customer_name2 || ''
        const fullName = (lastName + ' ' + firstName).trim() || c.name || c.customer_name || ''
        const compName = c.comp_name || c.customer_comp_name || c.company_name || ''
        const parentId = c.customer_parent_id || c.parent_id || ''

        currentBatch.push({
          email, name: fullName, company: compName,
          tel: c.tel || c.phone || '',
          type: 'salon', // Bカート会員は基本サロン
          bcartId: c.id || c.customer_id || '',
          parentId,
          status: 'active', source: 'bcart',
          // 同意記録（特定電子メール法）
          consentedAt: serverTimestamp(),
          consentMethod: 'bcart_import',
          consentSource: 'Bカート会員データ（既存取引先）',
          consentNote: `BカートID: ${c.id || c.customer_id || '不明'}`,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        })
        existingEmails.add(email)
        added++
        if (currentBatch.length >= 400) { chunks.push(currentBatch); currentBatch = [] }
      }
      if (currentBatch.length > 0) chunks.push(currentBatch)

      for (const chunk of chunks) {
        const batch = writeBatch(db)
        chunk.forEach((data) => batch.set(doc(collection(db, 'nl_readers')), data))
        await batch.commit()
      }

      setBcartProgress('')
      setImportMsg(`Bカートから${added}件追加 / ${skipped}件スキップ（既存）`)
      load()
    } catch (e) {
      console.error('Bカート取得エラー:', e)
      alert('Bカート取得に失敗しました: ' + e.message)
    } finally { setBcartFetching(false) }
  }

  // CSVインポート
  const handleCsvImport = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setImporting(true); setImportMsg('')
    try {
      const text = await file.text()
      const { headers, rows } = parseCsv(text)
      const emailIdx = headers.findIndex((h) => /メール|email/i.test(h))
      const nameIdx = headers.findIndex((h) => /名前|name|氏名/i.test(h))
      const companyIdx = headers.findIndex((h) => /会社|company|社名/i.test(h))
      const typeIdx = headers.findIndex((h) => /種別|type|タイプ/i.test(h))
      if (emailIdx < 0) { alert('「メール」または「email」カラムが必要です'); return }

      const existingEmails = new Set(readers.map((r) => (r.email || '').toLowerCase()))
      const batch = writeBatch(db)
      let added = 0
      for (const row of rows) {
        const email = (row[emailIdx] || '').trim().toLowerCase()
        if (!email || existingEmails.has(email)) continue
        batch.set(doc(collection(db, 'nl_readers')), {
          email,
          name: nameIdx >= 0 ? (row[nameIdx] || '') : '',
          company: companyIdx >= 0 ? (row[companyIdx] || '') : '',
          type: typeIdx >= 0 ? (row[typeIdx] || 'salon') : 'salon',
          status: 'active', source: 'csv',
          // 同意記録
          consentedAt: serverTimestamp(),
          consentMethod: 'csv_import',
          consentSource: `CSVファイル: ${file.name}`,
          consentNote: '管理者によるCSV一括登録',
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        })
        existingEmails.add(email); added++
      }
      if (added > 0) await batch.commit()
      setImportMsg(`CSVから${added}件追加`)
      load()
    } catch (err) { alert('CSVインポート失敗: ' + err.message) }
    finally { setImporting(false) }
  }

  const fmtDate = (ts) => {
    if (!ts) return ''
    const d = ts.toDate ? ts.toDate() : new Date(ts)
    return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  }

  const handleExport = () => {
    const BOM = '\uFEFF'
    const headers = ['メール', '名前', '会社名', '種別', 'ステータス', 'ソース', '同意日時', '同意方法', '同意経路', '備考']
    const rows = filtered.map((r) => [
      r.email, r.name, r.company, r.type, r.status, r.source,
      fmtDate(r.consentedAt), r.consentMethod || '', r.consentSource || '', r.consentNote || '',
    ].map(safeCsv))
    const csv = BOM + [headers.map(safeCsv).join(','), ...rows.map((r) => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `読者一覧_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  const handleDownloadTemplate = () => {
    const BOM = '\uFEFF'
    const headers = ['メール', '名前', '会社名', '種別']
    const sample = ['sample@example.com', '山田 太郎', '〇〇サロン', 'salon']
    const csv = BOM + [headers.map(safeCsv).join(','), sample.map(safeCsv).join(',')].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = '読者CSV_ひな形.csv'
    a.click()
  }

  const handleStatusChange = async (reader, newStatus) => {
    await updateDoc(doc(db, 'nl_readers', reader.id), { status: newStatus, updatedAt: serverTimestamp() })
    setReaders((prev) => prev.map((r) => r.id === reader.id ? { ...r, status: newStatus } : r))
  }

  const handleCreate = async (data) => {
    const ref = await addDoc(collection(db, 'nl_readers'), {
      ...data, status: 'active', source: 'manual',
      // 同意記録
      consentedAt: serverTimestamp(),
      consentMethod: 'manual_entry',
      consentSource: '管理画面（手動追加）',
      consentNote: '管理者が手動で登録',
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    })
    setReaders((prev) => [{ id: ref.id, ...data, status: 'active', source: 'manual' }, ...prev])
  }

  if (!isAdmin) {
    return <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">管理者のみ使用可能です</div>
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">読者管理</h1>
        <p className="mt-1 text-sm text-gray-500">メルマガ配信先の読者データを管理</p>
      </div>

      {/* サマリー */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
          <div className="text-xs text-gray-500">全読者</div>
          <div className="mt-1 text-2xl font-bold">{counts.all}件</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
          <div className="text-xs text-gray-500">アクティブ</div>
          <div className="mt-1 text-2xl font-bold text-green-600">{counts.active}件</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
          <div className="text-xs text-gray-500">サロン</div>
          <div className="mt-1 text-2xl font-bold text-blue-600">{counts.salon}件</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
          <div className="text-xs text-gray-500">代理店</div>
          <div className="mt-1 text-2xl font-bold text-orange-600">{counts.dealer}件</div>
        </div>
      </div>

      {/* セグメントフィルタ */}
      <div className="mb-4 flex flex-wrap gap-1">
        {SEGMENT_OPTIONS.map((s) => (
          <button key={s.key} onClick={() => setSegment(s.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              segment === s.key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>
            {s.label} ({counts[s.key] || 0})
          </button>
        ))}
      </div>

      {/* ツールバー */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="メール・名前・会社名で検索..."
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />

        <button onClick={() => setShowCreate(true)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          + 手動追加
        </button>

        <button onClick={handleBcartFetch} disabled={bcartFetching}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {bcartFetching ? '取得中...' : '🛒 Bカートから取得'}
        </button>

        <div className="ml-auto flex gap-2">
          <button onClick={handleDownloadTemplate}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50">
            📥 CSVひな形
          </button>
          <label className={`cursor-pointer rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 ${importing ? 'opacity-50' : ''}`}>
            📤 CSV取込
            <input type="file" accept=".csv" onChange={handleCsvImport} disabled={importing} className="hidden" />
          </label>
          <button onClick={handleExport} disabled={filtered.length === 0}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40">
            💾 CSVエクスポート
          </button>
        </div>
      </div>

      {/* 選択操作バー */}
      {(selected.size > 0 || readers.length > 0) && (
        <div className="mb-3 flex items-center gap-3 rounded-lg bg-gray-50 px-4 py-2">
          {selected.size > 0 ? (
            <>
              <span className="text-sm font-medium text-gray-700">{selected.size}件 選択中</span>
              <button onClick={handleDeleteSelected} disabled={deleting}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50">
                {deleting ? '削除中...' : `🗑 選択した${selected.size}件を削除`}
              </button>
              <button onClick={() => setSelected(new Set())}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100">
                選択解除
              </button>
            </>
          ) : (
            <span className="text-xs text-gray-400">チェックボックスで選択して一括操作</span>
          )}
          <button onClick={handleDeleteAll} disabled={deleting || readers.length === 0}
            className="ml-auto rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 disabled:opacity-40">
            ⚠ 全件削除
          </button>
        </div>
      )}

      {/* 進捗 */}
      {bcartProgress && <div className="mb-4 rounded-lg bg-blue-50 px-4 py-2 text-sm text-blue-700">{bcartProgress}</div>}
      {importMsg && <div className="mb-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700">✓ {importMsg}</div>}

      {/* テーブル */}
      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
          {readers.length === 0 ? '読者がいません。Bカートから取得またはCSV取込をしてください。' : '条件に一致する読者がいません'}
        </div>
      ) : (
        <div className="overflow-auto rounded-xl border border-gray-200 bg-white" style={{ maxHeight: 'calc(100vh - 480px)' }}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="px-2 py-2 w-8">
                  <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0}
                    onChange={toggleAll} className="rounded" />
                </th>
                <th className="px-3 py-2">メール</th>
                <th className="px-3 py-2">名前</th>
                <th className="px-3 py-2">会社名</th>
                <th className="px-3 py-2">種別</th>
                <th className="px-3 py-2">ステータス</th>
                <th className="px-3 py-2">ソース</th>
                <th className="px-3 py-2">同意日時</th>
                <th className="px-3 py-2">同意方法</th>
                <th className="px-3 py-2 w-16"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className={`border-b border-gray-50 hover:bg-gray-50 ${selected.has(r.id) ? 'bg-indigo-50' : ''}`}>
                  <td className="px-2 py-2">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} className="rounded" />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-900">{r.email}</td>
                  <td className="px-3 py-2 text-gray-700">{r.name || '—'}</td>
                  <td className="px-3 py-2 text-gray-700">{r.company || '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                      r.type === 'dealer' ? 'bg-orange-50 text-orange-700' : 'bg-blue-50 text-blue-700'
                    }`}>{r.type === 'dealer' ? '代理店' : 'サロン'}</span>
                  </td>
                  <td className="px-3 py-2">
                    <select value={r.status || 'active'}
                      onChange={(e) => handleStatusChange(r, e.target.value)}
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        r.status === 'active' ? 'bg-green-50 text-green-700'
                        : r.status === 'unsubscribed' ? 'bg-gray-100 text-gray-500'
                        : 'bg-red-50 text-red-700'
                      }`}>
                      <option value="active">アクティブ</option>
                      <option value="unsubscribed">解除済み</option>
                      <option value="blacklist">ブラックリスト</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-400">{r.source || '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{fmtDate(r.consentedAt) || '—'}</td>
                  <td className="px-3 py-2">
                    {r.consentMethod && (
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        r.consentMethod === 'web_form' ? 'bg-green-50 text-green-700'
                        : r.consentMethod === 'bcart_import' ? 'bg-blue-50 text-blue-700'
                        : r.consentMethod === 'csv_import' ? 'bg-purple-50 text-purple-700'
                        : 'bg-gray-100 text-gray-600'
                      }`}>
                        {r.consentMethod === 'web_form' ? 'フォーム登録'
                        : r.consentMethod === 'bcart_import' ? 'Bカート'
                        : r.consentMethod === 'csv_import' ? 'CSV'
                        : r.consentMethod === 'manual_entry' ? '手動'
                        : r.consentMethod}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => handleDelete(r)}
                      className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50">削除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-gray-100 bg-gray-50 px-3 py-1.5 text-xs text-gray-400">
            {filtered.length === readers.length ? `${readers.length}件` : `${filtered.length} / ${readers.length}件`}
          </div>
        </div>
      )}

      {showCreate && (
        <CreateReaderModal onClose={() => setShowCreate(false)}
          onSave={(data) => { handleCreate(data); setShowCreate(false) }} />
      )}
    </div>
  )
}

function CreateReaderModal({ onClose, onSave }) {
  const [form, setForm] = useState({ email: '', name: '', company: '', type: 'salon' })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-2xl bg-white p-6">
        <h3 className="mb-4 text-lg font-bold text-gray-900">読者を追加</h3>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">メールアドレス *</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">名前</label>
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">会社名</label>
            <input type="text" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">種別</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="salon">サロン</option>
              <option value="dealer">代理店</option>
            </select>
          </div>
        </div>
        <div className="mt-5 flex gap-3">
          <button onClick={onClose}
            className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button onClick={() => { if (!form.email.trim()) { alert('メールアドレスは必須です'); return }; onSave(form) }}
            className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700">追加</button>
        </div>
      </div>
    </div>
  )
}
