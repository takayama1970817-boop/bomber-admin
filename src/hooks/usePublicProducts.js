import { useEffect, useState } from 'react'
import { collection, getDocs, query, orderBy } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { products as fallbackProducts } from '../data/products.js'

/**
 * 公開ページ用 商品リストローダー
 *
 * 優先順位:
 *   1. Firestore `publicProducts`（Bカート同期で更新）
 *   2. `src/data/productsGenerated.js` ← `products.js` 経由
 *   3. 静的な staticProducts（`products.js` のフォールバック）
 *
 * Firestore が空・エラー時は静的データで常時表示できる。
 */
export function usePublicProducts() {
  const [products, setProducts] = useState(fallbackProducts)
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState('static')

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        // displayOrder で orderBy。同値の安定性は client 側で code をタイブレーカに。
        const q = query(collection(db, 'publicProducts'), orderBy('displayOrder', 'asc'))
        const snap = await getDocs(q)
        if (cancelled) return
        if (snap.empty) {
          // Firestore に何もなければフォールバック継続
          setSource('static')
          setLoading(false)
          return
        }
        const list = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((p) => p.isPublic !== false)
          .sort((a, b) => {
            const ao = a.displayOrder ?? 9999
            const bo = b.displayOrder ?? 9999
            if (ao !== bo) return ao - bo
            return String(a.code || '').localeCompare(String(b.code || ''))
          })
        if (list.length === 0) {
          // 全件 非公開 → フォールバック
          setSource('static')
          setLoading(false)
          return
        }
        setProducts(list)
        setSource('firestore')
      } catch (err) {
        // 読み取り失敗時はフォールバック維持
        console.warn('publicProducts の取得に失敗 → 静的データを使用', err?.code || err)
        setSource('static')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  return { products, loading, source }
}

export function usePublicProductBySlug(slug) {
  const { products, loading, source } = usePublicProducts()
  const product = products.find((p) => p.slug === slug) || null
  return { product, loading, source }
}
