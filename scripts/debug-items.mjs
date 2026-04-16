/**
 * デバッグ: Firestore受注のbcartOrderIdとBカートAPIのorder_productsの紐付けを確認
 */
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, collection, getDocs } from 'firebase/firestore'
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

async function bcartFetch(endpoint, params = {}) {
  const url = new URL(`${BCART_BASE}/${endpoint}`)
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  })
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${BCART_TOKEN}` },
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

async function main() {
  await signInWithEmailAndPassword(auth, SCRIPT_EMAIL, SCRIPT_PASSWORD)

  // Firestoreから明細なし受注を5件サンプル
  const snap = await getDocs(collection(db, 'orders'))
  const samples = []
  snap.docs.forEach((d) => {
    const data = d.data()
    if ((!data.items || data.items.length === 0) && data.bcartOrderId && samples.length < 5) {
      samples.push({ docId: d.id, bcartOrderId: data.bcartOrderId, bcartCode: data.bcartCode, companyName: data.companyName })
    }
  })

  console.log('=== Firestore側サンプル（明細なし受注） ===')
  samples.forEach((s) => {
    console.log(`  docId=${s.docId}, bcartOrderId=${s.bcartOrderId}, code=${s.bcartCode}, salon=${s.companyName}`)
  })

  // BカートAPIのordersから最新5件のid/codeを確認
  console.log('\n=== BカートAPI orders (最新5件) ===')
  const ordersData = await bcartFetch('orders', { limit: 5, offset: 0 })
  ordersData.orders?.forEach((o) => {
    console.log(`  id=${o.id}, code=${o.code}, company=${o.customer_comp_name}`)
  })

  // BカートAPIのorder_productsから最初の5件のフィールド名確認
  console.log('\n=== BカートAPI order_products (最初の5件) ===')
  const prodsData = await bcartFetch('order_products', { limit: 5, offset: 0 })
  const key = Object.keys(prodsData).find((k) => Array.isArray(prodsData[k]))
  console.log(`  レスポンスキー: ${Object.keys(prodsData).join(', ')}`)
  console.log(`  配列キー: ${key}`)
  if (key) {
    prodsData[key].slice(0, 5).forEach((p) => {
      console.log(`  order_id=${p.order_id}, product_name=${p.product_name}, qty=${p.order_pro_count}`)
      console.log(`    全フィールド: ${Object.keys(p).join(', ')}`)
    })
  }

  // Firestore側のbcartOrderIdのレンジ確認
  const allBcartIds = []
  snap.docs.forEach((d) => {
    const data = d.data()
    if (data.bcartOrderId) allBcartIds.push(data.bcartOrderId)
  })
  allBcartIds.sort((a, b) => a - b)
  console.log(`\n=== Firestore bcartOrderId レンジ ===`)
  console.log(`  最小: ${allBcartIds[0]}, 最大: ${allBcartIds[allBcartIds.length - 1]}, 件数: ${allBcartIds.length}`)

  // order_productsからorder_idのレンジ確認（最後のページ付近）
  const metaData = await bcartFetch('order_products', { limit: 1, offset: 0 })
  console.log(`\n=== order_products meta ===`)
  console.log(`  meta: ${JSON.stringify(metaData.meta || {})}`)

  process.exit(0)
}

main().catch((e) => {
  console.error('エラー:', e.message)
  process.exit(1)
})
