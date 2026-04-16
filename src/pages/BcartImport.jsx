import { useRef, useState } from 'react'
import {
  Timestamp,
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { parseBcartEmail } from '../lib/bcartParser.js'
import {
  buildGmailComposeUrl,
  hasReceiptRequest,
} from '../lib/receiptEmail.js'
import ReceiptPrintable from '../components/ReceiptPrintable.jsx'
import { generateReceiptPdf } from '../lib/generateReceiptPdf.js'
import { fetchAllOrders, fetchAllOrderProducts, fetchOrdersSince } from '../lib/bcartApi.js'

export default function BcartImport() {
  const { isAdmin } = useAuth()
  const [rawText, setRawText] = useState('')
  const [parsed, setParsed] = useState(null)
  const [error, setError] = useState('')
  const [matchedSalon, setMatchedSalon] = useState(null)
  const [duplicateOrder, setDuplicateOrder] = useState(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState('')
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const receiptRef = useRef(null)

  // API取り込み用
  const [apiMode, setApiMode] = useState('email') // 'email' | 'api'
  const [apiLoading, setApiLoading] = useState(false)
  const [apiOrders, setApiOrders] = useState([])
  const [apiProducts, setApiProducts] = useState([])
  const [apiResult, setApiResult] = useState('')
  const [apiImporting, setApiImporting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState('')

  const handleReceipt = async () => {
    if (!parsed) return
    setGeneratingPdf(true)
    try {
      // PDF生成 + ダウンロード
      await generateReceiptPdf(receiptRef.current, parsed)
      // Gmail 下書きを新タブで開く
      const url = buildGmailComposeUrl(parsed)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      console.error(e)
      alert('領収書の生成に失敗しました: ' + (e?.message || ''))
    } finally {
      setGeneratingPdf(false)
    }
  }

  // === ワンクリック同期 ===
  const handleOneClickSync = async () => {
    setSyncing(true)
    setSyncResult('')
    try {
      // 過去90日分を取得
      const since = new Date()
      since.setDate(since.getDate() - 90)
      const sinceStr = since.toISOString().slice(0, 10)

      const [orders, products] = await Promise.all([
        fetchOrdersSince(sinceStr),
        fetchAllOrderProducts(),
      ])

      if (orders.length === 0) {
        setSyncResult('新しい受注はありませんでした')
        return
      }

      // 既存の注文番号を取得（重複チェック）
      const existingSnap = await getDocs(collection(db, 'orders'))
      const existingCodes = new Set()
      existingSnap.docs.forEach((d) => {
        const data = d.data()
        if (data.bcartOrderNumber) existingCodes.add(data.bcartOrderNumber)
        if (data.bcartCode) existingCodes.add(data.bcartCode)
      })

      // 注文IDごとの商品明細をマップ
      const prodMap = {}
      products.forEach((p) => {
        if (!prodMap[p.order_id]) prodMap[p.order_id] = []
        prodMap[p.order_id].push(p)
      })

      // サロン名→IDのキャッシュ
      const salonSnap = await getDocs(collection(db, 'salons'))
      const salonMap = {}
      salonSnap.docs.forEach((d) => {
        const data = d.data()
        if (data.name) salonMap[data.name] = d.id
      })

      let imported = 0
      let skipped = 0
      let newSalons = 0

      const batchSize = 200
      for (let i = 0; i < orders.length; i += batchSize) {
        const chunk = orders.slice(i, i + batchSize)
        const batch = writeBatch(db)

        for (const order of chunk) {
          const code = order.code
          if (existingCodes.has(code)) {
            skipped++
            continue
          }

          const companyName = order.customer_comp_name || '（不明）'
          let salonId = salonMap[companyName]

          if (!salonId) {
            const salonRef = doc(collection(db, 'salons'))
            salonId = salonRef.id
            salonMap[companyName] = salonId
            newSalons++
            batch.set(salonRef, {
              name: companyName,
              contact: order.customer_name || '',
              phone: order.customer_tel || '',
              email: order.customer_email || '',
              address: `${order.customer_pref || ''}${order.customer_address1 || ''}${order.customer_address2 || ''}${order.customer_address3 || ''}`,
              zip: order.customer_zip || '',
              department: order.customer_department || '',
              plan: '',
              bcartRegistered: true,
              assignedUid: '',
              notes: 'Bカート同期で自動登録',
              lastOrderDate: Timestamp.fromDate(new Date(order.ordered_at)),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            })
          }

          const items = (prodMap[order.id] || []).map((p) => ({
            name: p.product_name || '',
            sku: p.jan_code || '',
            campaign: p.set_name || '',
            unit: p.set_unit || '',
            price: p.unit_price || 0,
            qty: p.order_pro_count || 1,
          }))

          const orderRef = doc(collection(db, 'orders'))
          batch.set(orderRef, {
            salonId,
            orderDate: Timestamp.fromDate(new Date(order.ordered_at)),
            total: order.final_price || 0,
            subtotal: order.total_price || 0,
            shipping: order.shipping_cost || 0,
            tax: order.tax || 0,
            paymentMethod: order.payment || '',
            campaign: '',
            customerNote: order.customer_message || '',
            items,
            source: 'bcart-api',
            status: 'new',
            bcartOrderNumber: code,
            bcartCode: code,
            bcartOrderId: order.id,
            companyName,
            contact: order.customer_name || '',
            createdAt: serverTimestamp(),
          })

          imported++
        }

        await batch.commit()
      }

      setSyncResult(
        `同期完了: ${imported}件の新規受注を取り込み / ${skipped}件スキップ（取り込み済み）${newSalons > 0 ? ` / ${newSalons}件の新規サロン登録` : ''}`,
      )
    } catch (e) {
      console.error(e)
      setSyncResult('同期エラー: ' + (e?.message || ''))
    } finally {
      setSyncing(false)
    }
  }

  // === API取り込み ===
  const handleApiFetch = async () => {
    setApiLoading(true)
    setApiResult('')
    setApiOrders([])
    try {
      const [orders, products] = await Promise.all([
        fetchAllOrders(),
        fetchAllOrderProducts(),
      ])
      setApiOrders(orders)
      setApiProducts(products)
      setApiResult(`${orders.length}件の受注データを取得しました`)
    } catch (e) {
      console.error(e)
      setApiResult('API取得エラー: ' + (e?.message || ''))
    } finally {
      setApiLoading(false)
    }
  }

  const handleApiImport = async () => {
    if (apiOrders.length === 0) return
    setApiImporting(true)
    setApiResult('')

    try {
      // 既存の注文番号を取得（重複チェック）
      const existingSnap = await getDocs(collection(db, 'orders'))
      const existingCodes = new Set()
      existingSnap.docs.forEach((d) => {
        const data = d.data()
        if (data.bcartOrderNumber) existingCodes.add(data.bcartOrderNumber)
        if (data.bcartCode) existingCodes.add(data.bcartCode)
      })

      // 注文IDごとの商品明細をマップ
      const prodMap = {}
      apiProducts.forEach((p) => {
        if (!prodMap[p.order_id]) prodMap[p.order_id] = []
        prodMap[p.order_id].push(p)
      })

      let imported = 0
      let skipped = 0
      let newSalons = 0

      // サロン名→IDのキャッシュ
      const salonSnap = await getDocs(collection(db, 'salons'))
      const salonMap = {}
      salonSnap.docs.forEach((d) => {
        const data = d.data()
        if (data.name) salonMap[data.name] = d.id
      })

      // バッチ書き込み（500件制限があるので分割）
      const batchSize = 200
      for (let i = 0; i < apiOrders.length; i += batchSize) {
        const chunk = apiOrders.slice(i, i + batchSize)
        const batch = writeBatch(db)

        for (const order of chunk) {
          const code = order.code
          if (existingCodes.has(code)) {
            skipped++
            continue
          }

          const companyName = order.customer_comp_name || '（不明）'
          let salonId = salonMap[companyName]

          // 新規サロン登録
          if (!salonId) {
            const salonRef = doc(collection(db, 'salons'))
            salonId = salonRef.id
            salonMap[companyName] = salonId
            newSalons++
            batch.set(salonRef, {
              name: companyName,
              contact: order.customer_name || '',
              phone: order.customer_tel || '',
              email: order.customer_email || '',
              address: `${order.customer_pref || ''}${order.customer_address1 || ''}${order.customer_address2 || ''}${order.customer_address3 || ''}`,
              zip: order.customer_zip || '',
              department: order.customer_department || '',
              plan: '',
              bcartRegistered: true,
              assignedUid: '',
              notes: 'BカートAPI取り込みで自動登録',
              lastOrderDate: Timestamp.fromDate(new Date(order.ordered_at)),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            })
          }

          // 注文明細
          const items = (prodMap[order.id] || []).map((p) => ({
            name: p.product_name || '',
            sku: p.jan_code || '',
            campaign: p.set_name || '',
            unit: p.set_unit || '',
            price: p.unit_price || 0,
            qty: p.order_pro_count || 1,
          }))

          const orderRef = doc(collection(db, 'orders'))
          batch.set(orderRef, {
            salonId,
            orderDate: Timestamp.fromDate(new Date(order.ordered_at)),
            total: order.final_price || 0,
            subtotal: order.total_price || 0,
            shipping: order.shipping_cost || 0,
            tax: order.tax || 0,
            paymentMethod: order.payment || '',
            campaign: '',
            customerNote: order.customer_message || '',
            items,
            source: 'bcart-api',
            status: 'new',
            bcartOrderNumber: code,
            bcartCode: code,
            bcartOrderId: order.id,
            companyName,
            contact: order.customer_name || '',
            createdAt: serverTimestamp(),
          })

          imported++
        }

        await batch.commit()
      }

      setApiResult(`取り込み完了: ${imported}件登録 / ${skipped}件スキップ（重複）${newSalons > 0 ? ` / ${newSalons}件の新規サロン登録` : ''}`)
      setApiOrders([])
      setApiProducts([])
    } catch (e) {
      console.error(e)
      setApiResult('取り込みエラー: ' + (e?.message || ''))
    } finally {
      setApiImporting(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
        この画面は管理者のみ使用できます
      </div>
    )
  }

  const resetAll = () => {
    setRawText('')
    setParsed(null)
    setError('')
    setSaveResult('')
    setMatchedSalon(null)
    setDuplicateOrder(null)
  }

  const handleParse = async () => {
    setError('')
    setSaveResult('')
    setMatchedSalon(null)
    setDuplicateOrder(null)
    setParsed(null)

    let p
    try {
      p = parseBcartEmail(rawText)
    } catch (e) {
      setError(e.message || '解析に失敗しました')
      return
    }

    setParsed(p)
    setChecking(true)
    try {
      // 重複チェック (bcartOrderNumber)
      const dupQ = query(
        collection(db, 'orders'),
        where('bcartOrderNumber', '==', p.order.orderNumber),
      )
      const dupSnap = await getDocs(dupQ)
      if (!dupSnap.empty) {
        const d = dupSnap.docs[0]
        setDuplicateOrder({ id: d.id, ...d.data() })
      }

      // サロン紐付け (会社名 完全一致)
      const salonQ = query(
        collection(db, 'salons'),
        where('name', '==', p.customer.companyName),
      )
      const salonSnap = await getDocs(salonQ)
      if (!salonSnap.empty) {
        const s = salonSnap.docs[0]
        setMatchedSalon({ id: s.id, ...s.data() })
      }
    } catch (e) {
      console.error(e)
      setError('Firestore 検索に失敗しました: ' + (e?.code || e?.message || ''))
    } finally {
      setChecking(false)
    }
  }

  const handleSave = async () => {
    if (!parsed) return
    if (duplicateOrder) {
      alert('この注文番号は既に登録済みです')
      return
    }

    setSaving(true)
    try {
      const batch = writeBatch(db)
      const orderDateTs = Timestamp.fromDate(parsed.order.orderDate)
      let salonId = matchedSalon?.id
      let createdNewSalon = false

      if (!salonId) {
        // 新規サロン登録
        const salonRef = doc(collection(db, 'salons'))
        salonId = salonRef.id
        createdNewSalon = true
        batch.set(salonRef, {
          name: parsed.customer.companyName,
          contact: parsed.customer.contact,
          phone: parsed.customer.phone,
          email: parsed.customer.email,
          address: parsed.customer.address,
          zip: parsed.customer.zip,
          department: parsed.customer.department || '',
          plan: '',
          bcartRegistered: true,
          assignedUid: '',
          notes: `Bカート取り込みで自動登録（${new Date().toLocaleDateString('ja-JP')}）`,
          lastOrderDate: orderDateTs,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      } else {
        // 既存サロンの lastOrderDate を新しい場合のみ更新
        const existingLast = matchedSalon.lastOrderDate?.toDate
          ? matchedSalon.lastOrderDate.toDate()
          : matchedSalon.lastOrderDate
            ? new Date(matchedSalon.lastOrderDate)
            : null
        const updates = { updatedAt: serverTimestamp() }
        if (!matchedSalon.bcartRegistered) updates.bcartRegistered = true
        if (!existingLast || parsed.order.orderDate > existingLast) {
          updates.lastOrderDate = orderDateTs
        }
        batch.update(doc(db, 'salons', salonId), updates)
      }

      // orders 追加
      const orderRef = doc(collection(db, 'orders'))
      batch.set(orderRef, {
        salonId,
        orderDate: orderDateTs,
        total: parsed.order.total,
        subtotal: parsed.order.subtotal,
        shipping: parsed.order.shipping,
        tax: parsed.order.tax,
        paymentMethod: parsed.order.paymentMethod,
        campaign: parsed.order.campaign || '',
        customerNote: parsed.order.customerNote || '',
        items: parsed.items.map((it) => ({
          name: it.name,
          sku: it.sku || '',
          campaign: it.campaign || '',
          unit: it.unit || '',
          price: it.price,
          qty: it.qty,
        })),
        source: 'bcart-email',
        status: 'new',
        bcartOrderNumber: parsed.order.orderNumber,
        createdAt: serverTimestamp(),
      })

      // 公開領収書（お客様がメールのリンクからダウンロードできるように）
      // 60日間有効
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + 60)
      const publicReceiptRef = doc(collection(db, 'publicReceipts'))
      batch.set(publicReceiptRef, {
        orderNumber: parsed.order.orderNumber,
        email: (parsed.customer.email || '').trim().toLowerCase(),
        companyName: parsed.customer.companyName,
        contact: parsed.customer.contact || '',
        orderDate: orderDateTs,
        paymentMethod: parsed.order.paymentMethod || '',
        subtotal: parsed.order.subtotal,
        shipping: parsed.order.shipping,
        tax: parsed.order.tax,
        total: parsed.order.total,
        expiresAt: Timestamp.fromDate(expiresAt),
        createdAt: serverTimestamp(),
      })

      await batch.commit()
      setSaveResult(
        createdNewSalon
          ? `✓ 保存完了（新規サロン「${parsed.customer.companyName}」を登録しました）`
          : `✓ 保存完了（既存サロン「${parsed.customer.companyName}」に紐付けました）`,
      )
      setRawText('')
      setParsed(null)
      setMatchedSalon(null)
      setDuplicateOrder(null)
    } catch (e) {
      console.error(e)
      alert('保存に失敗しました: ' + (e?.code || e?.message || ''))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-4xl">
      <h1 className="mb-2 text-2xl font-bold text-gray-900">Bカート取り込み</h1>

      {/* ── ワンクリック同期 ── */}
      <div className="mb-6 rounded-2xl border-2 border-indigo-200 bg-indigo-50 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-indigo-900">ワンクリック同期</h2>
            <p className="mt-1 text-xs text-indigo-700">
              過去90日分の受注をBカートAPIから取得し、未登録分を自動取り込みします
            </p>
          </div>
          <button
            onClick={handleOneClickSync}
            disabled={syncing}
            className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {syncing ? '同期中...' : '今すぐ同期'}
          </button>
        </div>
        {syncResult && (
          <div
            className={`mt-4 rounded-lg px-4 py-3 text-sm ${
              syncResult.includes('エラー')
                ? 'bg-red-50 text-red-700'
                : 'bg-green-50 text-green-700'
            }`}
          >
            {syncResult}
          </div>
        )}
      </div>

      {/* タブ切り替え */}
      <div className="mb-6 flex gap-2">
        <button
          onClick={() => setApiMode('api')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            apiMode === 'api'
              ? 'bg-indigo-600 text-white'
              : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          API自動取り込み
        </button>
        <button
          onClick={() => setApiMode('email')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            apiMode === 'email'
              ? 'bg-indigo-600 text-white'
              : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          メール貼り付け
        </button>
      </div>

      {/* === API取り込みモード === */}
      {apiMode === 'api' && (
        <div className="mb-4 space-y-4">
          <div className="rounded-2xl border border-gray-200 bg-white p-6">
            <h2 className="mb-2 text-sm font-bold text-gray-700">BカートAPIから受注データを取得</h2>
            <p className="mb-4 text-xs text-gray-500">
              BカートのAPIに接続し、受注データと商品明細を一括取得します。重複データは自動でスキップされます。
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleApiFetch}
                disabled={apiLoading}
                className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {apiLoading ? 'API取得中...' : 'BカートAPIから取得'}
              </button>
              {apiOrders.length > 0 && (
                <button
                  onClick={handleApiImport}
                  disabled={apiImporting}
                  className="rounded-lg bg-green-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {apiImporting ? '取り込み中...' : `${apiOrders.length}件をFirestoreに取り込む`}
                </button>
              )}
            </div>
            {apiResult && (
              <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${
                apiResult.includes('エラー') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
              }`}>
                {apiResult}
              </div>
            )}
          </div>

          {/* API取得した受注一覧プレビュー */}
          {apiOrders.length > 0 && (
            <div className="rounded-2xl border border-gray-200 bg-white">
              <div className="border-b border-gray-100 bg-gray-50 px-4 py-3 text-xs font-bold text-gray-600">
                取得した受注データ（{apiOrders.length}件）
              </div>
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-left text-xs text-gray-500">
                    <tr>
                      <th className="px-4 py-2">注文コード</th>
                      <th className="px-4 py-2">会社名</th>
                      <th className="px-4 py-2">担当者</th>
                      <th className="px-4 py-2 text-right">合計</th>
                      <th className="px-4 py-2">注文日</th>
                      <th className="px-4 py-2">状態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiOrders.map((o) => (
                      <tr key={o.id} className="border-t border-gray-50 hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono text-xs">{o.code}</td>
                        <td className="px-4 py-2 font-medium text-gray-900">{o.customer_comp_name}</td>
                        <td className="px-4 py-2 text-gray-600">{o.customer_name}</td>
                        <td className="px-4 py-2 text-right font-bold">{(o.final_price || 0).toLocaleString()}円</td>
                        <td className="px-4 py-2 text-xs text-gray-500">{o.ordered_at?.slice(0, 10)}</td>
                        <td className="px-4 py-2">
                          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">{o.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* === メール貼り付けモード === */}
      {apiMode === 'email' && (
      <div>
      <p className="mb-4 text-sm text-gray-500">
        Bカートの受注通知メールを Gmail で開き、本文を全文コピーして下のボックスに貼り付けてください。
      </p>

      <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-6">
        <label className="mb-2 block text-xs text-gray-500">
          Bカート受注メール本文
        </label>
        <textarea
          rows={12}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder="例）「この度はご注文ありがとうございます。下記の内容で...」で始まるメール本文を貼り付け"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-indigo-500 focus:outline-none"
        />
        <div className="mt-3 flex gap-2">
          <button
            onClick={handleParse}
            disabled={!rawText.trim() || checking}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {checking ? '解析中...' : '解析'}
          </button>
          <button
            onClick={resetAll}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            クリア
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          ❌ {error}
        </div>
      )}

      {saveResult && (
        <div className="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
          {saveResult}
        </div>
      )}

      {parsed && (
        <div className="space-y-4">
          {duplicateOrder && (
            <div className="rounded-lg bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
              ⚠️ この注文番号「{parsed.order.orderNumber}」は既に登録済みです。重複保存はブロックされます。
            </div>
          )}

          {hasReceiptRequest(parsed.order.customerNote) && (
            <div className="rounded-lg border-2 border-orange-300 bg-orange-50 px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-orange-800">
                📄 お客様が領収書の発行を希望しています
              </div>
              <div className="mb-3 text-xs text-orange-700">
                「{parsed.order.customerNote}」
              </div>
              <button
                onClick={handleReceipt}
                disabled={generatingPdf}
                className="inline-block rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {generatingPdf
                  ? 'PDF 生成中...'
                  : '📄 領収書PDF発行 + Gmailで送信'}
              </button>
              <div className="mt-2 space-y-1 text-xs text-orange-700">
                <p>
                  ① PDF領収書がパソコンに自動ダウンロードされます
                </p>
                <p>
                  ② 同時に Gmail の下書きが新タブで開きます
                </p>
                <p>
                  ③ ダウンロードされたPDFを Gmail 画面にドラッグして添付
                </p>
                <p>
                  ④ 内容を確認して「送信」ボタンを押す
                </p>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-gray-200 bg-white p-6">
            <h2 className="mb-3 text-lg font-semibold text-gray-900">
              サロン情報
            </h2>
            {matchedSalon ? (
              <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
                ✓ 既存サロンに紐付けます: <strong>{matchedSalon.name}</strong>
              </div>
            ) : (
              <div className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
                + 新規サロンとして自動登録します
              </div>
            )}
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                <tr>
                  <td className="w-32 py-1 text-gray-500">会社名</td>
                  <td>{parsed.customer.companyName}</td>
                </tr>
                {parsed.customer.department && (
                  <tr>
                    <td className="py-1 text-gray-500">部署名</td>
                    <td>{parsed.customer.department}</td>
                  </tr>
                )}
                <tr>
                  <td className="py-1 text-gray-500">担当者</td>
                  <td>{parsed.customer.contact}</td>
                </tr>
                <tr>
                  <td className="py-1 text-gray-500">郵便番号</td>
                  <td>{parsed.customer.zip}</td>
                </tr>
                <tr>
                  <td className="py-1 text-gray-500">住所</td>
                  <td>{parsed.customer.address}</td>
                </tr>
                <tr>
                  <td className="py-1 text-gray-500">電話</td>
                  <td>{parsed.customer.phone}</td>
                </tr>
                {parsed.customer.mobile && (
                  <tr>
                    <td className="py-1 text-gray-500">携帯</td>
                    <td>{parsed.customer.mobile}</td>
                  </tr>
                )}
                <tr>
                  <td className="py-1 text-gray-500">メール</td>
                  <td>{parsed.customer.email}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-6">
            <h2 className="mb-3 text-lg font-semibold text-gray-900">注文情報</h2>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                <tr>
                  <td className="w-32 py-1 text-gray-500">注文番号</td>
                  <td className="font-mono">{parsed.order.orderNumber}</td>
                </tr>
                <tr>
                  <td className="py-1 text-gray-500">注文日時</td>
                  <td>{parsed.order.orderDate.toLocaleString('ja-JP')}</td>
                </tr>
                <tr>
                  <td className="py-1 text-gray-500">決済方法</td>
                  <td>{parsed.order.paymentMethod || '—'}</td>
                </tr>
                {parsed.order.campaign && (
                  <tr>
                    <td className="py-1 text-gray-500">キャンペーン</td>
                    <td>
                      <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700">
                        {parsed.order.campaign}
                      </span>
                    </td>
                  </tr>
                )}
                <tr>
                  <td className="py-1 text-gray-500">商品総額（税抜）</td>
                  <td>¥{parsed.order.subtotal.toLocaleString('ja-JP')}</td>
                </tr>
                <tr>
                  <td className="py-1 text-gray-500">送料</td>
                  <td>¥{parsed.order.shipping.toLocaleString('ja-JP')}</td>
                </tr>
                <tr>
                  <td className="py-1 text-gray-500">消費税</td>
                  <td>¥{parsed.order.tax.toLocaleString('ja-JP')}</td>
                </tr>
                <tr>
                  <td className="py-1 font-semibold text-gray-900">
                    注文総額（税込）
                  </td>
                  <td className="font-semibold">
                    ¥{parsed.order.total.toLocaleString('ja-JP')}
                  </td>
                </tr>
                {parsed.order.customerNote && (
                  <tr>
                    <td className="py-1 text-gray-500 align-top">
                      お客様メモ
                    </td>
                    <td className="whitespace-pre-wrap text-gray-700">
                      📝 {parsed.order.customerNote}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-6">
            <h2 className="mb-3 text-lg font-semibold text-gray-900">
              商品明細（{parsed.items.length}件）
            </h2>
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2">商品名</th>
                    <th className="px-3 py-2">品番</th>
                    <th className="px-3 py-2 text-right">単価</th>
                    <th className="px-3 py-2 text-right">数量</th>
                    <th className="px-3 py-2 text-right">小計</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.items.map((it, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="px-3 py-2">{it.name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500">
                        {it.sku || '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        ¥{it.price.toLocaleString('ja-JP')}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {it.qty}
                        {it.unit ? `（${it.unit}）` : ''}
                      </td>
                      <td className="px-3 py-2 text-right">
                        ¥{it.subtotal.toLocaleString('ja-JP')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            {!hasReceiptRequest(parsed.order.customerNote) && (
              <button
                onClick={handleReceipt}
                disabled={generatingPdf}
                className="rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {generatingPdf ? 'PDF 生成中...' : '📄 領収書PDF発行'}
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving || !!duplicateOrder}
              className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving
                ? '保存中...'
                : duplicateOrder
                  ? '既に登録済み'
                  : '保存する'}
            </button>
          </div>
        </div>
      )}

      {/* 画面外にレンダリング: html2canvas 用 PDF テンプレート */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: '-10000px',
          pointerEvents: 'none',
          opacity: 0,
        }}
        aria-hidden
      >
        {parsed && <ReceiptPrintable ref={receiptRef} parsed={parsed} />}
      </div>
      </div>
      )}
    </div>
  )
}
