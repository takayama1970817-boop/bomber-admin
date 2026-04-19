import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useDealerDashboard, currentYearMonth } from '../hooks/useDealerDashboard.js'
import DashboardKPI from '../components/DashboardKPI.jsx'
import DashboardActionList from '../components/DashboardActionList.jsx'

/**
 * 代理店ダッシュボード（行動用）。
 * - 経営ダッシュボードは /dealer/dashboard-exec に分離。ここは「今何をするか」だけ。
 * - 集計は scripts/aggregate-dealer-monthly.mjs が毎日13:00に書き込む dealerMonthlySnapshots を読むだけ。
 * - 重い処理・グラフ・ランキング・CSV は意図的に置かない。
 */

function fmtYen(n) {
  return '¥' + Math.round(Number(n) || 0).toLocaleString()
}

function fmtTimestamp(ts) {
  if (!ts) return '—'
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}`
}

/**
 * 最終更新時刻の source of truth: snapshotAt → updatedAt フォールバック。
 * snapshotCutoffAt は補助文言には使ってよいが、主表示には使わない。
 */
function resolveLastUpdated(snapshot) {
  if (!snapshot) return null
  return snapshot.snapshotAt || snapshot.updatedAt || null
}

function fmtOrderDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function QuickLink({ to, label, hint }) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between rounded-2xl border border-gray-100 bg-white px-5 py-4 shadow-[0_1px_3px_rgba(17,24,39,0.04)] transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-[0_8px_24px_rgba(139,92,246,0.10)]"
    >
      <div>
        <div className="text-sm font-bold tracking-wide text-gray-900">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-gray-500">{hint}</div>}
      </div>
      <span className="text-violet-400">→</span>
    </Link>
  )
}

function RecentOrders({ orders }) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-[0_1px_3px_rgba(17,24,39,0.04)]">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-wide text-gray-800">最近の注文</h2>
        <Link
          to="/dealer/orders"
          className="text-xs font-medium text-violet-500 hover:text-violet-600 hover:underline"
        >
          注文一覧 →
        </Link>
      </div>
      {!orders || orders.length === 0 ? (
        <div className="py-6 text-center text-xs text-gray-400">直近の注文はありません</div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {orders.map((o) => (
            <li
              key={o.orderId}
              className="-mx-2 flex items-center justify-between rounded-lg px-2 py-2.5 text-sm transition-colors hover:bg-violet-50/50"
            >
              <span className="w-12 shrink-0 text-xs text-gray-500">{fmtOrderDate(o.orderDate)}</span>
              <span className="flex-1 truncate font-medium text-gray-900">{o.salonName || '—'}</span>
              <span className="ml-2 shrink-0 font-bold text-gray-900">{fmtYen(o.totalAmount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function DealerDashboard() {
  const { profile } = useAuth()
  const dealerCode = profile?.dealerCode || ''
  const month = currentYearMonth()
  const { loading, error, snapshot } = useDealerDashboard(dealerCode, month)

  if (!dealerCode) {
    return (
      <div className="rounded-2xl border-2 border-yellow-200 bg-yellow-50 p-8 text-center">
        <div className="text-lg font-bold text-yellow-800">代理店情報が未設定です</div>
        <p className="mt-2 text-sm text-yellow-600">管理者にお問い合わせください。</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        読み込み中...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl border-2 border-red-200 bg-red-50 p-8 text-center">
        <div className="text-lg font-bold text-red-800">ダッシュボードデータの取得に失敗しました</div>
        <p className="mt-2 text-sm text-red-600">{error.message || String(error)}</p>
      </div>
    )
  }

  if (!snapshot) {
    return (
      <>
        <Header companyName={profile?.companyName} snapshot={null} />
        <div className="rounded-2xl border-2 border-dashed border-gray-300 bg-white p-12 text-center">
          <div className="text-lg font-bold text-gray-700">データがありません</div>
          <p className="mt-2 text-sm text-gray-500">
            本日のスナップショットがまだ作成されていません。13:00 以降に再度ご確認ください。
          </p>
          <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
            <QuickLink to="/dealer/orders" label="注文一覧" hint="自社配下の注文" />
            <QuickLink to="/dealer/salons" label="サロン一覧" hint="所属サロン管理" />
            <QuickLink to="/dealer/kickbacks" label="キックバック" hint="清算書ダウンロード" />
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Header companyName={profile?.companyName} snapshot={snapshot} />

      {/* ① KPI */}
      <section className="mb-8">
        <DashboardKPI snapshot={snapshot} />
      </section>

      {/* ② 要対応サロン */}
      <section className="mb-8">
        <DashboardActionList snapshot={snapshot} />
      </section>

      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* ③ 最近の注文 */}
        <RecentOrders orders={snapshot.recentOrders} />

        {/* ④ クイック導線 */}
        <div>
          <h2 className="mb-3 text-sm font-bold text-gray-700">クイック導線</h2>
          <div className="grid grid-cols-1 gap-3">
            <QuickLink to="/dealer/orders" label="注文一覧" hint="自社配下の注文を月別で確認" />
            <QuickLink to="/dealer/salons" label="サロン一覧" hint="所属サロンの状況" />
            <QuickLink to="/dealer/kickbacks" label="キックバック" hint="月次清算書のダウンロード" />
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * ページタイトル + 最終更新表示。
 * 最終更新は snapshot 有無に関わらず必ずレンダリングする（値が無ければ「—」）。
 * 現在時刻は 30 秒ごとに更新（秒は表示しないので 1 分以内に揃えば十分）。
 */
function useClockMinutes() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30 * 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function Header({ companyName, snapshot }) {
  const month = snapshot?.month
  const lastUpdated = resolveLastUpdated(snapshot)
  const now = useClockMinutes()

  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-wide text-gray-900">
          ダッシュボード
          {month && <span className="ml-2 text-sm font-normal text-gray-500">{month}</span>}
        </h1>
        {companyName && (
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            {companyName} 様の今日の状況
          </p>
        )}
      </div>
      <div className="rounded-2xl border border-gray-100 bg-white px-5 py-3 text-right text-gray-500 shadow-[0_1px_3px_rgba(17,24,39,0.04)]">
        <div className="flex items-baseline justify-end gap-2">
          <span className="text-[11px] font-medium tracking-wider text-gray-400">現在</span>
          <span className="text-xl font-bold tracking-wide tabular-nums text-gray-900">
            {fmtTimestamp(now)}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-end gap-2">
          <span className="text-[11px] font-medium tracking-wider text-gray-400">最終更新</span>
          <span className="text-lg font-semibold tracking-wide tabular-nums text-gray-700">
            {fmtTimestamp(lastUpdated)}
          </span>
        </div>
        <div className="mt-1 text-xs text-gray-400">※当日12:00締め分まで反映</div>
        <div className="mt-0.5 text-xs text-violet-500">🕐 13:00集計済みデータ（Bカート基準）</div>
      </div>
    </div>
  )
}
