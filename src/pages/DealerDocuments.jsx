import { useEffect, useMemo, useState } from 'react'
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
// 横展開 Phase 5（2026-04-25）: 表示フォーマッタ / 共通 UI 統一
import { fmtDate } from '../lib/formatters.js'
import {
  LoadingSkeleton,
  ErrorBanner,
  RefreshButton,
  LastSyncedBadge,
  EmptyStateCard,
} from '../components/common/index.js'

function fmtSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

const CATEGORY_LABELS = {
  catalog: '商品カタログ',
  manual: 'マニュアル',
  campaign: 'キャンペーン',
  other: 'その他',
}

/**
 * 代理店 資料ダウンロード（横展開 Phase 5 対応）
 *
 * - 共通 UI: LoadingSkeleton / ErrorBanner / RefreshButton / LastSyncedBadge / EmptyStateCard
 * - localStorage 当日キャッシュ（key: dealerDocuments:{dealerCode}:v1）
 * - 0 件取得で既存データを上書きしない（fullSync 横展開要件）
 * - dealerCode フィルタは Firestore rules（visibility=specific + array-contains）で担保
 * - J0002 特別システムは対象外
 */
export default function DealerDocuments() {
  const { profile } = useAuth()
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')
  const [reloadCounter, setReloadCounter] = useState(0)
  const reload = () => setReloadCounter((c) => c + 1)

  // dealerCode 単位 cacheKey（他代理店データ混入防止）
  const cacheKey = profile?.dealerCode
    ? `dealerDocuments:${profile.dealerCode}:v1`
    : null

  useEffect(() => {
    if (!profile) return
    let cancelled = false

    // キャッシュ読み込み（reloadCounter==0 のみ）
    const today = new Date().toISOString().slice(0, 10)
    if (cacheKey && reloadCounter === 0) {
      try {
        const raw = localStorage.getItem(cacheKey)
        if (raw) {
          const cached = JSON.parse(raw)
          if (cached.date === today && Array.isArray(cached.docs) && cached.docs.length > 0) {
            const restored = cached.docs.map((d) => ({
              ...d,
              updatedAt: d.updatedAt ? new Date(d.updatedAt) : null,
            }))
            setDocs(restored)
            setLoading(false)
            setError(null)
            return () => { cancelled = true }
          }
        }
      } catch (e) { console.warn('DealerDocuments cache read failed:', e) }
    }

    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        // Firestore rules の canReadDealerDocument() に合致するクエリを分割実行。
        // dealer は「isActive && visibility in ['all','dealers']」または
        //         「isActive && visibility=='specific' && allowedDealers contains 自社dealerCode」
        const base = collection(db, 'dealerDocuments')
        const queries = [
          query(
            base,
            where('isActive', '==', true),
            where('visibility', 'in', ['all', 'dealers']),
            orderBy('updatedAt', 'desc'),
          ),
        ]
        if (profile.dealerCode) {
          queries.push(
            query(
              base,
              where('isActive', '==', true),
              where('visibility', '==', 'specific'),
              where('allowedDealers', 'array-contains', profile.dealerCode),
              orderBy('updatedAt', 'desc'),
            ),
          )
        }
        const snaps = await Promise.all(queries.map((q) => getDocs(q)))
        if (cancelled) return
        const map = new Map()
        snaps.forEach((snap) => snap.docs.forEach((d) => map.set(d.id, { id: d.id, ...d.data() })))
        const merged = Array.from(map.values()).sort((a, b) => {
          const ta = a.updatedAt?.toMillis?.() || 0
          const tb = b.updatedAt?.toMillis?.() || 0
          return tb - ta
        })
        // 0 件取得で既存データを上書きしない（fullSync 横展開要件）
        if (merged.length === 0 && docs.length > 0) {
          console.warn('[DealerDocuments] 0 件取得のため既存データを保持')
          return
        }
        setDocs(merged)
        // キャッシュ保存（updatedAt は ISO 化）
        if (cacheKey) {
          try {
            const serialised = merged.map((d) => ({
              ...d,
              updatedAt: d.updatedAt?.toMillis
                ? new Date(d.updatedAt.toMillis()).toISOString()
                : d.updatedAt instanceof Date
                  ? d.updatedAt.toISOString()
                  : null,
            }))
            localStorage.setItem(cacheKey, JSON.stringify({ date: today, docs: serialised }))
          } catch (e) { console.warn('DealerDocuments cache write failed:', e) }
        }
      } catch (e) {
        console.error('資料取得エラー:', e)
        if (!cancelled) setError(e?.message || '資料の取得に失敗しました')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, reloadCounter])

  // 最終更新時刻（docs.updatedAt の最大値）
  const lastSyncedAt = useMemo(() => {
    let latest = null
    for (const d of docs) {
      const ts = d.updatedAt
      const dt = ts?.toMillis ? new Date(ts.toMillis())
        : ts instanceof Date ? ts
        : ts ? new Date(ts) : null
      if (dt && !isNaN(dt.getTime()) && (!latest || dt > latest)) latest = dt
    }
    return latest
  }, [docs])

  const filtered = filter === 'all' ? docs : docs.filter((d) => d.category === filter)
  const categories = [...new Set(docs.map((d) => d.category).filter(Boolean))]

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">資料ダウンロード</h1>
          <p className="mt-1 text-sm text-gray-500">{loading ? '—' : `${docs.length} 件の資料`}</p>
        </div>
        <RefreshButton
          onClick={reload}
          loading={loading}
          label="再読込"
          title="Firestore から最新の資料を再取得（当日キャッシュをバイパス）"
        />
      </div>

      {/* データ鮮度バッジ */}
      <LastSyncedBadge syncedAt={lastSyncedAt} label="資料 最終更新" />

      {/* エラー */}
      <ErrorBanner message={error} onRetry={reload} />

      {/* ローディング */}
      {loading && !error && <LoadingSkeleton variant="card" lines={3} />}

      {!loading && !error && (
        <>
          {/* カテゴリフィルタ */}
          {categories.length > 0 && (
            <div className="mb-6 mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => setFilter('all')}
                className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                  filter === 'all'
                    ? 'bg-indigo-600 text-white'
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
                      ? 'bg-indigo-600 text-white'
                      : 'border border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {CATEGORY_LABELS[cat] || cat}
                </button>
              ))}
            </div>
          )}

          {filtered.length === 0 ? (
            <EmptyStateCard
              icon="📁"
              title={filter === 'all'
                ? '資料がまだ登録されていません'
                : `「${CATEGORY_LABELS[filter] || filter}」の資料はありません`}
              description={filter === 'all'
                ? '管理者が資料をアップロードすると表示されます。最新を反映するには右上の「🔄 再読込」を押してください。'
                : '別のカテゴリを選択するか「すべて」を選んでください。'}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {filtered.map((d) => (
                <div key={d.id} className="rounded-xl border border-gray-200 bg-white p-5">
                  <div className="mb-2 flex items-center gap-2">
                    {d.source === 'upload' && (
                      <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                        PDF
                      </span>
                    )}
                    {d.category && (
                      <span className="rounded bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                        {CATEGORY_LABELS[d.category] || d.category}
                      </span>
                    )}
                    <span className="text-xs text-gray-400">{fmtDate(d.updatedAt)}</span>
                  </div>
                  <h3 className="mb-1 text-sm font-bold text-gray-900">{d.title}</h3>
                  {d.description && (
                    <p className="mb-2 text-xs text-gray-500">{d.description}</p>
                  )}
                  {d.fileName && (
                    <p className="mb-3 text-xs text-gray-400">
                      {d.fileName}{d.fileSize ? ` (${fmtSize(d.fileSize)})` : ''}
                    </p>
                  )}
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-700"
                  >
                    {d.source === 'upload' ? 'PDFをダウンロード' : 'ダウンロード / 開く'}
                  </a>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
