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

function fmtSnapshotAt(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtCutoff(ts) {
  if (!ts) return null
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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
      className="flex items-center justify-between rounded-2xl border border-gray-200 bg-white px-5 py-4 transition-colors hover:border-indigo-300 hover:bg-indigo-50"
    >
      <div>
        <div className="text-sm font-bold text-gray-900">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-gray-500">{hint}</div>}
      </div>
      <span className="text-indigo-500">→</span>
    </Link>
  )
}

function RecentOrders({ orders }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-700">最近の注文</h2>
        <Link
          to="/dealer/orders"
          className="text-xs font-medium text-indigo-600 hover:underline"
        >
          注文一覧 →
        </Link>
      </div>
      {!orders || orders.length === 0 ? (
        <div className="py-6 text-center text-xs text-gray-400">直近の注文はありません</div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {orders.map((o) => (
            <li key={o.orderId} className="flex items-center justify-between py-2.5 text-sm">
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
        <Header />
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
      <Header companyName={profile?.companyName} month={snapshot.month} />

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

      {/* フッター: 最終更新 */}
      <div className="mt-6 border-t border-gray-200 pt-4 text-right text-xs text-gray-500">
        最終更新：{fmtSnapshotAt(snapshot.snapshotAt)}
        {snapshot.snapshotCutoffAt && (
          <span className="ml-2">※当日{fmtCutoff(snapshot.snapshotCutoffAt)?.split(' ')[1] || '12:00'}締め分まで反映</span>
        )}
      </div>
    </>
  )
}

function Header({ companyName, month }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-bold text-gray-900">
        ダッシュボード
        {month && <span className="ml-2 text-sm font-normal text-gray-500">{month}</span>}
      </h1>
      {companyName && (
        <p className="mt-1 text-xs text-gray-500">{companyName} 様の今日の状況</p>
      )}
    </div>
  )
}
