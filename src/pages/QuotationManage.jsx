import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  collection,
  doc,
  getDocs,
  addDoc,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
  getDoc,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { calcTax, taxRowLabel } from '../lib/taxCalc.js'
import { buildDocLayout, openPrintPreview } from '../lib/docGenerator.js'

// ── ステータス定義 ──
const STATUSES = [
  { key: 'draft', label: '下書き', bg: 'bg-gray-100', text: 'text-gray-700' },
  { key: 'sent', label: '送付済', bg: 'bg-blue-100', text: 'text-blue-700' },
  { key: 'accepted', label: '成約', bg: 'bg-green-100', text: 'text-green-700' },
  { key: 'rejected', label: '失注', bg: 'bg-red-100', text: 'text-red-700' },
  { key: 'expired', label: '期限切れ', bg: 'bg-yellow-100', text: 'text-yellow-700' },
]

const STATUS_MAP = Object.fromEntries(STATUSES.map((s) => [s.key, s]))

const statusOf = (quotation) => {
  const s = quotation.status || 'draft'
  return STATUS_MAP[s] || STATUS_MAP.draft
}

const fmtDate = (t) => {
  if (!t) return '—'
  const d = t.toDate ? t.toDate() : new Date(t)
  return d.toLocaleDateString('ja-JP')
}

const fmtYen = (n) => `¥${(n ?? 0).toLocaleString('ja-JP')}`

