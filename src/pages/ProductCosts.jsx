import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import { fetchCostMap, setCost } from '../lib/productCosts.js'
import { fetchAllSalonAnalyticsFromBcart } from '../lib/customerAnalytics.js' // 使わないが念のため
import { fetchOrdersByMonth, fetchOrderProductsBatch } from '../lib/bcartApi.js'

const fmtYen = (n) => `¥${Math.round(n || 0).toLocaleString()}`

/**
 * Bカート直近3ヶ月の注文明細から、商品名ユニーク一覧を取得（累計売上付き）
 * localStorage で日次キャッシュ
 */
async function fetchRecentProducts(months = 3, forceRefresh = false, onProgress) {
  const cacheKey = `productCosts:productList:${months}m`
  const today = new Date().toISOString().slice(0, 10)

  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(cacheKey)
      if (raw) {
        const cached = JSON.parse(raw)
        if (cached.date === today && Array.isArray(cached.list)) {
          return cached.list
        }
      }
    } catch (e) { /* ignore */ }
  }

  const now = new Date()
  const productMap = new Map() // name -> { name, totalAmount, totalCount }
  for (let i = 0; i < months; i += 1) {
    let ty = now.getFullYear()
    let tm = now.getMonth() - i
    while (tm < 0) { tm += 12; ty -= 1 }
    const ymStr = `${ty}-${String(tm + 1).padStart(2, '0')}`
    if (onProgress) onProgress(`Bカート ${ymStr} 受注取得中...`)
    let orders = []
    try {
      orders = await fetchOrdersByMonth(ymStr)
    } catch (e) {
      console.warn('skip orders', ymStr, e.message)
      continue
    }
    const orderIds = orders.map((o) => o.id).filter(Boolean)
    if (orderIds.length === 0) continue
    if (onProgress) onProgress(`Bカート ${ymStr} 明細取得中...`)
    let products = []
    try {
      products = await fetchOrderProductsBatch(orderIds, (done, total) => {
        if (onProgress) onProgress(`Bカート ${ymStr} 明細: ${done}/${total}件`)
      })
    } catch (e) {
      console.warn('skip products', ymStr, e.message)
      continue
    }
    for (const p of products) {
      const name = (p.product_name || '').trim()
      if (!name) continue
      if (/紙袋|送料|手数料/.test(name)) continue
      const qty = Number(p.order_pro_count) || 0
      const sub = (Number(p.unit_price) || 0) * qty
      if (!productMap.has(name)) productMap.set(name, { name, totalAmount: 0, totalCount: 0 })
      const entry = productMap.get(name)
      entry.totalAmount += sub
      entry.totalCount += qty
    }
  }

  const list = Array.from(productMap.values()).sort((a, b) => b.totalAmount - a.totalAmount)
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ date: today, list }))
  } catch (e) { /* ignore */ }
  return list
}

