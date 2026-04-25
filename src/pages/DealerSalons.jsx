import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { fetchDealerSalonNamesFromBcart } from '../lib/dashboardAggregator.js'
import { normalizeCompanyName } from '../lib/nameNormalize.js'

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function fmtYen(n) {
  if (n == null) return '—'
  return '\u00a5' + Number(n).toLocaleString()
}

export default function DealerSalons() {
  const { profile } = useAuth()
  const dealerCode = profile?.dealerCode || ''

  const [salons, setSalons] = useState([])
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [rawCount, setRawCount] = useState(0)
  const [cachedAt, setCachedAt] = useState(null)
  const [progress, setProgress] = useState('')
  const [searchParams] = useSearchParams()
  const [selected, setSelected] = useState(searchParams.get('salon'))

  // unmount 後の setState 抑止用
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const loadData = async (forceRefresh = false) => {
    if (!dealerCode) { setLoading(false); return }

    // キャッシュキーを v2 に上げて、旧 v1（12ヶ月 Bカート 受注を保持）を自動無効化
    const cacheKey = `dealerSalonsPage:${dealerCode}:v2`
    const today = new Date().toISOString().slice(0, 10)

    // キャッシュ確認
    // 注意: 空キャッシュ（salons.length===0 かつ orders.length===0）は
    //       過去の取得失敗の可能性が高いため捨てて再取得する。
    if (!forceRefresh) {
      try {
        const raw = localStorage.getItem(cacheKey)
        if (raw) {
          const cached = JSON.parse(raw)
          const salonsLen = Array.isArray(cached.salons) ? cached.salons.length : 0
          const ordersLen = Array.isArray(cached.orders) ? cached.orders.length : 0
          const isEmpty = salonsLen === 0 && ordersLen === 0
          if (cached.date === today && cached.salons && cached.orders && !isEmpty) {
            if (!aliveRef.current) return
            setRawCount(cached.rawCount || cached.salons.length)
            setSalons(cached.salons)
            setOrders(cached.orders.map((o) => ({
              ...o,
              orderDate: o.orderDate ? new Date(o.orderDate) : null,
            })))
            setCachedAt(cached.fetchedAt || today)
            setLoading(false)
            return
          }
          if (isEmpty) {
            // 0件キャッシュは過去の取得失敗の可能性が高いため破棄
            try { localStorage.removeItem(cacheKey) } catch {}
          }
        }
      } catch (e) { console.warn('cache read failed:', e) }
    }

    setLoading(true)
    setProgress('読み込み中...')
    try {
      // 並列実行: Bカート所属サロン名 + Firestore dealerSalons + Firestore orders
      // Firestore orders は dealerCode で絞った全期間を1リクエスト取得し、
      // クライアント側で直近12ヶ月にフィルタ。
      // 旧実装は Bカート fetchOrdersByMonth を 12 ヶ月連続で叩いていたため、
      // J0002 のような大規模代理店では数十秒かかっていた。
      setProgress('サロン名を取得しています...')
      const cutoff = new Date()
      cutoff.setMonth(cutoff.getMonth() - 12)
      cutoff.setHours(0, 0, 0, 0)

      const [bcartNames, salonSnap, ordersSnap] = await Promise.all([
        fetchDealerSalonNamesFromBcart(dealerCode, { fallbackMonths: 6, forceRefresh }),
        getDocs(query(collection(db, 'dealerSalons'), where('dealerCode', '==', dealerCode))),
        getDocs(query(collection(db, 'orders'), where('dealerCode', '==', dealerCode))),
      ])
      if (!aliveRef.current) return

      const computedRawCount = bcartNames.rawCount || bcartNames.size
      setRawCount(computedRawCount)

      // dealerSalons メタ情報（type='own' 等）
      const metaByName = new Map()
      for (const d of salonSnap.docs) {
        const data = d.data()
        if (data.companyName) metaByName.set(data.companyName, { id: d.id, ...data })
      }

      // サロンリスト（Bカート + dealerSalons の和集合）
      const combinedNameSet = new Set([...bcartNames, ...metaByName.keys()])
      const combinedSalons = Array.from(combinedNameSet).map((name) => {
        const meta = metaByName.get(name)
        if (meta) return meta
        return { id: `auto-${name}`, companyName: name, type: 'sub', auto: true }
      })
      setSalons(combinedSalons)

      // Firestore orders を直近12ヶ月でフィルタしてマップ
      const cutoffMs = cutoff.getTime()
      const allOrders = []
      for (const d of ordersSnap.docs) {
        const o = d.data()
        const od = o.orderDate?.toDate?.() ?? (o.orderDate?._seconds ? new Date(o.orderDate._seconds * 1000) : null)
        if (od && od.getTime() < cutoffMs) continue
        allOrders.push({
          id: d.id,
          companyName: o.companyName || '',
          total: Number(o.total) || 0,
          subtotal: Number(o.subtotal) || 0,
          orderDate: od,
          orderNumber: o.bcartOrderNumber || '',
          bcartOrderNumber: o.bcartOrderNumber || '',
        })
      }
      setOrders(allOrders)

      // キャッシュ保存（Date は ISO 文字列に）
      const fetchedAt = new Date().toLocaleString('ja-JP')
      setCachedAt(fetchedAt)
      try {
        localStorage.setItem(cacheKey, JSON.stringify({
          date: today,
          fetchedAt,
          rawCount: computedRawCount,
          salons: combinedSalons,
          orders: allOrders.map((o) => ({
            ...o,
            orderDate: o.orderDate ? o.orderDate.toISOString() : null,
          })),
        }))
      } catch (e) { console.warn('cache write failed:', e) }
    } catch (e) {
      console.error('データ取得エラー:', e)
    } finally {
      if (aliveRef.current) {
        setLoading(false)
        setProgress('')
      }
    }
  }

  useEffect(() => {
    aliveRef.current = true
    loadData(false)
    return () => { aliveRef.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealerCode])

  // サロンごとの集計（O(N+M) 化＋ useMemo で memoize）
  // 旧実装は salons.map 内で orders.filter を呼ぶ O(N×M) で、
  // J0002 のような 200 サロン × 数千注文では数十万回の比較が走り重かった。
  const sortedStats = useMemo(() => {
    const now = new Date()
    const thisMonthKey = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`

    // companyName 正規化キー → 集計バケット
    const bucket = new Map()
    const ensure = (key) => {
      if (!bucket.has(key)) {
        bucket.set(key, {
          totalOrders: 0,
          totalSales: 0,
          thisMonthOrders: 0,
          thisMonthSales: 0,
          lastOrderDate: null,
          orders: [],
        })
      }
      return bucket.get(key)
    }

    for (const o of orders) {
      const key = normalizeCompanyName(o.companyName)
      if (!key) continue
      const b = ensure(key)
      const total = Number(o.total) || 0
      b.totalOrders += 1
      b.totalSales += total
      b.orders.push(o)
      const d = o.orderDate instanceof Date ? o.orderDate : (o.orderDate ? new Date(o.orderDate) : null)
      if (d) {
        if (!b.lastOrderDate || d > b.lastOrderDate) b.lastOrderDate = d
        const ym = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
        if (ym === thisMonthKey) {
          b.thisMonthOrders += 1
          b.thisMonthSales += total
        }
      }
    }

    const stats = salons.map((salon) => {
      const key = normalizeCompanyName(salon.companyName)
      const b = bucket.get(key) || { totalOrders: 0, totalSales: 0, thisMonthOrders: 0, thisMonthSales: 0, lastOrderDate: null, orders: [] }
      return { ...salon, ...b }
    })
    stats.sort((a, b) => b.totalSales - a.totalSales)
    return stats
  }, [salons, orders])

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-gray-400">読み込み中...</div>
  }

  // サロン詳細表示
  if (selected) {
    const salon = sortedStats.find((s) => s.companyName === selected)
    if (!salon) { setSelected(null); return null }

    // 月別集計
    const monthly = {}
    for (const o of salon.orders) {
      const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
      if (!d) continue
      const key = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!monthly[key]) monthly[key] = { count: 0, total: 0 }
      monthly[key].count++
      monthly[key].total += Number(o.total) || 0
    }
    const monthlyKeys = Object.keys(monthly).sort().reverse()

    return (
      <div>
        <button
          onClick={() => setSelected(null)}
          className="mb-4 text-sm text-indigo-600 hover:underline"
        >
          ← サロン一覧に戻る
        </button>

        <div className="mb-2 flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${
            salon.type === 'own' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
          }`}>
            {salon.type === 'own' ? '自社' : 'サロン'}
          </span>
          <h1 className="text-2xl font-bold text-gray-900">{salon.companyName}</h1>
        </div>

        <div className="mb-6 flex gap-6 text-sm text-gray-500">
          <span>注文数：<strong className="text-gray-900">{salon.totalOrders}件</strong></span>
          <span>累計売上：<strong className="text-gray-900">{fmtYen(salon.totalSales)}</strong></span>
          <span>今月：<strong className="text-indigo-600">{fmtYen(salon.thisMonthSales)}</strong></span>
        </div>

        {/* 月別売上 */}
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-bold text-gray-700">月別売上</h2>
          <div className="flex flex-wrap gap-3">
            {monthlyKeys.length === 0 ? (
              <span className="text-sm text-gray-400">データなし</span>
            ) : (
              monthlyKeys.map((k) => (
                <div key={k} className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-center">
                  <div className="text-xs text-gray-500">{k}</div>
                  <div className="mt-1 text-lg font-bold text-gray-900">{fmtYen(monthly[k].total)}</div>
                  <div className="text-xs text-gray-400">{monthly[k].count}件</div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 注文一覧 */}
        <h2 className="mb-3 text-sm font-bold text-gray-700">注文履歴</h2>
        <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
          {salon.orders.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-400">注文データがありません</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                  <th className="px-4 py-3">注文番号</th>
                  <th className="px-4 py-3">注文日</th>
                  <th className="px-4 py-3 text-right">合計</th>
                </tr>
              </thead>
              <tbody>
                {salon.orders.map((o) => (
                  <tr key={o.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs">{o.orderNumber || o.bcartOrderNumber || '—'}</td>
                    <td className="px-4 py-3">{fmtDate(o.orderDate)}</td>
                    <td className="px-4 py-3 text-right font-bold">{fmtYen(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    )
  }

  // クエリ ?view=priority のとき、優先フォロー順に並べ替えて表示する。
  // 「sort（並べ替え）」だけで「filter（絞り込み）」しないため、件数 0 件等の
  // edge case を発生させない安全実装。
  // 優先度スコア:
  //   履歴なし                : 1000（最優先・新規未発注）
  //   90日以上未発注          : +200
  //   30〜89日未発注          : +100
  //   7〜29日未発注           : +30
  //   今月発注なし（履歴あり）: +20
  //   タイブレーク             : 経過日数（大きいほど上）
  const viewMode = searchParams.get('view')
  const showPriority = viewMode === 'priority'

  const displayStats = useMemo(() => {
    if (!showPriority) return sortedStats
    const now = Date.now()
    const score = (s) => {
      if (!s.lastOrderDate) return 1000
      const days = Math.floor((now - s.lastOrderDate.getTime()) / 86400000)
      let p = 0
      if (s.thisMonthOrders === 0) p += 20
      if (days >= 90) p += 200
      else if (days >= 30) p += 100
      else if (days >= 7) p += 30
      return p + days
    }
    return [...sortedStats].sort((a, b) => score(b) - score(a))
  }, [sortedStats, showPriority])

  const totalSales = displayStats.reduce((s, salon) => s + salon.totalSales, 0)
  const totalOrders = displayStats.reduce((s, salon) => s + salon.totalOrders, 0)

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">所属サロン管理</h1>
        <button
          onClick={() => loadData(true)}
          disabled={loading}
          className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
          title="Bカートから最新データを再取得"
        >
          🔄 更新
        </button>
      </div>
      <p className="mb-1 text-sm text-gray-500">
        {(rawCount || salons.length).toLocaleString()} 社 ／ 累計注文 {totalOrders}件 ／ 累計売上 {fmtYen(totalSales)}
      </p>
      {cachedAt && !loading && (
        <p className="mb-6 text-xs text-gray-400">
          データ取得日時: {cachedAt}（Bカートデータは1日1回取得。最新にするには「🔄 更新」）
        </p>
      )}
      {loading && progress && (
        <div className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
          {progress}
        </div>
      )}

      {/* 優先フォロー表示モードのバナー（インライン style 併用で FOUC 耐性も） */}
      {showPriority && (
        <div
          className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs"
          style={{
            background: '#eef2ff',
            border: '1px solid #c7d2fe',
            borderRadius: 8,
            padding: '8px 12px',
            marginBottom: 16,
          }}
        >
          <div className="font-bold text-indigo-700" style={{ color: '#4338ca', fontWeight: 700 }}>
            フォロー優先サロン一覧（ダッシュボードの続き）
          </div>
          <div className="mt-1 text-indigo-500" style={{ color: '#6366f1', marginTop: 2 }}>
            未発注期間が長いサロン順に並んでいます（並べ替えのみ。全 {displayStats.length} 件を表示）
          </div>
        </div>
      )}

      {salons.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          所属サロンがまだ登録されていません
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {displayStats.map((salon) => (
            <div
              key={salon.id}
              onClick={() => setSelected(salon.companyName)}
              className="cursor-pointer rounded-xl border border-gray-200 bg-white p-5 transition-shadow hover:shadow-md"
            >
              <div className="mb-3 flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                  salon.type === 'own' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                }`}>
                  {salon.type === 'own' ? '自社' : 'サロン'}
                </span>
                <span className="text-sm font-bold text-gray-900">{salon.companyName}</span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-[10px] text-gray-500">累計売上</div>
                  <div className="text-sm font-bold text-gray-900">{fmtYen(salon.totalSales)}</div>
                  <div className="text-[10px] text-gray-400">{salon.totalOrders}件</div>
                </div>
                <div>
                  <div className="text-[10px] text-indigo-500">今月</div>
                  <div className="text-sm font-bold text-indigo-600">{fmtYen(salon.thisMonthSales)}</div>
                  <div className="text-[10px] text-indigo-300">{salon.thisMonthOrders}件</div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-500">最終注文</div>
                  <div className="text-sm text-gray-700">
                    {salon.lastOrderDate
                      ? `${salon.lastOrderDate.getMonth() + 1}/${salon.lastOrderDate.getDate()}`
                      : '—'}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
