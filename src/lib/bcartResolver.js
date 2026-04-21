/**
 * Bカート受注の代理店帰属を「会員マスタの現在値」で解決するためのフロント側ヘルパー。
 *
 * 背景（2026-04-21）:
 *   V→J 代理店コード変更後、既存の Bカート受注に保持されている
 *   customer_parent_id は注文時点の V コードのまま。そのため
 *   `order.customer_parent_id === dealerCode` で絞り込むと
 *   過去注文が欠落する。
 *
 * 解決方針:
 *   注文の帰属 = 会員マスタ (customers) の current parent_id
 *   すなわち order.customer_id → parentMap.get(customer_id) を source of truth とする。
 *
 * キャッシュ:
 *   localStorage（`bcartCustomerParentMap:v1`）で1日1回 + メモリキャッシュ。
 *   1日1回が基本。強制更新は { forceRefresh: true } を渡す。
 *
 * 使用例:
 *   const parentMap = await fetchCustomerParentMap()
 *   const myOrders = rawOrders.filter((o) => isOrderForDealer(o, dealerCode, parentMap))
 */
import { fetchAllCustomers } from './bcartApi.js'

function parentIdOfCustomer(rec) {
  return String(rec?.parent_id ?? rec?.customer_parent_id ?? rec?.parent_member_id ?? '').trim()
}

function parentIdOfOrder(rec) {
  return String(rec?.customer_parent_id ?? rec?.parent_id ?? rec?.parent_member_id ?? '').trim()
}

let memoryCache = null
let memoryCacheDate = null

const CACHE_KEY = 'bcartCustomerParentMap:v1'

/**
 * customer_id → current parent_id の Map を返す。
 *
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh=false]
 * @param {(msg: string) => void} [options.onProgress]
 * @returns {Promise<Map<string, string>>}
 */
export async function fetchCustomerParentMap(options = {}) {
  const forceRefresh = options.forceRefresh ?? false
  const onProgress = options.onProgress
  const today = new Date().toISOString().slice(0, 10)

  if (!forceRefresh && memoryCache && memoryCacheDate === today) {
    return memoryCache
  }

  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (raw) {
        const cached = JSON.parse(raw)
        if (cached && cached.date === today && cached.entries) {
          const map = new Map(cached.entries)
          memoryCache = map
          memoryCacheDate = today
          return map
        }
      }
    } catch (e) { /* ignore */ }
  }

  if (onProgress) onProgress('Bカート 会員マスタ取得中...')
  const customers = await fetchAllCustomers((loaded, total) => {
    if (onProgress) onProgress(`Bカート 会員: ${loaded}/${total}件`)
  })

  const map = new Map()
  for (const c of customers) {
    const id = String(c?.id ?? '').trim()
    if (!id) continue
    const parent = parentIdOfCustomer(c)
    map.set(id, parent)
  }

  memoryCache = map
  memoryCacheDate = today
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ date: today, entries: Array.from(map.entries()) }),
    )
  } catch (e) { /* ignore quota */ }

  return map
}

/**
 * Bカート受注を、会員マスタの current parent_id で帰属解決する。
 *
 * 優先順位:
 *   1) parentMap[order.customer_id] （会員マスタの現在値 = 正）
 *   2) order.customer_parent_id    （会員が削除されている等のフォールバック）
 */
export function resolveOrderDealerCode(order, parentMap) {
  const cid = String(order?.customer_id ?? '').trim()
  if (cid && parentMap) {
    const resolved = parentMap.get(cid)
    if (resolved) return resolved
  }
  return parentIdOfOrder(order)
}

/** 指定 dealerCode に属する受注か否か */
export function isOrderForDealer(order, dealerCode, parentMap) {
  if (!dealerCode) return false
  return String(resolveOrderDealerCode(order, parentMap)) === String(dealerCode)
}

/** キャッシュを強制クリア（テスト・デバッグ用） */
export function clearCustomerParentMapCache() {
  memoryCache = null
  memoryCacheDate = null
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch (e) { /* ignore */ }
}
