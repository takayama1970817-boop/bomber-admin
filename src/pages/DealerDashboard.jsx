import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'
import useDealerDashboard, { STATUS_BADGE } from '../hooks/useDealerDashboard.js'
import DealerWeatherCard from '../components/DealerWeatherCard.jsx'

const fmtYen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString()}`
const fmtPct = (n) => (n == null ? '—' : `${(n * 100).toFixed(0)}%`)

function fmtDate(d) {
  if (!d) return '—'
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// =====================================================
// KPI カード（アクションセンター用）
// =====================================================

function ActionKpi({ label, count, emoji, accent, helper }) {
  const colorMap = {
    danger: { border: 'border-red-300 bg-red-50', num: 'text-red-700' },
    warn: { border: 'border-amber-300 bg-amber-50', num: 'text-amber-700' },
    info: { border: 'border-indigo-200 bg-indigo-50', num: 'text-indigo-700' },
    neutral: { border: 'border-gray-200 bg-white', num: 'text-gray-800' },
  }
  const c = colorMap[accent] || colorMap.neutral
  return (
    <div className={`rounded-2xl border ${c.border} p-5`}>
      <div className="flex items-center gap-2 text-sm font-bold text-gray-900">
        <span>{emoji}</span>
        <span>{label}</span>
      </div>
      <div className={`mt-2 text-3xl font-bold ${c.num}`}>{count}</div>
      {helper && <div className="mt-1 text-xs text-gray-500">{helper}</div>}
    </div>
  )
}

// =====================================================
// アラート節
// =====================================================

function AlertSection({ title, emoji, accent, items, renderRight }) {
  if (items.length === 0) return null
  const bg = accent === 'danger' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
  return (
    <div className={`rounded-2xl border ${bg} p-4`}>
      <div className="mb-2 flex items-center gap-2 text-sm font-bold text-gray-900">
        <span>{emoji}</span>
        <span>{title}</span>
        <span className="ml-auto text-xs text-gray-500">{items.length} 件</span>
      </div>
      <div className="space-y-1">
        {items.slice(0, 5).map((s) => (
          <div key={s.companyName} className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-xs">
            <span className="flex-1 truncate text-gray-900" title={s.companyName}>{s.companyName}</span>
            {renderRight(s)}
          </div>
        ))}
        {items.length > 5 && (
          <div className="text-center text-[11px] text-gray-500">他 {items.length - 5} 店...</div>
        )}
      </div>
    </div>
  )
}

// =====================================================
// メインページ
// =====================================================

export default function DealerDashboard() {
  const { profile } = useAuth()
  const {
    loading, error, kpis,
    top10FollowNeeded,
    sharpDeclines,
    inactiveSalons,
    firstOrderStopped,
  } = useDealerDashboard(profile)

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* 日時・天気カード（最上部・スマホはフルカード／PCはコンパクト） */}
      <DealerWeatherCard dealerCode={profile?.dealerCode} />

      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {profile?.companyName || '代理店'} ダッシュボード
          </h1>
          <p className="mt-1 text-xs text-gray-500">
            今日取るべき行動を即時把握するアクションセンター
          </p>
        </div>
        <Link
          to="/dealer/dashboard-exec"
          className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
        >
          📊 経営ダッシュボード →
        </Link>
      </div>

      {/* エラー */}
      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>
      )}

      {/* ローディング */}
      {loading && !error && (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          読み込み中...
        </div>
      )}

      {!loading && !error && kpis && (
        <>
          {/* KPI 4枚（アクション指標） */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <ActionKpi
              label="要対応サロン"
              count={`${kpis.needAttentionCount} 店`}
              helper="要注意 + 警告 合計"
              emoji="⚠️"
              accent={kpis.needAttentionCount > 0 ? 'warn' : 'neutral'}
            />
            <ActionKpi
              label="売上急落"
              count={`${kpis.sharpDeclineCount} 店`}
              helper="前月比 -30% 以下"
              emoji="📉"
              accent={kpis.sharpDeclineCount > 0 ? 'danger' : 'neutral'}
            />
            <ActionKpi
              label="7日以上発注なし"
              count={`${kpis.noOrderIn7DaysCount} 店`}
              helper="連絡すべき対象"
              emoji="⏰"
              accent={kpis.noOrderIn7DaysCount > 0 ? 'warn' : 'neutral'}
            />
            <ActionKpi
              label="新規立ち上げ"
              count={`${kpis.newStartupCount} 店`}
              helper="今月初発注のサロン"
              emoji="🌱"
              accent={kpis.newStartupCount > 0 ? 'info' : 'neutral'}
            />
          </div>

          {/* フォロー優先サロン Top 10 */}
          <div className="rounded-2xl border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
              <div className="text-sm font-bold text-gray-900">
                フォロー優先サロン Top 10
              </div>
              <div className="text-xs text-gray-500">
                警告 → 要注意 の順 / 同ランクは LTV 降順
              </div>
            </div>
            {top10FollowNeeded.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">
                フォロー必要なサロンはありません 👍
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-600">
                    <tr>
                      <th className="px-4 py-2 text-left">順位</th>
                      <th className="px-4 py-2 text-left">サロン名</th>
                      <th className="px-4 py-2 text-right">前月比</th>
                      <th className="px-4 py-2 text-left">最終発注</th>
                      <th className="px-4 py-2 text-left">状態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {top10FollowNeeded.map((s, i) => {
                      const badge = STATUS_BADGE[s.status]
                      return (
                        <tr key={s.companyName} className="border-t border-gray-100 hover:bg-gray-50">
                          <td className="px-4 py-2 text-xs font-bold text-gray-400">{i + 1}</td>
                          <td className="px-4 py-2 text-gray-900">{s.companyName}</td>
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

          {/* アラート3種 */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <AlertSection
              title="売上急落"
              emoji="📉"
              accent="danger"
              items={sharpDeclines}
              renderRight={(s) => (
                <span className="font-medium text-red-700">{fmtPct(s.diffRate)}</span>
              )}
            />
            <AlertSection
              title="発注停止"
              emoji="🛑"
              accent="warn"
              items={inactiveSalons}
              renderRight={(s) => (
                <span className="font-medium text-amber-700">{s.daysSinceLast}日</span>
              )}
            />
            <AlertSection
              title="初回後停止"
              emoji="🆕"
              accent="warn"
              items={firstOrderStopped}
              renderRight={(s) => (
                <span className="font-medium text-amber-700">{fmtYen(s.prevSales + s.currentSales)}</span>
              )}
            />
          </div>

          {/* アラートがすべて空ならメッセージ */}
          {sharpDeclines.length === 0 && inactiveSalons.length === 0 && firstOrderStopped.length === 0 && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center text-sm text-emerald-800">
              🎉 すべてのサロンが順調に発注しています
            </div>
          )}

          {/* クイック導線 */}
          <div>
            <div className="mb-2 text-sm font-bold text-gray-900">クイック導線</div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Link to="/dealer/salons" className="rounded-xl border border-gray-200 bg-white p-4 text-center text-sm font-medium text-gray-700 hover:bg-gray-50">
                👥 サロン管理
              </Link>
              <Link to="/dealer/orders" className="rounded-xl border border-gray-200 bg-white p-4 text-center text-sm font-medium text-gray-700 hover:bg-gray-50">
                📦 注文一覧
              </Link>
              <Link to="/dealer/invoices" className="rounded-xl border border-gray-200 bg-white p-4 text-center text-sm font-medium text-gray-700 hover:bg-gray-50">
                📄 請求書一覧
              </Link>
              <Link to="/dealer/chat" className="rounded-xl border border-gray-200 bg-white p-4 text-center text-sm font-medium text-gray-700 hover:bg-gray-50">
                💬 チャット
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
