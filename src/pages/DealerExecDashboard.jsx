import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchDealerCompanyNames,
  fetchDealerSalonNamesFromBcart,
  fetchMonthlyDashboardScoped,
  fetchMonthlyDashboardLive,
} from '../lib/dashboardAggregator.js'
import {
  fetchSalonAnalyticsFromBcart,
  summarizeAnalytics,
} from '../lib/customerAnalytics.js'
import { useAuth } from '../contexts/AuthContext.jsx'

const fmtYen = (n) => `¥${Math.round(n || 0).toLocaleString()}`

function MetricCard({ label, value, diff, diffRate, hint }) {
  const isUp = (diff ?? 0) > 0
  const isDown = (diff ?? 0) < 0
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-2 text-2xl font-bold text-gray-900">{value}</div>
      {(diff !== undefined && diff !== null) && (
        <div
          className={`mt-1 text-xs ${
            isUp ? 'text-green-600' : isDown ? 'text-red-600' : 'text-gray-500'
          }`}
        >
          {isUp ? '▲' : isDown ? '▼' : '−'}{' '}
          {diff !== null && diffRate !== null
            ? `${fmtYen(Math.abs(diff))} (${diffRate > 0 ? '+' : ''}${diffRate}%)`
            : '前月データなし'}
        </div>
      )}
      {hint && <div className="mt-1 text-xs text-gray-400">{hint}</div>}
    </div>
  )
}

function SectionCard({ title, children, right }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-bold text-gray-900">{title}</div>
        {right}
      </div>
      {children}
    </div>
  )
}

