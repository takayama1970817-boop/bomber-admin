import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc,
  serverTimestamp, writeBatch,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useCompany, CompanySwitcher } from '../contexts/CompanyContext.jsx'

// ── タブ定義（collectionはcompany.keyをプレフィックスに使う） ──
const TAB_DEFS = [
  { key: 'clients',      label: '取引先',   icon: '🏢', suffix: 'bp_clients' },
  { key: 'products',     label: '商品',     icon: '📦', suffix: 'bp_products' },
  { key: 'suppliers',    label: '仕入れ先', icon: '🏭', suffix: 'bp_suppliers' },
  { key: 'destinations', label: '納品先',   icon: '📍', suffix: 'bp_destinations' },
]

// ── 各タブのフィールド定義 ──
const FIELDS = {
  clients: [
    { key: 'code',     label: 'コード',   type: 'text', required: true },
    { key: 'name',     label: '取引先名', type: 'text', required: true },
    { key: 'category', label: 'カテゴリ', type: 'category' },
    { key: 'person',   label: '担当者',   type: 'text' },
    { key: 'zipCode',  label: '郵便番号', type: 'text' },
    { key: 'address',  label: '住所',     type: 'text' },
    { key: 'tel',      label: 'TEL',      type: 'text' },
    { key: 'fax',      label: 'FAX',      type: 'text' },
    { key: 'email',    label: 'メール',   type: 'text' },
    { key: 'notes',    label: '備考',     type: 'text' },
  ],
  products: [
    { key: 'code',         label: '品番',     type: 'text', required: true },
    { key: 'name',         label: '商品名',   type: 'text', required: true },
    { key: 'category',     label: 'カテゴリ', type: 'category' },
    { key: 'unit',         label: '単位',     type: 'text', placeholder: '個' },
    { key: 'sellingPrice', label: '販売単価', type: 'number' },
    { key: 'costPrice',    label: '原価',     type: 'number' },
    { key: 'notes',        label: '備考',     type: 'text' },
  ],
  suppliers: [
    { key: 'code',     label: 'コード',     type: 'text', required: true },
    { key: 'name',     label: '仕入れ先名', type: 'text', required: true },
    { key: 'category', label: 'カテゴリ',   type: 'category' },
    { key: 'person',   label: '担当者',     type: 'text' },
    { key: 'zipCode',  label: '郵便番号',   type: 'text' },
    { key: 'address',  label: '住所',       type: 'text' },
    { key: 'tel',      label: 'TEL',        type: 'text' },
    { key: 'fax',      label: 'FAX',        type: 'text' },
    { key: 'email',    label: 'メール',     type: 'text' },
    { key: 'notes',    label: '備考',       type: 'text' },
  ],
  destinations: [
    { key: 'code',     label: 'コード',   type: 'text', required: true },
    { key: 'name',     label: '納品先名', type: 'text', required: true },
    { key: 'category', label: 'カテゴリ', type: 'category' },
    { key: 'person',   label: '担当者',   type: 'text' },
    { key: 'zipCode',  label: '郵便番号', type: 'text' },
    { key: 'address',  label: '住所',     type: 'text' },
    { key: 'tel',      label: 'TEL',      type: 'text' },
    { key: 'notes',    label: '備考',     type: 'text' },
  ],
}

// ── CSV安全化 ──
function safeCsv(v) {
  const s = String(v ?? '').replace(/"/g, '""')
  return /^[+=\-@]/.test(s) ? `"'${s}"` : `"${s}"`
}

// ── CSVパース ──
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return { headers: [], rows: [] }
  const parseRow = (line) => {
    const result = []
    let current = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++ }
        else if (ch === '"') inQuote = false
        else current += ch
      } else {
        if (ch === '"') inQuote = true
        else if (ch === ',') { result.push(current.trim()); current = '' }
        else current += ch
      }
    }
    result.push(current.trim())
    return result
  }
  const headers = parseRow(lines[0])
  const rows = lines.slice(1).map(parseRow)
  return { headers, rows }
}

