import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import useDealerDashboard, { activeRateColor, STATUS_BADGE } from '../hooks/useDealerDashboard.js'
import { normalizeCompanyName } from '../lib/nameNormalize.js'
import { fetchDealerSalonNamesFromBcart } from '../lib/dashboardAggregator.js'

const fmtYen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString()}`
const fmtPct = (n) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`)

function fmtMonth(m) {
  if (!m) return ''
  const [, mm] = String(m).split('-')
  return `${Number(mm)}月`
}

function fmtDate(d) {
  if (!d) return '—'
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function KpiCard({ label, value, sub, subColor, accent }) {
  const border = accent === 'primary' ? 'border-indigo-200 bg-indigo-50' : 'border-gray-200 bg-white'
  return (
    <div className={`rounded-2xl border ${border} p-5`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-2 text-2xl font-bold text-gray-900">{value}</div>
      {sub && <div className={`mt-1 text-xs ${subColor || 'text-gray-500'}`}>{sub}</div>}
    </div>
  )
}

// サロン状況パネル内のクリック可能タイル
function StatTile({ label, value, accent, active, onClick, disabled }) {
  const base = 'rounded-xl border p-3 text-left transition-colors'
  const valueClass = accent === 'primary' ? 'text-indigo-900' : 'text-gray-900'
  if (disabled) {
    return (
      <div className={`${base} border-dashed border-gray-200 bg-gray-50`}>
        <div className="text-xs text-gray-500">{label}</div>
        <div className="mt-1 text-lg font-bold text-gray-400">{value}</div>
      </div>
    )
  }
  const ring = active ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200' : 'border-gray-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40'
  return (
    <button type="button" onClick={onClick} className={`${base} ${ring}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-lg font-bold ${valueClass}`}>{value}</div>
    </button>
  )
}

// サロン状態バッジ
function StateBadge({ state }) {
  const map = {
    '稼働': 'bg-emerald-100 text-emerald-800',
    '休眠': 'bg-amber-100 text-amber-800',
    '要フォロー': 'bg-red-100 text-red-700',
    '未稼働': 'bg-amber-100 text-amber-800',
    '未発注': 'bg-gray-100 text-gray-600',
    '管理対象外': 'bg-gray-100 text-gray-600',
    '管理対象外・稼働': 'bg-emerald-100 text-emerald-800',
  }
  const cls = map[state] || 'bg-gray-100 text-gray-600'
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>{state}</span>
}

// 経過日数から状態を算出
//   30日以内 / 当月発注あり → 稼働
//   31〜90日 → 休眠
//   91日以上 / 履歴なし → 要フォロー（赤）
function statusFromDays(currentSales, lastOrderDate, now = new Date()) {
  if ((Number(currentSales) || 0) > 0) return '稼働'
  if (!lastOrderDate) return '要フォロー'
  const days = Math.floor((now.getTime() - lastOrderDate.getTime()) / (1000 * 60 * 60 * 24))
  if (days >= 91) return '要フォロー'
  if (days >= 31) return '休眠'
  return '稼働'
}

function daysSince(lastOrderDate, now = new Date()) {
  if (!lastOrderDate) return null
  return Math.floor((now.getTime() - lastOrderDate.getTime()) / (1000 * 60 * 60 * 24))
}

// =====================================================
// 経営ダッシュボード（Firestore ベース、Phase 3-1 v2）
// =====================================================

export default function DealerExecDashboard() {
  const { profile } = useAuth()
  const {
    loading, error, kpis, salons,
    monthlyTrend, productsRanking, statusDistribution,
    productCoverage,
    allOrders, // PR-A 統合: hook が全期間 orders を返すようになった
  } = useDealerDashboard(profile)

  const [statusFilter, setStatusFilter] = useState('all')

  // サロン状況：dealerSalons + 月次snapshot を取得（allOrders は hook から取得）
  const [managedSalons, setManagedSalons] = useState([])
  const [snapshotTotalSalonCount, setSnapshotTotalSalonCount] = useState(null)
  const [bcartNames, setBcartNames] = useState(null) // Set<string> | null（未取得）
  const [bcartRecords, setBcartRecords] = useState(null) // Array<{name, customerId, status, source}> | null
  const [bcartLoading, setBcartLoading] = useState(false)
  const [bcartError, setBcartError] = useState(null)
  const [selectedListKey, setSelectedListKey] = useState(null)
  // 'all' | 'managed' | 'active' | 'rate' | 'dormant'

  useEffect(() => {
    const code = profile?.dealerCode
    if (!code) {
      setManagedSalons([]); setSnapshotTotalSalonCount(null)
      setBcartNames(null); setBcartRecords(null); setBcartError(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const dsSnap = await getDocs(
          query(collection(db, 'dealerSalons'), where('dealerCode', '==', code)),
        )
        if (cancelled) return
        setManagedSalons(dsSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      } catch (e) {
        console.warn('[DealerExec] dealerSalons 取得失敗:', e.message)
      }

      // dealerMonthlySnapshots/{code}_{YYYY-MM} を 当月→前月 と最大6ヶ月遡って取得。
      // 旧実装は直列ループで最悪 6 RTT 待ちだった。
      // PR-B（2026-04-25）: Promise.allSettled で並列化。完了時間は最大 1 RTT。
      // 新しい月から順に「存在 & totalSalonCount > 0」のものを採用。
      try {
        const now = new Date()
        const refs = []
        for (let i = 0; i < 6; i += 1) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
          const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
          refs.push(doc(db, 'dealerMonthlySnapshots', `${code}_${ym}`))
        }
        const results = await Promise.allSettled(refs.map((r) => getDoc(r)))
        if (cancelled) return
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.exists()) {
            const v = Number(r.value.data().totalSalonCount)
            if (Number.isFinite(v) && v > 0) {
              setSnapshotTotalSalonCount(v)
              break
            }
          }
        }
      } catch (e) {
        console.warn('[DealerExec] dealerMonthlySnapshots 取得失敗:', e.message)
      }
    })()
    return () => { cancelled = true }
  }, [profile?.dealerCode])

  // 起動時に Bcart 名簿をバックグラウンド取得（カード/一覧の件数が dedup 結果で即時一致するため）
  useEffect(() => {
    const code = profile?.dealerCode
    if (!code) return
    // localStorage キャッシュがあれば即時反映、無ければ数秒後に反映
    ensureBcartNames()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.dealerCode])

  // Bcart 名簿を遅延取得（一覧クリック時 / マウント時）
  const ensureBcartNames = async () => {
    const code = profile?.dealerCode
    if (!code || bcartNames || bcartLoading) return
    setBcartLoading(true); setBcartError(null)
    try {
      const names = await fetchDealerSalonNamesFromBcart(code)
      setBcartNames(names)
      setBcartRecords(Array.isArray(names?.records) ? names.records : [])
      // raw 件数（生の Bカート 会員件数）を最新値として反映
      const rawCount = Number(names?.rawCount)
      if (Number.isFinite(rawCount) && rawCount > 0) setSnapshotTotalSalonCount(rawCount)
    } catch (e) {
      setBcartError(e?.message || 'Bcart 名簿取得に失敗しました')
    } finally {
      setBcartLoading(false)
    }
  }

  // サロンインデックス: companyName 正規化キー → { displayName, cumulativeSales, currentSales, lastOrderDate, orderCount }
  const salonIndex = useMemo(() => {
    const m = new Map()
    const curYm = kpis?.curMonth
    for (const o of allOrders) {
      const key = normalizeCompanyName(o.companyName)
      if (!key) continue
      if (!m.has(key)) {
        m.set(key, { key, displayName: o.companyName || '（不明）', cumulativeSales: 0, currentSales: 0, lastOrderDate: null, orderCount: 0 })
      }
      const s = m.get(key)
      const t = Number(o.total) || 0
      s.cumulativeSales += t
      s.orderCount += 1
      const ts = o.orderDate
      const od = ts?.toDate?.() ?? (ts?._seconds ? new Date(ts._seconds * 1000) : (ts ? new Date(ts) : null))
      if (od && !Number.isNaN(od.getTime())) {
        if (!s.lastOrderDate || od > s.lastOrderDate) s.lastOrderDate = od
        if (curYm) {
          const ym = `${od.getFullYear()}-${String(od.getMonth() + 1).padStart(2, '0')}`
          if (ym === curYm) s.currentSales += t
        }
      }
    }
    return m
  }, [allOrders, kpis?.curMonth])

  // 管理対象 (dealerSalons) の正規化キー集合
  const managedKeys = useMemo(() => {
    const s = new Set()
    for (const ds of managedSalons) {
      const nm = normalizeCompanyName(ds.companyName || ds.salonName)
      if (nm) s.add(nm)
    }
    return s
  }, [managedSalons])

  // サロン単位の重複解消リスト（サロン名 正規化キーで1行=1サロン）
  // 同名複数 customer_id は、優先度「最終注文日 → 累計売上 → customerId（大きい=新しい）」で1件に集約。
  // 古い customer_id 側は非表示（hiddenIds に記録）。
  //
  // 重要: salonIndex（orders 由来の実績情報）をここで明示的に merge する。
  // これにより、listRows 側で再ルックアップする必要がなく、キー不整合の
  // 隠れバグを避ける。orderLastDate / currentSales / cumulativeSales はここで確定。
  const uniqueSalons = useMemo(() => {
    if (!Array.isArray(bcartRecords) || bcartRecords.length === 0) return null

    // salonIndex から「raw name」で引けるセカンダリインデックスも作る（キー不一致時のフォールバック）
    const byRawName = new Map()
    for (const s of salonIndex.values()) {
      if (s.displayName) byRawName.set(s.displayName, s)
    }

    const lookup = (rawName) => {
      if (!rawName) return null
      const normKey = normalizeCompanyName(rawName)
      return salonIndex.get(normKey) || byRawName.get(rawName) || byRawName.get(rawName.trim()) || null
    }

    const groups = new Map() // key → records[]
    const anonymous = []
    for (const rec of bcartRecords) {
      const nm = (rec.name || '').trim()
      if (!nm) { anonymous.push(rec); continue }
      const key = normalizeCompanyName(nm)
      if (!key) { anonymous.push(rec); continue }
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(rec)
    }

    const rows = []
    for (const [key, recs] of groups) {
      // このサロン（key）に紐づく orders 集計情報を確定
      const idx = salonIndex.get(key) || lookup(recs[0].name)
      const lastOrderMs = idx?.lastOrderDate?.getTime?.() || 0
      const cumulative = idx?.cumulativeSales || 0
      const sorted = [...recs].sort((a, b) => {
        const al = lastOrderMs, bl = lastOrderMs
        if (al !== bl) return bl - al
        const ac = cumulative, bc = cumulative
        if (ac !== bc) return bc - ac
        const ai = Number(a.customerId) || 0
        const bi = Number(b.customerId) || 0
        return bi - ai
      })
      const best = sorted[0]
      const hidden = sorted.slice(1)
      rows.push({
        key,
        name: best.name,
        displayName: best.name || '名称未設定',
        customerId: best.customerId || '',
        bcartStatus: best.status || '',
        groupCount: recs.length,
        hiddenIds: hidden.map((r) => r.customerId).filter(Boolean),
        // orders から merge（明示・ここで確定）
        lastOrderDate: idx?.lastOrderDate || null,
        currentSales: idx?.currentSales || 0,
        cumulativeSales: idx?.cumulativeSales || 0,
        orderCount: idx?.orderCount || 0,
        _hasOrderHistory: !!idx,
      })
    }

    // 名称未設定: customerId 単独、orders とは紐付かない
    for (const a of anonymous) {
      const pseudoKey = `anon:${a.customerId || Math.random().toString(36).slice(2)}`
      rows.push({
        key: pseudoKey,
        name: '',
        displayName: '名称未設定',
        customerId: a.customerId || '',
        bcartStatus: a.status || '',
        groupCount: 1,
        hiddenIds: [],
        lastOrderDate: null,
        currentSales: 0,
        cumulativeSales: 0,
        orderCount: 0,
        _hasOrderHistory: false,
      })
    }
    return rows
  }, [bcartRecords, salonIndex])

  // 各指標の値
  // 「これまでの取引サロン」はサロン単位（重複名マージ済み）で表示。
  //   優先度:
  //     1. uniqueSalons.length（Bcart 名簿から dedup した件数）
  //     2. snapshotTotalSalonCount（Bcart raw カウント、代替表示）
  //     3. salonIndex.size（orders ユニーク、最終フォールバック）
  const allTimeSalonCount = (uniqueSalons?.length ?? null) ?? snapshotTotalSalonCount ?? salonIndex.size
  const dealerSalonsCount = managedKeys.size
  const currentActiveCount = useMemo(
    () => [...salonIndex.values()].filter((s) => s.currentSales > 0).length,
    [salonIndex],
  )
  // 休眠候補 = 「状態 !== '稼働'」なサロン
  //   稼働 = 当月発注あり（currentSales>0）または 最終注文から30日以内
  //   → 休眠候補には緑バッジが混ざらない
  const dormantCount = useMemo(() => {
    if (Array.isArray(uniqueSalons) && uniqueSalons.length > 0) {
      return uniqueSalons.filter((u) => statusFromDays(u.currentSales, u.lastOrderDate) !== '稼働').length
    }
    return Math.max(0, allTimeSalonCount - currentActiveCount)
  }, [uniqueSalons, allTimeSalonCount, currentActiveCount])
  const showRate = dealerSalonsCount > 0
  const rate = showRate ? currentActiveCount / dealerSalonsCount : null
  const showManagedTile = dealerSalonsCount > 0 // 未設定時はタイル自体を非表示にする

  // 指標別サロン一覧
  const listRows = useMemo(() => {
    const toRow = (s, extras = {}) => ({
      key: s.key,
      displayName: s.displayName,
      lastOrderDate: s.lastOrderDate,
      currentSales: s.currentSales,
      cumulativeSales: s.cumulativeSales,
      orderCount: s.orderCount,
      ...extras,
    })
    // 状態算出: 当月発注あり=稼働、最終注文から 31〜90日=休眠、91日以上=要フォロー、履歴なし=未発注
    const stateOf = (s) => statusFromDays(s.currentSales, s.lastOrderDate)
    if (selectedListKey === 'all') {
      // uniqueSalons は既に orders と merge 済み。再ルックアップ不要。
      if (Array.isArray(uniqueSalons) && uniqueSalons.length > 0) {
        return uniqueSalons.map((u) => ({
          key: u.key,
          displayName: u.displayName,
          lastOrderDate: u.lastOrderDate,
          currentSales: u.currentSales,
          cumulativeSales: u.cumulativeSales,
          orderCount: u.orderCount,
          customerId: u.customerId,
          bcartStatus: u.bcartStatus,
          groupCount: u.groupCount,
          hiddenIds: u.hiddenIds,
          state: statusFromDays(u.currentSales, u.lastOrderDate),
        })).sort((a, b) => (b.lastOrderDate?.getTime() || 0) - (a.lastOrderDate?.getTime() || 0))
      }
      // フォールバック: orders ユニーク
      return [...salonIndex.values()].map((s) => toRow(s, {
        state: managedKeys.has(s.key) ? stateOf(s) : '管理対象外',
      })).sort((a, b) => (b.lastOrderDate?.getTime() || 0) - (a.lastOrderDate?.getTime() || 0))
    }
    if (selectedListKey === 'managed') {
      // dealerSalons 登録全件（発注歴有無に関わらず）
      const rows = []
      for (const key of managedKeys) {
        const s = salonIndex.get(key)
        if (s) rows.push(toRow(s, { state: stateOf(s) }))
        else rows.push({ key, displayName: key, lastOrderDate: null, currentSales: 0, cumulativeSales: 0, orderCount: 0, state: '要フォロー' })
      }
      return rows.sort((a, b) => b.cumulativeSales - a.cumulativeSales)
    }
    if (selectedListKey === 'active') {
      return [...salonIndex.values()]
        .filter((s) => s.currentSales > 0)
        .map((s) => toRow(s, { state: managedKeys.has(s.key) ? '稼働' : '管理対象外・稼働' }))
        .sort((a, b) => b.currentSales - a.currentSales)
    }
    if (selectedListKey === 'rate') {
      // 管理対象サロンを 稼働 / 未稼働 で列挙
      const rows = []
      for (const key of managedKeys) {
        const s = salonIndex.get(key) || { key, displayName: key, cumulativeSales: 0, currentSales: 0, lastOrderDate: null, orderCount: 0 }
        rows.push(toRow(s, { state: s.currentSales > 0 ? '稼働' : '未稼働' }))
      }
      return rows.sort((a, b) => {
        // 未稼働を上に出す
        if (a.state !== b.state) return a.state === '未稼働' ? -1 : 1
        return (b.lastOrderDate?.getTime() || 0) - (a.lastOrderDate?.getTime() || 0)
      })
    }
    if (selectedListKey === 'dormant') {
      // 休眠・掘り起こし候補
      //   除外: 当月発注あり / 最終注文から30日以内（= 状態 '稼働'）
      //   ソート: 履歴なし・365日以上が先頭、その後は最終注文が古い順
      const daysOrInf = (d) => {
        if (!d) return Infinity
        const n = daysSince(d)
        return n == null ? Infinity : n
      }
      const cmpDormant = (a, b) => daysOrInf(b.lastOrderDate) - daysOrInf(a.lastOrderDate)

      if (Array.isArray(uniqueSalons) && uniqueSalons.length > 0) {
        return uniqueSalons
          .map((u) => ({
            key: u.key,
            displayName: u.displayName,
            lastOrderDate: u.lastOrderDate,
            currentSales: u.currentSales,
            cumulativeSales: u.cumulativeSales,
            orderCount: u.orderCount,
            customerId: u.customerId,
            bcartStatus: u.bcartStatus,
            groupCount: u.groupCount,
            hiddenIds: u.hiddenIds,
            state: statusFromDays(u.currentSales, u.lastOrderDate),
          }))
          .filter((u) => u.state !== '稼働')
          .sort(cmpDormant)
      }
      return [...salonIndex.values()]
        .map((s) => ({ ...s, state: statusFromDays(s.currentSales, s.lastOrderDate) }))
        .filter((s) => s.state !== '稼働')
        .map((s) => toRow(s, { state: s.state }))
        .sort(cmpDormant)
    }
    return []
  }, [selectedListKey, salonIndex, managedKeys, bcartNames, bcartRecords, uniqueSalons])

  const listTitle = {
    all: 'これまでの取引サロン',
    managed: '管理対象サロン',
    active: '今月動いているサロン',
    rate: '管理対象サロンの稼働状況',
    dormant: '休眠・掘り起こし候補',
  }[selectedListKey] || ''

  const filteredSalons = statusFilter === 'all'
    ? salons
    : salons.filter((s) => s.status === statusFilter)

  const maxTrend = Math.max(...(monthlyTrend?.map((t) => t.revenue) || [0]), 1)
  const maxProduct = productsRanking?.[0]?.amount || 1
  const totalStatusCount = statusDistribution
    ? statusDistribution.green + statusDistribution.yellow + statusDistribution.red
    : 0

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {profile?.companyName || '代理店'} 経営ダッシュボード
          </h1>
          <p className="mt-1 text-xs text-gray-500">
            自社配下サロンの売上・状態を Firestore から集計（直近6ヶ月）
          </p>
        </div>
        <Link
          to="/dealer"
          className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
        >
          ← アクションセンター
        </Link>
      </div>

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>
      )}

      {loading && !error && (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          読み込み中...
        </div>
      )}

      {!loading && !error && kpis && (
        <>
          {/* PR #103 のスマホ専用 営業 UI（要フォロー主役）は撤回。
              経営ダッシュボードは「数字を判断する画面」として、
              スマホでも PC でも同じレスポンシブ KPI（売上 → 前月比 → 母集団 → 稼働）を最上部に置く。
              要フォロー寄りの行動 UI は /dealer 側に集約。 */}
          {/* KPI 4 枚 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label={`${fmtMonth(kpis.curMonth)}の売上（税込）`}
              value={fmtYen(kpis.currentSales)}
              accent="primary"
            />
            <KpiCard
              label="前月比"
              value={fmtPct(kpis.diffRate)}
              sub={`前月 ${fmtYen(kpis.prevSales)}`}
              subColor={
                (kpis.diffRate ?? 0) > 0
                  ? 'text-emerald-600'
                  : (kpis.diffRate ?? 0) < 0
                    ? 'text-red-600'
                    : 'text-gray-500'
              }
            />
            {/* スロット3: これまでの取引サロン（社長指定の優先表示順に固定）
                稼働率はサロン状況パネル内でのみ表示する */}
            <KpiCard
              label="これまでの取引サロン"
              value={`${allTimeSalonCount} 店`}
              sub={snapshotTotalSalonCount != null ? 'Bカート 顧客全件（最新スナップショット）' : '過去に1回以上注文のあったサロン'}
            />
            {/* スロット4: 今月動いているサロン */}
            <KpiCard
              label="今月動いているサロン"
              value={`${currentActiveCount} 店`}
              sub="今月注文があったサロン"
            />
          </div>

          {/* サロン状況 */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <div className="text-sm font-bold text-gray-900">サロン状況</div>
              <div className="text-[11px] text-gray-400">カードをクリックで該当サロン一覧</div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatTile
                label="これまでの取引サロン"
                value={`${allTimeSalonCount} 店`}
                active={selectedListKey === 'all'}
                onClick={() => {
                  const next = selectedListKey === 'all' ? null : 'all'
                  setSelectedListKey(next)
                  if (next === 'all') ensureBcartNames()
                }}
              />
              {showManagedTile && (
                <StatTile
                  label="管理対象サロン"
                  value={`${dealerSalonsCount} 店`}
                  active={selectedListKey === 'managed'}
                  onClick={() => setSelectedListKey(selectedListKey === 'managed' ? null : 'managed')}
                />
              )}
              <StatTile
                label="今月動いているサロン"
                value={`${currentActiveCount} 店`}
                accent="primary"
                active={selectedListKey === 'active'}
                onClick={() => setSelectedListKey(selectedListKey === 'active' ? null : 'active')}
              />
              {showRate && (
                <StatTile
                  label="稼働率"
                  value={fmtPct(rate)}
                  active={selectedListKey === 'rate'}
                  onClick={() => setSelectedListKey(selectedListKey === 'rate' ? null : 'rate')}
                />
              )}
              <StatTile
                label="休眠・掘り起こし候補"
                value={`${dormantCount} 店`}
                active={selectedListKey === 'dormant'}
                onClick={() => {
                  const next = selectedListKey === 'dormant' ? null : 'dormant'
                  setSelectedListKey(next)
                  if (next === 'dormant') ensureBcartNames()
                }}
              />
            </div>

            {!showRate && (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                管理対象サロンがまだ設定されていないため、稼働率は表示していません。
                <br />
                現在は、注文履歴をもとに「今月動いているサロン」を表示しています。
              </div>
            )}

            {selectedListKey && (
              <div className="mt-5">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-bold text-gray-900">
                    {listTitle}（{listRows.length} 件）
                  </div>
                  <button
                    onClick={() => setSelectedListKey(null)}
                    className="text-xs text-gray-500 hover:underline"
                  >
                    閉じる ×
                  </button>
                </div>
                {(selectedListKey === 'all' || selectedListKey === 'dormant') && bcartLoading && !bcartNames && (
                  <div className="mb-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
                    Bカートから顧客一覧を取得しています…
                  </div>
                )}
                {(selectedListKey === 'all' || selectedListKey === 'dormant') && bcartError && !bcartNames && (
                  <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                    Bカート 顧客一覧の取得に失敗しました（{bcartError}）。注文履歴ベースで暫定表示します。
                  </div>
                )}
                <div className="overflow-hidden rounded-xl border border-gray-200">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-600">
                      <tr>
                        <th className="px-3 py-2 text-left">サロン名</th>
                        <th className="px-3 py-2 text-left">顧客ID</th>
                        <th className="px-3 py-2 text-left">最終注文日</th>
                        <th className="px-3 py-2 text-right">今月売上（税込）</th>
                        <th className="px-3 py-2 text-right">累計売上（税込）</th>
                        <th className="px-3 py-2 text-center">状態</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listRows.length === 0 ? (
                        <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-gray-400">該当するサロンがありません</td></tr>
                      ) : listRows.map((r) => (
                        <tr key={r.key} className="border-t border-gray-100">
                          <td className="px-3 py-2 text-gray-900">
                            {r.displayName}
                            {r.bcartStatus && r.bcartStatus !== '' && (
                              <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">
                                {r.bcartStatus}
                              </span>
                            )}
                            {r.groupCount > 1 && (
                              <span
                                className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500"
                                title={`同一サロン名の他 customerId: ${(r.hiddenIds || []).join(', ') || '—'}（古い customer_id 側は非表示）`}
                              >
                                同名{r.groupCount}件を統合
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-500">{r.customerId || '—'}</td>
                          <td className="px-3 py-2 text-gray-700">
                            {(() => {
                              const d = r.lastOrderDate
                              const days = daysSince(d)
                              if (d && days != null && days >= 365) {
                                return (
                                  <>
                                    <div>{fmtDate(d)}</div>
                                    <div className="text-[10px] text-red-600">1年以上未発注</div>
                                  </>
                                )
                              }
                              if (d && days != null) {
                                return (
                                  <>
                                    <div>{fmtDate(d)}</div>
                                    <div className="text-[10px] text-gray-400">最終注文から {days} 日</div>
                                  </>
                                )
                              }
                              return (
                                <>
                                  <div>—</div>
                                  <div className="text-[10px] text-red-600">1年以上未発注</div>
                                </>
                              )
                            })()}
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-gray-900">{fmtYen(r.currentSales)}</td>
                          <td className="px-3 py-2 text-right font-medium text-gray-900">{fmtYen(r.cumulativeSales)}</td>
                          <td className="px-3 py-2 text-center">
                            <StateBadge state={r.state} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* 月次売上推移 */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="mb-3 text-sm font-bold text-gray-900">直近 6ヶ月 売上推移（税込）</div>
            <div className="flex h-44 items-end justify-between gap-3">
              {monthlyTrend.map((t) => {
                const h = (t.revenue / maxTrend) * 100
                const isCurrent = t.month === kpis.curMonth
                return (
                  <div key={t.month} className="flex flex-1 flex-col items-center gap-1.5">
                    <div className="text-[10px] font-medium text-gray-500">
                      {fmtYen(t.revenue)}
                    </div>
                    <div className="flex h-32 w-full items-end">
                      <div
                        className={`w-full rounded-t ${isCurrent ? 'bg-indigo-600' : 'bg-indigo-300'}`}
                        style={{ height: `${h}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-gray-600">{t.label}</div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 分析エリア */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* 商品別売上 Top 10 */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="mb-3 text-sm font-bold text-gray-900">
                商品別売上 Top 10（{fmtMonth(kpis.curMonth)}・税抜）
              </div>
              {/*
                商品明細カバレッジ:
                - 当月 N 件中、何件に items 配列が入っているかを表示
                - 0/N or 全 doc の半分未満なら「商品明細未取得」と注釈
                - bcart-sync の --skip-products や、外部経路書込みで items が
                  欠落している doc が多い場合の判別用
              */}
              {productCoverage && productCoverage.total > 0 && (
                <div className="-mt-2 mb-3 text-[11px] text-gray-500">
                  {productCoverage.withItems === 0 ? (
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">
                      ⚠️ 商品明細未取得（0 / {productCoverage.total} 件）— bcart-sync で order_products 取得が必要
                    </span>
                  ) : productCoverage.withItems < productCoverage.total ? (
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">
                      ⚠️ 商品明細 {productCoverage.withItems} / {productCoverage.total} 件のみ取得済み（残りは未取得）
                    </span>
                  ) : (
                    <span className="text-emerald-600">明細取得 {productCoverage.withItems} / {productCoverage.total} 件 ✓</span>
                  )}
                </div>
              )}
              {productsRanking.length === 0 ? (
                <div className="py-6 text-center text-xs text-gray-400">
                  {productCoverage && productCoverage.withItems === 0 && productCoverage.total > 0
                    ? '商品明細未取得のため Top10 を表示できません'
                    : 'データなし'}
                </div>
              ) : (
                <div className="space-y-1">
                  {productsRanking.map((p, i) => (
                    <div key={p.name} className="flex items-center gap-3 py-1">
                      <div className="w-5 text-center text-xs font-bold text-gray-400">{i + 1}</div>
                      <div className="flex-1 truncate text-xs text-gray-800" title={p.name}>{p.name}</div>
                      <div className="w-20">
                        <div className="h-4 overflow-hidden rounded bg-gray-100">
                          <div
                            className="h-full bg-indigo-500"
                            style={{ width: `${(p.amount / maxProduct) * 100}%` }}
                          />
                        </div>
                      </div>
                      <div className="w-10 text-right text-[11px] text-gray-500">{p.count}点</div>
                      <div className="w-24 text-right text-xs font-medium text-gray-900">
                        {fmtYen(p.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 状態分布 */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="mb-3 text-sm font-bold text-gray-900">サロン状態分布</div>
              {totalStatusCount === 0 ? (
                <div className="py-6 text-center text-xs text-gray-400">サロンデータなし</div>
              ) : (
                <div className="space-y-3">
                  {[
                    { key: 'green', label: '🟢 健全（前月比 +10% 以上）', cls: 'bg-emerald-500' },
                    { key: 'yellow', label: '🟡 要注意（前月比 -10%〜+10%）', cls: 'bg-amber-500' },
                    { key: 'red', label: '🔴 警告（前月比 -10% 以下 / 30日発注なし）', cls: 'bg-red-500' },
                  ].map((row) => {
                    const count = statusDistribution[row.key]
                    const pct = totalStatusCount > 0 ? (count / totalStatusCount) * 100 : 0
                    return (
                      <div key={row.key}>
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="text-gray-700">{row.label}</span>
                          <span className="font-medium text-gray-900">
                            {count} 店（{pct.toFixed(0)}%）
                          </span>
                        </div>
                        <div className="h-3 overflow-hidden rounded bg-gray-100">
                          <div className={`h-full ${row.cls}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* サロン一覧 */}
          <div className="rounded-2xl border border-gray-200 bg-white">
            <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-5 py-3">
              <div className="text-sm font-bold text-gray-900">
                サロン一覧（{filteredSalons.length} / {salons.length} 店）
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-1">
                {[
                  { v: 'all', label: 'すべて' },
                  { v: 'green', label: '🟢 健全' },
                  { v: 'yellow', label: '🟡 要注意' },
                  { v: 'red', label: '🔴 警告' },
                ].map((f) => (
                  <button
                    key={f.v}
                    onClick={() => setStatusFilter(f.v)}
                    className={`rounded-lg border px-3 py-1 text-xs font-medium ${
                      statusFilter === f.v
                        ? 'border-indigo-500 bg-indigo-500 text-white'
                        : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            {filteredSalons.length === 0 ? (
              <div className="py-10 text-center text-sm text-gray-400">
                {salons.length === 0
                  ? 'サロンデータがありません'
                  : 'この条件に該当するサロンはありません'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-600">
                    <tr>
                      <th className="px-4 py-2 text-left">サロン名</th>
                      <th className="px-4 py-2 text-right">{fmtMonth(kpis.curMonth)}売上（税込）</th>
                      <th className="px-4 py-2 text-right">{fmtMonth(kpis.prevMonth)}売上（税込）</th>
                      <th className="px-4 py-2 text-right">前月比</th>
                      <th className="px-4 py-2 text-left">最終発注</th>
                      <th className="px-4 py-2 text-left">状態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSalons.map((s) => {
                      const badge = STATUS_BADGE[s.status]
                      return (
                        <tr key={s.companyName} className="border-t border-gray-100 hover:bg-gray-50">
                          <td className="px-4 py-2 text-gray-900">{s.companyName}</td>
                          <td className="px-4 py-2 text-right font-medium text-gray-900">{fmtYen(s.currentSales)}</td>
                          <td className="px-4 py-2 text-right text-gray-600">{fmtYen(s.prevSales)}</td>
                          <td className={`px-4 py-2 text-right text-xs ${
                            s.diffRate == null
                              ? 'text-gray-400'
                              : s.diffRate > 0
                                ? 'text-emerald-600'
                                : s.diffRate < 0
                                  ? 'text-red-600'
                                  : 'text-gray-500'
                          }`}>
                            {s.diffRate == null ? '—' : fmtPct(s.diffRate)}
                          </td>
                          <td className="px-4 py-2 text-xs text-gray-600">
                            {fmtDate(s.lastOrderDate)}
                            <span className="ml-1 text-gray-400">（{s.daysSinceLast}日前）</span>
                          </td>
                          <td className="px-4 py-2">
                            <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>
                              {badge.label}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