// ── サマリーカード ──
function Stat({ label, value, hint, color }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color || 'text-gray-900'}`}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-gray-400">{hint}</div>}
    </div>
  )
}

// ── 見積番号の自動生成 ──
const generateQuoteNo = (existingNos) => {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const datePrefix = `Q-${yyyy}${mm}${dd}`

  // その日付のQuoteNoで既に何件あるか数える
  const matchingNos = existingNos.filter((no) => no.startsWith(datePrefix))
  const nextNum = matchingNos.length + 1
  const nnnStr = String(nextNum).padStart(3, '0')

  return `${datePrefix}-${nnnStr}`
}

// ── 新規作成モーダル ──
function CreateModal({ isOpen, onClose, onSave, taxRate, taxRounding, existingNos }) {
  const [formData, setFormData] = useState({
    customerName: '',
    customerPerson: '',
    customerEmail: '',
    customerAddress: '',
    quoteDate: new Date().toISOString().slice(0, 10),
    validUntil: '',
    notes: '',
    items: [{ name: '', code: '', qty: '', unitPrice: '' }],
  })

  const [saving, setSaving] = useState(false)

  const handleItemChange = (idx, field, value) => {
    setFormData((prev) => {
      const items = [...prev.items]
      items[idx] = { ...items[idx], [field]: value }
      return { ...prev, items }
    })
  }

  const addItem = () => {
    setFormData((prev) => ({
      ...prev,
      items: [...prev.items, { name: '', code: '', qty: '', unitPrice: '' }],
    }))
  }

  const removeItem = (idx) => {
    setFormData((prev) => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== idx),
    }))
  }

  const handleInputChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  // 金額計算
  const items = formData.items.map((it) => ({
    ...it,
    amount: (parseFloat(it.qty) || 0) * (parseFloat(it.unitPrice) || 0),
  }))
  const subtotal = items.reduce((sum, it) => sum + (it.amount || 0), 0)
  const tax = calcTax(subtotal, taxRate, taxRounding)
  const total = subtotal + tax

  const handleSave = async () => {
    if (!formData.customerName.trim()) {
      alert('取引先名を入力してください')
      return
    }
    if (items.length === 0 || items.some((it) => !it.name || !it.qty || !it.unitPrice)) {
      alert('すべての明細行を入力してください')
      return
    }
    if (!formData.validUntil) {
      alert('有効期限を入力してください')
      return
    }

    setSaving(true)
    try {
      await onSave({
        ...formData,
        items,
        subtotal,
        tax,
        total,
      })
      // フォームリセット
      setFormData({
        customerName: '',
        customerPerson: '',
        customerEmail: '',
        customerAddress: '',
        quoteDate: new Date().toISOString().slice(0, 10),
        validUntil: '',
        notes: '',
        items: [{ name: '', code: '', qty: '', unitPrice: '' }],
      })
      onClose()
    } catch (e) {
      console.error('保存エラー:', e)
      alert('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="max-h-screen w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-900">見積書を新規作成</h2>

        {/* ── 取引先情報 ── */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-gray-700">取引先名 *</label>
            <input
              type="text"
              value={formData.customerName}
              onChange={(e) => handleInputChange('customerName', e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              placeholder="サロン名"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700">担当者</label>
            <input
              type="text"
              value={formData.customerPerson}
              onChange={(e) => handleInputChange('customerPerson', e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              placeholder="担当者名"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700">メールアドレス</label>
            <input
              type="email"
              value={formData.customerEmail}
              onChange={(e) => handleInputChange('customerEmail', e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              placeholder="email@example.com"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700">住所</label>
            <input
              type="text"
              value={formData.customerAddress}
              onChange={(e) => handleInputChange('customerAddress', e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              placeholder="住所"
            />
          </div>
        </div>

        {/* ── 見積日・有効期限 ── */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-gray-700">見積日</label>
            <input
              type="date"
              value={formData.quoteDate}
              onChange={(e) => handleInputChange('quoteDate', e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700">有効期限 *</label>
            <input
              type="date"
              value={formData.validUntil}
              onChange={(e) => handleInputChange('validUntil', e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        {/* ── 明細行 ── */}
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-900">商品明細</h3>
            <button
              onClick={addItem}
              className="rounded-lg bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700"
            >
              + 行を追加
            </button>
          </div>

          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-left text-gray-500">
                <tr>
                  <th className="px-3 py-2">商品名</th>
                  <th className="px-3 py-2">品番</th>
                  <th className="px-3 py-2 text-right">数量</th>
                  <th className="px-3 py-2 text-right">単価</th>
                  <th className="px-3 py-2 text-right">小計</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {formData.items.map((it, i) => {
                  const amount = (parseFloat(it.qty) || 0) * (parseFloat(it.unitPrice) || 0)
                  return (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={it.name}
                          onChange={(e) => handleItemChange(i, 'name', e.target.value)}
                          className="w-full rounded border border-gray-200 px-2 py-1 focus:border-indigo-400 focus:outline-none"
                          placeholder="商品名"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={it.code}
                          onChange={(e) => handleItemChange(i, 'code', e.target.value)}
                          className="w-full rounded border border-gray-200 px-2 py-1 focus:border-indigo-400 focus:outline-none"
                          placeholder="品番"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          value={it.qty}
                          onChange={(e) => handleItemChange(i, 'qty', e.target.value)}
                          className="w-full text-right"
                          placeholder="0"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          value={it.unitPrice}
                          onChange={(e) => handleItemChange(i, 'unitPrice', e.target.value)}
                          className="w-full text-right"
                          placeholder="0"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-gray-900">
                        {fmtYen(amount)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => removeItem(i)}
                          className="text-red-600 hover:text-red-700"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 金額サマリー ── */}
        <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="text-gray-600">商品小計</div>
            <div className="text-right font-medium text-gray-900">{fmtYen(subtotal)}</div>
            <div className="text-gray-600">{taxRowLabel(taxRate)}</div>
            <div className="text-right font-medium text-gray-900">{fmtYen(tax)}</div>
            <div className="font-bold text-gray-900">合計（税込）</div>
            <div className="text-right text-lg font-bold text-gray-900">{fmtYen(total)}</div>
          </div>
        </div>

        {/* ── 備考 ── */}
        <div className="mb-6">
          <label className="block text-xs font-medium text-gray-700">備考</label>
          <textarea
            value={formData.notes}
            onChange={(e) => handleInputChange('notes', e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            placeholder="特記事項など"
            rows="3"
          />
        </div>

        {/* ── ボタン ── */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function QuotationManage() {
  const { isAdmin } = useAuth()

  const [quotations, setQuotations] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [filterStatus, setFilterStatus] = useState('all')
  const [searchText, setSearchText] = useState('')
  const [updatingId, setUpdatingId] = useState(null)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkUpdating, setBulkUpdating] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [convertingId, setConvertingId] = useState(null)
  const [companyInfo, setCompanyInfo] = useState({})
  const [stampDataUrl, setStampDataUrl] = useState('')

  // 税率設定（CLAUDE.md参照）
  const taxRate = 0.1
  const taxRounding = 'round' // 'round', 'floor', 'ceil'

  // ── データ読み込み ──
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [quoteSnap, compDoc, stampDoc] = await Promise.all([
        getDocs(query(collection(db, 'quotations'), orderBy('quoteDate', 'desc'))),
        getDoc(doc(db, 'settings', 'company')),
        getDoc(doc(db, 'settings', 'rt_companyStamp')),
      ])
      setQuotations(quoteSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      if (compDoc.exists()) setCompanyInfo(compDoc.data())
      if (stampDoc.exists() && stampDoc.data().dataUrl) {
        setStampDataUrl(stampDoc.data().dataUrl)
      } else {
        const oldStamp = await getDoc(doc(db, 'settings', 'companyStamp'))
        if (oldStamp.exists() && oldStamp.data().dataUrl) setStampDataUrl(oldStamp.data().dataUrl)
      }
    } catch (e) {
      console.error('見積データ読み込みエラー:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // ── フィルタ・検索 ──
  const filtered = useMemo(() => {
    let list = quotations

    // ステータスフィルタ
    if (filterStatus !== 'all') {
      list = list.filter((q) => (q.status || 'draft') === filterStatus)
    }

    // テキスト検索
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      list = list.filter((q) => {
        const customerName = (q.customerName || '').toLowerCase()
        const quoteNo = (q.quoteNo || '').toLowerCase()
        return customerName.includes(q) || quoteNo.includes(q)
      })
    }

    return list
  }, [quotations, filterStatus, searchText])

  // ── 集計 ──
  const stats = useMemo(() => {
    const now = new Date()
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    let draftCount = 0
    let monthCount = 0
    let monthTotal = 0

    quotations.forEach((q) => {
      if (!q.status || q.status === 'draft') draftCount++

      const d = q.quoteDate?.toDate ? q.quoteDate.toDate() : q.quoteDate ? new Date(q.quoteDate) : null
      if (d) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        if (key === thisMonth) {
          monthCount++
          monthTotal += q.total || 0
        }
      }
    })

    return { draftCount, monthCount, monthTotal }
  }, [quotations])

  // ── ステータス変更 ──
  const handleStatusChange = async (quotationId, newStatus) => {
    setUpdatingId(quotationId)
    try {
      await updateDoc(doc(db, 'quotations', quotationId), {
        status: newStatus,
        updatedAt: serverTimestamp(),
      })
      setQuotations((prev) =>
        prev.map((q) =>
          q.id === quotationId ? { ...q, status: newStatus } : q,
        ),
      )
    } catch (e) {
      console.error('ステータス更新エラー:', e)
      alert('ステータスの更新に失敗しました')
    } finally {
      setUpdatingId(null)
    }
  }

  // ── チェックボックス操作 ──
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map((q) => q.id)))
    }
  }

  // ── 一括ステータス変更 ──
  const handleBulkStatusChange = async (newStatus) => {
    if (selectedIds.size === 0) return
    setBulkUpdating(true)
    try {
      const batch = writeBatch(db)
      selectedIds.forEach((id) => {
        batch.update(doc(db, 'quotations', id), {
          status: newStatus,
          updatedAt: serverTimestamp(),
        })
      })
      await batch.commit()

      setQuotations((prev) =>
        prev.map((q) =>
          selectedIds.has(q.id) ? { ...q, status: newStatus } : q,
        ),
      )
      setSelectedIds(new Set())
    } catch (e) {
      console.error('一括更新エラー:', e)
      alert('一括更新に失敗しました')
    } finally {
      setBulkUpdating(false)
    }
  }

  // ── ステータスタブの件数 ──
  const statusCounts = useMemo(() => {
    const counts = { all: quotations.length }
    STATUSES.forEach((s) => {
      counts[s.key] = quotations.filter((q) => (q.status || 'draft') === s.key).length
    })
    return counts
  }, [quotations])

  // ── 新規作成 ──
  const handleCreateQuotation = async (formData) => {
    try {
      const existingNos = quotations.map((q) => q.quoteNo).filter(Boolean)
      const quoteNo = generateQuoteNo(existingNos)

      // quoteDate と validUntil を timestamp に変換
      const quoteDate = new Date(formData.quoteDate)
      const validUntil = new Date(formData.validUntil)

      const newQuotation = {
        quoteNo,
        customerName: formData.customerName,
        customerPerson: formData.customerPerson,
        customerEmail: formData.customerEmail,
        customerAddress: formData.customerAddress,
        status: 'draft',
        quoteDate: quoteDate,
        validUntil: validUntil,
        items: formData.items,
        subtotal: formData.subtotal,
        tax: formData.tax,
        total: formData.total,
        notes: formData.notes,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }

      const docRef = await addDoc(collection(db, 'quotations'), newQuotation)
      setQuotations((prev) => [
        { id: docRef.id, ...newQuotation },
        ...prev,
      ])
      alert('見積書を作成しました')
    } catch (e) {
      console.error('見積作成エラー:', e)
      alert('見積書の作成に失敗しました')
    }
  }

  // ── PDF見積書印刷 ──
  const handlePrintQuotation = async (quotation) => {
    try {
      const itemRows = (quotation.items || []).map((it) => [
        it.name || it.productName || '',
        String(it.qty || it.quantity || 0),
        `¥${(it.unitPrice || it.price || 0).toLocaleString()}`,
        `¥${(it.amount || ((it.qty || 0) * (it.unitPrice || 0))).toLocaleString()}`,
      ])
      const layout = buildDocLayout({
        title: '見 積 書',
        docNoLabel: '見積番号',
        docNo: quotation.quoteNo,
        date: quotation.quoteDate?.toDate?.() || new Date(quotation.quoteDate),
        customerName: quotation.customerName,
        customerPerson: quotation.customerPerson,
        customerAddress: quotation.customerAddress,
        subject: '',
        greeting: '下記の通りお見積り申し上げます。',
        totalLabel: 'お見積金額',
        subtotal: quotation.subtotal,
        taxSettings: { taxRate: String(taxRate * 100), taxRounding },
        company: companyInfo,
        stampDataUrl,
        colHeaders: ['品名', '数量', '単価', '金額'],
        itemRows,
        noteText: quotation.notes,
      })
      openPrintPreview('見積書', layout)
    } catch (e) {
      console.error('PDF生成エラー:', e)
      alert('PDF生成に失敗しました')
    }
  }

  // ── 見積→受注変換 ──
  const handleConvertToOrder = async (quotation) => {
    if (!window.confirm('この見積を受注に変換しますか？')) return

    setConvertingId(quotation.id)
    try {
      const batch = writeBatch(db)

      // 新規ordersドキュメント作成
      const orderRef = doc(collection(db, 'orders'))
      batch.set(orderRef, {
        companyName: quotation.customerName,
        contact: quotation.customerPerson,
        email: quotation.customerEmail,
        address: quotation.customerAddress,
        items: quotation.items.map((it) => ({
          name: it.name,
          sku: it.code,
          qty: it.qty,
          price: it.unitPrice,
        })),
        subtotal: quotation.subtotal,
        tax: quotation.tax,
        total: quotation.total,
        source: 'quotation',
        status: 'new',
        orderDate: serverTimestamp(),
        createdAt: serverTimestamp(),
      })

      // 見積をacceptedに更新
      batch.update(doc(db, 'quotations', quotation.id), {
        status: 'accepted',
        updatedAt: serverTimestamp(),
      })

      await batch.commit()

      setQuotations((prev) =>
        prev.map((q) =>
          q.id === quotation.id ? { ...q, status: 'accepted' } : q,
        ),
      )
      alert('見積を受注に変換しました')
    } catch (e) {
      console.error('変換エラー:', e)
      alert('受注への変換に失敗しました')
    } finally {
      setConvertingId(null)
    }
  }

  if (!isAdmin) {
    return (
      <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
        この画面は管理者のみ使用できます
      </div>
    )
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">見積書管理</h1>
        <button
          onClick={() => setModalOpen(true)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          + 見積書を作成
        </button>
      </div>

      {/* ── サマリー ── */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          label="下書き中"
          value={`${stats.draftCount}件`}
          color={stats.draftCount > 0 ? 'text-orange-600' : 'text-gray-900'}
        />
        <Stat label="今月の見積" value={`${stats.monthCount}件`} />
        <Stat label="今月の見積金額" value={fmtYen(stats.monthTotal)} />
      </div>

      {/* ── ステータスタブ ── */}
      <div className="mb-4 flex flex-wrap gap-1">
        <button
          onClick={() => setFilterStatus('all')}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            filterStatus === 'all'
              ? 'bg-gray-900 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          すべて ({statusCounts.all})
        </button>
        {STATUSES.map((s) => (
          <button
            key={s.key}
            onClick={() => setFilterStatus(s.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              filterStatus === s.key
                ? `${s.bg} ${s.text}`
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s.label} ({statusCounts[s.key] || 0})
          </button>
        ))}
      </div>

      {/* ── 検索 ── */}
      <div className="mb-4">
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="取引先名・見積番号で検索..."
          className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        />
      </div>

      {/* ── 一括操作バー ── */}
      {selectedIds.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3">
          <span className="text-sm font-bold text-indigo-900">
            {selectedIds.size}件選択中
          </span>
          <span className="text-xs text-indigo-600">→ 一括でステータスを変更:</span>
          {STATUSES.map((s) => (
            <button
              key={s.key}
              onClick={() => handleBulkStatusChange(s.key)}
              disabled={bulkUpdating}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${s.bg} ${s.text} hover:opacity-80 disabled:opacity-50`}
            >
              {s.label}
            </button>
          ))}
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
          >
            選択解除
          </button>
        </div>
      )}

      {/* ── 見積一覧テーブル ── */}
      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
          {quotations.length === 0
            ? '見積書データがありません'
            : '条件に一致する見積書がありません'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && selectedIds.size === filtered.length}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </th>
                  <th className="px-4 py-3">ステータス</th>
                  <th className="px-4 py-3">見積番号</th>
                  <th className="px-4 py-3">取引先名</th>
                  <th className="px-4 py-3 text-right">合計金額</th>
                  <th className="px-4 py-3">見積日</th>
                  <th className="px-4 py-3">有効期限</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((q) => {
                  const st = statusOf(q)
                  const isOpen = expandedId === q.id

                  return (
                    <Fragment key={q.id}>
                      <tr
                        className={`cursor-pointer border-t border-gray-100 hover:bg-gray-50 ${selectedIds.has(q.id) ? 'bg-indigo-50' : ''}`}
                        onClick={() => setExpandedId(isOpen ? null : q.id)}
                      >
                        {/* チェックボックス */}
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(q.id)}
                            onChange={() => toggleSelect(q.id)}
                            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                          />
                        </td>

                        {/* ステータス */}
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <select
                            value={q.status || 'draft'}
                            onChange={(e) => handleStatusChange(q.id, e.target.value)}
                            disabled={updatingId === q.id}
                            className={`rounded-lg border-0 px-2 py-1 text-xs font-medium ${st.bg} ${st.text} focus:outline-none focus:ring-2 focus:ring-indigo-300`}
                          >
                            {STATUSES.map((s) => (
                              <option key={s.key} value={s.key}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        </td>

                        {/* 見積番号 */}
                        <td className="px-4 py-3 font-mono text-xs text-gray-600">
                          {q.quoteNo}
                        </td>

                        {/* 取引先名 */}
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {q.customerName}
                        </td>

                        {/* 合計金額 */}
                        <td className="px-4 py-3 text-right font-bold">
                          {fmtYen(q.total)}
                        </td>

                        {/* 見積日 */}
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {fmtDate(q.quoteDate)}
                        </td>

                        {/* 有効期限 */}
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {fmtDate(q.validUntil)}
                        </td>

                        {/* 展開 */}
                        <td className="px-4 py-3 text-right text-gray-400">
                          {isOpen ? '▲' : '▼'}
                        </td>
                      </tr>

                      {/* ── 展開: 詳細 ── */}
                      {isOpen && (
                        <tr className="bg-gray-50">
                          <td colSpan={8} className="px-4 py-4">
                            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">

                              {/* ── 商品明細テーブル ── */}
                              <div className="lg:col-span-2">
                                <h4 className="mb-2 text-xs font-bold text-gray-600">商品明細</h4>
                                {(q.items ?? []).length > 0 ? (
                                  <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                                    <table className="w-full text-xs">
                                      <thead className="bg-gray-100 text-left text-gray-500">
                                        <tr>
                                          <th className="px-3 py-2">商品名</th>
                                          <th className="px-3 py-2">品番</th>
                                          <th className="px-3 py-2 text-right">単価</th>
                                          <th className="px-3 py-2 text-right">数量</th>
                                          <th className="px-3 py-2 text-right">小計</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {q.items.map((it, i) => (
                                          <tr key={i} className="border-t border-gray-100">
                                            <td className="px-3 py-2 text-gray-900">
                                              {it.name}
                                            </td>
                                            <td className="px-3 py-2 font-mono text-gray-400">
                                              {it.code || '—'}
                                            </td>
                                            <td className="px-3 py-2 text-right text-gray-700">
                                              {fmtYen(it.unitPrice)}
                                            </td>
                                            <td className="px-3 py-2 text-right text-gray-700">
                                              {it.qty}
                                            </td>
                                            <td className="px-3 py-2 text-right font-medium text-gray-900">
                                              {fmtYen((it.qty ?? 0) * (it.unitPrice ?? 0))}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <div className="rounded-lg border border-dashed border-gray-300 py-6 text-center text-xs text-gray-400">
                                    明細データなし
                                  </div>
                                )}

                                {q.notes && (
                                  <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
                                    備考: {q.notes}
                                  </div>
                                )}
                              </div>

                              {/* ── 見積情報・操作 ── */}
                              <div>
                                <h4 className="mb-2 text-xs font-bold text-gray-600">見積情報</h4>
                                <div className="rounded-lg border border-gray-200 bg-white">
                                  <table className="w-full text-xs">
                                    <tbody className="divide-y divide-gray-100">
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">見積番号</td>
                                        <td className="px-3 py-2 text-right font-mono text-gray-900">{q.quoteNo}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">見積日</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtDate(q.quoteDate)}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">有効期限</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtDate(q.validUntil)}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">取引先</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{q.customerName}</td>
                                      </tr>
                                      {q.customerPerson && (
                                        <tr>
                                          <td className="px-3 py-2 text-gray-500">担当者</td>
                                          <td className="px-3 py-2 text-right text-gray-900">{q.customerPerson}</td>
                                        </tr>
                                      )}
                                      <tr className="bg-gray-50">
                                        <td className="px-3 py-2 text-gray-500">商品小計</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtYen(q.subtotal)}</td>
                                      </tr>
                                      <tr className="bg-gray-50">
                                        <td className="px-3 py-2 text-gray-500">消費税</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtYen(q.tax)}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 font-bold text-gray-900">合計（税込）</td>
                                        <td className="px-3 py-2 text-right text-base font-bold text-gray-900">{fmtYen(q.total)}</td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </div>

                                {/* 操作ボタン */}
                                <div className="mt-3 space-y-2">
                                  <button
                                    onClick={() => handlePrintQuotation(q)}
                                    className="w-full rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700"
                                  >
                                    PDF見積書を印刷
                                  </button>
                                  {(q.status === 'sent' || q.status === 'draft') && (
                                    <button
                                      onClick={() => handleConvertToOrder(q)}
                                      disabled={convertingId === q.id}
                                      className="w-full rounded-lg bg-green-600 px-3 py-2 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                                    >
                                      {convertingId === q.id ? '変換中...' : '受注に変換'}
                                    </button>
                                  )}
                                </div>
                              </div>
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

          {/* 件数表示 */}
          <div className="border-t border-gray-100 bg-gray-50 px-4 py-2 text-xs text-gray-500">
            {filtered.length === quotations.length
              ? `全 ${quotations.length} 件`
              : `${filtered.length} / ${quotations.length} 件表示`}
          </div>
        </div>
      )}

      {/* ── 新規作成モーダル ── */}
      <CreateModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleCreateQuotation}
        taxRate={taxRate}
        taxRounding={taxRounding}
        existingNos={quotations.map((q) => q.quoteNo).filter(Boolean)}
      />
    </div>
  )
}
