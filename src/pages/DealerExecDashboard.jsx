import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { collection, doc, getDoc, getDocs, orderBy, query, where, limit } from 'firebase/firestore'
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
    '未稼働': 'bg-amber-100 text-amber-800',
    '未発注': 'bg-gray-100 text-gray-600',
    '管理対象外': 'bg-gray-100 text-gray-600',
    '管理対象外・稼働': 'bg-emerald-100 text-emerald-800',
  }
  const cls = map[state] || 'bg-gray-100 text-gray-600'
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>{state}</span>
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
  } = useDealerDashboard(profile)

  const [statusFilter, setStatusFilter] = useState('all')

  // サロン状況：全履歴 orders + dealerSalons + 月次snapshot を取得
  const [allOrders, setAllOrders] = useState([])
  const [managedSalons, setManagedSalons] = useState([])
  const [snapshotTotalSalonCount, setSnapshotTotalSalonCount] = useState(null)
  const [bcartNames, setBcartNames] = useState(null) // Set<string> | null（未取得）
  const [bcartLoading, setBcartLoading] = useState(false)
  const [bcartError, setBcartError] = useState(null)
  const [selectedListKey, setSelectedListKey] = useState(null)
  // 'all' | 'managed' | 'active' | 'rate' | 'dormant'

  useEffect(() => {
    const code = profile?.dealerCode
    if (!code) {
      setAllOrders([]); setManagedSalons([]); setSnapshotTotalSalonCount(null)
      setBcartNames(null); setBcartError(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const [ordSnap, dsSnap] = await Promise.all([
          getDocs(query(collection(db, 'orders'), where('dealerCode', '==', code))),
          getDocs(query(collection(db, 'dealerSalons'), where('dealerCode', '==', code))),
        ])
        if (cancelled) return
        setAllOrders(ordSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
        setManagedSalons(dsSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      } catch (e) {
        console.warn('[DealerExec] orders/dealerSalons 取得失敗:', e.message)
      }

      // dealerMonthlySnapshots から最新月の totalSalonCount を取得（Bカート 親フィルタ集計済み）
      try {
        const snapQuery = query(
          collection(db, 'dealerMonthlySnapshots'),
          where('dealerCode', '==', code),
          orderBy('month', 'desc'),
          limit(1),
        )
        const snap = await getDocs(snapQuery)
        if (cancelled) return
        if (!snap.empty) {
          const data = snap.docs[0].data()
          const cnt = Number(data.totalSalonCount)
          if (Number.isFinite(cnt) && cnt > 0) setSnapshotTotalSalonCount(cnt)
        }
      } catch (e) {
        console.warn('[DealerExec] dealerMonthlySnapshots 取得失敗:', e.message)
      }
    })()
    return () => { cancelled = true }
  }, [profile?.dealerCode])

  // Bcart 名簿を遅延取得（一覧クリック時に呼ぶ）
  const ensureBcartNames = async () => {
    const code = profile?.dealerCode
    if (!code || bcartNames || bcartLoading) return
    setBcartLoading(true); setBcartError(null)
    try {
      const names = await fetchDealerSalonNamesFromBcart(code)
      setBcartNames(names)
      // raw 件数（生の Bカート 会員件数）が snapshot より新しければ採用
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

  // 各指標の値
  // 「これまでの取引サロン」は Bcart 親=代理店 の会員数（snapshot キャッシュ）を 1次に。
  // snapshot 取得前 / 失敗時は orders ユニーク（過小評価だがフォールバック）。
  const allTimeSalonCount = snapshotTotalSalonCount ?? salonIndex.size
  const dealerSalonsCount = managedKeys.size
  const currentActiveCount = useMemo(
    () => [...salonIndex.values()].filter((s) => s.currentSales > 0).length,
    [salonIndex],
  )
  const dormantCount = Math.max(0, allTimeSalonCount - currentActiveCount)
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
    const stateOf = (s) => {
      if (s.currentSales > 0) return '稼働'
      if (s.cumulativeSales > 0) return '休眠'
      return '未発注'
    }
    if (selectedListKey === 'all') {
      // Bcart 名簿があればそれを母集団に。orders からの実績情報をマージ
      if (bcartNames && bcartNames.size > 0) {
        const rows = []
        for (const rawName of bcartNames) {
          const key = normalizeCompanyName(rawName)
          if (!key) continue
          const s = salonIndex.get(key)
          if (s) {
            rows.push(toRow(s, { state: managedKeys.has(s.key) ? stateOf(s) : (s.currentSales > 0 ? '稼働' : (s.cumulativeSales > 0 ? '休眠' : '未発注')) }))
          } else {
            rows.push({ key, displayName: rawName, lastOrderDate: null, currentSales: 0, cumulativeSales: 0, orderCount: 0, state: '未発注' })
          }
        }
        return rows.sort((a, b) => (b.lastOrderDate?.getTime() || 0) - (a.lastOrderDate?.getTime() || 0))
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
        else rows.push({ key, displayName: key, lastOrderDate: null, currentSales: 0, cumulativeSales: 0, orderCount: 0, state: '未発注' })
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
      // Bcart 名簿があれば「Bcart 全顧客 − 今月稼働」を母集団に
      if (bcartNames && bcartNames.size > 0) {
        const rows = []
        for (const rawName of bcartNames) {
          const key = normalizeCompanyName(rawName)
          if (!key) continue
          const s = salonIndex.get(key)
          // 今月稼働は除外
          if (s && s.currentSales > 0) continue
          if (s) {
            rows.push(toRow(s, { state: s.cumulativeSales > 0 ? '休眠' : '未発注' }))
          } else {
            rows.push({ key, displayName: rawName, lastOrderDate: null, currentSales: 0, cumulativeSales: 0, orderCount: 0, state: '未発注' })
          }
        }
        return rows.sort((a, b) => (b.lastOrderDate?.getTime() || 0) - (a.lastOrderDate?.getTime() || 0))
      }
      // フォールバック: orders 履歴のみから
      return [...salonIndex.values()]
        .filter((s) => s.cumulativeSales > 0 && s.currentSales === 0)
        .map((s) => toRow(s, { state: managedKeys.has(s.key) ? '休眠' : '管理対象外' }))
        .sort((a, b) => (b.lastOrderDate?.getTime() || 0) - (a.lastOrderDate?.getTime() || 0))
    }
    return []
  }, [selectedListKey, salonIndex, managedKeys, bcartNames])

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
            {/* スロット3: 管理対象がある場合のみ稼働率、無い場合は「これまでの取引サロン」 */}
            {showRate ? (
              <KpiCard
                label="稼働率"
                value={fmtPct(rate)}
                sub={`${currentActiveCount} / ${dealerSalonsCount} 店`}
                subColor={activeRateColor(rate)}
              />
            ) : (
              <KpiCard
                label="これまでの取引サロン"
                value={`${allTimeSalonCount} 店`}
                sub={snapshotTotalSalonCount != null ? 'Bカート 顧客全件（最新スナップショット）' : '過去に1回以上注文のあったサロン'}
              />
            )}
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
                        <th className="px-3 py-2 text-left">最終注文日</th>
                        <th className="px-3 py-2 text-right">今月売上（税込）</th>
                        <th className="px-3 py-2 text-right">累計売上（税込）</th>
                        <th className="px-3 py-2 text-center">状態</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listRows.length === 0 ? (
                        <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-gray-400">該当するサロンがありません</td></tr>
                      ) : listRows.map((r) => (
                        <tr key={r.key} className="border-t border-gray-100">
                          <td className="px-3 py-2 text-gray-900">{r.displayName}</td>
                          <td className="px-3 py-2 text-gray-700">{fmtDate(r.lastOrderDate)}</td>
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
