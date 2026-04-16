import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { generateInvoicePdf } from '../lib/generateInvoicePdf.js'
import { fetchOrdersByMonth, fetchOrderProductsBatch, fetchLogisticsByIds } from '../lib/bcartApi.js'

function fmtYen(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString() + '円'
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

const currentMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const STATUS_LABELS = {
  draft: '作成済',
  sent: '送付済',
  awaiting: '入金待ち',
  paid: '入金済',
}

const STATUS_COLORS = {
  draft: 'bg-gray-100 text-gray-700',
  sent: 'bg-blue-100 text-blue-700',
  awaiting: 'bg-yellow-100 text-yellow-700',
  paid: 'bg-green-100 text-green-700',
}

const NEXT_STATUS = {
  draft: 'sent',
  sent: 'awaiting',
  awaiting: 'paid',
}

const NEXT_LABEL = {
  draft: '送付済にする',
  sent: '入金待ちにする',
  awaiting: '入金済にする',
}

export default function InvoiceManage() {
  const [searchParams] = useSearchParams()
  const [dealers, setDealers] = useState([])
  const [selectedCode, setSelectedCode] = useState(searchParams.get('dealer') || '')
  const [month, setMonth] = useState(currentMonth())
  const [loading, setLoading] = useState(true)

  const [salonLinks, setSalonLinks] = useState([])
  const [invoices, setInvoices] = useState([])

  const [apiFetching, setApiFetching] = useState(false)
  const [apiProgress, setApiProgress] = useState('')

  const [calcResult, setCalcResult] = useState(null)

  const [stampDataUrl, setStampDataUrl] = useState(null)
  const [companyInfo, setCompanyInfo] = useState(null)

  const [confirmAction, setConfirmAction] = useState(null)

  // 初期データ取得
  useEffect(() => {
    ;(async () => {
      try {
        const [dealerSnap, linkSnap] = await Promise.all([
          getDocs(collection(db, 'allowedEmails')),
          getDocs(collection(db, 'dealerSalons')),
        ])

        const allDealers = dealerSnap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((d) => d.role === 'dealer' && d.dealerCode)

        const groupCDealers = allDealers.filter((d) => d.kbGroup === 'C')
        setDealers(groupCDealers)
        if (groupCDealers.length > 0 && !selectedCode) {
          setSelectedCode(groupCDealers[0].dealerCode)
        }

        setSalonLinks(linkSnap.docs.map((d) => ({ id: d.id, ...d.data() })))

        try {
          const [stampDoc, compDoc] = await Promise.all([
            getDoc(doc(db, 'settings', 'companyStamp')),
            getDoc(doc(db, 'settings', 'company')),
          ])
          if (stampDoc.exists() && stampDoc.data().dataUrl) setStampDataUrl(stampDoc.data().dataUrl)
          if (compDoc.exists()) setCompanyInfo(compDoc.data())
        } catch (e) {
          console.warn('設定読み込みスキップ:', e.message)
        }
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // 請求書一覧を取得
  useEffect(() => {
    if (!selectedCode) return
    ;(async () => {
      const snap = await getDocs(
        query(collection(db, 'invoices'), where('dealerCode', '==', selectedCode))
      )
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      list.sort((a, b) => (b.month || '').localeCompare(a.month || ''))
      setInvoices(list)
    })()
  }, [selectedCode])

  const selectedDealer = dealers.find((d) => d.dealerCode === selectedCode)
  const existingInvoice = invoices.find((inv) => inv.month === month)

  // === BカートAPI取得 ===
  const handleApiFetch = async () => {
    if (!month || !selectedCode) { alert('代理店と対象月を選択してください'); return }
    setApiFetching(true)
    setApiProgress('受注データを取得中...')
    try {
      const allOrders = await fetchOrdersByMonth(month, (fetched, total) => {
        setApiProgress(`受注データ取得中... ${fetched}/${total}件`)
      })
      if (allOrders.length === 0) {
        alert(`${month} の受注データが見つかりません`)
        return
      }

      // グループCは代理店自身の注文を抽出（会社名で特定）
      const ownCompanyNames = salonLinks
        .filter((s) => s.dealerCode === selectedCode && s.type === 'own')
        .map((s) => s.companyName.replace(/\s/g, ''))
      const dealerCompName = (selectedDealer?.companyName || '').replace(/\s/g, '')
      if (ownCompanyNames.length === 0 && dealerCompName) {
        ownCompanyNames.push(dealerCompName)
      }

      const dealerOrders = allOrders.filter((o) => {
        const comp = (o.customer_comp_name || '').replace(/\s/g, '')
        if (!comp) return false // 会社名なしの注文は除外
        return ownCompanyNames.some((n) => comp === n || comp.includes(n) || n.includes(comp))
      })

      if (dealerOrders.length === 0) {
        alert(`${month} の ${selectedDealer?.companyName || selectedCode} の受注データが見つかりません`)
        return
      }

      setApiProgress(`${dealerOrders.length}件の受注。明細を取得中...`)

      // 明細取得
      const orderIds = dealerOrders.map((o) => o.id)
      const allProducts = await fetchOrderProductsBatch(
        orderIds,
        (done, total) => setApiProgress(`明細取得中... ${done}/${total}受注`)
      )

      // 出荷情報（配送先）取得: order_products の logistics_id から紐付け
      const logisticsIdSet = new Set()
      allProducts.forEach((p) => { if (p.logistics_id) logisticsIdSet.add(p.logistics_id) })
      const uniqueLogisticsIds = [...logisticsIdSet]

      let logisticsMap = {}
      if (uniqueLogisticsIds.length > 0) {
        setApiProgress(`配送先取得中... 0/${uniqueLogisticsIds.length}件`)
        logisticsMap = await fetchLogisticsByIds(
          uniqueLogisticsIds,
          (done, total) => setApiProgress(`配送先取得中... ${done}/${total}件`)
        )
      }

      setApiProgress('集計中...')

      // 注文単位でデータを構築
      const orders = dealerOrders.map((o) => {
        const orderProducts = allProducts.filter((p) => p.order_id === o.id)
        // 注文内の最初の商品の logistics_id から配送先を取得
        const logisticsId = orderProducts.find((p) => p.logistics_id)?.logistics_id
        const logistics = logisticsId ? logisticsMap[logisticsId] : null

        return {
          orderNumber: o.code || String(o.id),
          orderedAt: o.ordered_at || '',
          payment: o.payment || '',
          shippedAt: logistics?.shipment_date || '',
          deliveryZip: logistics?.zip || '',
          deliveryAddress: ((logistics?.pref || '') + (logistics?.address1 || '') + (logistics?.address2 || '') + (logistics?.address3 || '')).trim(),
          deliveryTel: logistics?.tel || '',
          deliveryName: (logistics?.comp_name ? logistics.comp_name + ' ' : '') + (logistics?.name || ''),
          deliveryDate: logistics?.due_date || '',
          itemCount: orderProducts.reduce((s, p) => s + (p.order_pro_count || 0), 0),
          subtotal: orderProducts.reduce((s, p) => s + (p.unit_price || 0) * (p.order_pro_count || 0), 0),
          tax: Math.round(orderProducts.reduce((s, p) => s + (p.unit_price || 0) * (p.order_pro_count || 0), 0) * 0.1),
          total: orderProducts.reduce((s, p) => s + (p.unit_price || 0) * (p.order_pro_count || 0), 0) + Math.round(orderProducts.reduce((s, p) => s + (p.unit_price || 0) * (p.order_pro_count || 0), 0) * 0.1),
          items: orderProducts.map((p) => ({
            productName: (p.product_name || '') + (p.set_name ? ' / ' + p.set_name : ''),
            sku: p.product_code || '',
            unitPrice: p.unit_price || 0,
            inputCount: p.input_count || 1,
            quantity: p.order_pro_count || 0,
            totalQuantity: (p.order_pro_count || 0) * (p.input_count || 1),
            subtotal: (p.unit_price || 0) * (p.order_pro_count || 0),
          })),
        }
      }).sort((a, b) => (b.orderedAt || '').localeCompare(a.orderedAt || ''))

      const orderNumbers = orders.map((o) => o.orderNumber)
      const subtotal = orders.reduce((s, o) => s + o.subtotal, 0)
      const tax = Math.round(subtotal * 0.1)
      const grandTotal = subtotal + tax

      setCalcResult({ orders, orderNumbers, subtotal, tax, grandTotal, orderCount: orders.length })
      setApiProgress('')
    } catch (e) {
      console.error('API取得エラー:', e)
      alert('データ取得エラー: ' + e.message)
    } finally {
      setApiFetching(false)
    }
  }

  // === 請求書保存 ===
  const handleSave = async () => {
    if (!calcResult || !selectedCode || !month) return

    const invoiceData = {
      dealerCode: selectedCode,
      dealerName: selectedDealer?.companyName || selectedCode,
      dealerZip: selectedDealer?.zipCode || '',
      dealerAddress: selectedDealer?.address || '',
      month,
      orders: calcResult.orders,
      orderNumbers: calcResult.orderNumbers,
      subtotal: calcResult.subtotal,
      tax: calcResult.tax,
      grandTotal: calcResult.grandTotal,
      orderCount: calcResult.orderCount,
      status: 'draft',
      stampDataUrl,
      companyInfo,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }

    if (existingInvoice) {
      await updateDoc(doc(db, 'invoices', existingInvoice.id), {
        ...invoiceData,
        status: existingInvoice.status,
        createdAt: existingInvoice.createdAt,
      })
      setInvoices((prev) =>
        prev.map((inv) =>
          inv.id === existingInvoice.id
            ? { ...inv, ...invoiceData, status: existingInvoice.status }
            : inv
        )
      )
    } else {
      const ref = await addDoc(collection(db, 'invoices'), invoiceData)
      setInvoices((prev) => [{ id: ref.id, ...invoiceData }, ...prev])
    }

    alert('請求書を保存しました')
  }

  // === ステータス更新 ===
  const handleStatusChange = async (inv, newStatus) => {
    await updateDoc(doc(db, 'invoices', inv.id), {
      status: newStatus,
      updatedAt: serverTimestamp(),
      [`${newStatus}At`]: serverTimestamp(),
    })
    setInvoices((prev) =>
      prev.map((i) => (i.id === inv.id ? { ...i, status: newStatus } : i))
    )
    setConfirmAction(null)
  }

  // === 請求書番号の自動採番 ===
  const assignInvoiceNo = async (inv) => {
    if (inv.invoiceNo) return inv.invoiceNo
    const now = new Date()
    const ym = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`
    const counterDocId = 'rt_docCounters'
    const counterKey = `dealer_invoice_${ym}`

    const newNo = await runTransaction(db, async (tx) => {
      const counterRef = doc(db, 'settings', counterDocId)
      const counterDoc = await tx.get(counterRef)
      const counters = counterDoc.exists() ? counterDoc.data() : {}
      const seq = (counters[counterKey] || 0) + 1
      tx.set(counterRef, { ...counters, [counterKey]: seq }, { merge: true })
      return `DINV${ym}-${String(seq).padStart(3, '0')}`
    })

    await updateDoc(doc(db, 'invoices', inv.id), { invoiceNo: newNo, updatedAt: serverTimestamp() })
    setInvoices((prev) => prev.map((i) => i.id === inv.id ? { ...i, invoiceNo: newNo } : i))
    return newNo
  }

  // === 請求書PDF ===
  const handleDownloadPdf = async (inv) => {
    const invoiceNo = await assignInvoiceNo(inv)
    await generateInvoicePdf({
      ...inv,
      invoiceNo,
      companyInfo: inv.companyInfo || companyInfo,
      stampDataUrl: inv.stampDataUrl || stampDataUrl,
    })
  }

  // === 請求書削除 ===
  const handleDelete = async (inv) => {
    if (inv.status !== 'draft') {
      alert('作成済ステータスの請求書のみ削除できます')
      return
    }
    await deleteDoc(doc(db, 'invoices', inv.id))
    setInvoices((prev) => prev.filter((i) => i.id !== inv.id))
  }

  // === CSV ===
  const handleCsvDownload = (inv) => {
    const BOM = '\uFEFF'
    const rows = [['注文番号', '注文日', '品名', '単価', '数量', '金額（税抜）']]
    for (const order of (inv.orders || [])) {
      for (const item of (order.items || [])) {
        rows.push([order.orderNumber, order.orderedAt?.split(' ')[0] || '', item.productName, item.unitPrice, item.quantity, item.subtotal])
      }
    }
    rows.push([])
    rows.push(['小計（税抜）', '', '', '', '', inv.subtotal])
    rows.push(['消費税10%', '', '', '', '', inv.tax])
    rows.push(['合計（税込）', '', '', '', '', inv.grandTotal])

    const safeCsv = (v) => {
      const s = String(v ?? '').replace(/"/g, '""')
      return /^[+=\-@]/.test(s) ? `"'${s}"` : `"${s}"`
    }
    const csv = BOM + rows.map((r) => r.map(safeCsv).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `請求書_${inv.dealerCode}_${inv.month.replace('-', '')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-gray-400">読み込み中...</div>
  }

  if (dealers.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center">
        <p className="text-sm text-gray-400">グループCの代理店が登録されていません</p>
        <p className="mt-1 text-xs text-gray-300">代理店管理でKBグループを「C」に設定してください</p>
      </div>
    )
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-gray-900">請求書管理</h1>
      <p className="mb-6 text-sm text-gray-500">グループC代理店向けの請求書作成・ステータス管理</p>

      {/* 代理店・月選択 */}
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">代理店</label>
          <select
            value={selectedCode}
            onChange={(e) => { setSelectedCode(e.target.value); setCalcResult(null) }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            {dealers.map((d) => (
              <option key={d.dealerCode} value={d.dealerCode}>
                {d.dealerCode} — {d.companyName || d.email}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">対象月</label>
          <input
            type="month"
            value={month}
            onChange={(e) => { setMonth(e.target.value); setCalcResult(null) }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={handleApiFetch}
          disabled={apiFetching}
          className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {apiFetching ? 'API取得中...' : 'BカートAPI取得'}
        </button>
        {apiProgress && <span className="text-xs text-gray-400">{apiProgress}</span>}
      </div>

      {existingInvoice && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          この月の請求書は既に作成済です（ステータス：{STATUS_LABELS[existingInvoice.status]}）。
          再取得して保存すると上書きされます。
        </div>
      )}

      {/* 計算結果プレビュー */}
      {calcResult && (
        <div className="mb-8">
          <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold text-emerald-800">請求プレビュー</h2>
              <button
                onClick={handleSave}
                className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                {existingInvoice ? '上書き保存' : '請求書を保存'}
              </button>
            </div>

            <div className="mb-4 grid grid-cols-4 gap-4">
              <div className="rounded-lg bg-white p-3 text-center">
                <div className="text-xs text-gray-500">注文件数</div>
                <div className="text-lg font-bold text-gray-900">{calcResult.orderCount}件</div>
              </div>
              <div className="rounded-lg bg-white p-3 text-center">
                <div className="text-xs text-gray-500">小計（税抜）</div>
                <div className="text-lg font-bold text-gray-900">{fmtYen(calcResult.subtotal)}</div>
              </div>
              <div className="rounded-lg bg-white p-3 text-center">
                <div className="text-xs text-gray-500">消費税 10%</div>
                <div className="text-lg font-bold text-gray-900">{fmtYen(calcResult.tax)}</div>
              </div>
              <div className="rounded-lg bg-emerald-600 p-3 text-center text-white">
                <div className="text-xs opacity-80">合計（税込）</div>
                <div className="text-xl font-bold">{fmtYen(calcResult.grandTotal)}</div>
              </div>
            </div>

            {/* 注文別一覧 */}
            <div className="overflow-auto rounded-lg border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                    <th className="px-4 py-2">注文番号</th>
                    <th className="px-4 py-2">注文日</th>
                    <th className="px-4 py-2">決済方法</th>
                    <th className="px-4 py-2">配送先</th>
                    <th className="px-4 py-2 text-right">商品数</th>
                    <th className="px-4 py-2 text-right">金額（税込）</th>
                  </tr>
                </thead>
                <tbody>
                  {calcResult.orders.map((o) => (
                    <tr key={o.orderNumber} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-xs">{o.orderNumber}</td>
                      <td className="px-4 py-2 text-xs">{o.orderedAt?.split(' ')[0]}</td>
                      <td className="px-4 py-2 text-xs">{o.payment}</td>
                      <td className="px-4 py-2 text-xs truncate max-w-[200px]">{o.deliveryName}</td>
                      <td className="px-4 py-2 text-right">{o.itemCount}</td>
                      <td className="px-4 py-2 text-right font-bold">{fmtYen(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-emerald-500 bg-emerald-50 font-bold">
                    <td colSpan={5} className="px-4 py-2">合計（税込）</td>
                    <td className="px-4 py-2 text-right">{fmtYen(calcResult.grandTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 請求書一覧 */}
      <h2 className="mb-3 text-sm font-bold text-gray-700">請求書一覧</h2>
      {invoices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          請求書がまだありません
        </div>
      ) : (
        <div className="space-y-3">
          {invoices.map((inv) => (
            <div key={inv.id} className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[inv.status]}`}>
                    {STATUS_LABELS[inv.status]}
                  </span>
                  <span className="text-sm font-bold text-gray-900">
                    {inv.month?.replace('-', '年') + '月'}
                  </span>
                  <span className="text-sm text-gray-500">
                    {inv.dealerName || inv.dealerCode}
                  </span>
                  {inv.invoiceNo && (
                    <span className="font-mono text-xs text-gray-400">{inv.invoiceNo}</span>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-400">請求金額（税込）</div>
                  <div className="text-lg font-bold text-emerald-600">{fmtYen(inv.grandTotal)}</div>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-3 text-xs text-gray-400">
                <span>注文件数：{inv.orderCount || (inv.orders || []).length}件</span>
                <span>小計：{fmtYen(inv.subtotal)}</span>
                <span>消費税：{fmtYen(inv.tax)}</span>
                {inv.createdAt && <span>作成：{fmtDate(inv.createdAt)}</span>}
                {inv.sentAt && <span>送付：{fmtDate(inv.sentAt)}</span>}
                {inv.paidAt && <span>入金：{fmtDate(inv.paidAt)}</span>}
              </div>

              <div className="mt-3 flex items-center gap-2">
                {NEXT_STATUS[inv.status] && (
                  <button
                    onClick={() => setConfirmAction({ inv, newStatus: NEXT_STATUS[inv.status] })}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                  >
                    {NEXT_LABEL[inv.status]}
                  </button>
                )}
                <button
                  onClick={() => handleDownloadPdf(inv)}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  PDF
                </button>
                <button
                  onClick={() => handleCsvDownload(inv)}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  CSV
                </button>
                {inv.status === 'draft' && (
                  <button
                    onClick={() => setConfirmAction({ inv, action: 'delete' })}
                    className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                  >
                    削除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 確認モーダル */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            {confirmAction.action === 'delete' ? (
              <>
                <h3 className="mb-2 text-lg font-bold text-gray-900">請求書を削除しますか？</h3>
                <p className="mb-4 text-sm text-gray-500">
                  {confirmAction.inv.month?.replace('-', '年') + '月'} の請求書を削除します。この操作は元に戻せません。
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setConfirmAction(null)}
                    className="flex-1 rounded-lg border border-gray-300 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={() => { handleDelete(confirmAction.inv); setConfirmAction(null) }}
                    className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-medium text-white hover:bg-red-700"
                  >
                    削除する
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="mb-2 text-lg font-bold text-gray-900">ステータスを変更しますか？</h3>
                <p className="mb-4 text-sm text-gray-500">
                  {confirmAction.inv.month?.replace('-', '年') + '月'} の請求書を
                  「{STATUS_LABELS[confirmAction.inv.status]}」→「{STATUS_LABELS[confirmAction.newStatus]}」に変更します。
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setConfirmAction(null)}
                    className="flex-1 rounded-lg border border-gray-300 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={() => handleStatusChange(confirmAction.inv, confirmAction.newStatus)}
                    className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                  >
                    変更する
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
