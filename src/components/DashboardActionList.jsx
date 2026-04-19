import { Link } from 'react-router-dom'

function toDate(ts) {
  if (!ts) return null
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d
}

function fmtYmd(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function computeDaysAgo(d) {
  if (!d) return null
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 0) return 0
  return Math.floor(diffMs / (24 * 60 * 60 * 1000))
}

/**
 * 最終発注日セル。
 * - 発注履歴あり: YYYY/MM/DD （N日前）
 * - 発注履歴なし: —
 * N日前は snapshot の daysSinceLast を優先、無ければ lastOrderDate から計算。
 */
function LastOrderCell({ lastOrderDate, daysSinceLast }) {
  const d = toDate(lastOrderDate)
  if (!d) return <span className="text-gray-400">—</span>
  const days = daysSinceLast != null && daysSinceLast >= 0 ? daysSinceLast : computeDaysAgo(d)
  return (
    <span className="whitespace-nowrap">
      {fmtYmd(d)}
      {days != null && (
        <span className="ml-1 text-gray-400">（{days}日前）</span>
      )}
    </span>
  )
}

const STATUS_META = {
  'no-order': { label: '発注なし', className: 'bg-red-100 text-red-700' },
  stale30: { label: '30日以上', className: 'bg-red-100 text-red-700' },
  stale14: { label: '14日以上', className: 'bg-yellow-100 text-yellow-700' },
  new: { label: '新規', className: 'bg-green-100 text-green-700' },
}

/**
 * 旧スキーマ（followPriorityTop10 未対応の snapshot）向けの簡易フォールバック。
 * 既存の salonsStale30 / stale14 / new を 1列に並べて最大10件。
 */
function fallbackFromBuckets(snapshot) {
  if (!snapshot) return []
  const out = []
  for (const s of snapshot.salonsStale30 || []) {
    out.push({
      ...s,
      status: s.lastOrderDate ? 'stale30' : 'no-order',
      nextAction: s.lastOrderDate
        ? '30日以上未発注 → 電話フォロー'
        : '発注なし → ヒアリング',
    })
  }
  for (const s of snapshot.salonsStale14 || []) {
    out.push({ ...s, status: 'stale14', nextAction: '14日以上未発注 → リマインド' })
  }
  for (const s of snapshot.salonsNew || []) {
    out.push({ ...s, status: 'new', nextAction: '新規サロン → 初回フォロー' })
  }
  return out.slice(0, 10)
}

export default function DashboardActionList({ snapshot }) {
  const items =
    (snapshot && Array.isArray(snapshot.followPriorityTop10) && snapshot.followPriorityTop10.length > 0)
      ? snapshot.followPriorityTop10
      : fallbackFromBuckets(snapshot)

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-gray-700">🎯 フォロー優先Top10</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            停滞・発注ゼロ・新規の中から優先度の高い順に最大10件。上から順にアクションしてください。
          </p>
        </div>
        <Link
          to="/dealer/salons"
          className="text-xs font-medium text-indigo-600 hover:underline"
        >
          サロン一覧 →
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white py-10 text-center text-sm text-gray-400">
          フォローが必要なサロンはありません
        </div>
      ) : (
        <div className="overflow-auto rounded-2xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                <th className="w-10 px-3 py-2.5 text-center">#</th>
                <th className="px-3 py-2.5">サロン名</th>
                <th className="w-24 px-3 py-2.5">状態</th>
                <th className="w-40 px-3 py-2.5">最終発注</th>
                <th className="px-3 py-2.5">次アクション</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s, i) => {
                const meta = STATUS_META[s.status] || { label: s.status || '—', className: 'bg-gray-100 text-gray-700' }
                return (
                  <tr key={s.salonKey || `${s.name}-${i}`} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-3 py-2.5 text-center text-xs text-gray-400">{i + 1}</td>
                    <td className="px-3 py-2.5 font-medium text-gray-900">{s.name || '（名前なし）'}</td>
                    <td className="px-3 py-2.5">
                      <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-600">
                      <LastOrderCell lastOrderDate={s.lastOrderDate} daysSinceLast={s.daysSinceLast} />
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-700">{s.nextAction || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
