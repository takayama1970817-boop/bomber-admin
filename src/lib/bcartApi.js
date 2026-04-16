/**
 * Bカート API クライアント
 * Bearer Token 認証で受注・会員・商品データを取得
 *
 * ページネーション: limit / offset 方式（meta.total で総件数取得）
 * dev: Viteプロキシ(/api/bcart → api.bcart.jp)でCORS回避
 * prod: Cloud Functions プロキシ経由（CORS回避＋トークン隠蔽）
 */
import { getAuth } from 'firebase/auth'

const CF_URL = 'https://asia-northeast1-bomber-admin.cloudfunctions.net/bcartProxy'
const PROXY_URL = '/api/bcart'
const TOKEN = import.meta.env.VITE_BCART_API_TOKEN
const PAGE_SIZE = 100

async function apiFetch(endpoint, params = {}) {
  if (import.meta.env.DEV) {
    // 開発: Viteプロキシ経由
    const url = new URL(`${PROXY_URL}/${endpoint}`, window.location.origin)
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
    })
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    if (!res.ok) throw new Error(`BカートAPI エラー: ${res.status} ${res.statusText}`)
    return res.json()
  }

  // 本番: Cloud Functions プロキシ経由
  const url = new URL(CF_URL)
  url.searchParams.set('endpoint', endpoint)
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
  })

  // Firebase Auth の IDトークンを取得して認証
  const user = getAuth().currentUser
  const idToken = user ? await user.getIdToken() : ''

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${idToken}` },
  })

  if (!res.ok) throw new Error(`BカートAPI エラー: ${res.status} ${res.statusText}`)
  return res.json()
}

/**
 * 全ページ取得の汎用関数
 * @param {string} endpoint - APIエンドポイント
 * @param {string} dataKey - レスポンス内の配列キー
 * @param {Object} params - 追加パラメータ
 * @param {Function} onProgress - 進捗コールバック(取得済み件数, 全件数)
 */
async function fetchAll(endpoint, dataKey, params = {}, onProgress) {
  let offset = 0
  const all = []
  while (true) {
    const data = await apiFetch(endpoint, { ...params, limit: PAGE_SIZE, offset })
    const items = data[dataKey] || []
    if (items.length === 0) break
    all.push(...items)
    const total = data.meta?.total || all.length
    if (onProgress) onProgress(all.length, total)
    if (all.length >= total) break
    offset += PAGE_SIZE
  }
  return all
}

/**
 * 受注一覧を取得（全ページ取得）
 */
export async function fetchAllOrders(onProgress) {
  return fetchAll('orders', 'orders', {}, onProgress)
}

/**
 * 指定月の受注を全件取得
 * @param {string} month - "YYYY-MM" 形式
 * @param {Function} onProgress - 進捗コールバック
 */
export async function fetchOrdersByMonth(month, onProgress) {
  const [y, m] = month.split('-')
  const from = `${y}-${m}-01`
  const lastDay = new Date(Number(y), Number(m), 0).getDate()
  const to = `${y}-${m}-${String(lastDay).padStart(2, '0')}`

  return fetchAll('orders', 'orders', {
    ordered_at__gte: `${from} 00:00:00`,
    ordered_at__lte: `${to} 23:59:59`,
  }, onProgress)
}

/**
 * 受注明細を取得（全ページ取得）
 */
export async function fetchAllOrderProducts(onProgress) {
  return fetchAll('order_products', 'order_products', {}, onProgress)
}

/**
 * 指定受注IDの明細を取得
 * @param {number|string} orderId
 */
export async function fetchOrderProducts(orderId) {
  const data = await apiFetch('order_products', { order_id: orderId, limit: PAGE_SIZE })
  // レスポンスの配列キーを自動検出
  const key = Object.keys(data).find((k) => Array.isArray(data[k]))
  return key ? data[key] : []
}

/**
 * 複数受注IDの明細を一括取得（並列、10件ずつ）
 * @param {Array<number|string>} orderIds
 * @param {Function} onProgress - 進捗コールバック(完了数, 全数)
 */
export async function fetchOrderProductsBatch(orderIds, onProgress) {
  const results = []
  const batchSize = 10
  for (let i = 0; i < orderIds.length; i += batchSize) {
    const batch = orderIds.slice(i, i + batchSize)
    // allSettled で個別のreject が unhandled rejection にならないようにする
    const settled = await Promise.allSettled(
      batch.map((id) =>
        fetchOrderProducts(id).then((items) => items.map((item) => ({ ...item, order_id: id })))
      )
    )
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(...s.value)
      else console.warn('order_products skip:', s.reason?.message || s.reason)
    }
    if (onProgress) onProgress(Math.min(i + batchSize, orderIds.length), orderIds.length)
  }
  return results
}

/**
 * 会員一覧を取得
 */
export async function fetchAllCustomers(onProgress) {
  return fetchAll('customers', 'customers', {}, onProgress)
}

/**
 * 商品一覧を取得
 */
export async function fetchAllProducts(onProgress) {
  return fetchAll('products', 'products', {}, onProgress)
}

/**
 * 指定日以降の受注を取得（差分同期用）
 * @param {string} since - "YYYY-MM-DD" 形式
 */
export async function fetchOrdersSince(since, onProgress) {
  return fetchAll('orders', 'orders', {
    ordered_at__gte: `${since} 00:00:00`,
  }, onProgress)
}

/**
 * 出荷情報（配送先）を logistics ID で取得
 * order_products の logistics_id から紐付ける
 * @param {number|string} logisticsId
 */
export async function fetchLogisticsById(logisticsId) {
  const data = await apiFetch('logistics', { id: logisticsId, limit: 1 })
  const items = data.logistics || []
  return items[0] || null
}

/**
 * 複数の logistics ID から配送先を一括取得（並列、10件ずつ）
 * @param {Array<number|string>} logisticsIds - ユニークなIDリスト
 * @param {Function} onProgress
 * @returns {Object} - { [logisticsId]: logisticsRecord }
 */
export async function fetchLogisticsByIds(logisticsIds, onProgress) {
  const map = {}
  const batchSize = 10
  for (let i = 0; i < logisticsIds.length; i += batchSize) {
    const batch = logisticsIds.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map((lid) =>
        fetchLogisticsById(lid)
          .then((item) => ({ lid, item }))
          .catch(() => ({ lid, item: null }))
      )
    )
    batchResults.forEach(({ lid, item }) => { if (item) map[lid] = item })
    if (onProgress) onProgress(Math.min(i + batchSize, logisticsIds.length), logisticsIds.length)
  }
  return map
}

/**
 * BカートAPIが利用可能かテスト
 */
export async function testConnection() {
  if (!TOKEN) throw new Error('BカートAPIトークンが設定されていません')
  const data = await apiFetch('orders', { limit: 1 })
  return { ok: true, orderCount: data.meta?.total || data.orders?.length || 0 }
}
