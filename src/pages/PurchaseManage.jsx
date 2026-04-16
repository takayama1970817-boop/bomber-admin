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
  { key: 'pending', label: '下書き', bg: 'bg-gray-100', text: 'text-gray-700' },
  { key: 'confirmed', label: '発注済', bg: 'bg-blue-100', text: 'text-blue-700' },
  { key: 'producing', label: '製造中', bg: 'bg-yellow-100', text: 'text-yellow-700' },
  { key: 'shipped', label: '出荷済', bg: 'bg-indigo-100', text: 'text-indigo-700' },
  { key: 'received', label: '検収済', bg: 'bg-green-100', text: 'text-green-700' },
  { key: 'cancelled', label: 'キャンセル', bg: 'bg-red-100', text: 'text-red-700' },
]

const STATUS_MAP = Object.fromEntries(STATUSES.map((s) => [s.key, s]))

const statusOf = (purchase) => {
  const s = purchase.status || 'pending'
  return STATUS_MAP[s] || STATUS_MAP.pending
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

// ── 発注番号の自動生成 ──
const generatePoNo = (existingNos) => {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const datePrefix = `PO-${yyyy}${mm}${dd}`

  // その日付のPoNoで既に何件あるか数える
  const matchingNos = existingNos.filter((no) => no.startsWith(datePrefix))
  const nextNum = matchingNos.length + 1
  const nnnStr = String(nextNum).padStart(3, '0')

  return `${datePrefix}-${nnnStr}`
}

// ── 新規作成モーダル ──
function CreateModal({ isOpen, onClose, onSave, taxRate, taxRounding }) {
  const [formData, setFormData] = useState({
    factoryName: '',
    factoryPerson: '',
    factoryEmail: '',
    factoryAddress: '',
    orderDate: new Date().toISOString().slice(0, 10),
    deliveryDate: '',
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
    if (!formData.factoryName.trim()) {
      alert('仕入先名を入力してください')
      return
    }
    if (items.length === 0 || items.some((it) => !it.name || !it.qty || !it.unitPrice)) {
      alert('すべての明細行を入力してください')
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
        factoryName: '',
        factoryPerson: '',
        factoryEmail: '',
        factoryAddress: '',
        orderDate: new Date().toISOString().slice(0, 10),
        deliveryDate: '',
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6">
        <h2 className="mb-4 text-xl font-bold text-gray-900">新規発注作成</h2>

        {/* ── 仕入先情報 ── */}
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">仕入先情報</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-600">仕入先名 *</label>
              <input
                type="text"
                value={formData.factoryName}
                onChange={(e) => handleInputChange('factoryName', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                placeholder="例: ABC工場"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">担当者名</label>
              <input
                type="text"
                value={formData.factoryPerson}
                onChange={(e) => handleInputChange('factoryPerson', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                placeholder="例: 山田太郎"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">メール</label>
              <input
                type="email"
                value={formData.factoryEmail}
                onChange={(e) => handleInputChange('factoryEmail', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                placeholder="例: info@abc.co.jp"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">住所</label>
              <input
                type="text"
                value={formData.factoryAddress}
                onChange={(e) => handleInputChange('factoryAddress', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                placeholder="例: 東京都渋谷区..."
              />
            </div>
          </div>
        </div>

        {/* ── 発注日・納期 ── */}
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">発注情報</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-600">発注日 *</label>
              <input
                type="date"
                value={formData.orderDate}
                onChange={(e) => handleInputChange('orderDate', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">納期</label>
              <input
                type="date"
                value={formData.deliveryDate}
                onChange={(e) => handleInputChange('deliveryDate', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* ── 明細行 ── */}
        <div className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">明細 *</h3>
            <button
              onClick={addItem}
              className="rounded-lg bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
            >
              + 行を追加
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-xs">
              <thead className="bg-gray-100 text-left text-gray-600">
                <tr>
                  <th className="px-3 py-2">品名</th>
                  <th className="px-3 py-2">品番</th>
                  <th className="px-3 py-2 text-right">数量</th>
                  <th className="px-3 py-2 text-right">単価</th>
                  <th className="px-3 py-2 text-right">金額</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={idx} className="border-t border-gray-200">
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={formData.items[idx].name}
                        onChange={(e) => handleItemChange(idx, 'name', e.target.value)}
                        placeholder="例: Tシャツ"
                        className="w-full rounded border border-gray-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={formData.items[idx].code}
                        onChange={(e) => handleItemChange(idx, 'code', e.target.value)}
                        placeholder="例: SKU-001"
                        className="w-full rounded border border-gray-300 px-2 py-1"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        value={formData.items[idx].qty}
                        onChange={(e) => handleItemChange(idx, 'qty', e.target.value)}
                        placeholder="0"
                        className="w-full rounded border border-gray-300 px-2 py-1 text-right"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        value={formData.items[idx].unitPrice}
                        onChange={(e) => handleItemChange(idx, 'unitPrice', e.target.value)}
                        placeholder="0"
                        className="w-full rounded border border-gray-300 px-2 py-1 text-right"
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-gray-900">
                      {fmtYen(item.amount)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {items.length > 1 && (
                        <button
                          onClick={() => removeItem(idx)}
                          className="text-gray-400 hover:text-red-600"
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 金額サマリー ── */}
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>小計</span>
              <span className="font-medium text-gray-900">{fmtYen(subtotal)}</span>
            </div>
            <div className="flex justify-between text-gray-600">
              <span>{taxRowLabel(taxRate)}</span>
              <span className="font-medium text-gray-900">{fmtYen(tax)}</span>
            </div>
            <div className="border-t border-gray-300 pt-1">
              <div className="flex justify-between text-base font-bold text-gray-900">
                <span>合計</span>
                <span>{fmtYen(total)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── 備考 ── */}
        <div className="mb-6">
          <label className="block text-xs font-medium text-gray-600">備考</label>
          <textarea
            value={formData.notes}
            onChange={(e) => handleInputChange('notes', e.target.value)}
            placeholder="例: 〇月〇日納期必須"
            rows="3"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {/* ── ボタン ── */}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? '保存中...' : '発注を作成'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PurchaseManage() {
  const { isAdmin } = useAuth()

  const [purchases, setPurchases] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [filterStatus, setFilterStatus] = useState('all')
  const [searchText, setSearchText] = useState('')
  const [updatingId, setUpdatingId] = useState(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [taxSettings, setTaxSettings] = useState({ taxRate: 10, taxRounding: 'round' })
  const [companyInfo, setCompanyInfo] = useState({})
  const [stampDataUrl, setStampDataUrl] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkUpdating, setBulkUpdating] = useState(false)

  // ── データ読み込み ──
  const load = useCallback(async () => {
    setLoading(true)
    try {
      // 税設定・会社情報・印影を読み込む
      const [companyDoc, stampDoc] = await Promise.all([
        getDoc(doc(db, 'settings', 'company')),
        getDoc(doc(db, 'settings', 'rt_companyStamp')),
      ])
      if (companyDoc.exists()) {
        const data = companyDoc.data()
        setCompanyInfo(data)
        setTaxSettings({
          taxRate: data.taxRate || 10,
          taxRounding: data.taxRounding || 'round',
        })
      }
      if (stampDoc.exists() && stampDoc.data().dataUrl) {
        setStampDataUrl(stampDoc.data().dataUrl)
      } else {
        const oldStamp = await getDoc(doc(db, 'settings', 'companyStamp'))
        if (oldStamp.exists() && oldStamp.data().dataUrl) setStampDataUrl(oldStamp.data().dataUrl)
      }

      // 発注データを読み込む
      const snap = await getDocs(
        query(collection(db, 'purchases'), orderBy('orderDate', 'desc'))
      )
      setPurchases(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error('発注データ読み込みエラー:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // ── フィルタ・検索 ──
  const filtered = useMemo(() => {
    let list = purchases

    // ステータスフィルタ
    if (filterStatus !== 'all') {
      list = list.filter((p) => (p.status || 'pending') === filterStatus)
    }

    // テキスト検索
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      list = list.filter((p) => {
        const factoryName = (p.factoryName || '').toLowerCase()
        const poNo = (p.poNo || '').toLowerCase()
        return factoryName.includes(q) || poNo.includes(q)
      })
    }

    return list
  }, [purchases, filterStatus, searchText])

  // ── 集計 ──
  const stats = useMemo(() => {
    const now = new Date()
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    let pendingCount = 0
    let monthCount = 0
    let monthTotal = 0

    purchases.forEach((p) => {
      if (p.status === 'pending' || !p.status) pendingCount++

      const d = p.orderDate?.toDate ? p.orderDate.toDate() : p.orderDate ? new Date(p.orderDate) : null
      if (d) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        if (key === thisMonth) {
          monthCount++
          monthTotal += p.total || 0
        }
      }
    })

    return { pendingCount, monthCount, monthTotal }
  }, [purchases])

  // ── ステータスタブの件数 ──
  const statusCounts = useMemo(() => {
    const counts = { all: purchases.length }
    STATUSES.forEach((s) => {
      counts[s.key] = purchases.filter((p) => (p.status || 'pending') === s.key).length
    })
    return counts
  }, [purchases])

  // ── 新規発注作成 ──
  const handleCreatePurchase = async (formData) => {
    try {
      // 発注番号を自動生成
      const poNo = generatePoNo(purchases.map((p) => p.poNo))

      const docRef = await addDoc(collection(db, 'purchases'), {
        poNo,
        factoryName: formData.factoryName,
        factoryPerson: formData.factoryPerson,
        factoryEmail: formData.factoryEmail,
        factoryAddress: formData.factoryAddress,
        status: 'pending',
        orderDate: new Date(formData.orderDate),
        deliveryDate: formData.deliveryDate ? new Date(formData.deliveryDate) : null,
        items: formData.items,
        subtotal: formData.subtotal,
        tax: formData.tax,
        total: formData.total,
        notes: formData.notes,
        relatedSalesId: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })

      // ローカル状態に追加
      setPurchases((prev) => [
        {
          id: docRef.id,
          poNo,
          ...formData,
          status: 'pending',
          orderDate: new Date(formData.orderDate),
          deliveryDate: formData.deliveryDate ? new Date(formData.deliveryDate) : null,
          relatedSalesId: '',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        ...prev,
      ])

      alert(`発注番号 ${poNo} を作成しました`)
    } catch (e) {
      console.error('発注作成エラー:', e)
      throw e
    }
  }

  // ── ステータス変更 ──
  const handleStatusChange = async (purchaseId, newStatus) => {
    setUpdatingId(purchaseId)
    try {
      await updateDoc(doc(db, 'purchases', purchaseId), {
        status: newStatus,
        updatedAt: serverTimestamp(),
      })
      setPurchases((prev) =>
        prev.map((p) =>
          p.id === purchaseId ? { ...p, status: newStatus } : p,
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
      setSelectedIds(new Set(filtered.map((p) => p.id)))
    }
  }

  // ── 一括ステータス変更 ──
  const handleBulkStatusChange = async (newStatus) => {
    if (selectedIds.size === 0) return
    setBulkUpdating(true)
    try {
      const batch = writeBatch(db)
      selectedIds.forEach((id) => {
        batch.update(doc(db, 'purchases', id), {
          status: newStatus,
          updatedAt: serverTimestamp(),
        })
      })
      await batch.commit()

      setPurchases((prev) =>
        prev.map((p) =>
          selectedIds.has(p.id) ? { ...p, status: newStatus } : p,
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

  // ── PDF発注書プリント ──
  const handlePrintPurchase = (purchase) => {
    try {
      const docTitle = `発注書 ${purchase.poNo}`
      const docContent = {
        title: '発 注 書',
        docNoLabel: '発注番号',
        docNo: purchase.poNo,
        date: purchase.orderDate,
        customerName: purchase.factoryName,
        customerPerson: purchase.factoryPerson,
        subject: '',
        greeting: '',
        totalLabel: '発注金額',
        subtotal: purchase.subtotal,
        taxSettings,
        company: companyInfo,
        stampDataUrl,
        colHeaders: ['品名', '品番', '単価', '数量', '金額'],
        itemRows: (purchase.items || []).map((it) => [
          it.name || '—',
          it.code || '—',
          fmtYen(it.unitPrice),
          String(it.qty),
          fmtYen((it.qty || 0) * (it.unitPrice || 0)),
        ]),
        noteText: purchase.notes,
      }

      const layout = buildDocLayout(docContent)
      openPrintPreview('発注書', layout)
    } catch (e) {
      console.error('PDF生成エラー:', e)
      alert('発注書の生成に失敗しました')
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
        <h1 className="text-2xl font-bold text-gray-900">発注管理</h1>
        <button
          onClick={() => setIsModalOpen(true)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          + 新規発注
        </button>
      </div>

      {/* ── サマリー ── */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          label="未処理の発注"
          value={`${stats.pendingCount}件`}
          color={stats.pendingCount > 0 ? 'text-red-600' : 'text-gray-900'}
        />
        <Stat label="今月の発注" value={`${stats.monthCount}件`} />
        <Stat label="今月の発注金額" value={fmtYen(stats.monthTotal)} />
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
          placeholder="仕入先名・発注番号で検索..."
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

      {/* ── 発注一覧テーブル ── */}
      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
          {purchases.length === 0
            ? 'まだ発注データがありません。「+ 新規発注」で追加してください。'
            : '条件に一致する発注がありません'}
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
                  <th className="px-4 py-3">発注番号</th>
                  <th className="px-4 py-3">仕入先</th>
                  <th className="px-4 py-3 text-right">合計金額</th>
                  <th className="px-4 py-3">発注日</th>
                  <th className="px-4 py-3">納期</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const st = statusOf(p)
                  const isOpen = expandedId === p.id

                  return (
                    <Fragment key={p.id}>
                      <tr
                        className={`cursor-pointer border-t border-gray-100 hover:bg-gray-50 ${selectedIds.has(p.id) ? 'bg-indigo-50' : ''}`}
                        onClick={() => setExpandedId(isOpen ? null : p.id)}
                      >
                        {/* チェックボックス */}
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(p.id)}
                            onChange={() => toggleSelect(p.id)}
                            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                          />
                        </td>

                        {/* ステータス */}
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <select
                            value={p.status || 'pending'}
                            onChange={(e) => handleStatusChange(p.id, e.target.value)}
                            disabled={updatingId === p.id}
                            className={`rounded-lg border-0 px-2 py-1 text-xs font-medium ${st.bg} ${st.text} focus:outline-none focus:ring-2 focus:ring-indigo-300`}
                          >
                            {STATUSES.map((s) => (
                              <option key={s.key} value={s.key}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        </td>

                        {/* 発注番号 */}
                        <td className="px-4 py-3 font-mono text-xs text-gray-600">
                          {p.poNo}
                        </td>

                        {/* 仕入先名 */}
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {p.factoryName}
                        </td>

                        {/* 合計金額 */}
                        <td className="px-4 py-3 text-right font-bold">
                          {fmtYen(p.total)}
                        </td>

                        {/* 発注日 */}
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {fmtDate(p.orderDate)}
                        </td>

                        {/* 納期 */}
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {fmtDate(p.deliveryDate)}
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
                                {(p.items ?? []).length > 0 ? (
                                  <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                                    <table className="w-full text-xs">
                                      <thead className="bg-gray-100 text-left text-gray-500">
                                        <tr>
                                          <th className="px-3 py-2">品名</th>
                                          <th className="px-3 py-2">品番</th>
                                          <th className="px-3 py-2 text-right">単価</th>
                                          <th className="px-3 py-2 text-right">数量</th>
                                          <th className="px-3 py-2 text-right">小計</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {p.items.map((it, i) => (
                                          <tr key={i} className="border-t border-gray-100">
                                            <td className="px-3 py-2 text-gray-900">
                                              {it.name || '—'}
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

                                {p.notes && (
                                  <div className="mt-3 rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                                    備考: {p.notes}
                                  </div>
                                )}
                              </div>

                              {/* ── 発注情報 ── */}
                              <div>
                                <h4 className="mb-2 text-xs font-bold text-gray-600">発注情報</h4>
                                <div className="rounded-lg border border-gray-200 bg-white">
                                  <table className="w-full text-xs">
                                    <tbody className="divide-y divide-gray-100">
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">発注番号</td>
                                        <td className="px-3 py-2 text-right font-mono text-gray-900">{p.poNo}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">発注日</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtDate(p.orderDate)}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">納期</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtDate(p.deliveryDate) || '—'}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">ステータス</td>
                                        <td className="px-3 py-2 text-right">
                                          <span className={`rounded px-2 py-0.5 text-xs font-medium ${st.bg} ${st.text}`}>
                                            {st.label}
                                          </span>
                                        </td>
                                      </tr>
                                      <tr className="bg-gray-50">
                                        <td className="px-3 py-2 text-gray-500">商品小計</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtYen(p.subtotal)}</td>
                                      </tr>
                                      <tr className="bg-gray-50">
                                        <td className="px-3 py-2 text-gray-500">{taxRowLabel(taxSettings.taxRate)}</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtYen(p.tax)}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 font-bold text-gray-900">合計（税込）</td>
                                        <td className="px-3 py-2 text-right text-base font-bold text-gray-900">{fmtYen(p.total)}</td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </div>

                                {/* 仕入先情報 */}
                                {p.factoryName && (
                                  <div className="mt-3 rounded-lg border border-gray-200 bg-white px-3 py-2">
                                    <div className="text-xs text-gray-500">仕入先</div>
                                    <div className="text-sm font-medium text-gray-900">{p.factoryName}</div>
                                    {p.factoryPerson && (
                                      <div className="mt-1 text-xs text-gray-600">担当: {p.factoryPerson}</div>
                                    )}
                                    {p.factoryEmail && (
                                      <div className="text-xs text-gray-600">{p.factoryEmail}</div>
                                    )}
                                  </div>
                                )}

                                {/* PDF印刷ボタン */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handlePrintPurchase(p)
                                  }}
                                  className="mt-3 w-full rounded-lg bg-gray-600 px-3 py-2 text-xs font-medium text-white hover:bg-gray-700"
                                >
                                  📄 発注書を印刷
                                </button>
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
            {filtered.length === purchases.length
              ? `全 ${purchases.length} 件`
              : `${filtered.length} / ${purchases.length} 件表示`}
          </div>
        </div>
      )}

      {/* ── 新規作成モーダル ── */}
      <CreateModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleCreatePurchase}
        taxRate={taxSettings.taxRate}
        taxRounding={taxSettings.taxRounding}
      />
    </div>
  )
}