export default function DealerExecDashboard() {
  const { profile } = useAuth()
  const dealerCode = profile?.dealerCode || ''
  const dealerCompanyName = profile?.companyName || ''

  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [companyNames, setCompanyNames] = useState(null) // Set<string> | null

  const [salonAnalytics, setSalonAnalytics] = useState([])
  const [analyticsLoading, setAnalyticsLoading] = useState(true)
  const [progress, setProgress] = useState('')
  const [cachedAt, setCachedAt] = useState(null)
  const [showAllSalons, setShowAllSalons] = useState(false)
  const [showAllFollow, setShowAllFollow] = useState(false)

  // Bカート会員APIから所属サロン全件取得（発注未経験のサロンも含む）
  // Firestore dealerSalons は補助情報としてマージ
  useEffect(() => {
    if (!dealerCode) return
    let cancelled = false
    ;(async () => {
      try {
        const [bcartNames, fsNames] = await Promise.all([
          fetchDealerSalonNamesFromBcart(dealerCode, { fallbackMonths: 6 }),
          fetchDealerCompanyNames(dealerCode).catch(() => new Set()),
        ])
        if (cancelled) return
        const merged = new Set([...bcartNames, ...fsNames])
        // 表示用の生会員件数（同名サロンを別カウント）を引き継ぐ
        merged.rawCount = Math.max(bcartNames.rawCount || 0, merged.size)
        setCompanyNames(merged)
      } catch (e) {
        console.error(e)
        if (!cancelled) setCompanyNames(new Set())
      }
    })()
    return () => { cancelled = true }
  }, [dealerCode])

  // Bカートデータは1日1回だけ取得。日付が変わるまでlocalStorageキャッシュを使用
  // Live では customer_parent_id=dealerCode で絞込み（キックバック清算と同じロジック）
  const loadDashboard = (y, m, forceRefresh = false) => {
    if (!dealerCode) return () => {}
    const cacheKey = `dealerExecDashboard:${dealerCode}:${y}-${String(m + 1).padStart(2, '0')}`
    const today = new Date().toISOString().slice(0, 10)
    let cancelled = false

    // 強制リフレッシュ時は所属サロン名・サロン分析の派生キャッシュも一掃
    if (forceRefresh) {
      try {
        localStorage.removeItem(`dealerSalonNames:${dealerCode}:v2`)
        localStorage.removeItem(`salonAnalyticsBcart:${dealerCode}:12m`)
      } catch (e) { /* ignore */ }
      // サロン分析を再取得
      fetchSalonAnalyticsFromBcart(dealerCode, { months: 12, forceRefresh: true })
        .then((list) => setSalonAnalytics(list))
        .catch((e) => console.error('analytics refresh error:', e))
    }

    // キャッシュ確認
    if (!forceRefresh) {
      try {
        const raw = localStorage.getItem(cacheKey)
        if (raw) {
          const cached = JSON.parse(raw)
          if (cached.date === today && cached.data) {
            setData(cached.data)
            setCachedAt(cached.fetchedAt || today)
            setLoading(false)
            setErr(null)
            // 注：companyNames（所属サロン全件）は会員APIから別途取得するためここでは上書きしない
            return () => { cancelled = true }
          }
        }
      } catch (e) { console.warn('cache read failed:', e) }
    }

    setLoading(true)
    setErr(null)
    setProgress('Bカート接続中...')

    fetchMonthlyDashboardLive(
      y,
      m,
      (msg) => { if (!cancelled) setProgress(msg) },
      null,         // companyNames 側は使わない
      dealerCode,   // customer_parent_id で絞込む
    )
      .then((d) => {
        if (cancelled) return
        setData(d)
        // 注：companyNames は会員APIから取得済み（受注ありサロンに上書きしない）
        const fetchedAt = new Date().toLocaleString('ja-JP')
        setCachedAt(fetchedAt)
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ date: today, fetchedAt, data: d }))
        } catch (e) { console.warn('cache write failed:', e) }
      })
      .catch((e) => {
        console.error('live fetch failed, fallback to firestore:', e)
        if (cancelled) return
        // Firestore fallback は dealerSalons ベース（精度低）
        return fetchMonthlyDashboardScoped(y, m, companyNames || new Set()).then((d) => {
          if (!cancelled) {
            setData(d)
            setErr('Bカート取得失敗のためFirestoreデータを表示中: ' + (e?.message || ''))
          }
        })
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setProgress('')
        }
      })

    return () => { cancelled = true }
  }

  // 月次集計（dealerCode があれば即実行、companyNames 初期取得は待たない）
  useEffect(() => {
    if (!dealerCode) return
    const cleanup = loadDashboard(year, month, false)
    return cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, dealerCode])

  // サロン分析：Bカート Live から直接取得（Firestore同期遅れの影響を受けない）
  useEffect(() => {
    if (!dealerCode) return
    let cancelled = false
    setAnalyticsLoading(true)
    fetchSalonAnalyticsFromBcart(dealerCode, { months: 12 })
      .then((list) => { if (!cancelled) setSalonAnalytics(list) })
      .catch((e) => console.error('salon analytics error:', e))
      .finally(() => { if (!cancelled) setAnalyticsLoading(false) })
    return () => { cancelled = true }
  }, [dealerCode])

  const goPrev = () => {
    if (month === 0) { setYear(year - 1); setMonth(11) }
    else setMonth(month - 1)
  }
  const goNext = () => {
    if (month === 11) { setYear(year + 1); setMonth(0) }
    else setMonth(month + 1)
  }
  const goThisMonth = () => {
    const n = new Date()
    setYear(n.getFullYear())
    setMonth(n.getMonth())
  }

  const allProducts = useMemo(() => {
    if (!data?.current?.byProduct) return []
    return data.current.byProduct
  }, [data])
  const topProducts = useMemo(() => allProducts.slice(0, 10), [allProducts])
  const maxProduct = topProducts[0]?.amount || 0

  const maxTrend = useMemo(() => {
    if (!data) return 0
    return Math.max(...data.trend.map((t) => t.revenue), 0)
  }, [data])

  const visibleSalons = useMemo(() => {
    if (!data) return []
    return showAllSalons
      ? data.current.salonRanking
      : data.current.salonRanking.slice(0, 10)
  }, [data, showAllSalons])
  const maxSalon = visibleSalons[0]?.amount || 0

  const analyticsSummary = useMemo(
    () => summarizeAnalytics(salonAnalytics),
    [salonAnalytics],
  )

  const followNeededSorted = useMemo(() => {
    const order = { lost: 0, warn: 1, watch: 2, safe: 3 }
    return [...salonAnalytics]
      .filter((s) => s.risk !== 'safe' && s.totalOrders > 0)
      .sort((a, b) => {
        const d = order[a.risk] - order[b.risk]
        if (d !== 0) return d
        return b.totalRevenue - a.totalRevenue
      })
  }, [salonAnalytics])

  const followNeededVisible = useMemo(
    () => (showAllFollow ? followNeededSorted : followNeededSorted.slice(0, 5)),
    [followNeededSorted, showAllFollow],
  )

  if (!dealerCode) {
    return (
      <div className="rounded-2xl border-2 border-yellow-200 bg-yellow-50 p-8 text-center">
        <div className="text-lg font-bold text-yellow-800">代理店情報が未設定です</div>
        <p className="mt-2 text-sm text-yellow-600">管理者にお問い合わせください。</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">経営ダッシュボード</h1>
          <p className="text-xs text-gray-500">
            {dealerCompanyName && `${dealerCompanyName} 様`}
            {companyNames && (
              <>
                　／
                <span className="font-bold text-indigo-700">
                  所属サロン {(companyNames.rawCount || companyNames.size).toLocaleString()} 社
                </span>
                <span className="ml-1 text-gray-400">（現時点最新）</span>
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-emerald-600">🔄 Bカート最新（画面表示時点）</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={goPrev}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            ← 前月
          </button>
          <div className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-bold text-white">
            {year}/{String(month + 1).padStart(2, '0')}
          </div>
          <button
            onClick={goNext}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            翌月 →
          </button>
          <button
            onClick={goThisMonth}
            className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
          >
            今月
          </button>
          <button
            onClick={() => loadDashboard(year, month, companyNames, true)}
            disabled={loading || !companyNames}
            className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            title="Bカートから最新データを再取得"
          >
            🔄 更新
          </button>
        </div>
      </div>

      {cachedAt && !loading && (
        <div className="text-xs text-gray-500">
          データ取得日時: {cachedAt}（Bカートデータは1日1回取得。最新にするには「🔄 更新」）
        </div>
      )}

      {loading && progress && (
        <div className="rounded-lg bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
          {progress}
        </div>
      )}
      {!loading && data?.source === 'bcart-live' && (
        <div className="rounded-lg bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
          ✓ Bカートから直接取得した最新データを表示中（所属サロンのみ）
        </div>
      )}

      {!loading && data && companyNames && companyNames.size === 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
          直近で所属サロンの受注データがありませんでした（Bカートの親会員紐付けをご確認ください）。
        </div>
      )}

      {loading && (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          集計中...
        </div>
      )}

      {err && !loading && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-800">
          {err}
        </div>
      )}

      {!loading && !err && data && (
        <>
          {/* KPI カード */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="売上（税込）"
              value={fmtYen(data.current.revenue)}
              diff={data.diff}
              diffRate={data.diffRate}
            />
            <MetricCard
              label="売上（税抜）"
              value={fmtYen(data.current.subtotal)}
            />
            <MetricCard
              label="受注件数"
              value={data.current.count.toLocaleString()}
              hint={`前月 ${data.previous.count.toLocaleString()} 件`}
            />
            <MetricCard
              label="平均単価"
              value={fmtYen(data.current.avgOrderValue)}
              hint={`前月 ${fmtYen(data.previous.avgOrderValue)}`}
            />
          </div>

          {/* 前年同月同日比 */}
          {data.lastYear && data.currentToDate && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <div className="mb-1 text-sm font-bold text-amber-900">
                📅 前年同月同日比
              </div>
              <div className="mb-3 text-xs text-amber-700">
                {year}/{String(month + 1).padStart(2, '0')}/01〜{String(data.cutoffDay).padStart(2, '0')}
                　vs
                {year - 1}/{String(month + 1).padStart(2, '0')}/01〜{String(data.cutoffDay).padStart(2, '0')}
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <div className="text-xs text-amber-700">当年（〜{data.cutoffDay}日）</div>
                  <div className="mt-1 text-lg font-bold text-gray-900">
                    {fmtYen(data.currentToDate.revenue)}
                  </div>
                  <div className="text-xs text-gray-500">{data.currentToDate.count.toLocaleString()} 件</div>
                </div>
                <div>
                  <div className="text-xs text-amber-700">前年（〜{data.cutoffDay}日）</div>
                  <div className="mt-1 text-lg font-bold text-gray-900">
                    {fmtYen(data.lastYear.revenue)}
                  </div>
                  <div className="text-xs text-gray-500">{data.lastYear.count.toLocaleString()} 件</div>
                </div>
                <div>
                  <div className="text-xs text-amber-700">差額</div>
                  <div
                    className={`mt-1 text-lg font-bold ${
                      (data.yoyDiff ?? 0) > 0
                        ? 'text-green-700'
                        : (data.yoyDiff ?? 0) < 0
                          ? 'text-red-700'
                          : 'text-gray-900'
                    }`}
                  >
                    {(data.yoyDiff ?? 0) > 0 ? '▲ ' : (data.yoyDiff ?? 0) < 0 ? '▼ ' : '− '}
                    {fmtYen(Math.abs(data.yoyDiff ?? 0))}
                  </div>
                  <div className="text-xs text-gray-500">
                    {data.currentToDate.count > data.lastYear.count ? '+' : ''}
                    {data.currentToDate.count - data.lastYear.count} 件
                  </div>
                </div>
                <div>
                  <div className="text-xs text-amber-700">前年比</div>
                  <div
                    className={`mt-1 text-lg font-bold ${
                      (data.yoyDiffRate ?? 0) > 0
                        ? 'text-green-700'
                        : (data.yoyDiffRate ?? 0) < 0
                          ? 'text-red-700'
                          : 'text-gray-900'
                    }`}
                  >
                    {data.yoyDiffRate !== null
                      ? `${data.yoyDiffRate > 0 ? '+' : ''}${data.yoyDiffRate}%`
                      : '—'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* フォロー必要サロン */}
          <SectionCard
            title={
              showAllFollow
                ? `⚠️ フォロー必要サロン（全 ${followNeededSorted.length}）`
                : `⚠️ フォロー必要サロン Top ${Math.min(5, followNeededSorted.length)}`
            }
            right={
              followNeededSorted.length > 5 && (
                <button
                  onClick={() => setShowAllFollow((v) => !v)}
                  className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                >
                  {showAllFollow ? '▲ Top 5 に戻す' : `全 ${followNeededSorted.length} サロン表示 →`}
                </button>
              )
            }
          >
            {analyticsLoading ? (
              <div className="py-6 text-center text-xs text-gray-400">集計中...</div>
            ) : followNeededSorted.length === 0 ? (
              <div className="py-6 text-center text-xs text-gray-500">
                フォロー必要なサロンはありません 👍
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  onClick={() => setShowAllFollow((v) => !v)}
                  className="mb-2 block w-full rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-left text-xs text-gray-600 hover:border-indigo-300 hover:bg-indigo-50/50"
                >
                  <span>要注意 <span className="font-bold text-yellow-700">{analyticsSummary.counts.watch}</span> ／ 警告 <span className="font-bold text-orange-700">{analyticsSummary.counts.warn}</span> ／ 離脱 <span className="font-bold text-red-700">{analyticsSummary.counts.lost}</span>（合計 {analyticsSummary.followNeededCount} サロン）</span>
                  <span className="ml-2 text-indigo-600">
                    {showAllFollow ? '▲ Top 5 に戻す' : '→ 全件表示'}
                  </span>
                </button>
                {followNeededVisible.map((s) => {
                  const riskColor = {
                    watch: 'bg-yellow-100 text-yellow-800',
                    warn: 'bg-orange-100 text-orange-800',
                    lost: 'bg-red-100 text-red-800',
                  }[s.risk]
                  const riskLabel = { watch: '要注意', warn: '警告', lost: '離脱危険' }[s.risk]
                  return (
                    <Link
                      key={s.id}
                      to={`/dealer/salons?salon=${encodeURIComponent(s.name)}`}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 transition-colors hover:border-indigo-300 hover:bg-indigo-50/50"
                    >
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${riskColor}`}>
                        {riskLabel}
                      </span>
                      <div className="flex-1 min-w-[140px] text-sm font-medium text-indigo-700">
                        {s.name}
                      </div>
                      <div className="text-xs text-gray-600">
                        LTV <span className="font-medium text-gray-900">{fmtYen(s.totalRevenue)}</span>
                      </div>
                      <div className="text-xs text-gray-600" title="最後にBカートで発注を入れた日から今日までの経過日数">
                        最終発注 <span className="font-medium text-gray-900">{s.daysSinceLastOrder ?? '-'}日前</span>
                      </div>
                      <div className="text-xs text-gray-500">→ {s.nextAction}</div>
                    </Link>
                  )
                })}
              </div>
            )}
          </SectionCard>

          {/* 商品別売上 Top 10 */}
          <SectionCard
            title={`商品別売上（Top ${topProducts.length}）`}
            right={
              <div className="text-xs text-gray-500">
                全 {allProducts.length} 商品／合計 {(data.current.productCountTotal || 0).toLocaleString()} 点
              </div>
            }
          >
            {topProducts.length === 0 ? (
              <div className="py-6 text-center text-xs text-gray-400">データなし</div>
            ) : (
              <div className="space-y-1">
                {topProducts.map((p, i) => (
                  <div key={p.name} className="flex items-center gap-3 py-1.5">
                    <div className="w-6 text-center text-xs font-bold text-gray-400">{i + 1}</div>
                    <div className="flex-1 text-sm text-gray-900">{p.name}</div>
                    <div className="w-40">
                      <div className="h-5 overflow-hidden rounded-md bg-gray-100">
                        <div
                          className="h-full bg-indigo-500"
                          style={{ width: `${maxProduct > 0 ? (p.amount / maxProduct) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                    <div className="w-16 text-right text-xs text-gray-500">{p.count.toLocaleString()}点</div>
                    <div className="w-28 text-right text-sm font-medium text-gray-900">
                      {fmtYen(p.amount)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* サロン別ランキング */}
          <SectionCard
            title={
              showAllSalons
                ? `サロン別売上ランキング（全 ${data.current.salonRanking.length}）`
                : `サロン別売上ランキング（Top ${Math.min(10, data.current.salonRanking.length)}）`
            }
            right={
              <button
                onClick={() => setShowAllSalons((v) => !v)}
                className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
              >
                {showAllSalons
                  ? '▲ Top 10 に戻す'
                  : `当月発注あり ${data.current.salonRanking.length} サロン すべて表示 →`}
              </button>
            }
          >
            {visibleSalons.length === 0 ? (
              <div className="py-6 text-center text-sm text-gray-400">
                当月の発注データがありません
              </div>
            ) : (
              <div className="space-y-0.5">
                {visibleSalons.map((s, i) => (
                  <div key={s.name} className="flex items-center gap-3 py-1.5">
                    <div className="w-6 text-center text-xs font-bold text-gray-400">
                      {i + 1}
                    </div>
                    <div className="flex-1 truncate text-sm text-gray-800" title={s.name}>
                      {s.name}
                    </div>
                    <div className="flex-1">
                      <div className="h-4 overflow-hidden rounded bg-gray-100">
                        <div
                          className="h-full bg-pink-500"
                          style={{
                            width: `${maxSalon > 0 ? (s.amount / maxSalon) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="w-28 text-right text-sm font-medium text-gray-900">
                      {fmtYen(s.amount)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* 月次推移 */}
          <SectionCard title="直近 6 ヶ月の売上推移">
            <div className="flex h-48 items-end justify-between gap-3 pt-4">
              {data.trend.map((t) => {
                const h = maxTrend > 0 ? (t.revenue / maxTrend) * 100 : 0
                return (
                  <div key={t.label} className="flex flex-1 flex-col items-center gap-1.5">
                    <div className="text-[10px] font-medium text-gray-500">
                      {fmtYen(t.revenue)}
                    </div>
                    <div className="flex h-32 w-full items-end">
                      <div
                        className="w-full rounded-t bg-indigo-500"
                        style={{ height: `${h}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-gray-600">{t.label}</div>
                    <div className="text-[10px] text-gray-400">{t.count} 件</div>
                  </div>
                )
              })}
            </div>
          </SectionCard>

          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-xs text-indigo-900">
            <strong>表示範囲：</strong> {dealerCompanyName} 様の所属サロン（{companyNames?.size ?? 0} 社）の受注データのみを集計しています。
          </div>
        </>
      )}
    </div>
  )
}