export default function ProductCosts() {
  const { profile, isAdmin } = useAuth()
  const [products, setProducts] = useState([])
  const [costMap, setCostMap] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState('')
  const [err, setErr] = useState(null)
  const [keyword, setKeyword] = useState('')
  const [filter, setFilter] = useState('all') // all | missing | set
  const [editing, setEditing] = useState({}) // { productName: inputValue }
  const [saving, setSaving] = useState({}) // { productName: bool }
  const [savedFlash, setSavedFlash] = useState({}) // { productName: ts }

  const loadAll = async (forceRefresh = false) => {
    setLoading(true)
    setErr(null)
    setProgress('データ取得中...')
    try {
      const [pList, cMap] = await Promise.all([
        fetchRecentProducts(3, forceRefresh, setProgress),
        fetchCostMap(),
      ])
      setProducts(pList)
      setCostMap(cMap)
    } catch (e) {
      console.error(e)
      setErr(e?.message || 'データ取得に失敗しました')
    } finally {
      setLoading(false)
      setProgress('')
    }
  }

  useEffect(() => {
    loadAll(false)
  }, [])

  const filtered = useMemo(() => {
    let arr = products
    if (filter === 'missing') {
      arr = arr.filter((p) => !costMap.has(p.name))
    } else if (filter === 'set') {
      arr = arr.filter((p) => costMap.has(p.name))
    }
    if (keyword) {
      const k = keyword.toLowerCase()
      arr = arr.filter((p) => p.name.toLowerCase().includes(k))
    }
    return arr
  }, [products, costMap, filter, keyword])

  const counts = useMemo(() => ({
    all: products.length,
    set: products.filter((p) => costMap.has(p.name)).length,
    missing: products.filter((p) => !costMap.has(p.name)).length,
  }), [products, costMap])

  const handleSave = async (name) => {
    const val = editing[name]
    const unitCost = Number(val)
    if (val === undefined || val === '' || Number.isNaN(unitCost) || unitCost < 0) {
      alert('0以上の数値を入力してください')
      return
    }
    setSaving((s) => ({ ...s, [name]: true }))
    try {
      await setCost(name, unitCost, profile?.uid)
      // ローカル反映
      const newMap = new Map(costMap)
      newMap.set(name, { id: newMap.get(name)?.id || '', unitCost, updatedAt: new Date() })
      setCostMap(newMap)
      setEditing((e) => { const n = { ...e }; delete n[name]; return n })
      setSavedFlash((f) => ({ ...f, [name]: Date.now() }))
      setTimeout(() => setSavedFlash((f) => { const n = { ...f }; delete n[name]; return n }), 1500)
    } catch (e) {
      console.error(e)
      alert('保存失敗: ' + e.message)
    } finally {
      setSaving((s) => { const n = { ...s }; delete n[name]; return n })
    }
  }

  if (!isAdmin && profile?.role !== 'staff') {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        このページは admin / staff 権限のみ閲覧できます。
      </div>
    )
  }

  const filterBtn = (key, label, count) => (
    <button
      onClick={() => setFilter(key)}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        filter === key
          ? 'bg-indigo-600 text-white'
          : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
      }`}
    >
      {label}
      {count !== undefined && <span className="ml-1.5 opacity-80">({count})</span>}
    </button>
  )

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">原価マスタ</h1>
          <p className="text-xs text-gray-500">
            直近3ヶ月にBカートで受注のあった商品に単価原価（税別）を登録します。経営ダッシュボードの粗利計算に反映されます。
          </p>
        </div>
        <button
          onClick={() => loadAll(true)}
          disabled={loading}
          className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
        >
          🔄 更新
        </button>
      </div>

      {loading && progress && (
        <div className="rounded-lg bg-emerald-50 px-4 py-2 text-xs text-emerald-700">{progress}</div>
      )}

      {loading && (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          集計中...
        </div>
      )}

      {err && !loading && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-800">{err}</div>
      )}

      {!loading && !err && (
        <>
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="mb-3 flex flex-wrap gap-2">
              {filterBtn('all', 'すべて', counts.all)}
              {filterBtn('missing', '未登録', counts.missing)}
              {filterBtn('set', '登録済', counts.set)}
            </div>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="商品名で検索..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">商品名</th>
                    <th className="px-3 py-2 text-right">直近3ヶ月売上</th>
                    <th className="px-3 py-2 text-right">販売数</th>
                    <th className="px-3 py-2 text-right">単価原価（税別）</th>
                    <th className="px-3 py-2 text-right">粗利率見込</th>
                    <th className="px-3 py-2 text-left">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-xs text-gray-400">
                        該当する商品がありません
                      </td>
                    </tr>
                  )}
                  {filtered.map((p) => {
                    const entry = costMap.get(p.name)
                    const unitCost = entry?.unitCost
                    const isEditing = editing[p.name] !== undefined
                    const avgPrice = p.totalCount > 0 ? Math.round(p.totalAmount / p.totalCount) : 0
                    const margin = (unitCost !== undefined && avgPrice > 0)
                      ? Math.round(((avgPrice - unitCost) / avgPrice) * 1000) / 10
                      : null
                    return (
                      <tr key={p.name} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-900">{p.name}</td>
                        <td className="px-3 py-2 text-right text-gray-700">{fmtYen(p.totalAmount)}</td>
                        <td className="px-3 py-2 text-right text-gray-700">{p.totalCount.toLocaleString()}点</td>
                        <td className="px-3 py-2 text-right">
                          {isEditing ? (
                            <input
                              type="number"
                              min="0"
                              value={editing[p.name]}
                              onChange={(e) => setEditing((s) => ({ ...s, [p.name]: e.target.value }))}
                              className="w-28 rounded border border-indigo-300 px-2 py-1 text-right text-sm"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSave(p.name)
                                if (e.key === 'Escape') setEditing((s) => { const n = { ...s }; delete n[p.name]; return n })
                              }}
                            />
                          ) : unitCost !== undefined ? (
                            <span className="font-medium text-gray-900">{fmtYen(unitCost)}</span>
                          ) : (
                            <span className="text-gray-400">未登録</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {margin !== null ? (
                            <span className={`text-xs font-medium ${margin >= 35 ? 'text-green-700' : margin >= 0 ? 'text-orange-700' : 'text-red-700'}`}>
                              {margin > 0 ? '+' : ''}{margin}%
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400">-</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {savedFlash[p.name] ? (
                            <span className="text-xs text-emerald-600">✓ 保存済</span>
                          ) : isEditing ? (
                            <div className="flex gap-1">
                              <button
                                onClick={() => handleSave(p.name)}
                                disabled={saving[p.name]}
                                className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                              >
                                {saving[p.name] ? '保存中...' : '保存'}
                              </button>
                              <button
                                onClick={() => setEditing((s) => { const n = { ...s }; delete n[p.name]; return n })}
                                className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                              >
                                キャンセル
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setEditing((s) => ({ ...s, [p.name]: unitCost ?? '' }))}
                              className="rounded border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                            >
                              {unitCost !== undefined ? '編集' : '入力'}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-xs text-indigo-900">
            <strong>注意：</strong> 原価は「単価原価（税別）」で入力してください。経営ダッシュボードの「商品別売上」の粗利計算に使われます。
            履歴管理は後日対応予定のため、変更は即時全期間に反映されます。
          </div>
        </>
      )}
    </div>
  )
}
