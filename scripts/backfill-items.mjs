/**
 * 既存受注に商品明細をバックフィルするスクリプト
 * order_products?order_id=X で1件ずつ効率的に取得
 *
 * 使い方: node scripts/backfill-items.mjs
 *   --batch=100   一度に処理する注文数（デフォルト: 100）
 *   --offset=0    開始位置（中断後の再開用）
 */
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  writeBatch,
} from 'firebase/firestore'
import {
  BCART_BASE,
  getBcartToken,
  getFirebaseConfig,
  getScriptCredentials,
} from './_env.mjs'

const BCART_TOKEN = getBcartToken()
const firebaseConfig = getFirebaseConfig()
const { email: SCRIPT_EMAIL, password: SCRIPT_PASSWORD } = getScriptCredentials()

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

const args = process.argv.slice(2)
const batchArg = args.find((a) => a.startsWith('--batch='))
const offsetArg = args.find((a) => a.startsWith('--offset='))
const BATCH_LIMIT = batchArg ? parseInt(batchArg.split('=')[1]) : 100
const START_OFFSET = offsetArg ? parseInt(offsetArg.split('=')[1]) : 0

async function bcartFetch(endpoint, params = {}) {
  const url = new URL(`${BCART_BASE}/${endpoint}`)
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  })
  for (let retry = 0; retry < 10; retry++) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${BCART_TOKEN}` },
    })
    if (res.status === 429) {
      const wait = Math.min((retry + 1) * 5000, 60000)
      process.stdout.write(`[429→${wait / 1000}s] `)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    return res.json()
  }
  throw new Error('レート制限が継続中')
}

async function fetchItemsForOrder(orderId) {
  const data = await bcartFetch('order_products', { order_id: orderId, limit: 100 })
  const key = Object.keys(data).find((k) => Array.isArray(data[k])) || 'order_products'
  return data[key] || []
}

async function main() {
  console.log('=== 商品明細バックフィル ===\n')

  await signInWithEmailAndPassword(auth, SCRIPT_EMAIL, SCRIPT_PASSWORD)
  console.log('認証OK')

  const snap = await getDocs(collection(db, 'orders'))
  const emptyOrders = []
  snap.docs.forEach((d) => {
    const data = d.data()
    if ((!data.items || data.items.length === 0) && data.bcartOrderId) {
      emptyOrders.push({ docId: d.id, bcartOrderId: data.bcartOrderId })
    }
  })
  emptyOrders.sort((a, b) => a.bcartOrderId - b.bcartOrderId)
  console.log(`明細なし: ${emptyOrders.length} 件`)

  const targets = emptyOrders.slice(START_OFFSET, START_OFFSET + BATCH_LIMIT)
  console.log(`今回処理: ${targets.length} 件 (offset=${START_OFFSET})\n`)

  if (targets.length === 0) { console.log('完了'); process.exit(0) }

  let updated = 0
  let noData = 0
  let apiCalls = 0

  // 10件ずつバッチ処理
  for (let i = 0; i < targets.length; i += 10) {
    const chunk = targets.slice(i, i + 10)
    const batch = writeBatch(db)
    let batchHasUpdates = false

    for (const order of chunk) {
      try {
        const prods = await fetchItemsForOrder(order.bcartOrderId)
        apiCalls++

        if (prods.length === 0) { noData++; continue }

        const items = prods.map((p) => ({
          name: p.product_name || '',
          sku: p.jan_code || '',
          campaign: p.set_name || '',
          unit: p.set_unit || '',
          price: p.unit_price || 0,
          qty: p.order_pro_count || 1,
        }))
        batch.update(doc(db, 'orders', order.docId), { items })
        batchHasUpdates = true
        updated++
      } catch (e) {
        console.error(`\n  エラー order_id=${order.bcartOrderId}: ${e.message}`)
        // レート制限エラーの場合は中断して再開コマンドを表示
        if (e.message.includes('レート制限')) {
          console.log(`\n中断。再開コマンド:`)
          console.log(`  node scripts/backfill-items.mjs --offset=${START_OFFSET + i}`)
          process.exit(1)
        }
        noData++
      }

      // API間隔を空ける（レート制限回避）
      await new Promise((r) => setTimeout(r, 500))
    }

    if (batchHasUpdates) await batch.commit()
    console.log(`  ${i + chunk.length}/${targets.length} 件処理 (更新${updated}, スキップ${noData}, API${apiCalls}回)`)
  }

  console.log(`\n完了: ${updated}件更新 / ${noData}件スキップ`)

  const remaining = emptyOrders.length - START_OFFSET - BATCH_LIMIT
  if (remaining > 0) {
    console.log(`\n残り ${remaining} 件。次回:`)
    console.log(`  node scripts/backfill-items.mjs --offset=${START_OFFSET + BATCH_LIMIT}`)
  }

  process.exit(0)
}

main().catch((e) => {
  console.error('エラー:', e.message)
  process.exit(1)
})
