/**
 * 原価マスタ（productCosts）ヘルパー
 * キー戦略: 商品名（trim 後）で upsert。docId は Firestore 自動生成
 * 最小実装：履歴管理（effectiveFrom/To）は未対応、現在の単価原価のみ保持
 */
import {
  collection,
  getDocs,
  setDoc,
  doc,
  serverTimestamp,
  query,
  where,
} from 'firebase/firestore'
import { db } from './firebase.js'

const COLLECTION = 'productCosts'

/**
 * 全件取得して { productName -> { id, unitCost, updatedAt } } の Map を返す
 */
export async function fetchCostMap() {
  const snap = await getDocs(collection(db, COLLECTION))
  const map = new Map()
  for (const d of snap.docs) {
    const data = d.data()
    if (data.productName) {
      map.set(data.productName, {
        id: d.id,
        unitCost: Number(data.unitCost) || 0,
        updatedAt: data.updatedAt,
      })
    }
  }
  return map
}

/**
 * 原価を保存（上書き）
 * @param {string} productName 商品名（trim 済み）
 * @param {number} unitCost 単価原価（円、税別）
 * @param {string} updatedBy 更新者 uid
 */
export async function setCost(productName, unitCost, updatedBy) {
  const name = String(productName || '').trim()
  if (!name) throw new Error('商品名が空です')
  // 既存レコード検索
  const snap = await getDocs(
    query(collection(db, COLLECTION), where('productName', '==', name)),
  )
  const payload = {
    productName: name,
    unitCost: Number(unitCost) || 0,
    updatedAt: serverTimestamp(),
    updatedBy: updatedBy || '',
  }
  if (snap.empty) {
    // 新規
    const ref = doc(collection(db, COLLECTION))
    await setDoc(ref, payload)
    return ref.id
  }
  // 既存は最初の1件を更新（同名重複は理論上ないが保険）
  const existing = snap.docs[0]
  await setDoc(existing.ref, payload, { merge: true })
  return existing.id
}

/**
 * byProduct 配列に粗利情報をマージ
 * @param {Array<{name, amount, count}>} byProduct
 * @param {Map} costMap
 * @returns {Array<{name, amount, count, unitCost, grossProfit, grossMargin}>}
 */
export function enrichProductsWithCost(byProduct, costMap) {
  return byProduct.map((p) => {
    const costEntry = costMap.get(p.name)
    const unitCost = costEntry?.unitCost ?? null
    if (unitCost === null) {
      return { ...p, unitCost: null, grossProfit: null, grossMargin: null }
    }
    const cogs = unitCost * p.count
    const grossProfit = p.amount - cogs
    const grossMargin = p.amount > 0
      ? Math.round((grossProfit / p.amount) * 1000) / 10 // %小数1位
      : null
    return { ...p, unitCost, grossProfit, grossMargin }
  })
}
