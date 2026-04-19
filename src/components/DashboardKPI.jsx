const fmtYen = (n) => '¥' + Math.round(Number(n) || 0).toLocaleString()

function ratioPct(current, prev) {
  if (!prev || prev <= 0) return null
  return Math.round((current / prev) * 1000) / 10 // 小数1桁
}

function Card({ label, value, sub, accent, emphasis }) {
  return (
    <div className={`rounded-2xl border ${accent || 'border-gray-200'} bg-white p-5`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-2 ${emphasis ? 'text-3xl' : 'text-2xl'} font-bold text-gray-900`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs">{sub}</div>}
    </div>
  )
}

/**
 * KPI 5枚。分析ではなく「行動判断用」。
 * - 今月売上（強調）
 * - 前月同日比（色分け：緑/赤）
 * - 稼働率
 * - アクティブサロン数
 * - 今月キックバック見込
 */
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
    pct == null
      ? '前月データなし'
      : `${pct}%${pct > 100 ? '（増）' : pct < 100 ? '（減）' : ''}`
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
        label="今月売上"
        value={fmtYen(monthRevenue)}
        accent="border-indigo-200"
        emphasis
      />
      <Card
        label="前月同日比"
        value={<span className={pctColor}>{pctLabel}</span>}
        sub={
          <span className="text-gray-500">
            前月同日まで {fmtYen(prevMonthSameDayRevenue)}
          </span>
        }
      />
      <Card
        label="稼働率"
        value={`${Math.round((operationRate || 0) * 100)}%`}
        sub={
          <span className="text-gray-500">
            発注あり {activeSalonCount} / 総 {totalSalonCount} 社
          </span>
        }
      />
      <Card
        label="アクティブサロン数"
        value={`${activeSalonCount} 社`}
        sub={<span className="text-gray-500">直近30日</span>}
      />
      <Card
        label="今月キックバック見込"
        value={fmtYen(kickbackEstimate)}
        sub={<span className="text-gray-500">確定額ではありません</span>}
      />
    </div>
  )
}
