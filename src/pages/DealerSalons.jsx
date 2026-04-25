import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
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
  const [lastSyncedAt, setLastSyncedAt] = useState(null) // Bカート → Firestore 最終同期時刻
  const [progress, setProgress] = useState('')
  // 「最新データ取得（Bカート同期）」用の状態
  const [bcartSyncing, setBcartSyncing] = useState(false)
  const [bcartSyncResult, setBcartSyncResult] = useState(null)
  const [bcartSyncError, setBcartSyncError] = useState(null)
  const [searchParams] = useSearchParams()
  const [selected, setSelected] = useState(searchParams.get('salon'))

  // unmount 後の setState 抑止用
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const loadData = async (forceRefresh = false) => {
    if (!dealerCode) { setLoading(false); return }

    // キャッシュキー v4: Bカート画面取得を撤廃し Firestore のみで表示（軽量化）。旧 v3 を自動無効化
    const cacheKey = `dealerSalonsPage:${dealerCode}:v4`
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
            if (cached.lastSyncedAt) setLastSyncedAt(new Date(cached.lastSyncedAt))
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
      // 軽量化方針（2026-04-25）:
      //   画面表示時に Bカート API は叩かない。Firestore を「表示用キャッシュ」として使う。
      //   Bカート → Firestore の同期は別バッチ（bcart-sync 等）で行う。
      //   ここでは:
      //     - dealerSalons コレクション（type='own' 等のメタ）
      //     - orders コレクション（dealerCode で絞った全期間）
      //   から表示データを構築する。
      const cutoff = new Date()
      cutoff.setMonth(cutoff.getMonth() - 36)
      cutoff.setHours(0, 0, 0, 0)

      const [salonSnap, ordersSnap] = await Promise.all([
        getDocs(query(collection(db, 'dealerSalons'), where('dealerCode', '==', dealerCode))),
        getDocs(query(collection(db, 'orders'), where('dealerCode', '==', dealerCode))),
      ])
      if (!aliveRef.current) return

      // dealerSalons メタ情報（type='own' 等）
      const metaByName = new Map()
      for (const d of salonSnap.docs) {
        const data = d.data()
        if (data.companyName) metaByName.set(data.companyName, { id: d.id, ...data })
      }

      // orders からも会社名を抽出（dealerSalons に未登録だが発注実績ありのサロンも拾う）
      const orderCompanySet = new Set()
      let computedLastSyncedAt = null
      for (const d of ordersSnap.docs) {
        const o = d.data()
        if (o.companyName) orderCompanySet.add(o.companyName)
        const ts = o.syncedAt?._seconds || o.syncedAt?.seconds || 0
        if (ts > 0) {
          const dt = new Date(ts * 1000)
          if (!computedLastSyncedAt || dt > computedLastSyncedAt) computedLastSyncedAt = dt
        }
      }
      if (computedLastSyncedAt) setLastSyncedAt(computedLastSyncedAt)

      // サロンリスト（dealerSalons + orders の和集合）
      const combinedNameSet = new Set([...metaByName.keys(), ...orderCompanySet])
      const combinedSalons = Array.from(combinedNameSet).map((name) => {
        const meta = metaByName.get(name)
        if (meta) return meta
        return { id: `auto-${name}`, companyName: name, type: 'sub', auto: true }
      })
      setSalons(combinedSalons)
      setRawCount(combinedSalons.length)

      // Firestore orders を直近 36 ヶ月でフィルタしてマップ
      // orderNumber は複数キーをフォールバック（旧 fetch 経由 doc は bcartOrderNumber が
      // 無く bcartCode しか入っていないため）
      //   優先: bcartOrderNumber → bcartCode → bcartOrderId → orderNumber → orderNo
      const cutoffMs = cutoff.getTime()
      const allOrders = []
      for (const d of ordersSnap.docs) {
        const o = d.data()
        const od = o.orderDate?.toDate?.() ?? (o.orderDate?._seconds ? new Date(o.orderDate._seconds * 1000) : null)
        if (od && od.getTime() < cutoffMs) continue
        const orderNo = (
          o.bcartOrderNumber
          || o.bcartCode
          || (o.bcartOrderId != null ? String(o.bcartOrderId) : '')
          || o.orderNumber
          || o.orderNo
          || ''
        )
        allOrders.push({
          id: d.id,
          companyName: o.companyName || '',
          total: Number(o.total) || 0,
          subtotal: Number(o.subtotal) || 0,
          orderDate: od,
          orderNumber: orderNo,
          bcartOrderNumber: orderNo,
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
          rawCount: combinedSalons.length,
          salons: combinedSalons,
          orders: allOrders.map((o) => ({
            ...o,
            orderDate: o.orderDate ? o.orderDate.toISOString() : null,
          })),
          lastSyncedAt: computedLastSyncedAt ? computedLastSyncedAt.toISOString() : null,
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

  // 「最新データ取得」: Cloud Function を叩いて直近 N 日の Bカート 注文を Firestore へ upsert、
  // 完了後に Firestore 再取得して画面を更新。
  const runBcartSync = async (days = 7) => {
    if (!dealerCode || bcartSyncing) return
    setBcartSyncing(true)
    setBcartSyncError(null)
    setBcartSyncResult(null)
    try {
      const fn = httpsCallable(functions, 'runIncrementalBcartSync')
      const res = await fn({ days })
      const r = res?.data || {}
      setBcartSyncResult(r)
      // Firestore を再取得してキャッシュを上書き
      await loadData(true)
    } catch (e) {
      // Cloud Functions httpsCallable のエラー: code / message / details を全部出す
      console.warn('runBcartSync error:', e?.code, e?.message, e?.details, e)
      const parts = []
      if (e?.code) parts.push(`[${e.code}]`)
      if (e?.message) parts.push(e.message)
      if (e?.details?.stack) parts.push(`stack: ${e.details.stack}`)
      setBcartSyncError(parts.join(' ') || '同期に失敗しました')
    } finally {
      setBcartSyncing(false)
    }
  }

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

    // === 表示枠を「過去3年 / 過去36ヶ月」で固定（データなしも 0 で出す） ===
    const now = new Date()
    const currentYear = now.getFullYear()

    // 年別: 直近4年を必ず空枠で用意（2023年=表示範囲下限まで含める）
    // 2023 は前年データが無いため yoy=null（UI で「—」表示）
    const yearly = {}
    const yearKeysDesc = [currentYear, currentYear - 1, currentYear - 2, currentYear - 3].map(String)
    for (const y of yearKeysDesc) yearly[y] = { count: 0, total: 0, yoyRate: null }

    // 月別: 直近36ヶ月を必ず空枠で用意（新しい順）
    const monthly = {}
    const monthlyKeys = []
    for (let i = 0; i < 36; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const k = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
      monthlyKeys.push(k)
      monthly[k] = { count: 0, total: 0 }
    }

    // === orders を集計（過去3年外の古い注文は無視） ===
    let lastOrderDate = null
    for (const o of salon.orders) {
      const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
      if (!d) continue
      const t = Number(o.total) || 0
      const yKey = String(d.getFullYear())
      const mKey = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
      if (yearly[yKey]) {
        yearly[yKey].count++
        yearly[yKey].total += t
      }
      if (monthly[mKey]) {
        monthly[mKey].count++
        monthly[mKey].total += t
      }
      if (!lastOrderDate || d > lastOrderDate) lastOrderDate = d
    }

    // 前年比（新しい→古い順 yearKeysDesc に対し、各年と1つ古い年を比較）
    for (let i = 0; i < yearKeysDesc.length - 1; i += 1) {
      const cur = yearly[yearKeysDesc[i]]
      const prev = yearly[yearKeysDesc[i + 1]]
      if (prev?.total > 0) {
        cur.yoyRate = (cur.total - prev.total) / prev.total
      }
    }

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

        <div className="mb-6 flex flex-wrap gap-4 text-sm text-gray-500 md:gap-6">
          <span>注文数：<strong className="text-gray-900">{salon.totalOrders}件</strong></span>
          <span>累計売上：<strong className="text-gray-900">{fmtYen(salon.totalSales)}</strong></span>
          <span>今月：<strong className="text-indigo-600">{fmtYen(salon.thisMonthSales)}</strong></span>
          <span>最終注文：<strong className="text-gray-900">{fmtDate(lastOrderDate)}</strong></span>
        </div>

        {/* 年別サマリ（直近3年）+ 前年比 */}
        <div className="mb-6">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-bold text-gray-700">年別売上（前年比）</h2>
            <div className="text-[11px] text-gray-400">同期済データ（Bカート → Firestore）</div>
          </div>
          {/* 最終同期時刻と注意文 */}
          {lastSyncedAt && (() => {
            const ageH = Math.floor((Date.now() - lastSyncedAt.getTime()) / 3600000)
            const stale = ageH >= 24
            return (
              <div className={`mb-3 rounded-lg px-3 py-2 text-[11px] ${stale ? 'bg-amber-50 text-amber-800' : 'bg-gray-50 text-gray-500'}`}>
                Bカート 最終同期: {lastSyncedAt.toLocaleString('ja-JP')}（{ageH} 時間前）
                {stale && '。これ以降の注文は未反映の可能性があります。'}
              </div>
            )
          })()}
          {yearKeysDesc.length === 0 ? (
            <span className="text-sm text-gray-400">データなし</span>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {yearKeysDesc.map((y) => {
                const yoy = yearly[y].yoyRate
                const yoyColor = yoy == null
                  ? 'text-gray-400'
                  : yoy > 0
                    ? 'text-emerald-600'
                    : yoy < 0
                      ? 'text-red-600'
                      : 'text-gray-500'
                return (
                  <div key={y} className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="text-xs text-gray-500">{y}年</div>
                    <div className="mt-1 text-lg font-bold text-gray-900">{fmtYen(yearly[y].total)}</div>
                    <div className="text-xs text-gray-400">{yearly[y].count} 件</div>
                    <div className={`mt-1 text-xs ${yoyColor}`}>
                      前年比：{yoy == null ? '—' : `${(yoy * 100).toFixed(1)}%`}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
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

  // hotfix（PR #101 撤去）: view=priority による優先順ソートで真っ白画面の
  // 報告があったため、PR #99 時点（売上順 sortedStats）に再度戻す。
  // 原因が特定できるまで Top5 続き導線も非表示。
  const totalSales = sortedStats.reduce((s, salon) => s + salon.totalSales, 0)
  const totalOrders = sortedStats.reduce((s, salon) => s + salon.totalOrders, 0)

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">所属サロン管理</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadData(true)}
            disabled={loading || bcartSyncing}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            title="Firestore 同期済データを再読込（Bカートには問い合わせません）"
          >
            🔄 再読込
          </button>
          <button
            onClick={() => runBcartSync(7)}
            disabled={loading || bcartSyncing}
            className="rounded-lg border border-indigo-500 bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
            title="Bカートから直近7日分の最新注文を取り込み（数十秒かかる場合があります）"
          >
            {bcartSyncing ? '⏳ 同期中…' : '⤓ 最新データ取得'}
          </button>
        </div>
      </div>
      {/* 同期結果 / エラー表示 */}
      {bcartSyncResult && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          ✅ Bカート 同期完了：直近 {bcartSyncResult.sinceDays} 日 / 取得 {bcartSyncResult.bcartFetched} 件 / 自代理店 {bcartSyncResult.matched} 件 / 新規 {bcartSyncResult.created} ・更新 {bcartSyncResult.updated}
          {bcartSyncResult.failed > 0 && ` / 失敗 ${bcartSyncResult.failed}`}
        </div>
      )}
      {bcartSyncError && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          ⚠ Bカート 同期に失敗しました: {bcartSyncError}
        </div>
      )}
      <p className="mb-1 text-sm text-gray-500">
        {(rawCount || salons.length).toLocaleString()} 社 ／ 累計注文 {totalOrders}件 ／ 累計売上 {fmtYen(totalSales)}
      </p>
      <p className="mb-1 text-[11px] text-gray-400">
        Firestore 同期済みデータで表示中（軽量化のため Bカート へは画面表示時に問い合わせません）
      </p>
      {lastSyncedAt && (() => {
        const ageH = Math.floor((Date.now() - lastSyncedAt.getTime()) / 3600000)
        const stale = ageH >= 24
        return (
          <p className={`mb-1 text-xs ${stale ? 'text-amber-700' : 'text-gray-400'}`}>
            Bカート 最終同期: {lastSyncedAt.toLocaleString('ja-JP')}（{ageH} 時間前）
            {stale && '。これ以降の注文は未反映の可能性があります。'}
          </p>
        )
      })()}
      {cachedAt && !loading && (
        <p className="mb-6 text-xs text-gray-400">
          画面キャッシュ更新: {cachedAt}（再読込は「🔄 更新」）
        </p>
      )}
      {loading && progress && (
        <div className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
          {progress}
        </div>
      )}

      {salons.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          所属サロンがまだ登録されていません
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {sortedStats.map((salon) => (
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
