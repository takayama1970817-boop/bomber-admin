/**
 * BカートAPI: 個別受注取得と明細フィルタの各パターンを試す
 */
import { BCART_BASE as BASE, getBcartToken } from './_env.mjs'

const BCART_TOKEN = getBcartToken()

async function api(path, params = {}) {
  const url = new URL(`${BASE}/${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)))
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${BCART_TOKEN}` },
  })
  console.log(`  ${res.status} ${path} ${JSON.stringify(params)}`)
  if (!res.ok) return null
  return res.json()
}

async function main() {
  // テスト1: 個別受注取得 orders/{id}
  console.log('=== テスト1: GET orders/4 ===')
  const order = await api('orders/4')
  if (order) {
    console.log(`  キー: ${Object.keys(order).join(', ')}`)
    const o = order.order || order
    console.log(`  code=${o.code}, company=${o.customer_comp_name}`)
    if (o.order_products || o.items || o.products) {
      console.log(`  商品情報あり!`)
      console.log(`  ${JSON.stringify(o.order_products || o.items || o.products).slice(0, 200)}`)
    } else {
      console.log(`  商品情報なし（トップレベルキーのみ）`)
    }
  }

  // テスト2: order_products?order_id=4
  console.log('\n=== テスト2: order_products?order_id=4 ===')
  const t2 = await api('order_products', { order_id: 4 })
  if (t2) {
    const key = Object.keys(t2).find((k) => Array.isArray(t2[k]))
    console.log(`  件数: ${key ? t2[key].length : 0}, meta: ${JSON.stringify(t2.meta || {})}`)
    if (key && t2[key].length > 0) {
      console.log(`  order_ids: ${t2[key].map(p => p.order_id).join(',')}`)
    }
  }

  // テスト3: order_products?order_id[]=4
  console.log('\n=== テスト3: order_products (order_id[]=4) ===')
  const url3 = new URL(`${BASE}/order_products`)
  url3.searchParams.append('order_id[]', '4')
  const res3 = await fetch(url3.toString(), { headers: { Authorization: `Bearer ${BCART_TOKEN}` } })
  console.log(`  ${res3.status}`)
  if (res3.ok) {
    const t3 = await res3.json()
    const key = Object.keys(t3).find((k) => Array.isArray(t3[k]))
    console.log(`  件数: ${key ? t3[key].length : 0}`)
    if (key && t3[key].length > 0) console.log(`  order_ids: ${t3[key].map(p => p.order_id).join(',')}`)
  }

  // テスト4: orders/4/order_products (nested resource)
  console.log('\n=== テスト4: orders/4/order_products ===')
  const t4 = await api('orders/4/order_products')
  if (t4) {
    const key = Object.keys(t4).find((k) => Array.isArray(t4[k]))
    console.log(`  キー: ${Object.keys(t4).join(', ')}`)
    console.log(`  件数: ${key ? t4[key].length : 0}`)
  }

  process.exit(0)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
