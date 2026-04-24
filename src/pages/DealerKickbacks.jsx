import { useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import useDealerKickbacks, {
  KICKBACK_STATUS_LABELS,
  KICKBACK_STATUS_BADGE,
  normalizeKickbackStatus,
  extractKickbackAmount,
  extractSalesAmount,
} from '../hooks/useDealerKickbacks.js'
import DealerKickbacksTable from '../components/DealerKickbacksTable.jsx'
import DealerKickbackDetailModal from '../components/DealerKickbackDetailModal.jsx'

const fmtYen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString()}`

function fmtMonth(m) {
  if (!m) return '—'
  return String(m).replace('-', '/')
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// 今月のキー（YYYY-MM）
function currentMonthKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// 指定月の前月キー
function prevMonthKey(ym) {
  if (!ym) return ''
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ''
  const d = new Date(y, m - 2, 1) // m-2 = 前月 (month は 0始まり)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// 指定月の翌月キー
function nextMonthKey(ym) {
  if (!ym) return ''
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ''
  const d = new Date(y, m, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function KpiCard({ label, value, sub, accent }) {
  const accentClass = accent === 'primary'
    ? 'border-indigo-200 bg-indigo-50'
    : 'border-gray-200 bg-white'
  return (
    <div className={`rounded-2xl border ${accentClass} p-5`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-2 text-2xl font-bold text-gray-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-gray-500">{sub}</div>}
    </div>
  )
}

/**
 * 代理店 キックバック詳細（Phase 2）
 *
 * 設計原則:
 *   - 代理店の「収益確認画面」
 *   - Firestore のみ（Bカート API は使わない）
 *   - Read-only。分析機能は入れない
 *   - 「いくら」「いつ」「状態」を最優先で目立たせる
 */
export default function DealerKickbacks() {
  const { profile } = useAuth()
  const { kickbacks, loading, error } = useDealerKickbacks(profile)

  const [selectedMonth, setSelectedMonth] = useState(currentMonthKey())
  const [selectedKickback, setSelectedKickback] = useState(null)

  // 選択月・前月の kickback レコードを探索
  const currentKb = useMemo(
    () => kickbacks.find((k) => (k.month || k.period) === selectedMonth) || null,
    [kickbacks, selectedMonth],
  )
  const prevKb = useMemo(
    () => kickbacks.find((k) => (k.month || k.period) === prevMonthKey(selectedMonth)) || null,
    [kickbacks, selectedMonth],
  )

  const currentStatus = currentKb ? normalizeKickbackStatus(currentKb) : 'draft'
  const currentAmount = currentKb ? extractKickbackAmount(currentKb) : 0
  const prevAmount = prevKb ? extractKickbackAmount(prevKb) : 0

  const recentHistory = kickbacks.slice(0, 3)

  const goPrev = () => setSelectedMonth((m) => prevMonthKey(m))
  const goNext = () => setSelectedMonth((m) => nextMonthKey(m))
  const goThisMonth = () => setSelectedMonth(currentMonthKey())

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">キックバック清算</h1>
          <p className="mt-1 text-xs text-gray-500">
            自社のキックバック清算状況を月別に確認できます
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={goPrev} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
            ← 前月
          </button>
          <div className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-bold text-white">
            {fmtMonth(selectedMonth)}
          </div>
          <button onClick={goNext} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
            翌月 →
          </button>
          <button onClick={goThisMonth} className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
            今月
          </button>
        </div>
      </div>

      {/* エラー */}
      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          キックバックデータの取得に失敗しました: {error}
        </div>
      )}

      {/* ローディング */}
      {loading && !error && (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          読み込み中...
        </div>
      )}

      {!loading && !error && (
        <>
          {/* KPIカード4枚 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label={`${fmtMonth(selectedMonth)} 見込額`}
              value={fmtYen(currentAmount)}
              accent="primary"
            />
            <KpiCard
              label={`前月（${fmtMonth(prevMonthKey(selectedMonth))}）実績`}
              value={fmtYen(prevAmount)}
            />
            <KpiCard
              label="支払予定日"
              value={currentKb?.scheduledAt ? fmtDate(currentKb.scheduledAt) : '—'}
            />
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="text-xs text-gray-500">ステータス</div>
              <div className="mt-2">
                <span className={`inline-block rounded-lg px-3 py-1 text-sm font-bold ${KICKBACK_STATUS_BADGE[currentStatus]}`}>
                  {KICKBACK_STATUS_LABELS[currentStatus]}
                </span>
              </div>
              {currentKb?.paidAt && (
                <div className="mt-1 text-xs text-emerald-700">支払日: {fmtDate(currentKb.paidAt)}</div>
              )}
            </div>
          </div>

          {/* 今月の内訳 */}
          {currentKb && (
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="mb-3 text-sm font-bold text-gray-900">
                {fmtMonth(selectedMonth)} の内訳
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <div className="text-xs text-gray-500">対象売上（税抜）</div>
                  <div className="mt-1 text-base font-bold text-gray-900">
                    {fmtYen(extractSalesAmount(currentKb))}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">料率</div>
                  <div className="mt-1 text-base font-bold text-gray-900">
                    {currentKb.rate != null
                      ? `${(Number(currentKb.rate) * 100).toFixed(1)}%`
                      : (() => {
                          const s = extractSalesAmount(currentKb)
                          const k = Number(currentKb.totalKickback ?? 0)
                          return s > 0 && k > 0 ? `${((k / s) * 100).toFixed(1)}%` : '—'
                        })()
                    }
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">キックバック額</div>
                  <div className="mt-1 text-base font-bold text-indigo-900">
                    {fmtYen(currentAmount)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">対象サロン数</div>
                  <div className="mt-1 text-base font-bold text-gray-900">
                    {Array.isArray(currentKb.entries) ? currentKb.entries.length : (currentKb.salonCount ?? '—')} 店
                  </div>
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  onClick={() => setSelectedKickback(currentKb)}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-700"
                >
                  この月の詳細を見る →
                </button>
              </div>
            </div>
          )}

          {!currentKb && (
            <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
              {fmtMonth(selectedMonth)} のキックバックはまだ集計されていません
            </div>
          )}

          {/* 最近の清算履歴 */}
          {recentHistory.length > 0 && (
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="mb-3 text-sm font-bold text-gray-900">最近の清算履歴</div>
              <div className="space-y-1">
                {recentHistory.map((kb) => {
                  const status = normalizeKickbackStatus(kb)
                  return (
                    <div key={kb.id} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-gray-50">
                      <div className="w-20 text-sm font-medium text-gray-900">
                        {fmtMonth(kb.month || kb.period)}
                      </div>
                      <div className="flex-1 text-right text-sm font-bold text-gray-900">
                        {fmtYen(extractKickbackAmount(kb))}
                      </div>
                      <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${KICKBACK_STATUS_BADGE[status]}`}>
                        {KICKBACK_STATUS_LABELS[status]}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* 月別一覧 */}
          <div>
            <div className="mb-2 text-sm font-bold text-gray-900">月別一覧（直近12ヶ月）</div>
            <DealerKickbacksTable kickbacks={kickbacks} onSelect={setSelectedKickback} />
          </div>
        </>
      )}

      {/* 詳細モーダル */}
      <DealerKickbackDetailModal
        kickback={selectedKickback}
        onClose={() => setSelectedKickback(null)}
      />
    </div>
  )
}
