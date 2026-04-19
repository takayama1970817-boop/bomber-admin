import { Link } from 'react-router-dom'

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

function Bucket({ icon, title, items, emptyLabel, dateLabel, dateField }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-bold text-gray-900">
          <span className="mr-2">{icon}</span>
          {title}
          <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
            {items.length}件
          </span>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="py-6 text-center text-xs text-gray-400">{emptyLabel}</div>
      ) : (
        <ul className="space-y-2">
          {items.map((s) => (
            <li
              key={s.salonKey || s.name}
              className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm"
            >
              <span className="truncate font-medium text-gray-900">{s.name || '（名前なし）'}</span>
              <span className="ml-2 shrink-0 text-xs text-gray-500">
                {dateLabel}: {fmtDate(s[dateField])}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 要対応サロン表示。分析ではなく「今どこに電話するか」を決めるためのリスト。
 * クリックで /dealer/salons に遷移（個別ディープリンクは現時点で未対応）。
 */
export default function DashboardActionList({ snapshot }) {
  const {
    salonsStale30 = [],
    salonsStale14 = [],
    salonsNew = [],
  } = snapshot || {}

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-700">要対応サロン</h2>
        <Link
          to="/dealer/salons"
          className="text-xs font-medium text-indigo-600 hover:underline"
        >
          サロン一覧で見る →
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Bucket
          icon="🔴"
          title="30日以上未発注"
          items={salonsStale30}
          emptyLabel="該当サロンはありません"
          dateLabel="最終発注"
          dateField="lastOrderDate"
        />
        <Bucket
          icon="🟡"
          title="14日以上未発注"
          items={salonsStale14}
          emptyLabel="該当サロンはありません"
          dateLabel="最終発注"
          dateField="lastOrderDate"
        />
        <Bucket
          icon="🟢"
          title="新規サロン（30日以内）"
          items={salonsNew}
          emptyLabel="今月の新規サロンはまだありません"
          dateLabel="初回"
          dateField="firstOrderDate"
        />
      </div>
    </div>
  )
}