// ── テーブルコンポーネント ──
function DataTable({ items, fields, onEdit, onDelete, search, filterCategory }) {
  const filtered = useMemo(() => {
    let list = items
    if (filterCategory) list = list.filter((it) => (it.category || '') === filterCategory)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((it) =>
        fields.some((f) => String(it[f.key] || '').toLowerCase().includes(q))
      )
    }
    return list
  }, [items, fields, search, filterCategory])

  if (filtered.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
        {items.length === 0 ? 'データがありません。新規追加またはCSV取込をしてください。' : '検索条件に一致するデータがありません'}
      </div>
    )
  }

  // 表示するカラム（備考以外の主要フィールド、最大6列）
  const displayFields = fields.filter((f) => f.key !== 'notes').slice(0, 6)

  return (
    <div className="overflow-auto rounded-xl border border-gray-200 bg-white" style={{ maxHeight: 'calc(100vh - 420px)' }}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-gray-50">
          <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
            {displayFields.map((f) => (
              <th key={f.key} className="px-3 py-2">{f.label}</th>
            ))}
            <th className="px-3 py-2 w-20"></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((item) => (
            <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50">
              {displayFields.map((f) => (
                <td key={f.key} className="px-3 py-2 text-gray-900">
                  {f.type === 'number' ? Number(item[f.key] || 0).toLocaleString()
                    : f.type === 'category' ? (item[f.key] ? <span className="inline-block rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">{item[f.key]}</span> : '—')
                    : (item[f.key] || '—')}
                </td>
              ))}
              <td className="px-3 py-2">
                <div className="flex gap-1">
                  <button onClick={() => onEdit(item)}
                    className="rounded px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50">編集</button>
                  <button onClick={() => onDelete(item)}
                    className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50">削除</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-gray-100 bg-gray-50 px-3 py-1.5 text-xs text-gray-400">
        {filtered.length === items.length ? `${items.length}件` : `${filtered.length} / ${items.length}件`}
      </div>
    </div>
  )
}

// ── 編集モーダル ──
function EditModal({ isOpen, onClose, onSave, item, fields, title, categories }) {
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (isOpen) {
      const init = {}
      fields.forEach((f) => { init[f.key] = item?.[f.key] ?? '' })
      setForm(init)
    }
  }, [isOpen, item, fields])

  const handleSave = async () => {
    const missing = fields.filter((f) => f.required && !String(form[f.key] || '').trim())
    if (missing.length > 0) {
      alert(`${missing.map((f) => f.label).join('、')} は必須です`)
      return
    }
    setSaving(true)
    try {
      // 数値フィールドを変換
      const data = { ...form }
      fields.forEach((f) => {
        if (f.type === 'number') data[f.key] = parseFloat(data[f.key]) || 0
      })
      await onSave(data)
      onClose()
    } catch (e) {
      alert('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-lg rounded-2xl bg-white p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="mb-4 text-lg font-bold text-gray-900">{title}</h3>
        <div className="space-y-3">
          {fields.map((f) => (
            <div key={f.key}>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                {f.label} {f.required && <span className="text-red-500">*</span>}
              </label>
              {f.type === 'category' ? (
                <div>
                  <input
                    type="text" list={`dl_${f.key}`}
                    value={form[f.key] ?? ''}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    placeholder="選択または入力..."
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                  <datalist id={`dl_${f.key}`}>
                    {(categories || []).map((c) => <option key={c} value={c} />)}
                  </datalist>
                  {categories && categories.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {categories.map((c) => (
                        <button key={c} type="button"
                          onClick={() => setForm({ ...form, [f.key]: c })}
                          className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                            form[f.key] === c
                              ? 'bg-indigo-600 text-white'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}>
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <input
                  type={f.type === 'number' ? 'number' : 'text'}
                  value={form[f.key] ?? ''}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  placeholder={f.placeholder || ''}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                />
              )}
            </div>
          ))}
        </div>
        <div className="mt-5 flex gap-3">
          <button onClick={onClose}
            className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm text-gray-600 hover:bg-gray-50">
            キャンセル
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── メインページ ──
export default function BpMaster() {
  const { isAdmin } = useAuth()
  const { company } = useCompany()
  const [activeTab, setActiveTab] = useState('clients')
  const [data, setData] = useState({ clients: [], products: [], suppliers: [], destinations: [] })
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [editItem, setEditItem] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')

  // 会社別コレクション名を生成 (例: rt_bp_clients, rc_bp_clients)
  const TABS = useMemo(() =>
    TAB_DEFS.map((t) => ({ ...t, collection: `${company.key}_${t.suffix}` })),
    [company.key]
  )

  const tab = TABS.find((t) => t.key === activeTab)
  const fields = FIELDS[activeTab]
  const items = data[activeTab] || []

  // 現在タブのカテゴリ一覧を抽出
  const categories = useMemo(() => {
    const set = new Set()
    items.forEach((it) => { if (it.category) set.add(it.category) })
    return [...set].sort()
  }, [items])

  // ── データ読み込み ──
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const results = {}
      await Promise.all(
        TABS.map(async (t) => {
          const snap = await getDocs(collection(db, t.collection))
          results[t.key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        })
      )
      setData(results)
    } catch (e) {
      console.error('BPマスタ読み込みエラー:', e)
    } finally {
      setLoading(false)
    }
  }, [TABS])

  useEffect(() => { load() }, [load])

  // ── 新規追加 ──
  const handleCreate = async (formData) => {
    const ref = await addDoc(collection(db, tab.collection), {
      ...formData,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    setData((prev) => ({
      ...prev,
      [activeTab]: [{ id: ref.id, ...formData }, ...prev[activeTab]],
    }))
  }

  // ── 更新 ──
  const handleUpdate = async (formData) => {
    await updateDoc(doc(db, tab.collection, editItem.id), {
      ...formData,
      updatedAt: serverTimestamp(),
    })
    setData((prev) => ({
      ...prev,
      [activeTab]: prev[activeTab].map((it) =>
        it.id === editItem.id ? { ...it, ...formData } : it
      ),
    }))
  }

  // ── 削除 ──
  const handleDelete = async (item) => {
    if (!confirm(`「${item.name || item.code}」を削除しますか？`)) return
    await deleteDoc(doc(db, tab.collection, item.id))
    setData((prev) => ({
      ...prev,
      [activeTab]: prev[activeTab].filter((it) => it.id !== item.id),
    }))
  }

  // ── CSVエクスポート ──
  const handleExport = () => {
    const BOM = '\uFEFF'
    const headers = fields.map((f) => f.label)
    const rows = items.map((item) => fields.map((f) => safeCsv(item[f.key])))
    const csv = BOM + [headers.map(safeCsv).join(','), ...rows.map((r) => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `BP_${tab.label}_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── CSVひな形ダウンロード ──
  const handleDownloadTemplate = () => {
    const BOM = '\uFEFF'
    const headers = fields.map((f) => f.label)
    // サンプル行
    const sample = fields.map((f) => {
      if (f.key === 'code') return 'C001'
      if (f.key === 'name') return 'サンプル'
      if (f.type === 'number') return '1000'
      return ''
    })
    const csv = BOM + [headers.map(safeCsv).join(','), sample.map(safeCsv).join(',')].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `BP_${tab.label}_ひな形.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── CSVインポート ──
  const handleImport = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    setImporting(true)
    setImportMsg('')
    try {
      const text = await file.text()
      const { headers, rows } = parseCsv(text)

      if (rows.length === 0) { alert('データ行がありません'); return }

      // ヘッダーとフィールドのマッピング
      const fieldMap = {}
      fields.forEach((f) => {
        const idx = headers.findIndex((h) => h === f.label || h === f.key)
        if (idx >= 0) fieldMap[f.key] = idx
      })

      if (Object.keys(fieldMap).length === 0) {
        alert('CSVのヘッダーがBPマスタの項目と一致しません')
        return
      }

      const batch = writeBatch(db)
      let count = 0
      for (const row of rows) {
        const data = {}
        fields.forEach((f) => {
          const idx = fieldMap[f.key]
          if (idx != null && idx < row.length) {
            let val = row[idx]
            // 先頭のシングルクォート除去（CSV安全化の逆変換）
            if (val.startsWith("'")) val = val.substring(1)
            data[f.key] = f.type === 'number' ? (parseFloat(val) || 0) : val
          }
        })
        if (!data.code && !data.name) continue // 空行スキップ

        const ref = doc(collection(db, tab.collection))
        batch.set(ref, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
        count++
      }

      if (count === 0) { alert('有効なデータ行がありません'); return }

      await batch.commit()
      setImportMsg(`${count}件をインポートしました`)
      load()
    } catch (err) {
      console.error('CSVインポートエラー:', err)
      alert('インポートに失敗しました: ' + err.message)
    } finally {
      setImporting(false)
    }
  }

  if (!isAdmin) {
    return <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">この画面は管理者のみ使用できます</div>
  }

  return (
    <div className="max-w-6xl">
      {/* 会社切替 */}
      <div className="mb-4 w-72">
        <CompanySwitcher />
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">BPマスタ</h1>
        <p className="mt-1 text-sm text-gray-500">
          <span className={`font-bold ${company.text}`}>{company.name}</span> — 取引先・商品・仕入れ先・納品先のマスタデータを管理
        </p>
      </div>

      {/* タブ */}
      <div className="mb-4 flex gap-1 rounded-xl border border-gray-200 bg-gray-100 p-1">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => { setActiveTab(t.key); setSearch(''); setFilterCategory('') }}
            className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === t.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}>
            {t.icon} {t.label}
            <span className="ml-1 text-xs text-gray-400">({(data[t.key] || []).length})</span>
          </button>
        ))}
      </div>

      {/* カテゴリフィルタ */}
      {categories.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-gray-500">カテゴリ:</span>
          <button onClick={() => setFilterCategory('')}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              !filterCategory ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>
            すべて
          </button>
          {categories.map((c) => (
            <button key={c} onClick={() => setFilterCategory(filterCategory === c ? '' : c)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                filterCategory === c ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
              }`}>
              {c} ({items.filter((it) => it.category === c).length})
            </button>
          ))}
        </div>
      )}

      {/* ツールバー */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={`${tab.label}を検索...`}
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />

        <button onClick={() => { setEditItem(null); setShowCreate(true) }}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          + 新規追加
        </button>

        <div className="ml-auto flex gap-2">
          <button onClick={handleDownloadTemplate}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50">
            📥 CSVひな形
          </button>
          <label className={`cursor-pointer rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 ${importing ? 'opacity-50' : ''}`}>
            📤 CSV取込
            <input type="file" accept=".csv" onChange={handleImport} disabled={importing} className="hidden" />
          </label>
          <button onClick={handleExport} disabled={items.length === 0}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40">
            💾 CSVエクスポート
          </button>
        </div>
      </div>

      {importMsg && (
        <div className="mb-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700">
          ✓ {importMsg}
        </div>
      )}

      {/* データテーブル */}
      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">読み込み中...</div>
      ) : (
        <DataTable
          items={items}
          fields={fields}
          search={search}
          filterCategory={filterCategory}
          onEdit={(item) => { setEditItem(item); setShowCreate(false) }}
          onDelete={handleDelete}
        />
      )}

      {/* 新規作成モーダル */}
      <EditModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onSave={handleCreate}
        item={null}
        fields={fields}
        categories={categories}
        title={`${tab.label}を新規追加`}
      />

      {/* 編集モーダル */}
      <EditModal
        isOpen={!!editItem}
        onClose={() => setEditItem(null)}
        onSave={handleUpdate}
        item={editItem}
        fields={fields}
        categories={categories}
        title={`${tab.label}を編集`}
      />
    </div>
  )
}
