import { Link } from 'react-router-dom'

const fmtYen = (n) => '¥' + Math.round(Number(n) || 0).toLocaleString()

function ratioPct(current, prev) {
  if (!prev || prev <= 0) return null
  return Math.round((current / prev) * 1000) / 10 // 小数1桁
}

/**
 * KPIカード。すべてクリック導線を持ち「何をするか」に直結する画面へ飛ぶ。
 * - 今月売上 → 注文一覧（/dealer/orders）
 * - 前月同日比 → 経営ダッシュボード（/dealer/dashboard-exec）
 * - 稼働率 → サロン一覧（/dealer/salons）
 * - アクティブサロン数 → サロン一覧（/dealer/salons）
 * - 今月キックバック見込 → キックバック（/dealer/kickbacks）
 */
function Card({ to, label, value, sub, accent, emphasis, action }) {
  const accentClass = accent || 'border-gray-200'
  const inner = (
    <div
      className={`group flex h-full flex-col rounded-2xl border ${accentClass} bg-white p-5 transition-colors hover:border-indigo-400 hover:bg-indigo-50`}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-500">{label}</div>
        <span className="text-indigo-400 opacity-0 transition-opacity group-hover:opacity-100">→</span>
      </div>
      <div className={`mt-2 ${emphasis ? 'text-3xl' : 'text-2xl'} font-bold text-gray-900`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs">{sub}</div>}
      {action && (
        <div className="mt-3 text-[11px] font-medium text-indigo-600">
          {action} →
        </div>
      )}
    </div>
  )
  return to ? (
    <Link to={to} className="block h-full">
      {inner}
    </Link>
  ) : (
    inner
  )
}

export default function DashboardKPI({ snapshot }) {
  const {
    monthRevenue = 0,
    prevMonthSameDayRevenue = 0,
    activeSalonCount = 0,
    totalSalonCount = 0,
    operationRate = 0,
    kickbackEstimate = 0,
  } = snapshot || {}

  const pct = ratioPct(monthRevenue, prevMonthSameDayRevenue)
  const pctLabel =
    pct == null ? '前月データなし' : `${pct}%${pct > 100 ? '（増）' : pct < 100 ? '（減）' : ''}`
  const pctColor =
    pct == null
      ? 'text-gray-400'
      : pct > 100
      ? 'text-green-600'
      : pct < 100
      ? 'text-red-600'
      : 'text-gray-500'

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-5">
      <Card
        to="/dealer/orders"
        label="今月売上"
        value={fmtYen(monthRevenue)}
        accent="border-indigo-200"
        emphasis
        action="注文一覧を見る"
      />
      <Card
        to="/dealer/dashboard-exec"
        label="前月同日比"
        value={<span className={pctColor}>{pctLabel}</span>}
        sub={<span className="text-gray-500">前月同日まで {fmtYen(prevMonthSameDayRevenue)}</span>}
        action="経営ダッシュボードで要因分析"
      />
      <Card
        to="/dealer/salons"
        label="稼働率"
        value={`${Math.round((operationRate || 0) * 100)}%`}
        sub={
          <span className="text-gray-500">
            発注あり {activeSalonCount} / 総 {totalSalonCount} 社
          </span>
        }
        action="停滞サロンを確認"
      />
      <Card
        to="/dealer/salons"
        label="アクティブサロン数"
        value={`${activeSalonCount} 社`}
        sub={<span className="text-gray-500">直近30日</span>}
        action="所属サロン一覧へ"
      />
      <Card
        to="/dealer/kickbacks"
        label="今月キックバック見込"
        value={fmtYen(kickbackEstimate)}
        sub={<span className="text-gray-500">確定額ではありません</span>}
        action="過去の清算書を見る"
      />
    </div>
  )
}
