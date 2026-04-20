import { useEffect, useState } from 'react'
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

const CATEGORY_LABELS = {
  catalog: '商品カタログ',
  manual: 'マニュアル',
  campaign: 'キャンペーン',
  other: 'その他',
}

export default function SalonDocuments() {
  const { profile } = useAuth()
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    if (!profile) return
    ;(async () => {
      try {
        // rules の canReadDealerDocument() に合致するクエリを分割実行。
        const base = collection(db, 'dealerDocuments')
        const queries = [
          query(
            base,
            where('isActive', '==', true),
            where('visibility', 'in', ['all', 'salons']),
            orderBy('updatedAt', 'desc'),
          ),
        ]
        if (profile.companyName) {
          queries.push(
            query(
              base,
              where('isActive', '==', true),
              where('visibility', '==', 'specific'),
              where('allowedCompanies', 'array-contains', profile.companyName),
              orderBy('updatedAt', 'desc'),
            ),
          )
        }
        const snaps = await Promise.all(queries.map((q) => getDocs(q)))
        const map = new Map()
        snaps.forEach((snap) => snap.docs.forEach((d) => map.set(d.id, { id: d.id, ...d.data() })))
        const merged = Array.from(map.values()).sort((a, b) => {
          const ta = a.updatedAt?.toMillis?.() || 0
          const tb = b.updatedAt?.toMillis?.() || 0
          return tb - ta
        })
        setDocs(merged)
      } catch (e) {
        console.error('資料取得エラー:', e)
      } finally {
        setLoading(false)
      }
    })()
  }, [profile])

  const filtered = filter === 'all' ? docs : docs.filter((d) => d.category === filter)
  const categories = [...new Set(docs.map((d) => d.category).filter(Boolean))]

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-gray-400">読み込み中...</div>
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-gray-900">資料ダウンロード</h1>
      <p className="mb-6 text-sm text-gray-500">
        VAVITTE の販促資料・マニュアル等をダウンロードできます
      </p>

      {categories.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              filter === 'all'
                ? 'bg-pink-600 text-white'
                : 'border border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            すべて
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                filter === cat
                  ? 'bg-pink-600 text-white'
                  : 'border border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {CATEGORY_LABELS[cat] || cat}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          資料がまだ登録されていません
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {filtered.map((d) => (
            <div key={d.id} className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="mb-2 flex items-center gap-2">
                {d.category && (
                  <span className="rounded bg-pink-100 px-2 py-0.5 text-[10px] font-medium text-pink-700">
                    {CATEGORY_LABELS[d.category] || d.category}
                  </span>
                )}
                <span className="text-xs text-gray-400">{fmtDate(d.updatedAt)}</span>
              </div>
              <h3 className="mb-1 text-sm font-bold text-gray-900">{d.title}</h3>
              {d.description && (
                <p className="mb-3 text-xs text-gray-500">{d.description}</p>
              )}
              <a
                href={d.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block rounded-lg bg-pink-600 px-4 py-2 text-xs font-medium text-white hover:bg-pink-700"
              >
                ダウンロード / 開く
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
