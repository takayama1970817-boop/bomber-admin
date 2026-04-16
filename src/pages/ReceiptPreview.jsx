import { useRef, useState } from 'react'
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import ReceiptPrintable from '../components/ReceiptPrintable.jsx'
import { generateReceiptPdf } from '../lib/generateReceiptPdf.js'
import { useAuth } from '../contexts/AuthContext.jsx'

// テスト用サンプルデータ（実在のメール構造を模したダミー）
const SAMPLE_PARSED = {
  customer: {
    companyName: 'サンプル美容サロン 渋谷店',
    department: '',
    contact: '山田 花子',
    zip: '150-0002',
    address: '東京都渋谷区渋谷1-1-1 サンプルビル2F',
    email: 'sample@example.com',
    phone: '03-1234-5678',
    mobile: '',
  },
  order: {
    orderNumber: 'TEST00000001',
    orderDate: new Date(),
    paymentMethod: 'クレジットカード決済',
    subtotal: 38090,
    shipping: 0,
    total: 41899,
    tax: 3809,
    campaign: '',
    customerNote: '領収書お願いいたします',
  },
  items: [
    {
      name: 'VAVITTE（ヴァヴィッテ）ハーブローション【店】150ml',
      sku: '4589841830060',
      campaign: '',
      unit: '個',
      price: 4420,
      qty: 1,
      subtotal: 4420,
    },
    {
      name: 'VAVITTE（ヴァヴィッテ）ハーブビタミンクリーム【店】50g',
      sku: '4589841830084',
      campaign: '',
      unit: '個',
      price: 6500,
      qty: 1,
      subtotal: 6500,
    },
    {
      name: 'VAVITTE（ヴァヴィッテ）ハーブディープジェル【店】50ml',
      sku: '4589841830053',
      campaign: '',
      unit: '個',
      price: 5200,
      qty: 1,
      subtotal: 5200,
    },
    {
      name: 'VAVITTE（ヴァヴィッテ）ハーブクレンジングミルク【店】150g',
      sku: '4589841830046',
      campaign: '',
      unit: '個',
      price: 4420,
      qty: 1,
      subtotal: 4420,
    },
    {
      name: 'VAVITTE（ヴァヴィッテ）ハーブディープジェル【業務用】100ml',
      sku: '4589841830114',
      campaign: '',
      unit: '個',
      price: 7800,
      qty: 1,
      subtotal: 7800,
    },
    {
      name: 'VAVITTE（ヴァヴィッテ）ハーブビタミンセラム【店】30ml',
      sku: '4589841830077',
      campaign: '',
      unit: '個',
      price: 9750,
      qty: 1,
      subtotal: 9750,
    },
  ],
}

