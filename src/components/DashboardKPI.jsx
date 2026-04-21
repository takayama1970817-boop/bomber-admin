import { Link } from 'react-router-dom'

function ratioPct(current, prev) {
  if (!prev || prev <= 0) return null
  return Math.round((current / prev) * 1000) / 10
}

/**
 * 金額表示（¥ を小さく、数字を主役に）。
 */
function YenValue({ n, emphasis }) {
  const num = Math.round(Number(n) || 0).toLocaleString()
  return (
    <span className="inline-flex items-baseline">
      <span className={`mr-1 ${emphasis ? 'text-xl' : 'text-base'} font-semibold text-gray-400`}>
        ¥
      </span>
      <span>{num}</span>
    </span>
  )
}

/**
 * 数字＋単位（単位は小さく）。
 */
function CountValue({ n, unit }) {
  return (
    <span className="inline-flex items-baseline">
      <span>{Number(n || 0).toLocaleString()}</span>
      <span className="ml-1 text-base font-medium text-gray-400">{unit}</span>
    </span>
  )
}

function PctValue({ n, color }) {
  return (
    <span className="inline-flex items-baseline">
      <span className={color}>{n}</span>
      <span className="ml-0.5 text-base font-medium text-gray-400">%</span>
    </span>
  )
}

/**
 * KPIカード。
 * トーン: やわらかい violet（上品・高級感）／角丸 16px／薄いシャドウ／数字大・単位小。
 * すべてクリック可で「次に何をするか」へ直結。
 */
function Card({ to, label, value, sub, emphasis, action, ringClass }) {
  const inner = (
    <div
      className={`group flex h-full flex-col rounded-2xl border bg-white p-5 shadow-[0_1px_3px_rgba(17,24,39,0.04)] transition hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(139,92,246,0.10)] ${
        ringClass || 'border-gray-100 hover:border-violet-200'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium tracking-wide text-gray-500">{label}</div>
        <span className="text-violet-400 opacity-0 transition-opacity group-hover:opacity-100">
          →
        </span>
      </div>
      <div
        className={`mt-3 font-bold tracking-tight text-gray-900 ${
          emphasis ? 'text-4xl' : 'text-3xl'
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-1.5 text-xs leading-relaxed">{sub}</div>}
      {action && (
        <div className="mt-3 text-[11px] font-medium text-violet-500 opacity-80">
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
  const pctSuffix = pct == null ? '' : pct > 100 ? ' （増）' : pct < 100 ? ' （減）' : ''
  const pctColor =
    pct == null
      ? 'text-gray-400'
      : pct > 100
      ? 'text-emerald-600'
      : pct < 100
      ? 'text-[#D35A5A]'
      : 'text-gray-500'

  const prevLabelYen = '¥' + Math.round(prevMonthSameDayRevenue || 0).toLocaleString()

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-5">
      <Card
        to="/dealer/orders"
        label="今月売上"
        value={<YenValue n={monthRevenue} emphasis />}
        emphasis
        action="注文一覧を見る"
        ringClass="border-violet-200 bg-gradient-to-br from-violet-50/40 to-white hover:border-violet-300"
      />
      <Card
        to="/dealer/dashboard-exec"
        label="前月同日比"
        value={
          pct == null ? (
            <span className="text-gray-400">—</span>
          ) : (
            <>
              <PctValue n={pct} color={pctColor} />
              <span className={`ml-1 text-base font-medium ${pctColor}`}>{pctSuffix}</span>
            </>
          )
        }
        sub={<span className="text-gray-500">前月同日まで {prevLabelYen}</span>}
        action="要因分析へ"
      />
      <Card
        to="/dealer/salons"
        label="稼働率"
        value={<PctValue n={Math.round((operationRate || 0) * 100)} color="text-gray-900" />}
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
        value={<CountValue n={activeSalonCount} unit="社" />}
        sub={<span className="text-gray-500">直近30日</span>}
        action="所属サロン一覧へ"
      />
      <Card
        to="/dealer/kickbacks"
        label="今月キックバック見込"
        value={<YenValue n={kickbackEstimate} />}
        sub={<span className="text-gray-500">確定額ではありません</span>}
        action="過去の清算書を見る"
      />
    </div>
  )
}
