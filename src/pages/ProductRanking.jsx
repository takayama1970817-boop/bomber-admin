import { useMemo, useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'

const fmtYen = (n) => `¥${Math.round(n || 0).toLocaleString()}`

export default function ProductRanking() {
  const { isAdmin } = useAuth()
  const [searchParams] = useSearchParams()
  const ym = searchParams.get('ym') || '' // YYYY-MM
  const [cacheData, setCacheData] = useState(null)
  const [keyword, setKeyword] = useState('')
  const [sortKey, setSortKey] = useState('amount') // 'amount' | 'count' | 'name'

  useEffect(() => {
    // localStorage から該当月のキャッシュを読む
    try {
      // ym が "2026-04" 形式 → key は "execDashboard:2026-04"
      const cacheKey = ym ? `execDashboard:${ym}` : null
      if (cacheKey) {
        const raw = localStorage.getItem(cacheKey)
        if (raw) setCacheData(JSON.parse(raw))
      }
      // fallback: 最新のキャッシュを探す
      if (!cacheKey || !localStorage.getItem(cacheKey)) {
        const keys = Object.keys(localStorage).filter((k) => k.startsWith('execDashboard:'))
        keys.sort().reverse()
        if (keys[0]) {
          const raw = localStorage.getItem(keys[0])
          if (raw) setCacheData(JSON.parse(raw))
        }
      }
    } catch (e) {
      console.warn('cache read failed:', e)
    }
  }, [ym])

  const products = useMemo(() => {
    const list = cacheData?.data?.current?.byProduct || []
    let filtered = keyword
      ? list.filter((p) => p.name.toLowerCase().includes(keyword.toLowerCase()))
      : list
    filtered = [...filtered]
    if (sortKey === 'amount') filtered.sort((a, b) => b.amount - a.amount)
    else if (sortKey === 'count') filtered.sort((a, b) => b.count - a.count)
    else if (sortKey === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    return filtered
  }, [cacheData, keyword, sortKey])

  const maxAmount = products[0]?.amount || 0
  const totalAmount = products.reduce((s, p) => s + p.amount, 0)
  const totalCount = products.reduce((s, p) => s + p.count, 0)

  const period = cacheData?.data?.period || ym || '-'
  const fetchedAt = cacheData?.fetchedAt || '-'

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        このページは admin / master 権限のみ閲覧できます。
      </div>
    )
  }

  const exportCsv = () => {
    const rows = [['順位', '商品名', '販売点数', '売上金額']]
    products.forEach((p, i) => rows.push([i + 1, p.name, p.count, p.amount]))
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `商品別売上ランキング_${period.replace('/', '-')}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 3000)
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Link to="/admin/dashboard-exec" className="hover:text-indigo-600">← 経営ダッシュボードに戻る</Link>
          </div>
          <h1 className="mt-1 text-xl font-bold text-gray-900">商品別売上ランキング</h1>
          <p className="text-xs text-gray-500">
            対象月: <span className="font-medium">{period}</span> ／ データ取得: {fetchedAt}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCsv}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
          >
            📥 CSVダウンロード
          </button>
        </div>
      </div>

      {/* 検索・ソート */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4">
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="商品名で絞り込み..."
          className="flex-1 min-w-[200px] rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
        />
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500">並び替え:</span>
          {[
            { key: 'amount', label: '売上金額' },
            { key: 'count', label: '販売数' },
            { key: 'name', label: '商品名' },
          ].map((o) => (
            <button
              key={o.key}
              onClick={() => setSortKey(o.key)}
              className={`rounded-lg border px-3 py-1 text-xs font-medium ${
                sortKey === o.key
                  ? 'border-indigo-500 bg-indigo-500 text-white'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* サマリー */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">商品数</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">
            {products.length.toLocaleString()} 商品
          </div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">販売点数合計</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">
            {totalCount.toLocaleString()} 点
          </div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">売上合計</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">
            {fmtYen(totalAmount)}
          </div>
        </div>
      </div>

      {/* ランキング表 */}
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        {products.length === 0 ? (
          <div className="p-10 text-center text-sm text-gray-400">
            データがありません（経営ダッシュボードで一度データ取得後、このページを開いてください）
          </div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="px-4 py-2 text-left">順位</th>
                <th className="px-4 py-2 text-left">商品名</th>
                <th className="px-4 py-2 text-right">点数</th>
                <th className="px-4 py-2">売上割合</th>
                <th className="px-4 py-2 text-right">売上金額</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p, i) => (
                <tr key={p.name} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2 text-xs font-bold text-gray-400">{i + 1}</td>
                  <td className="px-4 py-2 text-sm text-gray-900">{p.name}</td>
                  <td className="px-4 py-2 text-right text-xs text-gray-600">
                    {p.count.toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <div className="h-4 overflow-hidden rounded bg-gray-100">
                      <div
                        className="h-full bg-indigo-500"
                        style={{ width: `${maxAmount > 0 ? (p.amount / maxAmount) * 100 : 0}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right text-sm font-medium text-gray-900">
                    {fmtYen(p.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
