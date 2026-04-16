import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  collection,
  doc,
  getDocs,
  addDoc,
  getDoc,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { calcTax } from '../lib/taxCalc.js'
import { buildDocLayout, openPrintPreview } from '../lib/docGenerator.js'

// ── ステータス定義 ──
const STATUSES = [
  { key: 'new', label: '新規', bg: 'bg-blue-100', text: 'text-blue-700' },
  { key: 'confirmed', label: '入金確認済', bg: 'bg-yellow-100', text: 'text-yellow-700' },
  { key: 'preparing', label: '出荷準備中', bg: 'bg-orange-100', text: 'text-orange-700' },
  { key: 'shipped', label: '出荷済', bg: 'bg-indigo-100', text: 'text-indigo-700' },
  { key: 'completed', label: '完了', bg: 'bg-green-100', text: 'text-green-700' },
]

const STATUS_MAP = Object.fromEntries(STATUSES.map((s) => [s.key, s]))

const statusOf = (order) => {
  const s = order.status || 'new'
  return STATUS_MAP[s] || STATUS_MAP.new
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

// ── ワークフローステップ定義 ──
const WORKFLOW_STEPS = [
  {
    key: 'confirm',
    label: 'Step 1: 受注確認',
    description: '受注を確認済にして、お客様に受注確認メールを送る準備をします。',
    icon: '✅',
    orderStatus: 'confirmed',
  },
  {
    key: 'purchase',
    label: 'Step 2: 工場発注書作成',
    description: '受注内容をもとに工場への発注書を自動作成します。',
    icon: '📋',
    orderStatus: 'confirmed',
  },
  {
    key: 'producing',
    label: 'Step 3: 製造開始',
    description: 'ステータスを「出荷準備中」に更新します。',
    icon: '🏭',
    orderStatus: 'preparing',
  },
  {
    key: 'shipped',
    label: 'Step 4: 出荷完了',
    description: 'ステータスを「出荷済」に更新します。',
    icon: '🚚',
    orderStatus: 'shipped',
  },
  {
    key: 'complete',
    label: 'Step 5: 完了・請求書作成',
    description: '受注を完了にし、請求書データを自動作成します。',
    icon: '📄',
    orderStatus: 'completed',
  },
]

// 受注ステータスから現在のワークフローステップを判定
function getWorkflowStep(orderStatus) {
  switch (orderStatus) {
    case 'new': return 0
    case 'confirmed': return 2  // Step1完了 → Step2 or 3へ
    case 'preparing': return 3  // Step3完了 → Step4へ
    case 'shipped': return 4    // Step4完了 → Step5へ
    case 'completed': return 5  // 全完了
    default: return 0
  }
}

// ── ワークフローモーダル ──
function WorkflowModal({ isOpen, onClose, order, salons, onOrderUpdate }) {
  const [currentStep, setCurrentStep] = useState(0)
  const [processing, setProcessing] = useState(false)
  const [stepResults, setStepResults] = useState({})
  const [purchaseForm, setPurchaseForm] = useState({
    factoryName: '',
    factoryPerson: '',
    deliveryDate: '',
    notes: '',
  })
  const [taxSettings, setTaxSettings] = useState({})
  const [companyInfo, setCompanyInfo] = useState({})
  const [stampDataUrl, setStampDataUrl] = useState('')

  // 初期化：受注ステータスに応じてステップを設定
  useEffect(() => {
    if (isOpen && order) {
      const step = getWorkflowStep(order.status || 'new')
      setCurrentStep(step)
      setStepResults({})
      // 設定読み込み
      ;(async () => {
        try {
          const [compDoc, stampDoc] = await Promise.all([
            getDoc(doc(db, 'settings', 'company')),
            getDoc(doc(db, 'settings', 'rt_companyStamp')),
          ])
          if (compDoc.exists()) {
            const data = compDoc.data()
            setCompanyInfo(data)
            setTaxSettings({
              taxRate: data.taxRate || '10',
              taxRounding: data.taxRounding || 'floor',
              taxDisplayMode: data.taxDisplayMode || 'exclusive',
            })
          }
          if (stampDoc.exists() && stampDoc.data().dataUrl) {
            setStampDataUrl(stampDoc.data().dataUrl)
          } else {
            const oldStamp = await getDoc(doc(db, 'settings', 'companyStamp'))
            if (oldStamp.exists() && oldStamp.data().dataUrl) setStampDataUrl(oldStamp.data().dataUrl)
          }
        } catch (e) {
          console.warn('設定読み込みエラー:', e)
        }
      })()
    }
  }, [isOpen, order])

  if (!isOpen || !order) return null

  const salonName = order.companyName || salons[order.salonId]?.name || '—'
  const orderNum = order.bcartOrderNumber || order.bcartCode || '—'

  // ── Step 1: 受注確認 ──
  const handleConfirmOrder = async () => {
    setProcessing(true)
    try {
      await updateDoc(doc(db, 'orders', order.id), {
        status: 'confirmed',
        statusUpdatedAt: serverTimestamp(),
        confirmedAt: serverTimestamp(),
      })
      onOrderUpdate(order.id, { status: 'confirmed' })
      setStepResults((prev) => ({ ...prev, confirm: '受注確認済に更新しました' }))
      setCurrentStep(1)
    } catch (e) {
      console.error('受注確認エラー:', e)
      alert('受注確認の更新に失敗しました')
    } finally {
      setProcessing(false)
    }
  }

  // ── Step 2: 発注書作成 ──
  const handleCreatePurchase = async () => {
    if (!purchaseForm.factoryName.trim()) {
      alert('仕入先名を入力してください')
      return
    }
    setProcessing(true)
    try {
      // 受注明細を発注明細に変換
      const items = (order.items || []).map((it) => ({
        name: it.name || it.productName || '',
        code: it.sku || it.code || '',
        qty: it.qty || it.quantity || 0,
        unitPrice: it.price || it.unitPrice || 0,
        amount: (it.qty || it.quantity || 0) * (it.price || it.unitPrice || 0),
      }))
      const subtotal = items.reduce((s, it) => s + (it.amount || 0), 0)
      const tax = calcTax(subtotal, taxSettings)
      const total = subtotal + tax

      // 既存の発注番号を取得して新番号生成
      const poSnap = await getDocs(collection(db, 'purchases'))
      const existingNos = poSnap.docs.map((d) => d.data().poNo || '').filter(Boolean)
      const now = new Date()
      const datePrefix = `PO-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
      const matchingNos = existingNos.filter((no) => no.startsWith(datePrefix))
      const poNo = `${datePrefix}-${String(matchingNos.length + 1).padStart(3, '0')}`

      const purchaseData = {
        poNo,
        factoryName: purchaseForm.factoryName,
        factoryPerson: purchaseForm.factoryPerson,
        factoryEmail: '',
        factoryAddress: '',
        status: 'pending',
        orderDate: now.toISOString().slice(0, 10),
        deliveryDate: purchaseForm.deliveryDate || '',
        items,
        subtotal,
        tax,
        total,
        notes: purchaseForm.notes || `受注番号 ${orderNum} に対する工場発注`,
        relatedSalesId: order.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }

      const poRef = await addDoc(collection(db, 'purchases'), purchaseData)

      // 受注に発注書IDを紐付け
      await updateDoc(doc(db, 'orders', order.id), {
        linkedPurchaseId: poRef.id,
        linkedPoNo: poNo,
        updatedAt: serverTimestamp(),
      })
      onOrderUpdate(order.id, { linkedPurchaseId: poRef.id, linkedPoNo: poNo })

      setStepResults((prev) => ({
        ...prev,
        purchase: `発注書 ${poNo} を作成しました`,
        purchaseId: poRef.id,
        purchaseData,
      }))
      setCurrentStep(2)
    } catch (e) {
      console.error('発注書作成エラー:', e)
      alert('発注書の作成に失敗しました')
    } finally {
      setProcessing(false)
    }
  }

  // ── Step 3: 製造開始 ──
  const handleStartProducing = async () => {
    setProcessing(true)
    try {
      const batch = writeBatch(db)

      // 受注ステータス更新
      batch.update(doc(db, 'orders', order.id), {
        status: 'preparing',
        statusUpdatedAt: serverTimestamp(),
      })

      // 関連する発注書があればステータス更新
      const poId = order.linkedPurchaseId || stepResults.purchaseId
      if (poId) {
        batch.update(doc(db, 'purchases', poId), {
          status: 'producing',
          updatedAt: serverTimestamp(),
        })
      }

      await batch.commit()
      onOrderUpdate(order.id, { status: 'preparing' })
      setStepResults((prev) => ({ ...prev, producing: '製造開始に更新しました' }))
      setCurrentStep(3)
    } catch (e) {
      console.error('製造開始エラー:', e)
      alert('ステータス更新に失敗しました')
    } finally {
      setProcessing(false)
    }
  }

  // ── Step 4: 出荷完了 ──
  const handleShipped = async () => {
    setProcessing(true)
    try {
      const batch = writeBatch(db)

      batch.update(doc(db, 'orders', order.id), {
        status: 'shipped',
        statusUpdatedAt: serverTimestamp(),
        shippedAt: serverTimestamp(),
      })

      const poId = order.linkedPurchaseId || stepResults.purchaseId
      if (poId) {
        batch.update(doc(db, 'purchases', poId), {
          status: 'shipped',
          updatedAt: serverTimestamp(),
        })
      }

      await batch.commit()
      onOrderUpdate(order.id, { status: 'shipped' })
      setStepResults((prev) => ({ ...prev, shipped: '出荷済に更新しました' }))
      setCurrentStep(4)
    } catch (e) {
      console.error('出荷更新エラー:', e)
      alert('ステータス更新に失敗しました')
    } finally {
      setProcessing(false)
    }
  }

  // ── Step 5: 完了・請求書作成 ──
  const handleComplete = async () => {
    setProcessing(true)
    try {
      const batch = writeBatch(db)

      // 受注完了
      batch.update(doc(db, 'orders', order.id), {
        status: 'completed',
        statusUpdatedAt: serverTimestamp(),
        completedAt: serverTimestamp(),
      })

      // 発注書を検収済に
      const poId = order.linkedPurchaseId || stepResults.purchaseId
      if (poId) {
        batch.update(doc(db, 'purchases', poId), {
          status: 'received',
          updatedAt: serverTimestamp(),
        })
      }

      await batch.commit()

      // 請求書データ作成（invoicesコレクション）
      const items = (order.items || []).map((it) => ({
        productName: it.name || it.productName || '',
        sku: it.sku || it.code || '',
        unitPrice: it.price || it.unitPrice || 0,
        quantity: it.qty || it.quantity || 0,
        subtotal: (it.qty || it.quantity || 0) * (it.price || it.unitPrice || 0),
      }))
      const subtotal = items.reduce((s, it) => s + it.subtotal, 0)
      const tax = calcTax(subtotal, taxSettings)
      const grandTotal = subtotal + tax

      // 請求書番号生成
      const invSnap = await getDocs(collection(db, 'orderInvoices'))
      const now = new Date()
      const invPrefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
      const existingInvNos = invSnap.docs.map((d) => d.data().invoiceNo || '').filter(Boolean)
      const matchingInvNos = existingInvNos.filter((no) => no.startsWith(invPrefix))
      const invoiceNo = `${invPrefix}-${String(matchingInvNos.length + 1).padStart(3, '0')}`

      const invoiceData = {
        invoiceNo,
        orderId: order.id,
        orderNumber: orderNum,
        customerName: salonName,
        customerAddress: order.customerAddress || '',
        customerPerson: order.contact || '',
        items,
        subtotal,
        tax,
        grandTotal,
        status: 'draft',
        invoiceDate: now.toISOString().slice(0, 10),
        dueDate: '',
        notes: `受注番号 ${orderNum} に対する請求書`,
        companyInfo,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }

      const invRef = await addDoc(collection(db, 'orderInvoices'), invoiceData)

      // 受注に請求書IDを紐付け
      await updateDoc(doc(db, 'orders', order.id), {
        linkedInvoiceId: invRef.id,
        linkedInvoiceNo: invoiceNo,
      })

      onOrderUpdate(order.id, {
        status: 'completed',
        linkedInvoiceId: invRef.id,
        linkedInvoiceNo: invoiceNo,
      })
      setStepResults((prev) => ({
        ...prev,
        complete: `完了。請求書 ${invoiceNo} を作成しました`,
        invoiceData,
      }))
      setCurrentStep(5)
    } catch (e) {
      console.error('完了処理エラー:', e)
      alert('完了処理に失敗しました')
    } finally {
      setProcessing(false)
    }
  }

  // ── 発注書印刷プレビュー ──
  const handlePrintPurchase = () => {
    const pd = stepResults.purchaseData
    if (!pd) return
    const itemRows = pd.items.map((it) => [
      it.name,
      it.code || '',
      String(it.qty),
      `¥${(it.unitPrice || 0).toLocaleString()}`,
      `¥${(it.amount || 0).toLocaleString()}`,
    ])
    const html = buildDocLayout({
      title: '発 注 書',
      docNoLabel: '発注番号',
      docNo: pd.poNo,
      date: pd.orderDate,
      customerName: pd.factoryName,
      customerPerson: pd.factoryPerson,
      subject: '',
      greeting: '',
      totalLabel: '発注金額',
      subtotal: pd.subtotal,
      taxSettings,
      company: companyInfo,
      stampDataUrl,
      colHeaders: ['品名', '品番', '数量', '単価', '金額'],
      itemRows,
      noteText: pd.notes,
    })
    openPrintPreview('発注書', html)
  }

  // ── 請求書印刷プレビュー ──
  const handlePrintInvoice = () => {
    const inv = stepResults.invoiceData
    if (!inv) return
    const itemRows = inv.items.map((it) => [
      it.productName,
      it.sku || '',
      String(it.quantity),
      `¥${(it.unitPrice || 0).toLocaleString()}`,
      `¥${it.subtotal.toLocaleString()}`,
    ])
    const html = buildDocLayout({
      title: '請 求 書',
      docNoLabel: '請求書番号',
      docNo: inv.invoiceNo,
      date: inv.invoiceDate,
      customerName: inv.customerName,
      customerPerson: inv.customerPerson,
      customerAddress: inv.customerAddress,
      subject: '',
      greeting: '下記の通りご請求申し上げます。',
      totalLabel: 'ご請求金額',
      subtotal: inv.subtotal,
      taxSettings,
      company: companyInfo,
      stampDataUrl,
      colHeaders: ['品名', '品番', '数量', '単価', '金額'],
      itemRows,
      noteText: inv.notes,
      bankText: companyInfo.bankInfo || '',
    })
    openPrintPreview('請求書', html)
  }

  const allDone = currentStep >= 5

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        {/* ヘッダー */}
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">🚀 受注ワークフロー</h2>
            <p className="mt-1 text-sm text-gray-500">
              {salonName} — {orderNum} — {fmtYen(order.total)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            ✕
          </button>
        </div>

        {/* ステップインジケーター */}
        <div className="mb-6 flex items-center gap-1">
          {WORKFLOW_STEPS.map((step, i) => {
            const isDone = i < currentStep
            const isCurrent = i === currentStep
            return (
              <div key={step.key} className="flex flex-1 items-center">
                <div
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    isDone
                      ? 'bg-green-500 text-white'
                      : isCurrent
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-200 text-gray-400'
                  }`}
                >
                  {isDone ? '✓' : i + 1}
                </div>
                {i < WORKFLOW_STEPS.length - 1 && (
                  <div className={`mx-1 h-0.5 flex-1 ${isDone ? 'bg-green-400' : 'bg-gray-200'}`} />
                )}
              </div>
            )
          })}
        </div>

        {/* ステップコンテンツ */}
        <div className="space-y-4">
          {/* ── Step 1: 受注確認 ── */}
          {currentStep === 0 && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-2xl">✅</span>
                <h3 className="text-lg font-bold text-blue-900">受注確認</h3>
              </div>
              <p className="mb-4 text-sm text-blue-700">
                {salonName} からの受注 ({orderNum}) を確認済にします。
              </p>
              <div className="mb-3 rounded-lg bg-white p-3">
                <div className="text-xs text-gray-500">受注内容</div>
                <div className="mt-1 space-y-1 text-sm">
                  {(order.items || []).map((it, i) => (
                    <div key={i} className="flex justify-between">
                      <span className="text-gray-700">{it.name || it.productName}</span>
                      <span className="text-gray-900 font-medium">
                        {it.qty || it.quantity}個 × {fmtYen(it.price || it.unitPrice)}
                      </span>
                    </div>
                  ))}
                  <div className="mt-2 border-t border-gray-200 pt-2 flex justify-between font-bold">
                    <span>合計</span>
                    <span>{fmtYen(order.total)}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={handleConfirmOrder}
                disabled={processing}
                className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {processing ? '処理中...' : '受注を確認済にする →'}
              </button>
            </div>
          )}

          {/* ── Step 2: 発注書作成 ── */}
          {currentStep === 1 && (
            <div className="rounded-xl border border-orange-200 bg-orange-50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-2xl">📋</span>
                <h3 className="text-lg font-bold text-orange-900">工場発注書作成</h3>
              </div>
              <p className="mb-4 text-sm text-orange-700">
                受注内容をもとに工場への発注書を自動作成します。仕入先情報を入力してください。
              </p>
              <div className="mb-4 space-y-3 rounded-lg bg-white p-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600">仕入先名 *</label>
                  <input
                    type="text"
                    value={purchaseForm.factoryName}
                    onChange={(e) => setPurchaseForm((p) => ({ ...p, factoryName: e.target.value }))}
                    placeholder="例: ABC工場"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600">担当者名</label>
                  <input
                    type="text"
                    value={purchaseForm.factoryPerson}
                    onChange={(e) => setPurchaseForm((p) => ({ ...p, factoryPerson: e.target.value }))}
                    placeholder="例: 田中太郎"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600">納期</label>
                  <input
                    type="date"
                    value={purchaseForm.deliveryDate}
                    onChange={(e) => setPurchaseForm((p) => ({ ...p, deliveryDate: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600">備考</label>
                  <textarea
                    value={purchaseForm.notes}
                    onChange={(e) => setPurchaseForm((p) => ({ ...p, notes: e.target.value }))}
                    rows={2}
                    placeholder="特記事項"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setCurrentStep(2)}
                  className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50"
                >
                  スキップ →
                </button>
                <button
                  onClick={handleCreatePurchase}
                  disabled={processing}
                  className="flex-1 rounded-lg bg-orange-600 py-2.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
                >
                  {processing ? '作成中...' : '発注書を作成する →'}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: 製造開始 ── */}
          {currentStep === 2 && (
            <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-2xl">🏭</span>
                <h3 className="text-lg font-bold text-yellow-900">製造開始</h3>
              </div>
              <p className="mb-4 text-sm text-yellow-700">
                受注ステータスを「出荷準備中」に、発注書を「製造中」に更新します。
              </p>
              {stepResults.purchase && (
                <div className="mb-3 flex items-center gap-2 rounded-lg bg-green-100 px-3 py-2 text-sm text-green-700">
                  ✓ {stepResults.purchase}
                  <button
                    onClick={handlePrintPurchase}
                    className="ml-auto rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                  >
                    発注書を印刷
                  </button>
                </div>
              )}
              <button
                onClick={handleStartProducing}
                disabled={processing}
                className="w-full rounded-lg bg-yellow-600 py-2.5 text-sm font-medium text-white hover:bg-yellow-700 disabled:opacity-50"
              >
                {processing ? '処理中...' : '製造開始にする →'}
              </button>
            </div>
          )}

          {/* ── Step 4: 出荷完了 ── */}
          {currentStep === 3 && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-2xl">🚚</span>
                <h3 className="text-lg font-bold text-indigo-900">出荷完了</h3>
              </div>
              <p className="mb-4 text-sm text-indigo-700">
                製品の出荷が完了したらステータスを「出荷済」に更新します。
              </p>
              <button
                onClick={handleShipped}
                disabled={processing}
                className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {processing ? '処理中...' : '出荷済にする →'}
              </button>
            </div>
          )}

          {/* ── Step 5: 完了・請求書 ── */}
          {currentStep === 4 && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-2xl">📄</span>
                <h3 className="text-lg font-bold text-emerald-900">完了・請求書作成</h3>
              </div>
              <p className="mb-4 text-sm text-emerald-700">
                受注を完了にし、請求書データを自動作成します。
              </p>
              <button
                onClick={handleComplete}
                disabled={processing}
                className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {processing ? '処理中...' : '完了にして請求書を作成 →'}
              </button>
            </div>
          )}

          {/* ── 全完了 ── */}
          {allDone && (
            <div className="rounded-xl border border-green-200 bg-green-50 p-5 text-center">
              <div className="mb-3 text-4xl">🎉</div>
              <h3 className="mb-2 text-lg font-bold text-green-900">ワークフロー完了</h3>
              <p className="mb-4 text-sm text-green-700">
                すべてのステップが完了しました。
              </p>
              {stepResults.complete && (
                <div className="mb-4 inline-flex items-center gap-2 rounded-lg bg-green-100 px-4 py-2 text-sm text-green-700">
                  ✓ {stepResults.complete}
                </div>
              )}
              <div className="flex justify-center gap-3">
                {stepResults.invoiceData && (
                  <button
                    onClick={handlePrintInvoice}
                    className="rounded-lg border border-green-300 bg-white px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50"
                  >
                    📄 請求書を印刷
                  </button>
                )}
                {stepResults.purchaseData && (
                  <button
                    onClick={handlePrintPurchase}
                    className="rounded-lg border border-green-300 bg-white px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50"
                  >
                    📋 発注書を印刷
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="rounded-lg bg-green-600 px-6 py-2 text-sm font-medium text-white hover:bg-green-700"
                >
                  閉じる
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 完了済ステップのサマリー */}
        {Object.keys(stepResults).length > 0 && !allDone && (
          <div className="mt-4 space-y-1">
            {stepResults.confirm && (
              <div className="flex items-center gap-2 text-xs text-green-600">
                <span>✓</span> {stepResults.confirm}
              </div>
            )}
            {stepResults.purchase && (
              <div className="flex items-center gap-2 text-xs text-green-600">
                <span>✓</span> {stepResults.purchase}
              </div>
            )}
            {stepResults.producing && (
              <div className="flex items-center gap-2 text-xs text-green-600">
                <span>✓</span> {stepResults.producing}
              </div>
            )}
            {stepResults.shipped && (
              <div className="flex items-center gap-2 text-xs text-green-600">
                <span>✓</span> {stepResults.shipped}
              </div>
            )}
          </div>
        )}

        {/* フッター */}
        {!allDone && (
          <div className="mt-4 flex justify-end">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              あとで続ける
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function OrderManage() {
  const { isAdmin } = useAuth()
  const navigate = useNavigate()

  const [orders, setOrders] = useState([])
  const [salons, setSalons] = useState({})
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [filterStatus, setFilterStatus] = useState('all')
  const [searchText, setSearchText] = useState('')
  const [updatingId, setUpdatingId] = useState(null)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkUpdating, setBulkUpdating] = useState(false)
  const [workflowOrder, setWorkflowOrder] = useState(null) // ワークフローモーダル対象

  // ── データ読み込み ──
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [orderSnap, salonSnap] = await Promise.all([
        getDocs(query(collection(db, 'orders'), orderBy('orderDate', 'desc'))),
        getDocs(collection(db, 'salons')),
      ])

      setOrders(orderSnap.docs.map((d) => ({ id: d.id, ...d.data() })))

      const salonMap = {}
      salonSnap.docs.forEach((d) => {
        salonMap[d.id] = d.data()
      })
      setSalons(salonMap)
    } catch (e) {
      console.error('受注データ読み込みエラー:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // ── フィルタ・検索 ──
  const filtered = useMemo(() => {
    let list = orders

    // ステータスフィルタ
    if (filterStatus !== 'all') {
      list = list.filter((o) => (o.status || 'new') === filterStatus)
    }

    // テキスト検索
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      list = list.filter((o) => {
        const salonName = (o.companyName || salons[o.salonId]?.name || '').toLowerCase()
        const orderNum = (o.bcartOrderNumber || o.bcartCode || '').toLowerCase()
        return salonName.includes(q) || orderNum.includes(q)
      })
    }

    return list
  }, [orders, filterStatus, searchText, salons])

  // ── 集計 ──
  const stats = useMemo(() => {
    const now = new Date()
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    let newCount = 0
    let monthCount = 0
    let monthTotal = 0

    orders.forEach((o) => {
      if (!o.status || o.status === 'new') newCount++

      const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
      if (d) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        if (key === thisMonth) {
          monthCount++
          monthTotal += o.total || 0
        }
      }
    })

    return { newCount, monthCount, monthTotal }
  }, [orders])

  // ── ステータス変更 ──
  const handleStatusChange = async (orderId, newStatus) => {
    setUpdatingId(orderId)
    try {
      await updateDoc(doc(db, 'orders', orderId), {
        status: newStatus,
        statusUpdatedAt: serverTimestamp(),
      })
      setOrders((prev) =>
        prev.map((o) =>
          o.id === orderId ? { ...o, status: newStatus } : o,
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
      setSelectedIds(new Set(filtered.map((o) => o.id)))
    }
  }

  // ── 一括ステータス変更 ──
  const handleBulkStatusChange = async (newStatus) => {
    if (selectedIds.size === 0) return
    setBulkUpdating(true)
    try {
      const batch = writeBatch(db)
      selectedIds.forEach((id) => {
        batch.update(doc(db, 'orders', id), {
          status: newStatus,
          statusUpdatedAt: serverTimestamp(),
        })
      })
      await batch.commit()

      setOrders((prev) =>
        prev.map((o) =>
          selectedIds.has(o.id) ? { ...o, status: newStatus } : o,
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

  // ── ワークフロー: ローカル受注更新 ──
  const handleOrderUpdate = useCallback((orderId, updates) => {
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, ...updates } : o)),
    )
  }, [])

  // ── ステータスタブの件数 ──
  const statusCounts = useMemo(() => {
    const counts = { all: orders.length }
    STATUSES.forEach((s) => {
      counts[s.key] = orders.filter((o) => (o.status || 'new') === s.key).length
    })
    return counts
  }, [orders])

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
        <h1 className="text-2xl font-bold text-gray-900">受注管理</h1>
        <button
          onClick={() => navigate('/admin/bcart-import')}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Bカート同期
        </button>
      </div>

      {/* ── サマリー ── */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          label="未処理の受注"
          value={`${stats.newCount}件`}
          color={stats.newCount > 0 ? 'text-red-600' : 'text-gray-900'}
        />
        <Stat label="今月の受注" value={`${stats.monthCount}件`} />
        <Stat label="今月の売上" value={fmtYen(stats.monthTotal)} />
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
          placeholder="サロン名・注文番号で検索..."
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

      {/* ── 受注一覧テーブル ── */}
      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
          {orders.length === 0
            ? '受注データがありません。Bカート同期で取り込んでください。'
            : '条件に一致する受注がありません'}
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
                  <th className="px-4 py-3">注文番号</th>
                  <th className="px-4 py-3">サロン名</th>
                  <th className="px-4 py-3 text-right">合計金額</th>
                  <th className="px-4 py-3">注文日</th>
                  <th className="px-4 py-3">ソース</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => {
                  const st = statusOf(o)
                  const isOpen = expandedId === o.id
                  const salonName = o.companyName || salons[o.salonId]?.name || '—'
                  const orderNum = o.bcartOrderNumber || o.bcartCode || '—'

                  return (
                    <Fragment key={o.id}>
                      <tr
                        className={`cursor-pointer border-t border-gray-100 hover:bg-gray-50 ${selectedIds.has(o.id) ? 'bg-indigo-50' : ''}`}
                        onClick={() => setExpandedId(isOpen ? null : o.id)}
                      >
                        {/* チェックボックス */}
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(o.id)}
                            onChange={() => toggleSelect(o.id)}
                            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                          />
                        </td>

                        {/* ステータス */}
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <select
                            value={o.status || 'new'}
                            onChange={(e) => handleStatusChange(o.id, e.target.value)}
                            disabled={updatingId === o.id}
                            className={`rounded-lg border-0 px-2 py-1 text-xs font-medium ${st.bg} ${st.text} focus:outline-none focus:ring-2 focus:ring-indigo-300`}
                          >
                            {STATUSES.map((s) => (
                              <option key={s.key} value={s.key}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        </td>

                        {/* 注文番号 */}
                        <td className="px-4 py-3 font-mono text-xs text-gray-600">
                          {orderNum}
                        </td>

                        {/* サロン名 */}
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {salonName}
                        </td>

                        {/* 合計金額 */}
                        <td className="px-4 py-3 text-right font-bold">
                          {fmtYen(o.total)}
                        </td>

                        {/* 注文日 */}
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {fmtDate(o.orderDate)}
                        </td>

                        {/* ソース */}
                        <td className="px-4 py-3">
                          <span
                            className={`rounded px-2 py-0.5 text-xs ${
                              (o.source || '').includes('bcart')
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {o.source === 'bcart-api'
                              ? 'API'
                              : o.source === 'bcart-email'
                                ? 'メール'
                                : o.source === 'bcart'
                                  ? 'Bカート'
                                  : '手動'}
                          </span>
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
                                {(o.items ?? []).length > 0 ? (
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
                                        {o.items.map((it, i) => (
                                          <tr key={i} className="border-t border-gray-100">
                                            <td className="px-3 py-2 text-gray-900">
                                              {it.name}
                                              {it.campaign && (
                                                <span className="ml-1 rounded bg-purple-100 px-1.5 py-0.5 text-purple-600">
                                                  {it.campaign}
                                                </span>
                                              )}
                                            </td>
                                            <td className="px-3 py-2 font-mono text-gray-400">
                                              {it.sku || '—'}
                                            </td>
                                            <td className="px-3 py-2 text-right text-gray-700">
                                              {fmtYen(it.price)}
                                            </td>
                                            <td className="px-3 py-2 text-right text-gray-700">
                                              {it.qty}{it.unit ? `（${it.unit}）` : ''}
                                            </td>
                                            <td className="px-3 py-2 text-right font-medium text-gray-900">
                                              {fmtYen((it.qty ?? 0) * (it.price ?? 0))}
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

                                {o.customerNote && (
                                  <div className="mt-3 rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                                    お客様メモ: {o.customerNote}
                                  </div>
                                )}

                                {/* ワークフロー & 紐付け情報 */}
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                  {(o.status || 'new') !== 'completed' && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setWorkflowOrder(o) }}
                                      className="rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2 text-xs font-bold text-white shadow hover:from-indigo-700 hover:to-purple-700"
                                    >
                                      🚀 処理ワークフロー
                                    </button>
                                  )}
                                  {o.linkedPoNo && (
                                    <span className="rounded-lg bg-orange-100 px-2 py-1 text-xs text-orange-700">
                                      📋 発注: {o.linkedPoNo}
                                    </span>
                                  )}
                                  {o.linkedInvoiceNo && (
                                    <span className="rounded-lg bg-emerald-100 px-2 py-1 text-xs text-emerald-700">
                                      📄 請求: {o.linkedInvoiceNo}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* ── 決済・注文情報 ── */}
                              <div>
                                <h4 className="mb-2 text-xs font-bold text-gray-600">決済情報</h4>
                                <div className="rounded-lg border border-gray-200 bg-white">
                                  <table className="w-full text-xs">
                                    <tbody className="divide-y divide-gray-100">
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">注文番号</td>
                                        <td className="px-3 py-2 text-right font-mono text-gray-900">{orderNum}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">注文日</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtDate(o.orderDate)}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 text-gray-500">決済方法</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{o.paymentMethod || '—'}</td>
                                      </tr>
                                      {o.campaign && (
                                        <tr>
                                          <td className="px-3 py-2 text-gray-500">キャンペーン</td>
                                          <td className="px-3 py-2 text-right">
                                            <span className="rounded bg-purple-100 px-1.5 py-0.5 text-purple-700">{o.campaign}</span>
                                          </td>
                                        </tr>
                                      )}
                                      <tr className="bg-gray-50">
                                        <td className="px-3 py-2 text-gray-500">商品小計</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtYen(o.subtotal)}</td>
                                      </tr>
                                      <tr className="bg-gray-50">
                                        <td className="px-3 py-2 text-gray-500">送料</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtYen(o.shipping)}</td>
                                      </tr>
                                      <tr className="bg-gray-50">
                                        <td className="px-3 py-2 text-gray-500">消費税</td>
                                        <td className="px-3 py-2 text-right text-gray-900">{fmtYen(o.tax)}</td>
                                      </tr>
                                      <tr>
                                        <td className="px-3 py-2 font-bold text-gray-900">合計（税込）</td>
                                        <td className="px-3 py-2 text-right text-base font-bold text-gray-900">{fmtYen(o.total)}</td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </div>

                                {/* 担当者情報 */}
                                {o.contact && (
                                  <div className="mt-3 rounded-lg border border-gray-200 bg-white px-3 py-2">
                                    <div className="text-xs text-gray-500">担当者</div>
                                    <div className="text-sm text-gray-900">{o.contact}</div>
                                  </div>
                                )}
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
            {filtered.length === orders.length
              ? `全 ${orders.length} 件`
              : `${filtered.length} / ${orders.length} 件表示`}
          </div>
        </div>
      )}

      {/* ── ワークフローモーダル ── */}
      <WorkflowModal
        isOpen={!!workflowOrder}
        onClose={() => { setWorkflowOrder(null); load() }}
        order={workflowOrder}
        salons={salons}
        onOrderUpdate={handleOrderUpdate}
      />
    </div>
  )
}
