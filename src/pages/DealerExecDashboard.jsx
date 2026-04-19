import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'
import useDealerDashboard, { activeRateColor, STATUS_BADGE } from '../hooks/useDealerDashboard.js'

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

// =====================================================
// 経営ダッシュボード（Firestore ベース、Phase 3-1 v2）
// =====================================================

export default function DealerExecDashboard() {
  const { profile } = useAuth()
  const {
    loading, error, kpis, salons,
    monthlyTrend, productsRanking, statusDistribution,
  } = useDealerDashboard(profile)

  const [statusFilter, setStatusFilter] = useState('all')

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
            <KpiCard
              label="稼働率"
              value={fmtPct(kpis.activeRate)}
              sub={`${kpis.activeCount} / ${kpis.totalSalonCount} サロン`}
              subColor={activeRateColor(kpis.activeRate)}
            />
            <KpiCard
              label="アクティブサロン数"
              value={`${kpis.activeCount} 店`}
              sub={`配下 ${kpis.totalSalonCount} 店中`}
            />
          </div>

          {/* 月次売上推移 */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="mb-3 text-sm font-bold text-gray-900">直近 6ヶ月 売上推移</div>
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
                商品別売上 Top 10（{fmtMonth(kpis.curMonth)}）
              </div>
              {productsRanking.length === 0 ? (
                <div className="py-6 text-center text-xs text-gray-400">データなし</div>
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
                      <th className="px-4 py-2 text-right">{fmtMonth(kpis.curMonth)}売上</th>
                      <th className="px-4 py-2 text-right">{fmtMonth(kpis.prevMonth)}売上</th>
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