export default function ReceiptPreview() {
  const { isAdmin } = useAuth()
  const receiptRef = useRef(null)

  if (!isAdmin) {
    return (
      <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
        この画面は管理者のみ使用できます
      </div>
    )
  }

  const [testUrl, setTestUrl] = useState('')
  const [seeding, setSeeding] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [migrateResult, setMigrateResult] = useState('')

  const handleGenerate = async () => {
    try {
      await generateReceiptPdf(receiptRef.current, SAMPLE_PARSED)
    } catch (e) {
      alert('PDF生成に失敗しました: ' + (e?.message || ''))
    }
  }

  // テスト用：publicReceipts にサンプルデータを登録して公開URLを生成
  const handleSeedTest = async () => {
    setSeeding(true)
    try {
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + 60)
      const ref = doc(collection(db, 'publicReceipts'))
      await setDoc(ref, {
        orderNumber: SAMPLE_PARSED.order.orderNumber,
        email: SAMPLE_PARSED.customer.email.trim().toLowerCase(),
        companyName: SAMPLE_PARSED.customer.companyName,
        contact: SAMPLE_PARSED.customer.contact,
        orderDate: Timestamp.fromDate(SAMPLE_PARSED.order.orderDate),
        paymentMethod: SAMPLE_PARSED.order.paymentMethod,
        subtotal: SAMPLE_PARSED.order.subtotal,
        shipping: SAMPLE_PARSED.order.shipping,
        tax: SAMPLE_PARSED.order.tax,
        total: SAMPLE_PARSED.order.total,
        expiresAt: Timestamp.fromDate(expiresAt),
        createdAt: serverTimestamp(),
      })
      const url = `${window.location.origin}/receipt?order=${encodeURIComponent(SAMPLE_PARSED.order.orderNumber)}&mail=${encodeURIComponent(SAMPLE_PARSED.customer.email)}`
      setTestUrl(url)
    } catch (e) {
      alert('テストデータの登録に失敗しました: ' + (e?.message || ''))
    } finally {
      setSeeding(false)
    }
  }

  // 既存の全注文に publicReceipts を一括生成
  const handleMigrateAll = async () => {
    if (!confirm('既存の全注文に対して公開領収書データを生成します。よろしいですか？')) return
    setMigrating(true)
    setMigrateResult('')
    try {
      // 1. 全注文を取得
      const ordersSnap = await getDocs(collection(db, 'orders'))
      if (ordersSnap.empty) {
        setMigrateResult('注文データが0件です')
        return
      }

      // 2. 全サロンを取得（salonId → salon データのマップ）
      const salonsSnap = await getDocs(collection(db, 'salons'))
      const salonsMap = {}
      salonsSnap.forEach((d) => { salonsMap[d.id] = d.data() })

      // 3. 既存の publicReceipts の orderNumber を取得（重複スキップ用）
      const existingSnap = await getDocs(collection(db, 'publicReceipts'))
      const existingOrders = new Set()
      existingSnap.forEach((d) => { existingOrders.add(d.data().orderNumber) })

      // 4. バッチ書き込み（Firestore は1バッチ最大500件）
      let created = 0
      let skipped = 0
      let batch = writeBatch(db)
      let batchCount = 0

      for (const orderDoc of ordersSnap.docs) {
        const order = orderDoc.data()
        const orderNumber = order.bcartOrderNumber || ''
        if (!orderNumber) { skipped++; continue }
        if (existingOrders.has(orderNumber)) { skipped++; continue }

        const salon = salonsMap[order.salonId] || {}
        const email = (salon.email || '').trim().toLowerCase()
        if (!email) { skipped++; continue }

        const expiresAt = new Date()
        expiresAt.setDate(expiresAt.getDate() + 60)

        const ref = doc(collection(db, 'publicReceipts'))
        batch.set(ref, {
          orderNumber,
          email,
          companyName: salon.name || '',
          contact: salon.contact || '',
          orderDate: order.orderDate || null,
          paymentMethod: order.paymentMethod || '',
          subtotal: order.subtotal || 0,
          shipping: order.shipping || 0,
          tax: order.tax || 0,
          total: order.total || 0,
          expiresAt: Timestamp.fromDate(expiresAt),
          createdAt: serverTimestamp(),
        })

        created++
        batchCount++

        // 500件ごとにコミット
        if (batchCount >= 400) {
          await batch.commit()
          batch = writeBatch(db)
          batchCount = 0
        }
      }

      if (batchCount > 0) await batch.commit()

      setMigrateResult(`✅ 完了！ ${created}件 生成 / ${skipped}件 スキップ（重複・データ不足）`)
    } catch (e) {
      console.error(e)
      setMigrateResult('❌ エラー: ' + (e?.message || ''))
    } finally {
      setMigrating(false)
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            領収書プレビュー（A4サイズ）
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            サンプルデータで領収書の仕上がりを確認できます。下のプレビューは実際のA4サイズ（210mm × 297mm）です。
          </p>
        </div>
        <button
          onClick={handleGenerate}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          📄 PDF生成テスト
        </button>
      </div>

      {/* 公開URL テストボタン */}
      <div className="mb-4 rounded-2xl border border-blue-200 bg-blue-50 p-4">
        <div className="mb-2 text-sm font-semibold text-blue-800">
          🔗 お客様向け公開ページのテスト
        </div>
        <p className="mb-3 text-xs text-blue-700">
          サンプルデータで公開領収書ページを確認できます。
        </p>
        {!testUrl ? (
          <button
            onClick={handleSeedTest}
            disabled={seeding}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {seeding ? '登録中...' : '📎 テスト用公開URLを生成'}
          </button>
        ) : (
          <div>
            <div className="mb-2 text-xs text-blue-700">✅ テストデータ登録完了！下のリンクを開いてください：</div>
            <a
              href={testUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block break-all rounded-lg bg-white px-3 py-2 text-sm text-blue-700 underline hover:text-blue-900"
            >
              {testUrl}
            </a>
            <p className="mt-2 text-xs text-blue-600">
              ↑ お客様が見る画面です。PDFダウンロードボタンが動くか確認してください。
            </p>
          </div>
        )}
      </div>

      {/* 一括生成 */}
      <div className="mb-4 rounded-2xl border border-green-200 bg-green-50 p-4">
        <div className="mb-2 text-sm font-semibold text-green-800">
          🔄 既存注文の一括生成
        </div>
        <p className="mb-3 text-xs text-green-700">
          既に保存済みの全注文に対して、公開領収書データを一括生成します。既に生成済みの注文はスキップされます。
        </p>
        <button
          onClick={handleMigrateAll}
          disabled={migrating}
          className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          {migrating ? '生成中...' : '⚡ 全注文の公開領収書を一括生成'}
        </button>
        {migrateResult && (
          <div className="mt-3 rounded-lg bg-white px-3 py-2 text-sm text-green-800">
            {migrateResult}
          </div>
        )}
      </div>

      <div className="mb-4 rounded-lg bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
        📌 印影画像（社印）が表示されない場合は、
        <code className="mx-1 rounded bg-yellow-100 px-1 font-mono text-xs">
          public/seal.png
        </code>
        にファイルが正しく保存されているか確認してください。
      </div>

      {/* A4 プレビュー（灰色背景で用紙感を演出） */}
      <div
        style={{
          background: '#d1d5db',
          padding: '40px',
          overflowX: 'auto',
          borderRadius: '12px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            minWidth: '794px',
          }}
        >
          <div
            style={{
              boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
              background: '#fff',
            }}
          >
            <ReceiptPrintable ref={receiptRef} parsed={SAMPLE_PARSED} />
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-lg bg-gray-50 px-4 py-3 text-xs text-gray-600">
        <div className="mb-1 font-semibold">サンプルデータの内訳:</div>
        <div>・宛名: サンプル美容サロン 渋谷店 / 山田 花子 様</div>
        <div>・注文番号: TEST00000001</div>
        <div>・商品6点 / 商品合計 ¥38,090（税抜）/ 税込 ¥41,899</div>
        <div>・発行元: ロイヤルトラスト株式会社（T5120001125556）</div>
      </div>
    </div>
  )
}
